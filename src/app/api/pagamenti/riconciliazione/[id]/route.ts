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
import { residuoEffettivo } from '@/lib/pagamenti/aging'
import { formatEuro } from '@/lib/format/valuta'
import { mapStatoAruba } from '@/lib/aruba/stato'
// LO STORNO DI UN INCASSO SINGOLO HA UN POSTO SOLO, ed è quello. `eseguiStornoIncasso`
// crea il contro-incasso NEGATIVO tracciato (`storno_di`), marca l'originale, ricalcola
// lo stato del pagamento e scrive l'audit col motivo: riscriverne una copia qui
// significherebbe avere due idee diverse di che cos'è uno storno, e la seconda nascerebbe
// senza il ramo che degrada quando l'enum `storno` non esiste sul DB non migrato.
import { eseguiStornoIncasso } from '@/app/api/pagamenti/incassi/storno/route'

const patchBodySchema = z.object({
  azione: z.enum(['conferma', 'ignora', 'riapri']),
  pagamento_id: zUuid.optional(),
})

/** La RPC non esiste su questo ambiente (DB E2E della CI, mai migrato). */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
/** La colonna non esiste (DB non migrato): si ritenta senza, non si cade. */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * Il motivo che finisce in `pagamenti_transazioni.annullo_motivo` e in
 * `incassi.storno_motivo` quando la riapertura scioglie un abbinamento.
 *
 * NON si chiede all'operatrice: la riapertura è un pulsante della coda, non un
 * modulo. Ma un motivo la RPC lo pretende (min 3 caratteri) e soprattutto lo
 * pretende chi domani aprirà il registro delle transazioni e troverà un annullo:
 * «annullata» senza un perché manda a cercare un'operazione che nessuno ricorda.
 * Testo fisso e generico: in quelle due colonne non deve finire niente che
 * riguardi una famiglia.
 */
const MOTIVO_RIAPERTURA = 'Riapertura del movimento bancario dal registro di riconciliazione'

/**
 * Le colonne del movimento. Due varianti per la stessa ragione di `PAG_SELECT_*`
 * qui sotto: `transazione_id` nasce con la conciliazione composita e sul DB E2E
 * della CI non c'è → `42703`. Chiederla in una SELECT che serve anche alla
 * conferma farebbe cadere l'intera rotta su quell'ambiente.
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
   * ⚠️ Valorizzato NON vuol più dire «riga confermata», e la guardia qui sotto vive
   * proprio di questa differenza: dal 2026-09-12
   * `annulla_transazione_contabile` riapre il movimento della transazione annullata
   * (`stato` → `da_abbinare`) e gli LASCIA questa colonna — è la memoria di ciò a cui
   * era legato, e senza di essa `mov.pagamento_id != null` non scatterebbe mai.
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
 * Il numero di una fattura come si legge sul documento, a prova di riga storica.
 *
 * NON è `formattaNumeroFattura` di `@/lib/fatturazione/sezionale`, ed è una scelta:
 * quella LANCIA su un sezionale assente o su un anno fuori scala, perché nasce per
 * comporre il numero di un documento che sta per partire. Qui si sta solo NOMINANDO
 * una riga già a registro — magari una storica, senza sezionale — e un'eccezione
 * trasformerebbe un avviso in un 500. Sta qui, in un posto solo, perché la usano i
 * due punti che parlano di fatture in questo file: la guardia del riabbinamento e
 * l'avviso della riapertura. Due copie direbbero due numeri diversi dello stesso
 * documento.
 */
function etichettaFattura(r: { numero: number; anno: number | null; sezionale: string | null }): string {
  const anno = r.anno ?? new Date().getFullYear()
  return r.sezionale ? `${r.sezionale} ${r.numero}/${anno}` : `${r.numero}/${anno}`
}

/** Una riga di `fatture_emesse`, come la leggono i due punti di questo file. */
interface RigaFattura {
  numero: number
  /** L'anno del SEZIONALE di quella riga, che non è per forza quello di oggi. */
  anno: number | null
  sezionale: string | null
  sdi_stato: number | null
}

/**
 * Le righe VIVE: tutto ciò che non è uno scarto SDI (2/4/9). Stesso predicato di
 * `emissione.ts`, e per lo stesso motivo: una riga scartata si riemette — chiuderle
 * la strada renderebbe uno scarto definitivo — mentre una riga senza stato (rifiuto
 * di trasporto) resta viva, perché nessuno sa se quel documento sia partito.
 */
const fatturaViva = (r: RigaFattura): boolean => !(r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto)

/**
 * L'avviso che viaggia SU UNA RISPOSTA 200, accanto a `success: true`.
 *
 * ⚠️ Non è un errore travestito, ed è progettato per essere MOSTRATO. I numeri
 * stanno anche in un campo loro (`numeri`) e non solo dentro la frase, perché chi
 * disegna il pannello possa elencarli senza fare il parsing di una prosa; il
 * `codice` c'è perché la frase di contorno sia traducibile come tutte le altre
 * (`CODICI_ERRORE`), e `messaggio` porta il dettaglio che il catalogo non può
 * conoscere. È la stessa forma di `{ error, codice }`, spostata sul verso del
 * successo.
 */
interface AvvisoRiapertura {
  codice: 'RIAPERTURA_CON_FATTURA_VIVA' | 'RIAPERTURA_FATTURE_NON_VERIFICATE'
  messaggio: string
  /** I numeri dei documenti rimasti vivi. Vuoto quando non si è potuto leggerli. */
  numeri: string[]
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

/**
 * ─── LO STORNO DI QUESTO INCASSO È GIÀ STATO REGISTRATO? ─────────────────────
 *
 * ⚠️ ESISTE PERCHÉ L'IDEMPOTENZA DELLA RIAPERTURA NON PUÒ POGGIARE SU
 * `incassi.stornato_il`. Quella marcatura, dentro `eseguiStornoIncasso`, è un
 * `.then(() => {}, () => {})`: best-effort **muto**, e il motivo per cui è muto è
 * legittimo (sul DB non migrato le colonne S3 non ci sono). Ma la riapertura ne
 * è diventata un chiamante che DIPENDE da quella marcatura: se fallisce in
 * silenzio, l'originale resta «vivo» in ogni campo e il ritentativo lo storna una
 * seconda volta — due contro-incassi sullo stesso denaro, con un 200 sopra.
 *
 * Quella funzione non si riscrive: è di un'altra rotta, e il difetto è
 * preesistente. Ma questo ramo deve reggere lo stesso, e ci riesce guardando la
 * riga che quella funzione scrive DAVVERO, non quella che marca in silenzio: il
 * **contro-incasso** (`storno_di` = l'originale) è la sua scrittura primaria,
 * l'unica il cui errore viene restituito invece che inghiottito. Se c'è, lo
 * storno è avvenuto — che `stornato_il` sia stato scritto o no.
 *
 * Misurato in produzione il 2026-09-13: 4 contro-incassi, **0** originali
 * stornati e non marcati, **0** originali con due storni. Il caso non si è ancora
 * verificato: questa lettura serve perché non si verifichi.
 *
 * Fail-CLOSED su un guasto di lettura (stessa scelta della guardia del
 * riabbinamento poche decine di righe più giù): «non lo so» non è «non c'è», e
 * stornare alla cieca è la strada che porta al doppio contro-incasso. Unica
 * eccezione, il DB non migrato: senza la colonna `storno_di` la domanda non ha
 * nemmeno senso, e un 500 lì trasformerebbe una rete di sicurezza in un guasto.
 */
async function stornoGiaRegistrato(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  incassoId: string,
): Promise<{ response: NextResponse } | { presente: boolean }> {
  const { data, error } = await supabase
    .from('incassi')
    .select('id')
    .eq('storno_di', incassoId)
    .limit(1)
  if (error) {
    const code = (error as { code?: string }).code ?? ''
    if (COLONNA_ASSENTE.has(code)) {
      logEvento('pagamento', 'warn', {
        operazione: 'pagamenti/riconciliazione/[id]:PATCH',
        esito: 'storno-non-verificabile-colonna-assente',
        incasso_id: incassoId,
      })
      return { presente: false }
    }
    // PostgREST non lancia: senza questo controllo l'errore verrebbe scartato dalla
    // destrutturazione e «non l'ho potuto leggere» diventerebbe «non c'è».
    logErrore(
      { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'storno_gia_registrato_non_letto', stato: 500 },
      error,
    )
    return {
      response: NextResponse.json(
        {
          error:
            'Non è stato possibile verificare se l’incasso di questo bonifico fosse già stato stornato: ' +
            'la riapertura è stata fermata per non stornarlo due volte.',
          codice: 'RIAPERTURA_NON_RIUSCITA',
        },
        { status: 500 },
      ),
    }
  }
  return { presente: ((data ?? []) as unknown[]).length > 0 }
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
         * riapertura. Si salta la RPC e si va dritti al punto 3.
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

        // ── 1. L'AVVISO: quali documenti restano vivi ─────────────────────────
        // Si legge PRIMA di scrivere, così l'avviso racconta lo stato su cui
        // l'operatrice decide, e un guasto qui non lascia niente a metà.
        // ⚠️ NON è una guardia: non ferma niente. Decisione esplicita del titolare
        // («riapri comunque, avvisando»), presa davanti alla misura: 167 movimenti
        // confermati su 174, in produzione, hanno una fattura viva sul pagamento
        // abbinato. Un 409 qui avrebbe vietato il 96% delle riaperture.
        let avviso: AvvisoRiapertura | undefined
        let fattureVive = 0
        if (mov.pagamento_id) {
          const { data: righeFattura, error: errFatture } = await supabase
            .from('fatture_emesse')
            .select('numero, anno, sezionale, sdi_stato')
            .eq('pagamento_id', mov.pagamento_id)
          if (errFatture) {
            // PostgREST non lancia. Con l'errore scartato, «nessuna fattura» e «non
            // l'abbiamo potuta leggere» diventerebbero la stessa cosa — e siccome
            // qui non si ferma niente, il silenzio non costerebbe un rifiuto: ne
            // uscirebbe una riapertura che DICHIARA di non aver trovato documenti
            // senza averli cercati.
            logErrore(
              {
                operazione: 'pagamenti/riconciliazione/[id]:PATCH',
                evento: 'fatture_del_movimento_non_lette_riapertura',
                stato: 200,
              },
              errFatture,
            )
            avviso = {
              codice: 'RIAPERTURA_FATTURE_NON_VERIFICATE',
              messaggio:
                'Non è stato possibile leggere le fatture della voce a cui questo bonifico era abbinato.',
              numeri: [],
            }
          } else {
            const numeri = ((righeFattura ?? []) as RigaFattura[]).filter(fatturaViva).map(etichettaFattura)
            fattureVive = numeri.length
            if (numeri.length > 0) {
              avviso = {
                codice: 'RIAPERTURA_CON_FATTURA_VIVA',
                // La prosa dice il FATTO coi numeri — che il catalogo non può
                // conoscere, e sono l'unica cosa che dica quale documento andare a
                // guardare; la conseguenza sta nella frase tradotta.
                messaggio: `Fatture ancora valide sulla voce abbinata: ${numeri.join(', ')}.`,
                numeri,
              }
            }
          }
        }

        // ── 2. LO STORNO ──────────────────────────────────────────────────────
        let incassiStornati = 0
        let transazioneAnnullata = false
        let riapertaDallaRpc = false
        /** Quante righe bancarie sono tornate in coda: 1 di norma, di più se la
         *  transazione era stata saldata da più bonifici. Il numero viaggia fino
         *  alla risposta perché è l'unica cosa che dica all'operatrice quanti
         *  movimenti dovrà rilavorare. */
        let movimentiRiaperti = 1
        if (mov.transazione_id && transazioneGiaAnnullata) {
          // Il RITENTATIVO del ramo composito. Gli storni sono già stati commessi
          // da un giro precedente (o dal pulsante del registro transazioni): la RPC
          // non si richiama — risponderebbe comunque `KV409` — e si va a riaprire,
          // che è l'unica metà rimasta da fare.
          transazioneAnnullata = true
          // `incassi_stornati` resta 0, e non è pignoleria: quel numero dice
          // all'operatrice quante righe questo giro ha toccato, e gonfiarlo con
          // storni fatti prima le farebbe contare due volte lo stesso denaro.
          logEvento('pagamento', 'warn', {
            operazione: 'pagamenti/riconciliazione/[id]:PATCH',
            esito: 'riapertura-transazione-gia-annullata',
            movimento_id: id,
          })
        } else if (mov.transazione_id) {
          // Composito: si annulla la TRANSAZIONE intera, che è l'unico modo di
          // stornare insieme incassi, ricariche mensa ed eccedenza a credito —
          // e in una transazione atomica sola. La RPC riapre da sé il movimento.
          const { data: esitoRpc, error: rpcErr } = await supabase.rpc('annulla_transazione_contabile', {
            p: { transazione_id: mov.transazione_id, motivo: MOTIVO_RIAPERTURA, annullato_da: auth.user.id },
          })
          if (rpcErr) {
            const code = (rpcErr as { code?: string }).code ?? ''
            // RPC assente → 503 SENZA storni parziali: nulla è stato scritto,
            // perché storno e riapertura vivono entrambi dentro quella chiamata.
            if (RPC_ASSENTE.has(code)) {
              logEvento(
                'pagamento',
                'error',
                { operazione: 'pagamenti/riconciliazione/[id]:PATCH', esito: 'riapertura-rpc-assente' },
                rpcErr,
              )
              return NextResponse.json(
                {
                  error: 'Riapertura non disponibile su questo ambiente: nessuno storno è stato registrato.',
                  codice: 'RIAPERTURA_NON_DISPONIBILE',
                },
                { status: 503 },
              )
            }
            if (code === 'KV410') {
              logEvento('pagamento', 'warn', {
                operazione: 'pagamenti/riconciliazione/[id]:PATCH',
                esito: 'riapertura-credito-gia-speso',
                movimento_id: id,
              })
              return NextResponse.json(
                {
                  error:
                    'Il credito generato da questo bonifico è già stato utilizzato: la riapertura è stata ' +
                    'fermata prima di qualunque storno.',
                  codice: 'RIAPERTURA_CREDITO_GIA_SPESO',
                },
                { status: 409 },
              )
            }
            // KV404 — la transazione NON ESISTE. Qui non si riapre, ed è voluto:
            // la RPC trova gli incassi da stornare PER `transazione_id`, quindi se
            // la transazione non c'è quegli incassi non sono stati stornati.
            // Liberare il bonifico lo farebbe riabbinare a un'altra voce con
            // l'incasso ancora vivo — lo stesso denaro incassato due volte.
            if (code === 'KV404') {
              return NextResponse.json(
                { error: 'La transazione di questo bonifico non esiste più.', codice: 'CONCILIAZIONE_MOVIMENTO_CAMBIATO' },
                { status: 409 },
              )
            }
            // KV409 — «già annullata», cioè la stessa condizione del pre-check qui
            // sopra, raggiunta però in GARA (fra la lettura e la RPC). Gli storni
            // ci sono: si PROSEGUE alla riapertura invece di rifiutare. Fino al
            // 2026-09-13 anche questo era un 409, e lasciava una riga `confermato`
            // sopra incassi che non esistevano più.
            if (code !== 'KV409') {
              logErrore(
                { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'riapertura_rpc_fallita', stato: 500 },
                rpcErr,
              )
              return NextResponse.json(
                { error: 'Errore durante la riapertura del movimento', codice: 'RIAPERTURA_NON_RIUSCITA' },
                { status: 500 },
              )
            }
            transazioneAnnullata = true
            logEvento('pagamento', 'warn', {
              operazione: 'pagamenti/riconciliazione/[id]:PATCH',
              esito: 'riapertura-transazione-annullata-in-gara',
              movimento_id: id,
            })
          } else {
            const conteggi = (esitoRpc ?? {}) as { incassi_stornati?: number; movimenti_riaperti?: number }
            transazioneAnnullata = true
            incassiStornati = conteggi.incassi_stornati ?? 0
            // ⚠️ `movimenti_riaperti` può MANCARE, e non è teoria: è lo stato del
            // database fra il rilascio della colonna e quello della RPC estesa. Con la
            // funzione vecchia lo storno avviene e il movimento resta `confermato` —
            // cioè una riga che mente, il difetto che questa fetta esiste per chiudere.
            // Chi non lo trova, riapre di sua mano qui sotto.
            riapertaDallaRpc = (conteggi.movimenti_riaperti ?? 0) >= 1
            if (riapertaDallaRpc) movimentiRiaperti = conteggi.movimenti_riaperti as number
            if (!riapertaDallaRpc) {
              logEvento('pagamento', 'warn', {
                operazione: 'pagamenti/riconciliazione/[id]:PATCH',
                esito: 'riapertura-non-fatta-dalla-rpc',
                movimento_id: id,
              })
            }
          }
        } else if (mov.incasso_id) {
          // ── LO STORNO È GIÀ STATO REGISTRATO? Si chiede alla riga giusta ────
          // Non a `incassi.stornato_il`, che `eseguiStornoIncasso` marca in
          // best-effort MUTO: al CONTRO-INCASSO, che è la sua scrittura primaria.
          // Senza questa lettura l'idempotenza di questo ramo dipenderebbe da una
          // `update` il cui fallimento nessuno vede — e un ritentativo stornerebbe
          // due volte lo stesso denaro. Il perché per esteso sta su
          // `stornoGiaRegistrato`.
          const gia = await stornoGiaRegistrato(supabase, mov.incasso_id)
          if ('response' in gia) return gia.response
          if (gia.presente) {
            logEvento('pagamento', 'warn', {
              operazione: 'pagamenti/riconciliazione/[id]:PATCH',
              esito: 'riapertura-storno-gia-registrato',
              movimento_id: id,
              incasso_id: mov.incasso_id,
            })
            // `incassiStornati` resta 0: questo giro non ha stornato niente.
          } else {
            // Voce singola: si storna l'incasso che la conferma aveva creato.
            const esitoStorno = await eseguiStornoIncasso(supabase, {
              incassoId: mov.incasso_id,
              motivo: MOTIVO_RIAPERTURA,
              userId: auth.user.id,
            })
            if (esitoStorno.status === 200) {
              incassiStornati = 1
            } else if (esitoStorno.status === 404 || esitoStorno.status === 409) {
              // 404 «incasso non trovato» e 409 «già stornato / è uno storno» dicono
              // la stessa cosa ai fini della riapertura: quella riga NON è più viva.
              // Proseguire rende il ritentativo idempotente — ed è ciò che serve
              // quando un giro precedente ha stornato e non è riuscito a riaprire.
              // ⚠️ È la rete SECONDA, non la prima: scatta quando `stornato_il` è
              // stato marcato davvero. Quando quella marcatura muta fallisce, qui
              // non si arriva nemmeno — ferma prima `stornoGiaRegistrato`.
              logEvento('pagamento', 'warn', {
                operazione: 'pagamenti/riconciliazione/[id]:PATCH',
                esito: 'riapertura-incasso-gia-non-vivo',
                movimento_id: id,
                // `stato` numerico → `logEvento` lo promuove alla colonna `statoHttp`,
                // che è il primo filtro di qualunque query sui log.
                stato: esitoStorno.status,
              })
            } else {
              // Lo storno non è riuscito: NON si riapre. Un movimento libero con
              // l'incasso ancora vivo si fa riabbinare a un'altra voce, cioè incassare
              // due volte lo stesso denaro. Qui non è stato scritto niente.
              logErrore(
                { operazione: 'pagamenti/riconciliazione/[id]:PATCH', evento: 'riapertura_storno_fallito', stato: 500 },
                new Error(String((esitoStorno.body as { error?: string }).error ?? 'storno non riuscito')),
              )
              return NextResponse.json(
                {
                  error: 'Non è stato possibile stornare l’incasso: il movimento non è stato riaperto.',
                  codice: 'RIAPERTURA_NON_RIUSCITA',
                },
                { status: 500 },
              )
            }
          }
        } else {
          // Confermato senza incasso: non dovrebbe esistere (la conferma li scrive
          // insieme), ma se esiste non è un motivo per non riaprire — è un motivo
          // per lasciarne traccia.
          logEvento('pagamento', 'warn', {
            operazione: 'pagamenti/riconciliazione/[id]:PATCH',
            esito: 'riapertura-senza-incasso',
            movimento_id: id,
          })
        }

        // ── 3. LA RIAPERTURA ──────────────────────────────────────────────────
        // Solo se non l'ha già fatta la RPC. Si azzerano i legami MORTI e si
        // CONSERVA `pagamento_id`: è la memoria di ciò a cui il bonifico era
        // legato, ed è l'unica cosa che, al riabbinamento successivo, faccia
        // scattare la guardia `BONIFICO_GIA_FATTURATO` qui sotto. Si conserva anche
        // `scuola_id`, per la ragione scritta nella migrazione dell'annullo: a NULL
        // la riga sparirebbe dalla vista di sede di chi deve rilavorarla.
        if (!riapertaDallaRpc) {
          const patch: Record<string, unknown> = {
            stato: 'da_abbinare',
            incasso_id: null,
            confermato_da: null,
            confermato_il: null,
          }
          // Si scrive solo se la colonna esiste: su un DB non migrato un
          // `transazione_id: null` farebbe fallire l'UPDATE con `PGRST204`.
          if (colonnaTransazione) patch.transazione_id = null
          const { data: upd, error: errUpd } = await supabase
            .from('riconciliazione_movimenti')
            .update(patch)
            .eq('id', id)
            // CAS ottimistico: si riapre solo se la riga è ancora quella letta.
            .eq('stato', 'confermato')
            .select('id')
          if (errUpd || !upd?.length) {
            // ⚠️ QUI LO STORNO È GIÀ AVVENUTO, e la risposta lo DICE invece di
            // tacerlo. L'ordine storno → riapertura è scelto: nel verso opposto un
            // movimento libero con l'incasso ancora vivo si fa riabbinare, cioè
            // incassare due volte. Così invece resta uno storno senza riapertura,
            // che si ripara ritentando (il secondo giro trova l'incasso già
            // stornato e prosegue).
            logErrore(
              {
                operazione: 'pagamenti/riconciliazione/[id]:PATCH',
                evento: 'riapertura_non_scritta_dopo_storno',
                stato: 409,
              },
              errUpd ?? new Error('nessuna riga riaperta: il movimento è cambiato sotto la richiesta'),
            )
            return NextResponse.json(
              {
                error:
                  'Il movimento è cambiato mentre lo si riapriva: lo storno è stato registrato, la riga ' +
                  'non è tornata in coda. Ricarica l’elenco e riprova.',
                // ⚠️ NON `CONCILIAZIONE_MOVIMENTO_CAMBIATO`, e fino al 2026-09-13 lo
                // era — proprio su una risposta progettata per DICHIARARE lo storno.
                // Quel codice non sta in `CODICI_CON_DETTAGLIO`: `messaggioDaCorpo`
                // scarta la prosa appena lo riconosce, e la frase qui sopra — l'unica
                // che nomini il denaro restituito — non arrivava MAI a schermo. Al suo
                // posto usciva «un altro operatore ha appena modificato questo
                // bonifico: ricarica l'elenco e ricomponi il pagamento». Misurato
                // eseguendo `messaggioDaCorpo`, non dedotto.
                codice: 'RIAPERTURA_STORNATA_NON_RIAPERTA',
                data: { incassi_stornati: incassiStornati, transazione_annullata: transazioneAnnullata },
              },
              { status: 409 },
            )
          }
        }

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
            transazione_annullata: transazioneAnnullata,
            incassi_stornati: incassiStornati,
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
          transazione_annullata: transazioneAnnullata,
          incassi_stornati: incassiStornati,
          fatture_vive: fattureVive,
        })

        // NESSUNA notifica al genitore: decisione esplicita del titolare. La
        // conferma avvisa («Pagamento registrato»), lo storno no — un avviso
        // «il tuo pagamento non risulta più» su una correzione di segreteria
        // sarebbe allarmante e quasi sempre sbagliato (la riga viene rilavorata
        // subito dopo).
        return NextResponse.json({
          success: true,
          data: {
            stato: 'da_abbinare',
            transazione_annullata: transazioneAnnullata,
            movimenti_riaperti: movimentiRiaperti,
            incassi_stornati: incassiStornati,
          },
          ...(avviso ? { avviso } : {}),
        })
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
    // ⚠️ NON È PIÙ UNA GUARDIA DIFENSIVA: dal 2026-09-12 sta sulla strada
    // principale — e fino a quel giorno qui era scritto il contrario.
    // Prima, lo stato che la fa scattare era irraggiungibile: `pagamento_id` lo
    // scriveva solo la conferma qui sotto, e un confermato non tornava indietro
    // (`ignora` e `riapri` rispondono 409 poche righe più su). Adesso
    // `annulla_transazione_contabile` riapre il movimento della transazione
    // annullata — `stato` torna `da_abbinare` — e gli LASCIA `pagamento_id`; e
    // l'annullo non è un intervento a mano, è un pulsante del registro
    // (`TransazioniPanel` → `pagamenti/transazioni/[id]/annulla:POST`).
    // Il percorso «il bonifico M salda la transazione T, la cui voce di
    // ancoraggio è P1 → su P1 si emette la fattura → si annulla T → M torna in
    // coda → l'operatore lo riabbina a P2» è quindi normale amministrazione, non
    // un'ipotesi: questo `if` è l'unica cosa che lo ferma, e la migrazione
    // conserva `pagamento_id` PROPRIO perché lui lo legga — le due metà le tiene
    // insieme il lock `__tests__/architecture/annullo-riapre-movimento.test.ts`.
    // Costa una lettura, e solo quando il pagamento cambia davvero.
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
      const righe = (righeFattura ?? []) as RigaFattura[]
      // Le righe VIVE: il predicato sta in `fatturaViva`, in un posto solo — lo
      // legge anche l'avviso della riapertura, e due definizioni di «viva»
      // direbbero due cose diverse dello stesso documento.
      const viva = righe.find(fatturaViva)
      if (viva) {
        const annoViva = viva.anno ?? new Date().getFullYear()
        const numeroFattura = etichettaFattura(viva)
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
          corpo: `${pagDett.descrizione ?? 'Pagamento'}: registrato un bonifico di ${formatEuro(mov.importo)}.`,
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
