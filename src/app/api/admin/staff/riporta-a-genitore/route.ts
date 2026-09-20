import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertUtenteInScope, scuoleDiUtente } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { puoEliminareStaff } from '@/lib/personale/permessi-eliminazione'
import { cancellaFascicoloPersonale } from '@/lib/personale/cancella-fascicolo'

/**
 * RIPORTA A GENITORE — toglie la veste da insegnante a chi non lo è mai stato.
 *
 * ─── IL CASO CHE LA FA NASCERE ────────────────────────────────────────────────
 *
 * Il modulo pubblico `/anagrafica-personale` è anonimo per scelta: chi lo
 * compila si dichiara insegnante da sé. Se la segreteria approva, in tre secondi
 * nascono un account `educator` e un fascicolo del personale con codice fiscale,
 * residenza e due scansioni del documento d'identità. Quando la persona era in
 * realtà un genitore, non esisteva nessun modo di tornare indietro.
 *
 * ─── PERCHÉ NON PASSA DA `PATCH /api/admin/staff` ─────────────────────────────
 *
 * Perché `RUOLI_ASSEGNABILI` esclude `genitore` DI PROPOSITO
 * (`src/lib/auth/ruoli.ts`, righe 2-4) e quell'elenco alimenta anche le due
 * `<select>` del pannello: allargarlo metterebbe «Genitore» in una tendina
 * accanto a «Docente», cioè a un clic di distanza da un salvataggio qualunque.
 *
 * ⚠️ `'genitore'` NON ARRIVA DAL CORPO: è cablato qui dentro. Il corpo dice CHI,
 * non VERSO COSA — così questa rotta ha un solo verso possibile, e lo si legge
 * dal nome. È la forma speculare di `admin/staff/collega-profilo-esistente`,
 * che fa il percorso opposto.
 *
 * ─── L'ORDINE, E IL VERSO IN CUI È LECITO SBAGLIARE ───────────────────────────
 *
 * Non c'è transazione fra `utenti`, lo Storage e la RPC. Dei due guasti a metà
 * possibili si sceglie il reversibile:
 *   · fermarsi DOPO il ruolo e PRIMA del fascicolo lascia una genitrice con una
 *     scheda del personale: compare nelle scadenze documenti con un ruolo che
 *     non è staff, si vede, e si ri-cancella con lo stesso comando;
 *   · fermarsi DOPO il fascicolo e PRIMA del ruolo lascerebbe una docente in
 *     servizio senza fascicolo: continua a vedere i bambini, e la segreteria ha
 *     perso codice fiscale e documento. Invisibile e irreversibile.
 */

const OPERAZIONE = 'admin/staff/riporta-a-genitore:POST'

/** Cablato: non arriva mai dal corpo. */
const RUOLO_GENITORE = 'genitore'

const postBodySchema = z.object({
  utenteId: zUuid,
  conferma: z.literal(true, { error: 'Conferma mancante' }),
})

export const POST = withRoute('admin/staff/riporta-a-genitore:POST', async (request: NextRequest) => {
  // Gate PRIMA della lettura del corpo (lock `corpo-letto-dopo-il-gate`).
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { utenteId } = b.data

  try {
    const supabase = await createAdminClient()
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, utenteId)
    if (fuoriScope) return fuoriScope

    // 1. LETTURE. Qualunque lettura fallita ⇒ 503, e niente è stato toccato.
    const { data: bersaglio, error: errBersaglio } = await supabase
      .from('utenti')
      .select('id, ruolo, role, scuola_id, gradi')
      .eq('id', utenteId)
      .maybeSingle()
    if (errBersaglio) {
      logErrore({ operazione: OPERAZIONE, evento: 'lettura_bersaglio' }, errBersaglio)
      return risposta503()
    }
    const riga = bersaglio as { ruolo?: string | null; role?: string | null; scuola_id?: string | null } | null
    const ruoloGrezzo = riga?.ruolo ?? riga?.role ?? null

    const permesso = puoEliminareStaff(auth.user, utenteId, ruoloGrezzo)
    if (!permesso.consentito) {
      logEvento('auth', 'warn', {
        operazione: OPERAZIONE,
        esito: 'declassamento-negato',
        tipo: permesso.motivo,
        ruolo: auth.user.role,
      })
      return rifiuto(permesso.motivo)
    }

    if (ruoloGrezzo === RUOLO_GENITORE) {
      return NextResponse.json(
        { error: 'Questa persona è già un genitore', codice: 'RIPORTA_GENITORE_GIA_GENITORE' },
        { status: 409 },
      )
    }

    // 2. IL PONTE. Se manca, si RIFIUTA: non si crea.
    //
    // ⚠️ Creare qui la riga `parents` vorrebbe dire fabbricare una scheda
    // anagrafica di genitore — nome, codice fiscale, recapiti — copiandola dal
    // fascicolo del personale che questa stessa operazione sta per cancellare.
    // E un genitore senza figli collegati non è un genitore: è un account che
    // atterra su una schermata vuota. Il posto dove si crea quel legame è la
    // scheda dell'alunno, e il messaggio ci manda.
    const { data: ponte, error: errPonte } = await supabase
      .from('parents')
      .select('id')
      .eq('auth_user_id', utenteId)
      .maybeSingle()
    if (errPonte) {
      logErrore({ operazione: OPERAZIONE, evento: 'lettura_ponte' }, errPonte)
      return risposta503()
    }
    if (!ponte) {
      return NextResponse.json(
        {
          error: 'Questa persona non è collegata a nessun bambino come genitore',
          codice: 'RIPORTA_GENITORE_SENZA_PONTE',
        },
        { status: 409 },
      )
    }

    const plessi = await scuoleDiUtente(supabase, auth.user)

    // 3. LO SGANCIO DEL POTERE, nell'ordine in cui ciascuno apre una porta.
    //    `utenti_sezioni` per prima: decide QUALI BAMBINI VEDE, e
    //    `sezioniVisibili` non guarda il ruolo.
    for (const [tabella, colonna] of [
      ['utenti_sezioni', 'utente_id'],
      ['utenti_sezioni_materie', 'utente_id'],
      ['utenti_scuole', 'utente_id'],
    ] as const) {
      const { error } = await supabase.from(tabella).delete().eq(colonna, utenteId)
      if (error) {
        logErrore({ operazione: OPERAZIONE, evento: `sgancio_${tabella}` }, error)
        return risposta503()
      }
    }
    const { error: errOrario } = await supabase
      .from('orario_settimanale')
      .update({ docente_id: null })
      .eq('docente_id', utenteId)
    if (errOrario) {
      logErrore({ operazione: OPERAZIONE, evento: 'sgancio_orario' }, errOrario)
      return risposta503()
    }
    const { error: errTask } = await supabase
      .from('task_interni')
      .update({ assigned_to: null })
      .eq('assigned_to', utenteId)
      .in('scuola_id', plessi)
    if (errTask) {
      logErrore({ operazione: OPERAZIONE, evento: 'sgancio_task' }, errTask)
      return risposta503()
    }

    // 4. IL RUOLO — una sola istruzione, CAS.
    //
    // `.eq('ruolo', ruoloGrezzo)` è il valore LETTO, non quello normalizzato: se
    // qualcuno l'ha cambiato fra la lettura e adesso, zero righe e si dice.
    // `.in('scuola_id', plessi)` mette l'isolamento NELLA stessa istruzione che
    // scrive. `gradi: []` perché è metà del gate di `requireFunzione`: lasciarlo
    // scritto significa che il giorno in cui questa persona tornasse staff si
    // ritroverebbe un perimetro che nessuno le ha ridato.
    //
    // ⚠️ `scuola_id` NON si tocca: è NOT NULL, ed è la sede di ripiego delle sue
    // schermate da genitore. Si resta dove stanno i figli.
    // ⚠️ Mai `role`/`first_name`/`last_name`: sono colonne GENERATE.
    const { data: aggiornate, error: errRuolo } = await supabase
      .from('utenti')
      .update({ ruolo: RUOLO_GENITORE, gradi: [] })
      .eq('id', utenteId)
      .eq('ruolo', ruoloGrezzo)
      .in('scuola_id', plessi)
      .select('id')
    if (errRuolo) {
      logErrore({ operazione: OPERAZIONE, evento: 'cambio_ruolo' }, errRuolo)
      return risposta503()
    }
    if ((aggiornate ?? []).length === 0) {
      return NextResponse.json(
        { error: 'Il ruolo è cambiato nel frattempo: ricarica la scheda', codice: 'RIPORTA_GENITORE_GIA_DECISO' },
        { status: 409 },
      )
    }

    // 5. IL FASCICOLO E LA PRATICA. Da qui in poi un guasto NON annulla il
    //    declassamento — che è già scritto e vale — ma torna al client come
    //    `fascicoloCancellato: false`, e si logga a `error`.
    const fascicolo = await cancellaFascicoloPersonale(supabase, utenteId, OPERAZIONE)
    if (!fascicolo.ok) {
      logEvento('gdpr', 'error', {
        operazione: OPERAZIONE,
        esito: 'fascicolo-non-cancellato',
        entita_id: utenteId,
        tipo: fascicolo.motivo,
      })
    }

    // 6. LA VERIFICA DELLA PROMESSA. Una promessa che nessuno misura smette di
    //    essere vera in silenzio: è il passo 7 di `collega-profilo-esistente`.
    const { data: ponteDopo } = await supabase
      .from('parents')
      .select('id')
      .eq('auth_user_id', utenteId)
      .maybeSingle()
    if (!ponteDopo) {
      logEvento('anagrafica', 'error', {
        operazione: OPERAZIONE,
        esito: 'ponte-genitore-perso-dopo-la-scrittura',
        entita_id: utenteId,
      })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'utente_staff',
      entitaId: utenteId,
      azione: 'update',
      scuolaId: riga?.scuola_id ?? null,
      valorePrima: { ruolo: ruoloGrezzo },
      valoreDopo: {
        ruolo: RUOLO_GENITORE,
        motivo: 'raccolta-errata',
        fascicolo_cancellato: fascicolo.ok,
        n_file_rimossi: fascicolo.ok ? fascicolo.fileRimossi : 0,
      },
    })
    // `warn` e non `info`: un `info` sul canale `anagrafica` non arriva in
    // `app_log`, e questa è la riga a cui si torna fra mesi per «chi ha tolto
    // l'area docente, e quando». Solo uuid, ruoli e conteggi.
    logEvento('anagrafica', 'warn', {
      operazione: OPERAZIONE,
      esito: 'staff-riportato-a-genitore',
      entita_id: utenteId,
      sede_id: riga?.scuola_id ?? null,
      ruolo: ruoloGrezzo,
      fascicolo_cancellato: fascicolo.ok,
    })

    return NextResponse.json({
      success: true,
      data: {
        ruolo: RUOLO_GENITORE,
        fascicoloCancellato: fascicolo.ok,
        praticheCancellate: fascicolo.ok ? fascicolo.praticheCancellate : 0,
        fileRimossi: fascicolo.ok ? fascicolo.fileRimossi : 0,
        ponteIntatto: !!ponteDopo,
      },
    })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’operazione', codice: 'PERSONALE_OPERAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})

function risposta503(): NextResponse {
  return NextResponse.json(
    { error: 'Una delle verifiche non è riuscita: niente è stato modificato', codice: 'STAFF_ELIMINAZIONE_NON_DECISA' },
    { status: 503 },
  )
}

function rifiuto(motivo: string): NextResponse {
  if (motivo === 'se-stessi') {
    return NextResponse.json(
      { error: 'Non puoi cambiare il tuo stesso ruolo', codice: 'STAFF_ELIMINAZIONE_SE_STESSI' },
      { status: 403 },
    )
  }
  if (motivo === 'bersaglio-direzione') {
    return NextResponse.json(
      { error: 'Gli account della Direzione non si declassano da qui', codice: 'STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE' },
      { status: 403 },
    )
  }
  if (motivo === 'bersaglio-sconosciuto') {
    return NextResponse.json(
      { error: 'Non è stato possibile leggere questa persona', codice: 'STAFF_ELIMINAZIONE_NON_LETTA' },
      { status: 503 },
    )
  }
  return NextResponse.json(
    { error: 'Operazione riservata alla Direzione', codice: 'INCARICO_STAFF_RISERVATO' },
    { status: 403 },
  )
}
