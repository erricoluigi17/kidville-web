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
// ⚠️ QUI NON SI IMPORTA `marcaAutomaticaDisponibile`, e l'assenza è una scelta:
// quella funzione risponde a «l'automatismo deve PARTIRE?» ed è fail-closed su
// ogni guasto. Questa rotta fa la domanda opposta — «posso SPEGNERE la marca?» —
// dove «non lo so» trattato come «no» lascia accesa una marca che mente. La
// risposta arriva perciò dalla lettura del movimento (`MOV_SELECT_MARCA`), che
// degrada sulla sola colonna assente e su tutto il resto esce 500 prima dello
// storno.
// La lettura «a che cosa è associato questo bonifico» della GET: le voci, i
// bambini, il denaro per voce e chi ha confermato. Il gate di sede resta qui,
// nell'handler; al modulo arriva un movimento che chi chiede può già vedere.
import { leggiAssociazione, oscuraVociFuoriSede } from '@/lib/pagamenti/associazione-movimento'

const patchBodySchema = z.object({
  azione: z.enum(['conferma', 'ignora', 'riapri']),
  pagamento_id: zUuid.optional(),
  /**
   * Che cosa fare della riga DOPO la riapertura di un confermato: tornare in
   * coda (`da_abbinare`, il default di sempre) o finire fra gli ignorati — cioè
   * «elimina l'associazione» del popup. Conta solo su `riapri` di un
   * `confermato`: una riga ignorata che si riapre torna in coda e basta.
   */
  poi: z.enum(['da_abbinare', 'ignorato']).optional(),
})

/**
 * Le colonne del movimento. TRE varianti (erano due fino al 2026-09-20) per la
 * stessa ragione di `PAG_SELECT_*` dentro `@/lib/pagamenti/riconciliazione-conferma`:
 * `transazione_id` nasce con la conciliazione composita e sul DB E2E della CI non
 * c'è → `42703`. Chiederla in una SELECT che serve anche alla conferma farebbe
 * cadere l'intera rotta su quell'ambiente.
 */
const MOV_SELECT_BASE =
  'id, scuola_id, importo, data_operazione, causale, stato, suggerimenti, pagamento_id, incasso_id'
const MOV_SELECT_TX = `${MOV_SELECT_BASE}, transazione_id`
/**
 * La variante COMPLETA: `abbinato_auto_il` in coda, la marca «abbinato dalla
 * macchina» (migrazione `20260920124742`).
 *
 * ⚠️ È QUI E NON IN UNA SONDA A PARTE, e la differenza non è di stile.
 * `marcaAutomaticaDisponibile` è fail-closed per costruzione — su «non lo so»
 * risponde `false` — ed è il verso giusto per la domanda che quella funzione fa:
 * «l'automatismo deve PARTIRE?». La riapertura fa la domanda OPPOSTA — «posso
 * SPEGNERE la marca?» — e lì `false` su un guasto qualunque (timeout, 5xx di
 * PostgREST, pool esaurito) non è prudente: lascia ACCESA la marca che mente,
 * cioè esattamente ciò che questa fetta esiste per impedire. La riga tornerebbe
 * in coda `da_abbinare` ancora «automatica»; una riconferma fatta a mano da
 * `confermaSuVoceSingola` non la spegne (là `abbinato_auto_il` si scrive solo
 * quando `automatico` è vero); e l'annullamento in blocco disferebbe il lavoro
 * di una persona.
 *
 * Chiedendola invece nella LETTURA DEL MOVIMENTO — l'unica che c'è già — le due
 * colonne nuove seguono lo stesso ramo di degradazione che `transazione_id`
 * aveva da sé: `42703` ⇒ si ritenta senza, qualunque ALTRO errore ⇒ 500 **prima**
 * dello storno. Una lettura in meno, non una in più.
 */
const MOV_SELECT_MARCA = `${MOV_SELECT_TX}, abbinato_auto_il`

/**
 * Le tre varianti in ordine di ricchezza decrescente, cioè l'ordine in cui le
 * migrazioni hanno aggiunto le colonne: `abbinato_auto_il` (20260920124742) dopo
 * `transazione_id` (20260912180100). Le colonne presenti su un database sono
 * perciò sempre un PREFISSO di questo elenco, e scalare di uno alla volta
 * distingue i tre stati raggiungibili invece di appiattirli:
 *   · produzione migrata → la prima riesce, tutt'e due le colonne si scrivono;
 *   · la finestra fra il merge della migrazione e il deploy del codice (o
 *     viceversa) → la prima dà `42703`, la seconda riesce: `transazione_id` si
 *     azzera lo stesso, che è il comportamento di ieri;
 *   · il DB E2E della CI, non migrato → si arriva alla terza e non si scrive
 *     nessuna delle due.
 * Appiattire i primi due stati in uno solo lascerebbe sulla riga riaperta un
 * `transazione_id` che punta a una transazione annullata: un legame morto in
 * meno di quelli che oggi si azzerano.
 */
const MOV_VARIANTI = [MOV_SELECT_MARCA, MOV_SELECT_TX, MOV_SELECT_BASE] as const

/**
 * La stessa scala per la GET, con le due colonne della conferma in coda a OGNI
 * gradino: «chi ha confermato, e quando» è metà della risposta del popup.
 *
 * Non si degradano, e non per svista: `confermato_da`/`confermato_il` esistono
 * dalla migrazione base del 2026-07-10, quindi ci sono anche sul DB E2E della
 * CI. Stanno in coda per non spostare la ragione per cui la scala esiste — il
 * gradino che cade è sempre quello di `abbinato_auto_il` o di `transazione_id`.
 *
 * ⚠️ NON si aggiungono anche al PATCH: la sua lettura non ne ha bisogno, e una
 * colonna in più nella SELECT che regge storno e conferma è un modo in più per
 * farla cadere.
 */
const MOV_VARIANTI_ASSOCIAZIONE = MOV_VARIANTI.map((v) => `${v}, confermato_da, confermato_il`)

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
  /** La marca «abbinato dalla macchina»: `undefined` dove la colonna non c'è. */
  abbinato_auto_il?: string | null
  /** Chi ha confermato e quando: li chiede solo la GET (`MOV_VARIANTI_ASSOCIAZIONE`). */
  confermato_da?: string | null
  confermato_il?: string | null
}

/**
 * La lettura di UNA riga di `riconciliazione_movimenti` con le colonne date.
 * La scrive l'handler — tabella e chiave — e `leggiMovimento` la chiama a ogni
 * gradino della scala.
 */
type LetturaMovimento = (colonne: string) => PromiseLike<{ data: unknown; error: { code?: string } | null }>

// ── LA LETTURA DEL MOVIMENTO, E PERCHÉ GUARDA L'ERRORE ───────────────────────
// PostgREST non lancia: ritorna `{ error }`. In origine l'errore era scartato
// dalla destrutturazione, e QUALUNQUE guasto di lettura — permesso
// negato, rete, colonna assente — usciva come «Movimento non trovato», 404: un
// messaggio che manda a cercare una riga che invece esiste. Adesso l'errore si
// legge, e serve anche a un secondo scopo: `transazione_id` non esiste sul DB
// E2E della CI, e senza il ritentativo qui sotto l'intera rotta — conferma
// compresa — cadrebbe su quell'ambiente.
//
// È UNA FUNZIONE dal 2026-10-05 perché la usano due handler: il PATCH (con
// `MOV_VARIANTI`) e la GET dell'associazione (con `MOV_VARIANTI_ASSOCIAZIONE`).
// Il codice è quello che stava in linea nel PATCH, spostato: stessi gradini,
// stessi log, stesse risposte.
//
// ⚠️ LA QUERY LA PASSA L'HANDLER (`leggi`), e non è un vezzo. Il PATCH scrive
// su `riconciliazione_movimenti` per `id` (ignora, riapri, poi), e il lock
// `isolamento-sede-coverage` accetta quelle scritture perché lo STESSO handler
// legge quella riga di quella tabella con quella chiave — l'idioma «leggi la
// riga per id, verifica, riscrivila». Una funzione che facesse da sé la
// `.from(…)` sposterebbe la lettura fuori dall'handler, e le tre scritture
// diventerebbero rosse (misurato: le tre righe del PATCH, il 2026-10-05). Così
// chi legge l'handler vede quale riga si legge; qui resta solo il COME:
// la scala, i log, le risposte.
async function leggiMovimento(
  leggi: LetturaMovimento,
  operazione: string,
  varianti: readonly string[] = MOV_VARIANTI,
): Promise<{ mov: Movimento; colonnaTransazione: boolean; colonnaMarca: boolean } | { response: NextResponse }> {
  let movRaw: unknown = null
  /** `true` se il database HA la colonna: decide se la riapertura può scriverla. */
  let colonnaTransazione = true
  /**
   * `true` se il database HA `abbinato_auto_il`: decide se la riapertura può
   * SPEGNERE la marca. Parte da `true` e scende solo su un `42703`/`PGRST204`
   * — cioè su «la colonna non c'è», mai su «non lo so»: un guasto qualunque
   * esce 500 dal ciclo qui sotto, PRIMA dello storno.
   */
  let colonnaMarca = true
  for (let i = 0; i < varianti.length; i++) {
    const lettura = await leggi(varianti[i])
    if (!lettura.error) {
      movRaw = lettura.data
      break
    }
    const code = (lettura.error as { code?: string }).code ?? ''
    // Si scala di UNA colonna sola, e solo finché resta una variante più
    // povera da provare: sull'ultima non c'è più niente da togliere, quindi
    // l'errore è un guasto vero e va detto.
    if (i < varianti.length - 1 && COLONNA_ASSENTE.has(code)) {
      if (i === 0) colonnaMarca = false
      else colonnaTransazione = false
      // `warn` e non `info`: una colonna nuova che manca è lo stato ATTESO sul
      // DB E2E della CI, ma un ramo di degradazione che nessuno vede è la
      // prima metà di ogni guasto lungo di questo repository. Non è `error`
      // per la stessa ragione: un canale rosso a ogni giro di CI smette di
      // essere guardato. Solo enumerati e codici: niente causali, niente nomi.
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'movimento-letto-in-degradazione',
        tipo: i === 0 ? 'colonna-marca-assente' : 'colonna-transazione-assente',
        error_code: code,
      })
      continue
    }
    logErrore({ operazione, evento: 'movimento_non_letto', stato: 500 }, lettura.error)
    return {
      response: NextResponse.json(
        { error: 'Errore nel recupero del movimento', codice: 'MOVIMENTO_NON_LETTO' },
        { status: 500 },
      ),
    }
  }
  if (!movRaw) return { response: NextResponse.json({ error: 'Movimento non trovato' }, { status: 404 }) }
  return { mov: movRaw as unknown as Movimento, colonnaTransazione, colonnaMarca }
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

// GET /api/pagamenti/riconciliazione/[id] — il movimento e A CHE COSA è associato (staff).
// Una richiesta sola per il popup: voci, bambini, denaro per voce, chi ha
// confermato, e stato/fattura della voce àncora (che prima costavano una
// seconda chiamata a `/api/pagamenti/[id]`).
export const GET = withRoute('pagamenti/riconciliazione/[id]:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const supabase = await createAdminClient()
    const letto = await leggiMovimento(
      (colonne) => supabase.from('riconciliazione_movimenti').select(colonne).eq('id', id).maybeSingle(),
      'pagamenti/riconciliazione/[id]:GET',
      MOV_VARIANTI_ASSOCIAZIONE,
    )
    if ('response' in letto) return letto.response
    const mov = letto.mov

    // ── IL GATE DI SEDE, PRIMA DI LEGGERE VOCI E NOMI ─────────────────────────
    // Un movimento CONFERMATO ha la sede della voce (la scrive la conferma); uno
    // libero è della coda globale, come per `ignora`, e non porta nomi. Fuori
    // sede → 404 e non 403, come altrove: chi non può vederla non deve nemmeno
    // sapere che esiste. Una riga confermata SENZA sede (storica) si giudica
    // dalla voce àncora, con lo stesso gate della riapertura a voce singola.
    // Le sedi attive servono due volte: al gate qui sotto, e dopo la lettura per
    // oscurare le voci di un fratello iscritto in un altro plesso (`oscuraVociFuoriSede`).
    let sediAttive: string[] = []
    if (mov.stato === 'confermato') {
      sediAttive = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
      if (mov.scuola_id) {
        if (!sediAttive.includes(mov.scuola_id)) {
          return NextResponse.json(
            { error: 'Movimento non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' },
            { status: 404 },
          )
        }
      } else if (mov.pagamento_id) {
        const fuoriScope = await assertPagamentoInScope(supabase, auth.user, mov.pagamento_id)
        if (fuoriScope) return fuoriScope
      }
    }

    const esito = await leggiAssociazione(supabase, mov, 'pagamenti/riconciliazione/[id]:GET')
    if ('guasto' in esito) {
      logErrore({ operazione: 'pagamenti/riconciliazione/[id]:GET', evento: 'associazione_non_letta', stato: 500 }, esito.guasto)
      return NextResponse.json(
        { error: 'Errore nella lettura dell’associazione', codice: 'MOVIMENTO_NON_LETTO' },
        { status: 500 },
      )
    }
    return NextResponse.json({
      success: true,
      data: {
        id: mov.id,
        stato: mov.stato,
        importo: mov.importo,
        data_operazione: mov.data_operazione,
        // Un composito può pagare le voci di fratelli in sedi diverse: quelle fuori
        // dalle sedi attive escono senza nome né descrizione, con le sole cifre.
        associazione: esito.associazione ? oscuraVociFuoriSede(esito.associazione, sediAttive) : null,
        pagamento: esito.ancora,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione/[id]:GET', stato: 500 }, err)
    // Con un codice anche qui: è una lettura di questa riga che non è riuscita,
    // e `MOVIMENTO_NON_LETTO` è il 500 che il catalogo già traduce.
    return NextResponse.json({ error: 'Internal Server Error', codice: 'MOVIMENTO_NON_LETTO' }, { status: 500 })
  }
})

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
    // La lettura del movimento — con la scala di degradazione e il 500 su ogni
    // guasto che non sia «la colonna non c'è» — sta in `leggiMovimento`, qui
    // sopra: la condivide la GET dell'associazione. La riga (tabella e chiave)
    // la sceglie questo handler, che poi la riscrive per la stessa chiave.
    const letto = await leggiMovimento(
      (colonne) => supabase.from('riconciliazione_movimenti').select(colonne).eq('id', id).maybeSingle(),
      'pagamenti/riconciliazione/[id]:PATCH',
    )
    if ('response' in letto) return letto.response
    const { mov, colonnaTransazione, colonnaMarca } = letto

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
        // ── LA MARCA «ABBINATO DALLA MACCHINA» SI PUÒ SPEGNERE QUI? ──────────
        // La riapertura deve azzerare anche `abbinato_auto_il`, o la marca
        // mente: la riga tornerebbe in coda ancora «automatica», e una
        // riconferma fatta A MANO resterebbe bersaglio dell'annullamento in
        // blocco. La risposta è già in mano: `colonnaMarca` viene dalla LETTURA
        // DEL MOVIMENTO qui sopra, che chiede la colonna insieme alle altre.
        //
        // 🔴 E NON DA `marcaAutomaticaDisponibile`, che pure risponderebbe.
        // Quella funzione è fail-closed su QUALUNQUE guasto, ed è il verso
        // giusto per la sua domanda — «l'automatismo deve partire?» — ma il
        // verso SBAGLIATO per questa: su un timeout risponderebbe «non
        // disponibile» e la riapertura proseguirebbe, storno compreso, lasciando
        // accesa la marca che mente. Qui un guasto che non sia «la colonna non
        // esiste» ha già fatto uscire la richiesta con 500, PRIMA dello storno.
        const esito = await riapriMovimento(supabase, {
          movimento: mov,
          transazioneGiaAnnullata,
          colonnaTransazione,
          colonnaMarca,
          attoreId: auth.user.id,
          operazione: 'pagamenti/riconciliazione/[id]:PATCH',
        })
        if (esito.ok) {
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
            // Se la marca si è spenta viaggia sul log del SUCCESSO, invece di
            // occupare una riga sua a ogni riapertura: così «nessun log» non
            // diventa di nuovo l'ambiguità fra «la marca si è spenta» e «non è
            // mai partito niente». Booleano, quindi `redact` lo lascia in chiaro.
            marca_disponibile: colonnaMarca,
          })

          // ── «ELIMINA L'ASSOCIAZIONE»: RIAPRIRE E POI IGNORARE ──────────────
          // Il popup offre due seguiti alla riapertura: rimettere la riga in coda
          // (il default) o toglierla di mezzo fra gli ignorati. Il secondo è un
          // UPDATE A PARTE, e CONDIZIONATO a `da_abbinare`: fra la riapertura e
          // questa riga un'altra persona può aver già riabbinato il bonifico, e un
          // «ignora» incondizionato ignorerebbe una riga confermata — cioè un
          // incasso vivo sparito dalla coda di chi lo deve vedere.
          // Se non tocca righe (o fallisce) la risposta resta 200: lo storno e la
          // riapertura sono avvenuti e sono ciò che conta. La riga è in coda, e
          // la risposta lo DICE (`ignorato: false`) invece di fingere.
          let ignoraApplicato: boolean | undefined
          if (b.data.poi === 'ignorato') {
            const { data: ign, error: errIgn } = await supabase
              .from('riconciliazione_movimenti')
              .update({ stato: 'ignorato' })
              .eq('id', id)
              .eq('stato', 'da_abbinare')
              .select('id')
            ignoraApplicato = !errIgn && (ign?.length ?? 0) > 0
            if (!ignoraApplicato) {
              logEvento(
                'pagamento',
                'warn',
                {
                  operazione: 'pagamenti/riconciliazione/[id]:PATCH',
                  esito: 'ignora-dopo-riapertura-non-applicato',
                  movimento_id: id,
                },
                errIgn ?? undefined,
              )
            }
          }
          // Chi ha riaperto: la riapertura cancella `confermato_da`/`confermato_il`,
          // quindi senza questa riga «chi aveva confermato quel bonifico» si perde e
          // nessuno sa nemmeno chi l'abbia disfatto.
          // ⚠️ DOPO l'«ignora», non prima (revisione finale, 2026-10-05): l'audit
          // registrava `da_abbinare` anche quando un istante dopo la riga finiva
          // `ignorato`, cioè uno stato che la riga non aveva più. Ora porta quello
          // in cui è RIMASTA.
          await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'riconciliazione_movimenti',
            entitaId: id,
            azione: 'update',
            scuolaId: mov.scuola_id ?? undefined,
            valoreDopo: {
              stato: ignoraApplicato ? 'ignorato' : 'da_abbinare',
              transazione_annullata: esito.ok.transazioneAnnullata,
              incassi_stornati: esito.ok.incassiStornati,
            },
          })
          // Il SUCCESSO dell'intenzione dell'operatrice, distinto dal
          // `movimento-riaperto` qui sopra (che è il successo dello storno).
          logEvento('pagamento', 'info', {
            operazione: 'pagamenti/riconciliazione/[id]:PATCH',
            esito: b.data.poi === 'ignorato' ? 'associazione-eliminata' : 'associazione-riaperta',
            movimento_id: id,
            ignorato: ignoraApplicato === true,
          })
          if (ignoraApplicato !== undefined) {
            // Spread, non sostituzione: `data` porta già i numeri della
            // riapertura (incassi stornati, transazione annullata…).
            const corpo = esito.body as { data?: Record<string, unknown> }
            corpo.data = {
              ...(corpo.data ?? {}),
              stato: ignoraApplicato ? 'ignorato' : 'da_abbinare',
              ignorato: ignoraApplicato,
            }
          }
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
        const { data: aggiornato, error: errStato } = await supabase
          .from('pagamenti')
          .select('stato')
          .eq('id', pagamentoId)
          .maybeSingle()
        // Lo stato non riletto non ferma l'avviso (il bonifico è registrato e la famiglia va
        // avvisata): il titolo resta il più prudente, «Acconto», e il guasto non è più muto
        // (fase 5 robustezza, sesto pezzo).
        if (errStato) {
          logEvento('pagamento', 'error', { operazione: 'pagamenti/riconciliazione/[id]:PATCH', esito: 'stato-non-riletto', pagamento_id: pagamentoId }, errStato)
        }
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
