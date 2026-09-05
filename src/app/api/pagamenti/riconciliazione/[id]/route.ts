import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { residuoEffettivo } from '@/lib/pagamenti/aging'
import { formatEuro } from '@/lib/format/valuta'
import { mapStatoAruba } from '@/lib/aruba/stato'

const patchBodySchema = z.object({
  azione: z.enum(['conferma', 'ignora', 'riapri']),
  pagamento_id: zUuid.optional(),
})

interface Movimento {
  id: string
  // I movimenti sono ora GLOBALI: nasce senza sede (null) e assume quella del pagamento alla conferma.
  scuola_id: string | null
  importo: number
  data_operazione: string
  causale: string | null
  stato: string
  /** Il pagamento a cui questo bonifico è già abbinato: lo scrive solo la conferma. */
  pagamento_id: string | null
  suggerimenti?: { pagamento_id: string }[] | null
}

// SELECT del pagamento con le colonne Contabilità v2 (sconto) e quelle per il residuo effettivo.
// Sul DB E2E CI (non migrato) `sconto` non esiste → 42703: si ritenta senza (residuoEffettivo
// tratta sconto assente come 0). Stesso pattern di /api/pagamenti.
const PAG_SELECT_BASE = 'id, scuola_id, stato, alunno_id, descrizione, importo, importo_pagato, scadenza'
const PAG_SELECT_V2 = 'id, scuola_id, stato, alunno_id, descrizione, importo, importo_pagato, sconto, scadenza'

// PATCH /api/pagamenti/riconciliazione/[id] — conferma/ignora/riapri (staff).
// La CONFERMA crea l'incasso (metodo bonifico, data = data operazione): lo
// stato del pagamento lo ricalcola il trigger. Mai conferme automatiche.
export const PATCH = withRoute('pagamenti/riconciliazione/[id]:PATCH', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { azione } = b.data

    const supabase = await createAdminClient()
    const { data: movRaw } = await supabase
      .from('riconciliazione_movimenti')
      .select('id, scuola_id, importo, data_operazione, causale, stato, suggerimenti, pagamento_id')
      .eq('id', id)
      .maybeSingle()
    if (!movRaw) return NextResponse.json({ error: 'Movimento non trovato' }, { status: 404 })
    const mov = movRaw as unknown as Movimento

    // I movimenti sono GLOBALI (scuola_id può essere null finché non confermati): niente gate di
    // sede in cima. ignora/riapri restano azioni staff sulla coda globale. Il vincolo di scrittura
    // (registrare solo sulla PROPRIA sede) vale sul PAGAMENTO, nella conferma.

    if (azione === 'ignora') {
      if (mov.stato === 'confermato') {
        return NextResponse.json({ error: 'Movimento già confermato: stornare prima l’incasso' }, { status: 409 })
      }
      // PostgREST non lancia: l'esito dell'UPDATE va letto. `.select('id')` conferma quante righe
      // sono state toccate: `error` → 500 (non un finto success); 0 righe → 404 (già lavorato/sparito).
      const { data: upd, error } = await supabase
        .from('riconciliazione_movimenti')
        .update({ stato: 'ignorato' })
        .eq('id', id)
        .select('id')
      if (error) {
        logErrore({ operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'ignora_update_fallita', stato: 500 }, error)
        return NextResponse.json({ error: 'Errore nell’aggiornamento del movimento' }, { status: 500 })
      }
      if (!upd?.length) return NextResponse.json({ error: 'Movimento non trovato' }, { status: 404 })
      return NextResponse.json({ success: true })
    }

    if (azione === 'riapri') {
      if (mov.stato === 'confermato') {
        return NextResponse.json({ error: 'Movimento già confermato: stornare prima l’incasso' }, { status: 409 })
      }
      const { data: upd, error } = await supabase
        .from('riconciliazione_movimenti')
        .update({ stato: 'da_abbinare' })
        .eq('id', id)
        .select('id')
      if (error) {
        logErrore({ operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'riapri_update_fallita', stato: 500 }, error)
        return NextResponse.json({ error: 'Errore nell’aggiornamento del movimento' }, { status: 500 })
      }
      if (!upd?.length) return NextResponse.json({ error: 'Movimento non trovato' }, { status: 404 })
      return NextResponse.json({ success: true })
    }

    // conferma
    if (mov.stato === 'confermato') {
      return NextResponse.json({ error: 'Movimento già confermato' }, { status: 409 })
    }
    const pagamentoId = b.data.pagamento_id ?? mov.suggerimenti?.[0]?.pagamento_id
    if (!pagamentoId) {
      return NextResponse.json({ error: 'Indica il pagamento da abbinare' }, { status: 400 })
    }

    // ── 🔴 UN BONIFICO NON SI FATTURA DUE VOLTE ──────────────────────────────
    // La fattura si emette per `pagamento_id`, e la guardia contro il secondo
    // documento (`emettiFatturaPagamento`) confronta le righe vive di
    // `fatture_emesse` DELLO STESSO pagamento. Non vede niente, quindi, quando è
    // il BONIFICO a cambiare pagamento sotto di lei: il movimento che aveva
    // saldato la retta P1 — già fatturata — viene riabbinato a P2, e P2 nasce
    // libero da fatture. Restano in circolazione un documento fiscale senza
    // l'incasso che lo giustifica e un avviso «Pagamento registrato» al genitore,
    // entrambi con un 200 sopra e nessuna riga d'errore da nessuna parte.
    //
    // ⚠️ È UNA GUARDIA DIFENSIVA, e vale la pena scrivere perché.
    // Oggi quello stato dall'interfaccia NON è raggiungibile: `pagamento_id` lo
    // scrive solo la conferma qui sotto, e un movimento confermato non torna
    // indietro (`ignora` e `riapri` rispondono 409 poche righe più su, lo storno
    // dell'incasso non tocca questa tabella). Ma «non raggiungibile oggi» non è
    // una difesa: basta una riapertura fatta a mano dopo uno storno — che è la
    // cosa naturale da chiedere, e prima o poi qualcuno la chiederà — perché la
    // strada si apra, e si aprirebbe in silenzio. Costa una lettura, e solo
    // quando il pagamento cambia davvero.
    //
    // Sta QUI, prima di ogni altra lettura e di ogni scrittura, per una ragione
    // sola: finché una guardia sta in fondo, tutto ciò che le sta davanti ha già
    // letto, scritto o notificato quando lei dice di no.
    if (mov.pagamento_id != null && mov.pagamento_id !== pagamentoId) {
      const { data: righeFattura, error: errFatture } = await supabase
        .from('fatture_emesse')
        .select('numero, anno, sezionale, sdi_stato')
        .eq('pagamento_id', mov.pagamento_id)
      // PostgREST non lancia: ritorna `{ error }`. Con l'errore scartato, `data`
      // vale null, «nessuna fattura» e «non l'abbiamo potuta leggere» diventano
      // la stessa cosa, e un guasto di lettura si trasforma in un secondo
      // incasso. Fail-closed, come l'idempotenza del motore: se non è
      // VERIFICABILE, non si riabbina.
      if (errFatture) {
        logErrore(
          { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'fatture_del_movimento_non_lette', stato: 503 },
          errFatture,
        )
        return NextResponse.json(
          {
            error:
              'Non è stato possibile verificare se questo bonifico sia già stato fatturato: il ' +
              'riabbinamento è stato fermato per non rischiare un secondo documento. Riprova fra qualche minuto.',
            codice: 'BONIFICO_FATTURA_NON_VERIFICABILE',
          },
          { status: 503 },
        )
      }
      const righe = (righeFattura ?? []) as {
        numero: number
        /** L'anno del SEZIONALE di quella riga, che non è per forza quello di oggi. */
        anno: number | null
        sezionale: string | null
        sdi_stato: number | null
      }[]
      // Le righe VIVE: tutto ciò che non è uno scarto SDI (2/4/9). È lo stesso
      // predicato di `emissione.ts`, e per lo stesso motivo: una riga scartata si
      // riemette — chiuderle la strada renderebbe uno scarto definitivo — mentre
      // una riga senza stato (rifiuto di trasporto) resta viva, perché nessuno sa
      // se quel documento sia partito.
      const viva = righe.find((r) => !(r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto))
      if (viva) {
        const annoViva = viva.anno ?? new Date().getFullYear()
        const numeroFattura = viva.sezionale
          ? `${viva.sezionale} ${viva.numero}/${annoViva}`
          : `${viva.numero}/${annoViva}`
        // `esito` è in lista bianca e resta in chiaro: «quante volte si è tentato
        // di spostare un bonifico già fatturato» diventa una query. Numeri e
        // uuid, niente altro: la causale del bonifico porta i nomi delle famiglie.
        logEvento('pagamento', 'warn', {
          operazione: 'pagamenti/riconciliazione/[id]:PATCH',
          esito: 'bonifico-gia-fatturato-fermato',
          pagamento_id: mov.pagamento_id,
          numero: viva.numero,
          anno: annoViva,
        })
        // La prosa dice il FATTO col numero — che il catalogo non può conoscere,
        // ed è l'unica cosa che dica quale documento andare a guardare; la
        // conseguenza e il rimedio stanno nella frase tradotta
        // (`BONIFICO_GIA_FATTURATO` è in `CODICI_CON_DETTAGLIO`, quindi a schermo
        // si leggono tutte e due).
        return NextResponse.json(
          {
            error: `Fattura viva sulla voce attualmente abbinata: ${numeroFattura}.`,
            codice: 'BONIFICO_GIA_FATTURATO',
          },
          { status: 409 },
        )
      }
    }

    // Vincolo di SCRITTURA: una segreteria registra un incasso solo sulla PROPRIA sede.
    const sediAttive = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)

    let { data: pag, error: errPag } = await supabase
      .from('pagamenti')
      .select(PAG_SELECT_V2)
      .eq('id', pagamentoId)
      .maybeSingle()
    if (errPag?.code === '42703') {
      // DB E2E CI non migrato: colonna `sconto` assente → ritenta senza.
      ;({ data: pag, error: errPag } = await supabase
        .from('pagamenti')
        .select(PAG_SELECT_BASE)
        .eq('id', pagamentoId)
        .maybeSingle())
    }
    if (!pag || !sediAttive.includes((pag as { scuola_id: string }).scuola_id)) {
      return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    }
    const pagDett = pag as {
      scuola_id: string; alunno_id: string | null; descrizione: string | null; stato: string
      importo: number | string; importo_pagato?: number | string | null
      sconto?: number | string | null; scadenza?: string | null
    }

    // GUARD unificato sul residuo: si evita OGNI sovra-incasso (importo_pagato che sfonda importo).
    //  • residuo ≤ 0 → voce già saldata (es. incasso a mano): niente secondo incasso.
    //  • bonifico > residuo → registrare l'INTERO bonifico come incasso su questa voce sfonderebbe
    //    l'importo, senza 409 e con notifica «Pagamento registrato» al genitore. Si blocca e si
    //    rimanda all'«Incasso unico», che gestisce l'eccedenza come credito.
    const residuo = Math.round(residuoEffettivo(pagDett) * 100) / 100
    if (residuo <= 0) {
      return NextResponse.json(
        { error: 'Pagamento già saldato: ignora la riga o scegli un\'altra voce' },
        { status: 409 },
      )
    }
    if (Number(mov.importo) > residuo) {
      return NextResponse.json(
        { error: `L'importo del bonifico (${formatEuro(mov.importo)}) supera il residuo (${formatEuro(residuo)}): usa «Incasso unico» per gestire l'eccedenza/credito` },
        { status: 409 },
      )
    }

    const { data: incasso, error: errInc } = await supabase
      .from('incassi')
      .insert({
        pagamento_id: pagamentoId,
        importo: mov.importo,
        data_incasso: mov.data_operazione,
        metodo: 'bonifico',
        note: `Riconciliazione: ${(mov.causale ?? '').slice(0, 160)}`.trim(),
        registrato_da: auth.user.id,
      })
      .select()
      .single()
    if (errInc) {
      return NextResponse.json({ error: 'Errore nella registrazione dell’incasso', details: errInc.message }, { status: 500 })
    }

    // CAS ottimistico: conferma solo se il movimento è ancora nello stato letto.
    // Due conferme concorrenti creerebbero due incassi per lo stesso bonifico
    // (#12): se la corsa è persa, storna l'incasso appena inserito.
    const { data: updated, error: errUpd } = await supabase
      .from('riconciliazione_movimenti')
      .update({
        stato: 'confermato',
        pagamento_id: pagamentoId,
        incasso_id: (incasso as { id: string }).id,
        // Il movimento (finora globale/senza sede) assume la sede del pagamento confermato.
        scuola_id: pagDett.scuola_id,
        confermato_da: auth.user.id,
        confermato_il: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('stato', mov.stato)
      .select('id')
    if (errUpd || !updated || updated.length === 0) {
      await supabase.from('incassi').delete().eq('id', (incasso as { id: string }).id)
      return NextResponse.json({ error: 'Movimento già riconciliato da un altro operatore' }, { status: 409 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'riconciliazione_movimenti',
      entitaId: id,
      azione: 'update',
      scuolaId: pagDett.scuola_id,
      valoreDopo: { stato: 'confermato', pagamento_id: pagamentoId, importo: mov.importo },
    })

    // Abbinare un bonifico dall'estratto conto È registrare un pagamento: il
    // genitore va avvisato come per un incasso a mano (finora era l'unica strada
    // che creava un incasso in silenzio) e un bonifico che salda lo scaduto deve
    // poter revocare la sospensione. Best-effort: lo stato l'ha già ricalcolato
    // il trigger; se l'avviso non parte, la conferma resta valida (si logga).
    try {
      if (pagDett.alunno_id) {
        const { data: aggiornato } = await supabase
          .from('pagamenti')
          .select('stato')
          .eq('id', pagamentoId)
          .maybeSingle()
        const saldato = (aggiornato as { stato?: string } | null)?.stato === 'pagato'
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: pagDett.scuola_id,
          alunnoIds: [pagDett.alunno_id],
          titolo: saldato ? 'Pagamento registrato' : 'Acconto registrato',
          corpo: `${pagDett.descrizione ?? 'Pagamento'}: registrato un bonifico di ${formatEuro(mov.importo)}.${saldato ? ' La ricevuta è disponibile.' : ''}`,
          link: '/parent/pagamenti',
          entitaTipo: 'pagamento',
          entitaId: pagamentoId,
          debounce: true,
        })
        await verificaRevocaSospensioneMorosita(supabase, [pagDett.alunno_id])
      }
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/riconciliazione/[id]:PATCH', esito: 'avviso_o_revoca_non_eseguiti' }, e)
    }

    return NextResponse.json({ success: true, data: { incasso_id: (incasso as { id: string }).id } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
