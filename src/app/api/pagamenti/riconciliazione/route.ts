import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData, parseMultipart, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import {
  hashMovimento,
  parseCsv,
  preparaAperti,
  suggerisciMatchPreparato,
  type MappingCsv,
  type MovimentoCsv,
  type PagamentoAperto,
} from '@/lib/pagamenti/riconciliazione'
import { leggiEstrattoConto } from '@/lib/pagamenti/estratto-conto/lettura'
import { interpretaFogli } from '@/lib/pagamenti/estratto-conto/tabella'
import type { Formato } from '@/lib/pagamenti/estratto-conto/tipi'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { formatEuro } from '@/lib/format/valuta'

/**
 * L'ESTRATTO ANNUALE È 9.004 RIGHE, e le legge tutte in una richiesta sola.
 *
 * Il default di una Function è 10 secondi: con 6.775 accrediti da confrontare con i 545
 * pagamenti aperti, il taglio arriverebbe a metà dell'INSERT — cioè con parte dei movimenti
 * già scritti e nessuna risposta. Gli unici altri due `maxDuration` del repository stanno su
 * `api/pagamenti/fattura` e `api/iscrizione/import-massivo`, per la stessa ragione.
 */
export const maxDuration = 300

const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())
// `z.iso.date()` valida una data ISO REALE (giorno/mese esistenti), non solo la forma YYYY-MM-DD:
// così un input impossibile come 2026-13-40 / 2026-02-30 è respinto qui (→ 400 warn) e non arriva
// mai a `.gte/.lte`, dove Postgres esploderebbe (22008) e riempirebbe il canale ERROR con un
// errore di INPUT utente. Vale per `da` e `a`.
const zDataQueryOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.iso.date('Data non valida (atteso YYYY-MM-DD reale)').optional(),
)

const getQuerySchema = z.object({
  stato: z.enum(['da_abbinare', 'suggerito', 'confermato', 'ignorato']).or(z.literal('')).optional(),
  /**
   * IL FILTRO DI FATTURAZIONE NON È UN QUINTO STATO DEL MOVIMENTO.
   *
   * Il registro ha quattro stati e soli quattro (`CHECK (stato IN (…))` sul DB): «fatturato»
   * non ci entra, e non deve entrarci — è un dato del PAGAMENTO abbinato, non del movimento
   * bancario. Perciò vive su un parametro suo, che si COMPONE con `?stato=` invece di
   * sostituirlo: la schermata manda `?stato=confermato&fattura=da_fatturare`.
   *
   * Nessun `.or(z.literal(''))` qui, a differenza di `stato`: il vuoto è un valore che la UI
   * non manda mai per questo filtro, e accettarlo significherebbe far passare in silenzio un
   * `?fattura=` costruito male. Un 400 lo dice.
   */
  fattura: z.enum(['da_fatturare', 'fatturate']).optional(),
  import_id: zUuidQueryOpzionale,
  // Intervallo su data_operazione (estremi inclusi).
  da: zDataQueryOpzionale,
  a: zDataQueryOpzionale,
})

const OPERAZIONE_POST = 'pagamenti/riconciliazione:POST'

const mappingSchema = z.object({
  data: z.string().max(80).optional(),
  importo: z.string().max(80).optional(),
  causale: z.string().max(80).optional(),
  controparte: z.string().max(80).optional(),
})

/**
 * IL RAMO JSON — resta, e costa dieci righe.
 *
 * ⚠️ **IL BASE64 NON SI ACCETTA IN NESSUNA FORMA, e non è una preferenza di stile.**
 * `Conti-15.xls` pesa 2.182.144 byte: in base64 diventa 2,91 MB e sfonda sia questo
 * `max()` sia il tetto di 4 MB della piattaforma (`src/lib/upload/limite-piattaforma.ts`),
 * oltre il quale Vercel risponde 413 in `text/plain` — la route non parte nemmeno e il
 * client non ha un JSON da leggere. E terrebbe tre copie del file in RAM.
 * Il file si manda in **multipart**. Questo ramo serve a incollare un CSV da uno script.
 */
const postBodySchema = z.object({
  filename: z.string().max(200).optional(),
  // contenuto CSV in chiaro: PII bancarie → si persistono SOLO i movimenti normalizzati
  contenuto: z.string().min(1).max(2_000_000),
  mapping: mappingSchema.optional(),
  scuola_id: zUuid.nullish(),
})

/**
 * Il `mapping` in multipart viaggia come STRINGA JSON: un `FormData` non ha oggetti.
 *
 * Se non si legge non si fa cadere l'import — i sinonimi automatici riconoscono da soli il
 * formato della banca — ma **si logga**: un mapping scritto a mano e ignorato in silenzio
 * farebbe cercare il difetto nelle colonne del file, che sono a posto.
 */
const zMappingMultipart = z.preprocess((v) => {
  if (typeof v !== 'string' || v.trim() === '') return undefined
  try {
    return JSON.parse(v)
  } catch (errore) {
    logEvento('pagamento', 'info', { operazione: OPERAZIONE_POST, esito: 'mapping_non_leggibile' }, errore)
    return undefined
  }
}, mappingSchema.optional())

const zScuolaMultipart = z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional())

const uploadSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun estratto conto ricevuto' }),
  scuola_id: zScuolaMultipart,
  mapping: zMappingMultipart,
})

/**
 * I TRE TIPI CHE UNA BANCA DICHIARA — e il nome del file, che vale quanto loro.
 *
 * Il MIME dichiarato dal client non è mai una prova: su un `.xls` scaricato dall'home
 * banking arriva regolarmente `application/octet-stream`. La prova vera è che il lettore
 * riesca ad aprirlo, e arriva due passi più sotto. Qui si scarta ciò che è palesemente
 * altro — un PDF, una foto — prima di leggerne i byte.
 */
const MIME_ESTRATTO = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const
const ESTENSIONI_ESTRATTO = /\.(csv|xls|xlsx)$/i

/**
 * Righe CHIESTE per pagina nella finestra di dedup.
 *
 * ⚠️ Non sta «sotto» il `db-max-rows` di PostgREST: ci COINCIDE — `supabase/config.toml`
 * dichiara `max_rows = 1000`. Chiederne di più non ne restituirebbe di più, chiederne di
 * meno moltiplicherebbe i round-trip. Ma quel numero è una riga di CONFIGURAZIONE, non una
 * costante di questo codice: può scendere senza che nessuno tocchi questo file, e il ciclo
 * qui sotto non deve dipenderne (avanza di quante righe ha RICEVUTO, non di quante ne ha
 * chieste). Stessa scelta, e stessa motivazione, di `src/lib/avvisi/statistiche.ts`.
 */
const BLOCCO_DEDUP = 1000
/**
 * Il tetto dei round-trip. Col `db-max-rows` di oggi sono 100.000 righe di registro nella
 * finestra di UN estratto conto — undici volte l'annuale intero, che ne ha 9.004. Se un
 * `db-max-rows` più basso lo facesse mordere davvero, il log `dedup-finestra-troncata` lo
 * dice a livello `error`: una finestra letta a metà fa passare per NUOVI dei movimenti già
 * in registro, e non deve mai succedere in silenzio.
 */
const MAX_PAGINE_DEDUP = 100
/** Righe per INSERT: la taglia già usata da `iscrizioni/elenco`, qui con i `suggerimenti` in JSONB. */
const BLOCCO_INSERT = 200

/**
 * IL CORPO, LETTO MA NON ANCORA INTERPRETATO.
 *
 * Le due fasi sono separate di proposito. La PRIMA (`apriCorpo`) prende i campi e respinge
 * ciò che è palesemente sbagliato — niente file, troppo grande, tipo non ammesso — e
 * consegna anche la SEDE dichiarata. La SECONDA (`interpretaCorpo`) apre davvero il foglio,
 * ed è la parte cara: 2,1 MB di BIFF8 e 9.004 righe.
 *
 * In mezzo ci sta il passo che decide se questa scrittura è ammessa: `resolveScuolaScrittura`.
 * Interpretare prima vorrebbe dire spendere quel lavoro per poi scoprire che la sede non era
 * stata dichiarata — e con tre plessi quella risposta è un 400 normale, non un caso limite.
 */
type CorpoAperto =
  | { tipo: 'json'; contenuto: string; mapping?: MappingCsv; filename: string | null; scuolaId?: string | null }
  | { tipo: 'file'; file: File; mapping?: MappingCsv; filename: string | null; scuolaId?: string | null }

/** Quello che la route ottiene una volta interpretato il corpo, comunque sia arrivato. */
interface CorpoImport {
  movimenti: MovimentoCsv[]
  scartate: number
  uscite: number
  troncate: number
  senzaOrdinante: number
  formato: Formato
  byte: number
}

/** Il corpo è multipart quando lo dichiara: tutto il resto è il ramo JSON di sempre. */
const È_MULTIPART = /^\s*multipart\/form-data\s*(;|$)/i

/**
 * FASE 1 — i campi, e i rifiuti nell'ordine che costa meno.
 *
 * Prima la dimensione (un confronto), poi il tipo (una regex). Aprire un foglio da 4 MB per
 * scoprire che era un PDF è lavoro sprecato su una richiesta che andava respinta subito.
 */
async function apriCorpo(request: Request): Promise<CorpoAperto | { response: NextResponse }> {
  const contentType = request.headers.get('content-type') ?? ''

  if (!È_MULTIPART.test(contentType)) {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return { response: b.response }
    return {
      tipo: 'json',
      contenuto: b.data.contenuto,
      mapping: b.data.mapping,
      filename: b.data.filename ?? null,
      scuolaId: b.data.scuola_id,
    }
  }

  const form = await parseMultipart(request)
  if ('response' in form) return { response: form.response }
  // ⚠️ Il campo assente ha un codice SUO, e non è pignoleria: il 400 generico di zod
  // («Dati non validi») è l'unico rifiuto di questa porta che l'operatore leggerebbe senza
  // capire che cosa deve fare — mentre qui la cosa da fare è una sola, e si può dire.
  if (!(form.data.get('file') instanceof File)) {
    logEvento('pagamento', 'warn', { operazione: OPERAZIONE_POST, esito: 'estratto-conto-assente' })
    return {
      response: NextResponse.json(
        { error: 'Nessun estratto conto ricevuto: scegli il file da caricare', codice: 'ESTRATTO_CONTO_ASSENTE' },
        { status: 400 },
      ),
    }
  }
  const parsed = parseData(uploadSchema, {
    file: form.data.get('file'),
    scuola_id: form.data.get('scuola_id'),
    mapping: form.data.get('mapping'),
  })
  if ('response' in parsed) return { response: parsed.response }
  const { file, scuola_id: scuolaId, mapping } = parsed.data

  if (file.size > LIMITE_UPLOAD_BYTE) {
    logEvento('pagamento', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'estratto-conto-troppo-grande',
      byte: file.size,
    })
    return {
      response: NextResponse.json(
        {
          error: `L’estratto conto è troppo grande: può pesare al massimo ${LIMITE_UPLOAD_MB} MB`,
          codice: 'ESTRATTO_CONTO_TROPPO_GRANDE',
        },
        { status: 413 },
      ),
    }
  }

  const tipoDichiarato = (file.type || '').toLowerCase()
  const nomeAmmesso = ESTENSIONI_ESTRATTO.test(file.name || '')
  if (!nomeAmmesso && !(MIME_ESTRATTO as readonly string[]).includes(tipoDichiarato)) {
    // Il TIPO sì, il NOME del file NO: un estratto conto scaricato dall'home banking si
    // chiama spesso col numero di rapporto, e a volte col cognome dell'intestatario.
    logEvento('pagamento', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'estratto-conto-tipo-non-ammesso',
      mime: tipoDichiarato || 'assente',
      byte: file.size,
    })
    return {
      response: NextResponse.json(
        {
          error: 'Questo tipo di file non si può caricare: serve un estratto conto .csv, .xls o .xlsx',
          codice: 'ESTRATTO_CONTO_TIPO_NON_AMMESSO',
        },
        { status: 415 },
      ),
    }
  }

  return { tipo: 'file', file, mapping, filename: file.name || null, scuolaId }
}

/** FASE 2 — si apre il foglio davvero. È il passo caro, e si fa a sede già decisa. */
async function interpretaCorpo(corpo: CorpoAperto): Promise<CorpoImport | { response: NextResponse }> {
  if (corpo.tipo === 'json') {
    const letto = parseCsv(corpo.contenuto, corpo.mapping)
    return {
      movimenti: letto.movimenti,
      scartate: letto.scartate,
      uscite: letto.uscite ?? 0,
      troncate: letto.troncate ?? 0,
      senzaOrdinante: letto.senzaOrdinante ?? 0,
      formato: 'csv',
      byte: corpo.contenuto.length,
    }
  }

  const { file } = corpo
  const dati = await file.arrayBuffer()
  let letto
  try {
    letto = leggiEstrattoConto(dati, { nomeFile: file.name })
  } catch (errore) {
    // Difetto del FILE, non guasto del server: 400, e `warn` — non `error`, che è il canale
    // dove si cercano i guasti veri.
    logEvento('pagamento', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'estratto-conto-illeggibile',
      byte: file.size,
    }, errore)
    return {
      response: NextResponse.json(
        {
          error: 'Il file è arrivato ma non si apre come estratto conto: controlla che sia il file giusto',
          codice: 'ESTRATTO_CONTO_ILLEGGIBILE',
        },
        { status: 400 },
      ),
    }
  }

  const esito = interpretaFogli(letto.fogli, { mapping: corpo.mapping, date1904: letto.date1904 })
  return {
    movimenti: esito.movimenti,
    scartate: esito.scartate,
    uscite: esito.uscite,
    troncate: esito.troncate,
    senzaOrdinante: esito.senzaOrdinante,
    formato: letto.formato,
    byte: file.size,
  }
}

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

interface SuggerimentoRiga { pagamento_id: string; label?: string | null; [k: string]: unknown }
interface MovimentoRiga {
  suggerimenti?: SuggerimentoRiga[] | null
  stato?: string | null
  pagamento_id?: string | null
  [k: string]: unknown
}

/** I quattro valori che `pagamenti.fattura_stato` può assumere (baseline, colonna non nullable in pratica). */
type FatturaStato = 'non_richiesta' | 'in_attesa' | 'emessa' | 'scartata'
const FATTURA_STATI = new Set<string>(['non_richiesta', 'in_attesa', 'emessa', 'scartata'])

/**
 * La riga che esce dal GET: il movimento com'è in registro, PIÙ due campi DERIVATI dal
 * pagamento abbinato. Derivati e basta: non esiste nessuna colonna `fattura_stato` su
 * `riconciliazione_movimenti`, e non deve nascere — il registro è append-only e duplicare
 * lì lo stato della fattura vorrebbe dire tenerlo allineato per sempre.
 */
interface MovimentoArricchito extends MovimentoRiga {
  pagamento_stato: string | null
  fattura_stato: FatturaStato | null
}

/**
 * I DUE CAMPI ESCONO SEMPRE, ANCHE A `null` — e «sempre» è la parte che conta.
 *
 * Se comparissero solo sulle righe che hanno qualcosa da dire, il client non potrebbe
 * distinguere «questa riga non è fatturabile» da «questa risposta non porta l'informazione»
 * (batch fallito, nessun pagamento da risolvere, campo non ancora implementato). Sono due
 * significati opposti che si leggerebbero uguali: `undefined` per entrambi. Con il campo
 * sempre presente, `null` vuol dire una cosa sola — «non lo so, o non ti riguarda».
 */
function conFatturazione(
  r: MovimentoRiga,
  pagamentoStato: string | null = null,
  fatturaStato: FatturaStato | null = null,
): MovimentoArricchito {
  return { ...r, pagamento_stato: pagamentoStato, fattura_stato: fatturaStato }
}

/**
 * Un valore fuori dai quattro noti diventa `null`, non passa così com'è.
 * Chi legge questo campo decide che cosa mostrare in segreteria: meglio «non lo so» che una
 * pill con dentro una stringa che nessuno ha previsto.
 */
function normalizzaFattura(v: unknown): FatturaStato | null {
  return typeof v === 'string' && FATTURA_STATI.has(v) ? (v as FatturaStato) : null
}

/** Fattura ancora da fare: mai emessa, oppure emessa e SCARTATA dallo SDI (va rifatta). */
const FATTURA_DA_FARE = new Set<string>(['non_richiesta', 'scartata'])
/** Fattura già partita: in viaggio verso lo SDI o consegnata. Non si rifà. */
const FATTURA_FATTA = new Set<string>(['in_attesa', 'emessa'])

/**
 * Il filtro si applica IN MEMORIA, dopo l'arricchimento, e non può essere altrimenti: il dato
 * su cui filtra non sta su `riconciliazione_movimenti` ma su `pagamenti`, e PostgREST non
 * filtra una tabella per una colonna dell'altra senza una join che qui non esiste (il legame
 * è `pagamento_id`, nullable). Il costo è nullo: le righe sono al massimo 500 (`.limit(500)`).
 *
 * `da_fatturare` pretende anche il pagamento SALDATO: su un pagamento parziale la fattura non
 * si emette, e mostrarlo fra i «da fatturare» manderebbe l'operatore contro un rifiuto.
 */
function filtraFattura(
  righe: MovimentoArricchito[],
  fattura: 'da_fatturare' | 'fatturate' | undefined,
): MovimentoArricchito[] {
  if (!fattura) return righe
  if (fattura === 'da_fatturare') {
    return righe.filter(
      (r) => r.stato === 'confermato' && r.pagamento_stato === 'pagato' && FATTURA_DA_FARE.has(r.fattura_stato ?? ''),
    )
  }
  return righe.filter((r) => FATTURA_FATTA.has(r.fattura_stato ?? ''))
}

// GET /api/pagamenti/riconciliazione?stato=&fattura=&import_id=&da=&a= — registro movimenti (staff).
// Registro CUMULATIVO GLOBALE: l'estratto conto della banca è unico e cross-sede, quindi ogni
// segreteria vede TUTTE le RIGHE bancarie (data/importo/causale/controparte/stato, ogni stato):
// è l'estratto conto condiviso del titolare. La sede si assegna solo alla conferma, quindi filtrare
// le righe per sede nasconderebbe proprio quelle ancora da lavorare (scuola_id = null).
// MINIMIZZAZIONE IN LETTURA (privacy, dati di minori): i `suggerimenti` portano però il NOME del
// minore (label). Quello è arricchimento identificante: si mostra SOLO per le PROPRIE sedi. Sotto,
// dopo aver caricato le righe, si risolve la sede di ogni pagamento citato (una query batch) e si
// tengono nei suggerimenti solo quelli in sede attiva; la riga bancaria resta invece globale.
//
// LA STESSA QUERY BATCH PORTA LO STATO DI FATTURAZIONE (2026-09-05). Il movimento confermato
// non dice se la fattura è uscita — quel dato vive su `pagamenti.fattura_stato`, che `emissione.ts`
// scrive e che sul registro non arriva mai. La batch, estesa ai `pagamento_id` dei confermati e
// alle colonne `stato, fattura_stato`, restituisce `pagamento_stato` e `fattura_stato` su ogni
// riga (`null` fuori dalle proprie sedi, come i label), e `?fattura=` filtra in memoria. Nessuna
// query in più, nessuna colonna nuova sul registro.
export const GET = withRoute('pagamenti/riconciliazione:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()

    let query = supabase
      .from('riconciliazione_movimenti')
      .select('id, import_id, scuola_id, data_operazione, importo, causale, controparte, stato, suggerimenti, pagamento_id, confermato_il')
      .order('data_operazione', { ascending: false })
      .limit(500)
    if (q.data.stato) query = query.eq('stato', q.data.stato)
    if (q.data.import_id) query = query.eq('import_id', q.data.import_id)
    if (q.data.da) query = query.gte('data_operazione', q.data.da)
    if (q.data.a) query = query.lte('data_operazione', q.data.a)

    const { data, error } = await query
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: [], disponibile: false })
      return NextResponse.json({ error: 'Errore nel recupero dei movimenti' }, { status: 500 })
    }
    const righe = (data || []) as MovimentoRiga[]

    // I PAGAMENTI DA RISOLVERE SONO DUE INSIEMI, e servono due cose diverse.
    //   · quelli citati dai SUGGERIMENTI → per minimizzare i label (nomi di minori);
    //   · quelli abbinati alle righe CONFERMATE → per dire se la fattura è già uscita.
    // Un movimento confermato non ha più suggerimenti da mostrare (l'abbinamento è fatto), ma
    // ha `pagamento_id`: senza questa seconda metà la riga verde resterebbe muta, che è
    // esattamente il difetto — su un registro di centinaia di righe verdi indistinguibili
    // nessuno può dire quali restano da fatturare, e una fattura saltata non se ne accorge nessuno.
    const confermateConPagamento = righe.filter(
      (r) => r.stato === 'confermato' && typeof r.pagamento_id === 'string' && r.pagamento_id !== '',
    )
    const pagIds = [...new Set([
      ...righe.flatMap((r) => (r.suggerimenti ?? []).map((s) => s.pagamento_id)),
      ...confermateConPagamento.map((r) => r.pagamento_id as string),
    ].filter(Boolean))]
    // Nessun pagamento citato da nessuna parte: niente da risolvere, ma i due campi escono lo stesso.
    if (pagIds.length === 0) {
      return NextResponse.json({
        success: true,
        data: filtraFattura(righe.map((r) => conFatturazione(r)), q.data.fattura),
      })
    }

    const sediAttive = new Set(await resolveScuoleAttive(request, supabase, auth.user))
    const { data: pagSedi, error: errSedi } = await supabase
      .from('pagamenti')
      .select('id, scuola_id, stato, fattura_stato')
      .in('id', pagIds)
    if (errSedi || !pagSedi) {
      // UNA query fallita, DUE conseguenze distinte — e ognuna ha il suo nome in `app_log`,
      // perché chi indaga cerca il sintomo che ha visto, non la causa che ancora non conosce:
      //   · senza la mappa sede non distinguiamo le proprie sedi dalle altre → si toglie
      //     l'arricchimento identificante (il nome) da TUTTI i suggerimenti. Meglio ometterlo
      //     che rischiare di esporre il nome di un minore di un altro plesso;
      //   · senza `fattura_stato` la riga confermata non può dire se è già fatturata → i due
      //     campi escono `null`, e la schermata non mostra nessuna pill. Mai inventare
      //     «da fatturare» su una riga la cui fattura potrebbe essere già partita.
      // Un `esito` solo renderebbe invisibile uno dei due sintomi.
      logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:GET', esito: 'sedi_suggerimenti_non_risolte' }, errSedi)
      logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:GET', esito: 'fatturazione_movimenti_non_risolta' }, errSedi)
      const oscurati = righe.map((r) =>
        conFatturazione(
          r.suggerimenti ? { ...r, suggerimenti: r.suggerimenti.map((s) => ({ ...s, label: null })) } : r,
        ),
      )
      return NextResponse.json({ success: true, data: filtraFattura(oscurati, q.data.fattura) })
    }
    interface PagamentoAbbinato { id: string; scuola_id: string | null; stato: string | null; fattura_stato: string | null }
    const pagDi = new Map((pagSedi as PagamentoAbbinato[]).map((p) => [p.id, p]))
    const minimizzate = righe.map((r) => {
      const conSuggerimenti = r.suggerimenti
        ? {
            ...r,
            suggerimenti: r.suggerimenti.filter((s) => {
              const sede = pagDi.get(s.pagamento_id)?.scuola_id
              return sede != null && sediAttive.has(sede)
            }),
          }
        : r
      // Stessa minimizzazione dei label, stessa ragione: lo stato di fatturazione si mostra
      // SOLO sulle proprie sedi. Un operatore non deve leggere «da fatturare» su un plesso su
      // cui non può agire — e la riga bancaria resta comunque globale, come oggi.
      const pag = r.stato === 'confermato' && typeof r.pagamento_id === 'string'
        ? pagDi.get(r.pagamento_id)
        : undefined
      const visibile = pag != null && pag.scuola_id != null && sediAttive.has(pag.scuola_id)
      return visibile
        ? conFatturazione(conSuggerimenti, pag.stato ?? null, normalizzaFattura(pag.fattura_stato))
        : conFatturazione(conSuggerimenti)
    })
    return NextResponse.json({ success: true, data: filtraFattura(minimizzate, q.data.fattura) })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/riconciliazione — import dell'estratto conto (staff).
//
// ─── L'ORDINE DEI PASSI, E PERCHÉ NON SI CAMBIA ──────────────────────────────
//   1. gate di ruolo        chi bussa — PRIMA di leggere il corpo (lock `corpo-letto-dopo-il-gate`)
//   2. il corpo             multipart o JSON secondo il `content-type`; dimensione, tipo, lettura
//   3. la sede di scrittura DICHIARATA (arriva col corpo), mai indovinata
//   4. dedup                per FINESTRA DI DATE, paginata
//   5. suggerimenti         sui pagamenti aperti PREPARATI una volta sola
//   6. INSERT a blocchi     e l'audit, e il log di successo coi conteggi
//
// ⚠️ La sede arriva DENTRO il corpo (`scuola_id`), quindi il passo 3 non può stare prima del
// 2: leggerla dalla query invece che dal corpo cambierebbe il contratto del ramo JSON, che
// è in uso. Il vincolo che conta — non bufferizzare megabyte da chi non si è ancora
// identificato — è il passo 1, ed è rispettato.
//
// I movimenti nascono senza sede (scuola_id null): la sede si assegna alla conferma, e
// nessun abbinamento si auto-conferma mai.
export const POST = withRoute('pagamenti/riconciliazione:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const aperto = await apriCorpo(request)
    if ('response' in aperto) return aperto.response
    const filename = aperto.filename

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, aperto.scuolaId ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const corpo = await interpretaCorpo(aperto)
    if ('response' in corpo) return corpo.response
    const { movimenti, scartate, uscite, troncate, senzaOrdinante, formato } = corpo

    if (movimenti.length === 0) {
      // Non è un guasto ed è un rifiuto: «zero movimenti» da solo non distingue il file
      // sbagliato dal file vuoto, quindi si dichiara che cosa il lettore ha visto.
      logEvento('pagamento', 'warn', {
        operazione: OPERAZIONE_POST,
        esito: 'estratto-conto-senza-accrediti',
        formato,
        scartate,
        uscite,
        byte: corpo.byte,
      })
      return NextResponse.json(
        {
          error: 'Nessun accredito riconosciuto nel file: controlla le intestazioni delle colonne o il separatore',
          codice: 'ESTRATTO_CONTO_SENZA_ACCREDITI',
        },
        { status: 400 },
      )
    }

    // dedup nel file + contro il registro esistente
    const visti = new Set<string>()
    const conHash = movimenti
      .map((m) => ({ m, hash: hashMovimento(m) }))
      .filter(({ hash }) => (visti.has(hash) ? false : (visti.add(hash), true)))

    // DEDUP GLOBALE: l'UNIQUE su hash_movimento è globale (non per sede) e l'estratto conto è
    // unico → il controllo anti re-import NON filtra per scuola_id. La finestra è quella delle
    // date del file: la data è dentro l'hash, quindi un duplicato non può stare fuori.
    const date = conHash.map(({ m }) => m.data_operazione).sort()

    /**
     * GLI HASH GIÀ IN REGISTRO, cercati per FINESTRA DI DATE e non per lista.
     *
     * ⚠️ Sta QUI DENTRO, e non come funzione di modulo, per una ragione precisa: è una query
     * su `riconciliazione_movimenti` DELIBERATAMENTE senza filtro di sede, e il lock
     * `isolamento-sede-coverage` la legge insieme all'handler che la contiene — cioè insieme
     * al suo `resolveScuolaScrittura`. Portandola fuori diventerebbe una lettura di sede
     * «di nessuno», e l'unico modo di farla passare sarebbe una voce di allowlist: una
     * protezione spenta per un dettaglio di forma.
     *
     * ─── PERCHÉ NON `.in('hash_movimento', […])` ──────────────────────────────
     * L'estratto annuale ha 6.775 accrediti: 6.775 sha256 da 64 caratteri in un `.in()` fanno
     * una query string da oltre **450 KB**, che PostgREST rifiuta prima ancora di guardarla.
     * Il controllo anti-doppio-import salterebbe per intero — sull'unico file su cui serve.
     *
     * La finestra funziona perché **la data è DENTRO l'hash**: due movimenti con lo stesso
     * hash hanno per forza la stessa data, quindi un duplicato del file sta certamente fra il
     * minimo e il massimo delle date del file. Una query invece di sessantotto.
     *
     * ─── E PERCHÉ SI PAGINA ───────────────────────────────────────────────────
     * PostgREST tronca le risposte lunghe (`db-max-rows`) **senza dirlo**: la pagina arriva
     * corta e sembra la fine dell'elenco. Gli hash mancanti diventerebbero movimenti «nuovi»,
     * cioè doppioni scritti in registro. Quindi non si guarda quanto è corta la pagina: si
     * avanza di quante righe sono ARRIVATE e ci si ferma solo su una pagina VUOTA — l'unico
     * segnale che un tetto del server non può falsificare. L'ordine è `hash_movimento`, che è
     * UNIVOCO: un ordine totale, in cui nessuna riga può scivolare da una pagina all'altra.
     *
     * ─── E PERCHÉ NON FILTRA PER SEDE ─────────────────────────────────────────
     * L'UNIQUE su `hash_movimento` è globale e l'estratto conto della banca è uno solo per
     * tutte e tre le sedi: un movimento già importato da un'altra segreteria è un duplicato,
     * non un movimento nuovo. Filtrando per sede lo si riscriverebbe.
     */
    const hashGiaInRegistro = async (
      dal: string,
      al: string,
    ): Promise<{ hash: Set<string> } | { errore: { code?: string; message?: string } }> => {
      const trovati = new Set<string>()
      let letto = 0
      for (let pagina = 0; pagina < MAX_PAGINE_DEDUP; pagina++) {
        const { data, error } = await supabase
          .from('riconciliazione_movimenti')
          .select('hash_movimento')
          .gte('data_operazione', dal)
          .lte('data_operazione', al)
          .order('hash_movimento', { ascending: true })
          .range(letto, letto + BLOCCO_DEDUP - 1)
        if (error) return { errore: error }
        const pagineRighe = (data || []) as { hash_movimento: string }[]
        for (const r of pagineRighe) trovati.add(r.hash_movimento)
        // ⚠️ SI AVANZA DI QUANTE RIGHE SONO ARRIVATE, e ci si ferma solo su una pagina
        // VUOTA. La regola di prima — «pagina più corta del blocco ⇒ fine dei dati» —
        // scambiava il TRONCAMENTO del server per la fine dell'elenco: con un
        // `db-max-rows` di 500 si leggeva una pagina sola, si riconoscevano 500 duplicati
        // e gli altri 6.275 passavano per NUOVI. In produzione l'UNIQUE su
        // `hash_movimento` lo trasformerebbe in un fallimento a metà scrittura, con una
        // riga orfana in `riconciliazione_import` e un import che fallisce a ogni
        // ritentativo. Il tetto del server non si indovina: non lo si guarda affatto.
        if (pagineRighe.length === 0) return { hash: trovati }
        letto += pagineRighe.length
      }
      // Oltre il tetto: la finestra è stata letta solo in parte. Non si nasconde — un
      // duplicato che passasse da qui verrebbe scritto due volte e nessuno lo saprebbe.
      logEvento('pagamento', 'error', {
        operazione: OPERAZIONE_POST,
        esito: 'dedup-finestra-troncata',
        n: trovati.size,
      })
      return { hash: trovati }
    }

    const registro = await hashGiaInRegistro(date[0], date[date.length - 1])
    if ('errore' in registro) {
      if (SCHEMA_MANCANTE.has(registro.errore.code ?? '')) {
        return NextResponse.json({ error: 'Riconciliazione non ancora disponibile.' }, { status: 503 })
      }
      logErrore({ operazione: OPERAZIONE_POST, evento: 'dedup_finestra_fallita', stato: 500 }, registro.errore)
      return NextResponse.json({ error: 'Errore nel controllo duplicati' }, { status: 500 })
    }
    const gia = registro.hash
    const nuovi = conHash.filter(({ hash }) => !gia.has(hash))
    const duplicati = conHash.length - nuovi.length
    // Un secondo bonifico identico non deve sparire in silenzio: si logga QUANTI ne saltiamo.
    if (duplicati > 0) {
      logEvento('pagamento', 'info', { operazione: OPERAZIONE_POST, esito: 'duplicati_saltati', duplicati })
    }

    // Pagamenti aperti di TUTTE le sedi: l'estratto conto è globale e questo è un client
    // service-role. Il CF dell'alunno è l'aggancio più forte (`codice_fiscale`, con fallback
    // sullo storico `fiscal_code`).
    // FIX collaudo: l'ERRORE della SELECT non si scarta. Il matching per CF/nome è il CUORE
    // dell'import: se questa SELECT fallisce, `aperti` resterebbe vuoto e la rotta loggerebbe
    // comunque `import_ok` con `con_cf:0` — un successo che MENTE. Quindi:
    //  • 42703 (colonna CF assente sul DB E2E CI non migrato) → si ritenta SENZA le colonne CF,
    //    coerente col resto della codebase: l'import degrada senza aggancio per codice fiscale;
    //  • qualunque altro errore → si INTERROMPE l'import (500 + logErrore), niente `import_ok`.
    const APERTI_SELECT_CF = 'id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunno_id, alunni:alunno_id ( nome, cognome, codice_fiscale, fiscal_code )'
    const APERTI_SELECT_BASE = 'id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunno_id, alunni:alunno_id ( nome, cognome )'
    // `apertiRaw` normalizzato a `unknown[] | null`: la SELECT con CF e quella senza hanno tipi
    // literal diversi (l'embed `alunni` differisce) → tenerli in un `let` tipizzato darebbe conflitto.
    // Il downstream fa comunque `as unknown as {…}` sul mapping, quindi il tipo preciso qui non serve.
    const primaSelezione = await supabase
      .from('pagamenti')
      .select(APERTI_SELECT_CF)
      .in('stato', ['da_pagare', 'parziale', 'scaduto'])
    let apertiRaw: unknown[] | null = primaSelezione.data
    let errAperti = primaSelezione.error
    if (errAperti?.code === '42703') {
      logEvento('pagamento', 'info', { operazione: OPERAZIONE_POST, esito: 'degradazione_cf_aperti' })
      const senzaCf = await supabase
        .from('pagamenti')
        .select(APERTI_SELECT_BASE)
        .in('stato', ['da_pagare', 'parziale', 'scaduto'])
      apertiRaw = senzaCf.data
      errAperti = senzaCf.error
    }
    if (errAperti) {
      logErrore({ operazione: OPERAZIONE_POST, evento: 'aperti_select_fallita', stato: 500 }, errAperti)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti aperti' }, { status: 500 })
    }
    const aperti: PagamentoAperto[] = ((apertiRaw || []) as unknown as {
      id: string; descrizione?: string | null; importo: number; importo_pagato?: number | null
      periodo_competenza?: string | null; tipo: string; alunno_id?: string | null
      alunni?: { nome?: string; cognome?: string; codice_fiscale?: string | null; fiscal_code?: string | null } | null
    }[])
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        id: p.id,
        descrizione: p.descrizione,
        importo: p.importo,
        importo_pagato: p.importo_pagato,
        periodo_competenza: p.periodo_competenza,
        alunno_id: p.alunno_id ?? null,
        codice_fiscale: p.alunni?.codice_fiscale ?? p.alunni?.fiscal_code ?? null,
        alunno_nome: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ') || null,
      }))
    const labels = new Map(
      aperti.map((p) => [
        p.id,
        `${p.alunno_nome ?? '—'} · ${p.descrizione ?? '—'} (residuo ${formatEuro(Number(p.importo) - Number(p.importo_pagato || 0))})`,
      ]),
    )
    // ⚠️ UNA VOLTA SOLA. Sull'estratto annuale sono 6.775 accrediti × 545 pagamenti aperti =
    // 3,7 milioni di confronti: normalizzare i nomi DENTRO il ciclo significava rifare
    // `normalize('NFD')` sugli stessi nomi milioni di volte.
    const apertiPreparati = preparaAperti(aperti)

    // Il movimento nasce SENZA sede (scuola_id null): la sede si assegna alla conferma.
    // DEGRADAZIONE CI: sul DB E2E non migrato scuola_id è ancora NOT NULL → 23502; si ritenta
    // con la sede risolta dell'operatore (`resolveScuolaScrittura`).
    const impBase = { filename: filename, righe_totali: nuovi.length, caricato_da: auth.user.id }
    let { data: imp, error: errImp } = await supabase
      .from('riconciliazione_import')
      .insert({ ...impBase, scuola_id: null })
      .select()
      .single()
    if (errImp?.code === '23502') {
      logEvento('pagamento', 'info', { operazione: OPERAZIONE_POST, esito: 'degradazione_scuola_id_import' })
      ;({ data: imp, error: errImp } = await supabase
        .from('riconciliazione_import')
        .insert({ ...impBase, scuola_id: scuolaId })
        .select()
        .single())
    }
    if (errImp || !imp) {
      logErrore({ operazione: OPERAZIONE_POST, evento: 'import_non_creato', stato: 500 }, errImp)
      return NextResponse.json({ error: "Errore nella creazione dell'import" }, { status: 500 })
    }

    let suggeriti = 0
    let conCf = 0
    const righe = nuovi.map(({ m, hash }) => {
      const s = suggerisciMatchPreparato(m, apertiPreparati)
      if (s.stato === 'suggerito') suggeriti++
      if (s.cf_match && s.cf_match.length > 0) conCf++
      return {
        import_id: (imp as { id: string }).id,
        scuola_id: null as string | null,
        data_operazione: m.data_operazione,
        importo: m.importo,
        causale: m.causale || null,
        controparte: m.controparte || null,
        hash_movimento: hash,
        stato: s.stato,
        suggerimenti: s.suggerimenti.map((x) => ({ ...x, label: labels.get(x.pagamento_id) ?? null })),
      }
    })
    // A BLOCCHI. Un solo INSERT da 6.775 righe che portano anche i `suggerimenti` in JSONB è
    // un corpo di svariati megabyte: la richiesta a PostgREST muore per dimensione, e con lei
    // l'import intero. Il ritentativo su 23502 (DB E2E non migrato) resta DENTRO il ciclo.
    for (let i = 0; i < righe.length; i += BLOCCO_INSERT) {
      const blocco = righe.slice(i, i + BLOCCO_INSERT)
      let { error: errIns } = await supabase.from('riconciliazione_movimenti').insert(blocco)
      if (errIns?.code === '23502') {
        logEvento('pagamento', 'info', { operazione: OPERAZIONE_POST, esito: 'degradazione_scuola_id_movimenti' })
        const bloccoConSede = blocco.map((r) => ({ ...r, scuola_id: scuolaId }))
        ;({ error: errIns } = await supabase.from('riconciliazione_movimenti').insert(bloccoConSede))
      }
      if (errIns) {
        logErrore({ operazione: OPERAZIONE_POST, evento: 'movimenti_non_salvati', stato: 500 }, errIns)
        // Un blocco fallito a metà lascia scritti quelli PRIMA, e questo è il fatto che serve
        // sapere: «errore nel salvataggio» da solo non distingue «niente scritto» da «metà
        // scritto», e le due cose si riparano in modi opposti. Si dichiara solo quando è
        // successo davvero, per non aggiungere una riga a ogni fallimento del primo blocco.
        if (i > 0) {
          logEvento('pagamento', 'error', {
            operazione: OPERAZIONE_POST,
            esito: 'movimenti-scritti-a-meta',
            scritti: i,
            totali: righe.length,
          })
        }
        return NextResponse.json({ error: 'Errore nel salvataggio dei movimenti' }, { status: 500 })
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'riconciliazione_import',
      entitaId: (imp as { id: string }).id,
      azione: 'insert',
      scuolaId,
      valoreDopo: { filename: filename, nuovi: righe.length, duplicati },
    })

    // Log di SUCCESSO con i soli CONTEGGI (mai PII: niente causale/CF/nomi). 'pagamento' è un
    // evento persistito → il successo dell'import resta tracciato, non solo gli errori.
    //
    // ⚠️ `senza_ordinante` è il campanello: se la banca cambia la forma della descrizione, il
    // nome di chi paga smette di uscirne e questo numero salta da 11 a seimila. Va guardato al
    // primo import di ogni mese — senza, il degrado sarebbe invisibile, perché l'import
    // continuerebbe a riuscire.
    logEvento('pagamento', 'info', {
      operazione: OPERAZIONE_POST,
      esito: 'import_ok',
      formato,
      totali: movimenti.length,
      nuovi: righe.length,
      duplicati,
      scartate,
      uscite,
      troncate,
      senza_ordinante: senzaOrdinante,
      suggeriti,
      con_cf: conCf,
    })

    return NextResponse.json({
      success: true,
      data: {
        import_id: (imp as { id: string }).id,
        nuovi: righe.length,
        duplicati,
        scartate,
        uscite,
        troncate,
        senza_ordinante: senzaOrdinante,
        suggeriti,
        con_cf: conCf,
        da_abbinare: righe.length - suggeriti,
      },
    })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_POST, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
