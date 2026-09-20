import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive, assertPagamentoInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { formatEuro } from '@/lib/format/valuta'
// ─── LE DUE OPERAZIONI CONTABILI NON VIVONO PIÙ DENTRO QUESTA ROTTA ─────────
// Abbinare un bonifico a una voce e scioglierne l'abbinamento sono due gesti che
// stanno per avere più di una porta: l'import dell'estratto conto confermerà da
// sé i bonifici che riconosce, e un endpoint nuovo li riaprirà in blocco. Nessuna
// delle due ha una `Request`, un operatore o un corpo JSON — ma tutte e due
// devono passare dalle stesse identiche guardie, che quindi non possono stare
// dentro un handler HTTP. Ricopiarle è il modo certo di farle divergere: in
// questo repository quando un predicato è scritto in linea in due punti, la
// correzione è una funzione esportata, non due modifiche gemelle.
// Qui restano le sole cose che sono DAVVERO della rotta: il gate di ruolo, la
// validazione, la risoluzione delle sedi, il gate di sede, e — dopo — l'audit,
// l'avviso alla famiglia e la revoca della sospensione, che sono del chiamante
// perché solo lui sa se sta rispondendo a una persona.
import { confermaSuVoceSingola } from '@/lib/pagamenti/riconciliazione-conferma'
// `COLONNA_ASSENTE` arriva da lì e non è una svista: nella rotta era UNA costante
// sola, letta dalla lettura del movimento e dallo storno. Riscriverla qui farebbe
// due dichiarazioni gemelle, cioè la cosa che questa estrazione toglie di mezzo.
import { riapriMovimento, COLONNA_ASSENTE } from '@/lib/pagamenti/riapertura-movimento'

const patchBodySchema = z.object({
  azione: z.enum(['conferma', 'ignora', 'riapri']),
  pagamento_id: zUuid.optional(),
})

/**
 * Le colonne del movimento. Due varianti per la stessa ragione di `PAG_SELECT_*`
 * dentro `@/lib/pagamenti/riconciliazione-conferma`: `transazione_id` nasce con
 * la conciliazione composita e sul DB E2E della CI non c'è → `42703`. Chiederla
 * in una SELECT che serve anche alla conferma farebbe cadere l'intera rotta su
 * quell'ambiente.
 */
const MOV_SELECT_BASE =
  'id, scuola_id, importo, data_operazione, causale, stato, suggerimenti, pagamento_id, incasso_id'
const MOV_SELECT_TX = `${MOV_SELECT_BASE}, transazione_id`

interface Movimento {
  id: string
  // I movimenti sono ora GLOBALI: nasce senza sede (null) e assume quella del pagamento alla conferma.
  scuola_id: string | null
  importo: number
  data_operazione: string
  causale: string | null
  stato: string
  /**
   * Il pagamento a cui questo bonifico è già abbinato: lo scrive solo la conferma.
   *
   * ⚠️ Valorizzato NON vuol più dire «riga confermata», e la guardia del
   * riabbinamento vive proprio di questa differenza: dal 2026-09-12
   * `annulla_transazione_contabile` riapre il movimento della transazione
   * annullata (`stato` → `da_abbinare`) e gli LASCIA questa colonna — è la memoria
   * di ciò a cui era legato, e senza di essa `mov.pagamento_id != null` non
   * scatterebbe mai.
   */
  pagamento_id: string | null
  /** L'incasso creato dalla conferma: è la riga che la riapertura deve stornare. */
  incasso_id?: string | null
  /**
   * La transazione composita che questo bonifico ha saldato (conciliazione
   * composita), quando ne ha saldata una.
   *
   * `undefined` NON è `null`, e la differenza decide un ramo: `null` significa
   * «abbinamento a voce singola», `undefined` significa «la colonna non esiste su
   * questo database» — e in quel caso la riapertura non deve nemmeno provare a
   * scriverla, o l'UPDATE esce con `PGRST204`.
   */
  transazione_id?: string | null
  suggerimenti?: { pagamento_id: string }[] | null
}

/**
 * ─── IL GATE DI SEDE SULLA TRANSAZIONE CHE SI STA PER ANNULLARE ──────────────
 *
 * ⚠️ ESISTE PERCHÉ `annulla_transazione_contabile` GIRA A SERVICE-ROLE: è
 * `SECURITY DEFINER`, nessun filtro le arriva addosso, e storna incassi, ricariche
 * mensa e credito di famiglia in una transazione sola. Senza questa lettura una
 * segreteria di Cesa potrebbe annullare la transazione di Giugliano passando
 * l'uuid di un movimento — e uno storno non è una lettura, è un movimento
 * contabile definitivo su denaro di un'altra sede.
 *
 * È la stessa forma del pre-check di `pagamenti/transazioni/[id]/annulla:POST`,
 * ed è voluto che siano uguali: là la sede si verifica sulla TRANSAZIONE (non sul
 * movimento) perché è la transazione l'oggetto dell'annullo — e la sua sede può
 * legittimamente essere diversa da quella della voce àncora, visto che un bonifico
 * può pagare figli di plessi diversi con un documento solo.
 *
 * 404 e non 403 su una sede altrui: chi non può vederla non deve nemmeno sapere
 * che esiste. Stessa scelta della route dell'annullo.
 *
 * ⚠️ E STA QUI, NELL'HANDLER, mentre lo storno e la riapertura sono andati in
 * `@/lib/pagamenti/riapertura-movimento`: il perimetro di sede è ciò che
 * distingue questa porta da quelle che verranno, e un gate di sede si legge dove
 * la richiesta arriva. Al modulo va il VERDETTO, non la domanda.
 */
async function assertTransazioneInScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  transazioneId: string,
  sediAttive: string[],
): Promise<{ response: NextResponse } | { annullataIl: string | null }> {
  const { data: trx, error } = await supabase
    .from('pagamenti_transazioni')
    .select('id, scuola_id, annullata_il')
    .eq('id', transazioneId)
    .maybeSingle()
  if (error) {
    // PostgREST non lancia: con l'errore scartato «non l'ho potuta leggere»
    // diventerebbe «non esiste», e un gate che non ha letto niente non è un gate.
    logErrore(
      { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'transazione_non_letta', stato: 503 },
      error,
    )
    return {
      response: NextResponse.json(
        {
          error:
            'Non è stato possibile verificare la sede di questo bonifico composito: la riapertura è ' +
            'stata fermata. Riprova fra qualche minuto.',
          // ⚠️ NON `MOVIMENTO_NON_LETTO`, e fino al 2026-09-13 lo era: quel codice è
          // documentato 500 (ed è 500 dov'è usato davvero) mentre questa risposta è
          // 503, e la sua frase di catalogo parla di «questa riga dell'estratto
          // conto» — mentre qui la cosa che non si è potuta leggere è la
          // TRANSAZIONE. Stato sbagliato e soggetto sbagliato insieme: l'operatrice
          // andava a guardare l'oggetto che non c'entra.
          codice: 'RIAPERTURA_SEDE_NON_VERIFICATA',
        },
        { status: 503 },
      ),
    }
  }
  const riga = trx as { scuola_id?: string | null; annullata_il?: string | null } | null
  if (!riga || !sediAttive.includes(String(riga.scuola_id))) {
    // 404 e non 403: chi non può vedere quella sede non deve nemmeno sapere che il
    // bonifico esiste. Il codice è quello della riga bancaria che «non c'è», ed è
    // coerente con la scelta di non rivelarla.
    return {
      response: NextResponse.json(
        { error: 'Movimento non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' },
        { status: 404 },
      ),
    }
  }
  return { annullataIl: riga.annullata_il ?? null }
}

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
    // ── LA LETTURA DEL MOVIMENTO, E PERCHÉ ORA GUARDA L'ERRORE ───────────────
    // PostgREST non lancia: ritorna `{ error }`. Fino a oggi l'errore era scartato
    // dalla destrutturazione, e QUALUNQUE guasto di lettura — permesso negato,
    // rete, colonna assente — usciva come «Movimento non trovato», 404: un
    // messaggio che manda a cercare una riga che invece esiste. Adesso l'errore si
    // legge, e serve anche a un secondo scopo: `transazione_id` non esiste sul DB
    // E2E della CI, e senza il ritentativo qui sotto l'intera rotta — conferma
    // compresa — cadrebbe su quell'ambiente.
    let movRaw: unknown = null
    /** `true` se il database HA la colonna: decide se la riapertura può scriverla. */
    let colonnaTransazione = true
    const letturaTx = await supabase
      .from('riconciliazione_movimenti')
      .select(MOV_SELECT_TX)
      .eq('id', id)
      .maybeSingle()
    if (letturaTx.error && COLONNA_ASSENTE.has((letturaTx.error as { code?: string }).code ?? '')) {
      colonnaTransazione = false
      const letturaBase = await supabase
        .from('riconciliazione_movimenti')
        .select(MOV_SELECT_BASE)
        .eq('id', id)
        .maybeSingle()
      if (letturaBase.error) {
        logErrore(
          { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'movimento_non_letto', stato: 500 },
          letturaBase.error,
        )
        return NextResponse.json(
          { error: 'Errore nel recupero del movimento', codice: 'MOVIMENTO_NON_LETTO' },
          { status: 500 },
        )
      }
      movRaw = letturaBase.data
    } else if (letturaTx.error) {
      logErrore(
        { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'movimento_non_letto', stato: 500 },
        letturaTx.error,
      )
      return NextResponse.json(
        { error: 'Errore nel recupero del movimento', codice: 'MOVIMENTO_NON_LETTO' },
        { status: 500 },
      )
    } else {
      movRaw = letturaTx.data
    }
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
      // ── RIAPRIRE UN CONFERMATO: LO STORNO LO FA LA ROUTE ──────────────────
      //
      // Fino al 2026-09-13 qui c'era un 409 «stornare prima l'incasso», cioè
      // l'invito a cercare a mano, nel registro incassi, la riga che quel bonifico
      // aveva creato — e a farlo senza che niente tenesse insieme le due
      // operazioni: chi stornava e non riapriva lasciava una riga verde sopra un
      // incasso che non c'era più (è lo stesso difetto che la migrazione
      // `20260912180200` chiude dal lato della transazione). Adesso le due metà
      // stanno nella stessa richiesta.
      if (mov.stato === 'confermato') {
        // ── 0. IL GATE DI SEDE, PRIMA DI OGNI LETTURA E DI OGNI SCRITTURA ────
        // Riaprire un confermato è uno STORNO, cioè un movimento contabile
        // definitivo: non è più «un'azione staff sulla coda globale» come `ignora`
        // e come la riapertura di un `ignorato`. Chi storna deve poterlo fare su
        // quella sede.
        const sediRiapertura = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
        /**
         * La transazione è GIÀ annullata: gli storni ci sono, manca solo la
         * riapertura. Si salta la RPC e si va dritti alla riapertura.
         *
         * ⚠️ QUI C'ERA UN 409, ed era il difetto che questa fetta esiste per
         * chiudere, ricreato in un percorso d'errore. Misurato su due giri
         * consecutivi: primo giro corsa persa sull'UPDATE → 409; secondo giro →
         * **409 di nuovo**, zero UPDATE sul movimento. Il gate leggeva
         * `annullata_il` — ormai valorizzato dalla RPC del primo giro — e rifiutava
         * PRIMA di poter riaprire. Restava una riga `confermato` sopra incassi
         * stornati e transazione annullata, e non era riparabile nemmeno
         * dall'interfaccia: anche «annulla transazione» risponde 409 su una
         * transazione già annullata. Il ramo a voce singola era invece idempotente
         * da subito (404/409 di `eseguiStornoIncasso` → si prosegue): la
         * dichiarazione «ritentativo idempotente» valeva per metà.
         *
         * Non serve una condizione su `mov.stato`: si è dentro il ramo
         * `mov.stato === 'confermato'`, e una riga confermata con la transazione
         * già annullata è per definizione una riga che mente.
         */
        let transazioneGiaAnnullata = false
        if (mov.transazione_id) {
          const scopeTx = await assertTransazioneInScope(supabase, mov.transazione_id, sediRiapertura)
          if ('response' in scopeTx) return scopeTx.response
          transazioneGiaAnnullata = scopeTx.annullataIl != null
        } else if (mov.pagamento_id) {
          // Voce singola: la sede è quella del PAGAMENTO su cui l'incasso è stato
          // registrato. Stesso gate di `pagamenti/incassi/storno:POST`.
          const fuoriScope = await assertPagamentoInScope(supabase, auth.user, mov.pagamento_id)
          if (fuoriScope) return fuoriScope
        } else if (mov.scuola_id && !sediRiapertura.includes(mov.scuola_id)) {
          return NextResponse.json(
            { error: 'Movimento non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' },
            { status: 404 },
          )
        }

        // ── LO STORNO E LA RIAPERTURA ─────────────────────────────────────────
        // L'avviso sulle fatture vive, lo storno idempotente, la mappa degli
        // errori della RPC e il compare-and-swap stanno in
        // `@/lib/pagamenti/riapertura-movimento`, perché la riapertura in blocco
        // che arriverà dovrà passare di lì e non di qui.
        const esito = await riapriMovimento(supabase, {
          movimento: mov,
          transazioneGiaAnnullata,
          colonnaTransazione,
          attoreId: auth.user.id,
          operazione: 'pagamenti/riconciliazione/[id]:PATCH',
        })
        if (esito.ok) {
          // Chi ha riaperto: la riapertura cancella `confermato_da`/`confermato_il`,
          // quindi senza questa riga «chi aveva confermato quel bonifico» si perde e
          // nessuno sa nemmeno chi l'abbia disfatto.
          await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'riconciliazione_movimenti',
            entitaId: id,
            azione: 'update',
            scuolaId: mov.scuola_id ?? undefined,
            valoreDopo: {
              stato: 'da_abbinare',
              transazione_annullata: esito.ok.transazioneAnnullata,
              incassi_stornati: esito.ok.incassiStornati,
            },
          })

          // Evento critico → il SUCCESSO si logga (AGENTS.md §5): con i soli errori,
          // «nessun log» non distinguerebbe «tutto ok» da «non è mai partito niente».
          // Solo uuid, numeri e booleani: la causale di un bonifico porta i nomi delle
          // famiglie, e `redact` è a lista bianca.
          logEvento('pagamento', 'info', {
            operazione: 'pagamenti/riconciliazione/[id]:PATCH',
            esito: 'movimento-riaperto',
            movimento_id: id,
            pagamento_id: mov.pagamento_id,
            transazione_annullata: esito.ok.transazioneAnnullata,
            incassi_stornati: esito.ok.incassiStornati,
            fatture_vive: esito.ok.fattureVive,
          })
        }
        return NextResponse.json(esito.body, { status: esito.status })
      }

      // Il caso di sempre: un movimento IGNORATO torna in coda. Nessuno storno,
      // perché non c'è mai stato un incasso.
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

    // Vincolo di SCRITTURA: una segreteria registra un incasso solo sulla PROPRIA sede.
    //
    // ⚠️ Si risolve QUI e si passa al modulo come `sediAmmesse`, invece di
    // lasciarglielo risolvere: il percorso manuale registra sulle sedi
    // dell'operatore, quello automatico che arriverà su un perimetro che dovrà
    // dichiarare: un modulo che se lo risolvesse da sé sceglierebbe per tutt'e
    // due, e la differenza diventerebbe accidentale invece che scritta.
    const sediAttive = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)

    // Le guardie della conferma — «un bonifico non si fattura due volte», il gate
    // di sede sul pagamento, il residuo, l'incasso e il compare-and-swap con il
    // rollback — stanno in `@/lib/pagamenti/riconciliazione-conferma`: sono le
    // stesse che dovrà attraversare l'import quando confermerà da sé.
    const esito = await confermaSuVoceSingola(supabase, {
      movimento: mov,
      pagamentoId,
      sediAmmesse: sediAttive,
      attoreId: auth.user.id,
      operazione: 'pagamenti/riconciliazione/[id]:PATCH',
    })
    if (!esito.ok) return NextResponse.json(esito.body, { status: esito.status })
    const pagDett = esito.ok.pagamento

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'riconciliazione_movimenti',
      entitaId: id,
      azione: 'update',
      scuolaId: pagDett.scuolaId,
      valoreDopo: { stato: 'confermato', pagamento_id: pagamentoId, importo: mov.importo },
    })

    // Abbinare un bonifico dall'estratto conto È registrare un pagamento: il
    // genitore va avvisato come per un incasso a mano (finora era l'unica strada
    // che creava un incasso in silenzio) e un bonifico che salda lo scaduto deve
    // poter revocare la sospensione. Best-effort: lo stato l'ha già ricalcolato
    // il trigger; se l'avviso non parte, la conferma resta valida (si logga).
    try {
      if (pagDett.alunnoId) {
        const { data: aggiornato } = await supabase
          .from('pagamenti')
          .select('stato')
          .eq('id', pagamentoId)
          .maybeSingle()
        const saldato = (aggiornato as { stato?: string } | null)?.stato === 'pagato'
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: pagDett.scuolaId,
          alunnoIds: [pagDett.alunnoId],
          titolo: saldato ? 'Pagamento registrato' : 'Acconto registrato',
          corpo: `${pagDett.descrizione ?? 'Pagamento'}: registrato un bonifico di ${formatEuro(mov.importo)}.`,
          link: '/parent/pagamenti',
          entitaTipo: 'pagamento',
          entitaId: pagamentoId,
          debounce: true,
        })
        await verificaRevocaSospensioneMorosita(supabase, [pagDett.alunnoId])
      }
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/riconciliazione/[id]:PATCH', esito: 'avviso_o_revoca_non_eseguiti' }, e)
    }

    return NextResponse.json(esito.body, { status: esito.status })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
