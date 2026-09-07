import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData, parseMultipart, parseQuery } from '@/lib/validation/http'
import { zUuid, zTestoRicerca } from '@/lib/validation/common'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import {
  agganciaFuoriSede,
  hashMovimento,
  parseCsv,
  preparaAperti,
  suggerisciMatchPreparato,
  type MappingCsv,
  type MovimentoCsv,
  type PagamentoAperto,
  type VerdettoAltraSede,
  sedeDedotta,
} from '@/lib/pagamenti/riconciliazione'
import { leggiEstrattoConto } from '@/lib/pagamenti/estratto-conto/lettura'
import { interpretaFogli } from '@/lib/pagamenti/estratto-conto/tabella'
import type { Formato } from '@/lib/pagamenti/estratto-conto/tipi'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { formatEuro } from '@/lib/format/valuta'
import { mapStatoAruba } from '@/lib/aruba/stato'
import { formattaNumeroFattura } from '@/lib/fatturazione/sezionale'
/**
 * IL MOTORE DELLO STATO DI FATTURAZIONE — la stessa politica che disegna il chip.
 *
 * `fatturazione-riga.ts` è il posto in cui «questa riga è fatturata / è da fatturare»
 * è scritta e collaudata, una volta sola. Riscriverla qui è ciò che ha prodotto il
 * difetto che questa importazione chiude: due copie, divergenti sul documento
 * sintetico (v. la testata del motore).
 *
 * ⚠️ Sta in `src/lib` e non fra i componenti, e il perché è misurato: la prima
 * stesura importava da `@/components/features/admin/pagamenti/riconciliazione-ui`
 * ed era il PRIMO import di `src/app/api` da `src/components` di tutto il
 * repository. `eslint` non lo vede, `tsc --noEmit` nemmeno, e a provare la
 * frontiera RSC è solo `next build`: un `'use client'` aggiunto un giorno in
 * quella cartella avrebbe fatto cadere QUESTA rotta, in CI, con un messaggio che
 * non nomina la fatturazione. Lock:
 * `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts`.
 */
import {
  daFatturareInListaDiLavoro,
  fatturaGiaFatta,
  type FatturaMovimentoUi,
  type RigaListaDiLavoro,
} from '@/lib/pagamenti/fatturazione-riga'
import { termineOr, orIlike } from '@/lib/db/ricerca-postgrest'

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

/** Un importo in query string: facoltativo, non negativo, e mai `NaN`. */
const zNumeroQueryOpzionale = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
  .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), 'Importo non valido')

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
  /**
   * «QUANTE NE RESTANO?» — la domanda che le tre pillole non sapevano rispondere.
   *
   * Con `conteggi=1` questa rotta non porta a casa nessuna riga (`data: []`): conta e
   * basta, sui DUE bidoni di `?fattura=` e con lo STESSO motore, così il numero scritto
   * sulla pillola e l'elenco che la pillola apre non possono divergere.
   *
   * ⚠️ UN LETTERALE, non un booleano permissivo (`z.coerce.boolean()` accetta perfino
   * `'false'`): `?conteggi=0` deve essere un 400, non un conteggio silenzioso. Lo schema
   * non è `.strict()`, quindi un client vecchio che non manda niente resta valido.
   */
  conteggi: z.enum(['1']).optional(),
  import_id: zUuidQueryOpzionale,
  // Intervallo su data_operazione (estremi inclusi).
  da: zDataQueryOpzionale,
  a: zDataQueryOpzionale,
  /**
   * Ricerca su causale e ordinante. `zTestoRicerca` misura la LUNGHEZZA; la
   * SINTASSI la sanifica `termineOr` più sotto — servono tutti e due, e nessuno
   * dei due si riscrive qui.
   *
   * ⚠️ I nomi `da`/`a` NON si rinominano in `dataDa`/`dataA`. Sembrerebbe un
   * allineamento gratuito alla barra filtri, e invece: questo schema non è
   * `.strict()`, quindi zod scarta in SILENZIO le chiavi ignote. Il giorno del
   * rinominamento un `?da=2026-13-40` smetterebbe di essere un 400 e diventerebbe
   * un filtro ignorato, con la lista che esce non filtrata e nessuno che lo dice.
   */
  q: zTestoRicerca,
  /**
   * Intervallo d'importo, estremi inclusi, su `numeric(10,2)`.
   *
   * Nessuna auto-correzione se il minimo supera il massimo: l'elenco esce vuoto,
   * che è ciò che è stato chiesto. Scambiare gli estremi «per gentilezza»
   * significa rispondere a una domanda diversa da quella scritta a schermo.
   */
  importoDa: zNumeroQueryOpzionale,
  importoA: zNumeroQueryOpzionale,
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
  /**
   * La sede che l'app ha DEDOTTO dai suggerimenti, per le sole righe non
   * confermate — sulle confermate `scuola_id` sta già sulla riga, quindi è nota.
   * `null` = l'app non ha saputo dedurla: è il bidone «sede non riconosciuta»,
   * cioè le righe rosse che vanno controllate a mano.
   */
  sede_dedotta: SedeDedottaUi | null
  /**
   * «QUESTO BONIFICO SEMBRA DI UN'ALTRA SEDE» — l'aggancio forte è fuori dalle
   * sedi dell'operatore, e i candidati che vedrà lui sono deboli.
   *
   * ⚠️ ESCE IL NOME, NON L'UUID, e non è una svista: al client serve una frase
   * («ha un aggancio forte su Kidville Cesa»), e un uuid in più sarebbe
   * superficie senza uso — un identificatore di plesso che viaggia in un JSON
   * che nessuno legge per quello.
   *
   * ⚠️ LA DECISIONE DI PRIVACY, dichiarata invece che scoperta: dire «questo
   * bonifico ha un aggancio forte su Kidville Cesa» rivela l'ESISTENZA di una
   * voce aperta in un altro plesso, mai CHI. È meno del nome dell'ORDINANTE che
   * quella stessa riga bancaria già mostra a tutte e tre le segreterie (il
   * registro è l'estratto conto unico del titolare). Il nome del MINORE resta
   * oscurato esattamente come prima: la minimizzazione dei `suggerimenti` non è
   * toccata di una riga, e questo campo si calcola PRIMA di quel filtro proprio
   * perché dopo l'informazione non c'è più.
   */
  altra_sede: AltraSedeUi | null
}

/**
 * Il verdetto come esce nel JSON: il NOME della sede, o `null`. E basta.
 *
 * ⚠️ `per_cf` — «a dirlo è stato un codice fiscale» — È STATO TOLTO DAL CONTRATTO
 * il 2026-09-07, il giorno dopo esserci entrato. Viaggiava nel JSON e non lo
 * leggeva nessuno: la schermata dice la stessa frase nei due casi, perché
 * all'operatore serve sapere *che* l'aggancio è altrove, non *da quale segnale*.
 * Un campo che nessuno legge non è un'informazione in più, è una promessa da
 * mantenere in eterno — e il giorno in cui servisse davvero, il verdetto lo porta
 * già (`VerdettoAltraSede.per_cf`, in `@/lib/pagamenti/riconciliazione`) e
 * rimetterlo qui costa una riga.
 */
interface AltraSedeUi {
  /** `null` = la sede c'è ma non si è potuto leggerne il nome. MAI una stringa inventata. */
  nome: string | null
}

/**
 * DI QUALE SEDE SEMBRA — e a differenza di `altra_sede` qui l'uuid SERVE, perché
 * questo campo è la chiave di un filtro, non il soggetto di una frase.
 *
 * Filtrare per nome vorrebbe dire confrontare stringhe che degradano a `null`
 * quando la lettura delle sedi cade: due sedi ignote e una sede vera senza nome
 * finirebbero nello stesso bidone.
 *
 * `certa` è `true` solo quando a decidere è stato un codice fiscale. Non è
 * decorazione: misurato sui 219 movimenti non confermati di produzione, 93 sono
 * dedotti per CF e 93 per punteggio — l'operatore che filtra per sede ha diritto
 * di sapere quale delle due cose sta guardando.
 */
interface SedeDedottaUi {
  scuola_id: string
  certa: boolean
}

/**
 * I TRE CAMPI ESCONO SEMPRE, ANCHE A `null` — e «sempre» è la parte che conta.
 *
 * Se comparissero solo sulle righe che hanno qualcosa da dire, il client non potrebbe
 * distinguere «questa riga non è fatturabile» da «questa risposta non porta l'informazione»
 * (batch fallito, nessun pagamento da risolvere, campo non ancora implementato). Sono due
 * significati opposti che si leggerebbero uguali: `undefined` per entrambi. Con il campo
 * sempre presente, `null` vuol dire una cosa sola — «non lo so, o non ti riguarda».
 *
 * Dal 2026-09-07 vale anche per il terzo, `altra_sede`: `undefined` significherebbe insieme
 * «l'aggancio forte è qui» e «non ho potuto guardare», che sono opposti.
 */
function conFatturazione(
  r: MovimentoRiga,
  pagamentoStato: string | null = null,
  fatturaStato: FatturaStato | null = null,
  altraSede: AltraSedeUi | null = null,
  sedeDedottaUi: SedeDedottaUi | null = null,
): MovimentoArricchito {
  return {
    ...r,
    pagamento_stato: pagamentoStato,
    fattura_stato: fatturaStato,
    altra_sede: altraSede,
    sede_dedotta: sedeDedottaUi,
  }
}

/**
 * Un valore fuori dai quattro noti diventa `null`, non passa così com'è.
 * Chi legge questo campo decide che cosa mostrare in segreteria: meglio «non lo so» che una
 * pill con dentro una stringa che nessuno ha previsto.
 */
function normalizzaFattura(v: unknown): FatturaStato | null {
  return typeof v === 'string' && FATTURA_STATI.has(v) ? (v as FatturaStato) : null
}

/**
 * ─── LA BATCH VA A BLOCCHI, E NON È UNA MICRO-OTTIMIZZAZIONE ────────────────
 *
 * `.in('id', pagIds)` finisce nella QUERY STRING, e un uuid costa ~39 byte una volta
 * codificato. Misurato con un finto PostgREST: 200 id passano (8,2 KB di sola request
 * line), 500 fanno rispondere **431 Request Header Fields Too Large** — 8 KB è il default
 * di nginx per la request line, ed è il muro che si incontra per primo. Il 431 non è un
 * errore PostgREST: arriva senza `code`, con un corpo che non è JSON, quindi il ramo di
 * degrado scattava con un messaggio VUOTO in `app_log`.
 *
 * Oggi in produzione i soli suggerimenti citano già 208 pagamenti distinti. Con i
 * `pagamento_id` dei confermati aggiunti a quell'insieme (2026-09-05) il numero cresce
 * insieme al registro: il tetto non era teorico, era il prossimo import.
 *
 * 100 per blocco tiene la request line sotto i 4 KB con ogni margine, e i blocchi partono
 * INSIEME (`Promise.all`): il costo in latenza è quello di una query sola.
 */
const BLOCCO_PAGAMENTI = 100

/** La finestra di sempre del registro (nessun filtro di fatturazione). */
const LIMITE_REGISTRO = 500

/**
 * La finestra quando `?fattura=` è attivo — e perché è un numero diverso.
 *
 * Il filtro di fatturazione lavora IN MEMORIA (il dato sta su `pagamenti`, non sul
 * registro), quindi si applica a ciò che la query ha già portato a casa. Con 500 righe
 * lette per data decrescente, il giorno in cui i confermati passano 500 le righe più
 * vecchie — cioè proprio quelle dimenticate, le sole che «Da fatturare» esiste per
 * trovare — sparirebbero dall'elenco senza nessun segnale. La lista di lavoro deve
 * guardare tutto il registro, non la sua ultima pagina.
 */
const LIMITE_FATTURAZIONE = 5000

/**
 * `max_rows` di PostgREST: il taglio che il server applica DA SOLO, senza dirlo.
 *
 * È il motivo per cui il troncamento non si può dedurre dal solo `limit` chiesto: si può
 * chiedere 5.001 righe e riceverne 1.000 senza nessun errore e nessun header che lo
 * dichiari. Ricevere esattamente `max_rows` righe è l'unico indizio che resta.
 */
const MAX_ROWS_POSTGREST = 1000

/**
 * La finestra è piena? (solo quando il filtro di fatturazione è attivo)
 *
 * ⚠️ IL LIMITE È UN PARAMETRO, e prima non lo era: confrontava sempre con
 * `LIMITE_FATTURAZIONE` (5.000). Sulla finestra normale — quella che si vede
 * aprendo la Riconciliazione — il registro veniva tagliato a 500 righe e
 * `troncato` restava FALSO, perché 501 non è mai maggiore di 5.000 e la riga in
 * più non veniva nemmeno chiesta. Su un estratto annuale (la testata di
 * `riconciliazione.ts` cita 6.775 accrediti) la lista ne mostrava 500 e non lo
 * diceva a nessuno. Oggi il registro ne ha 239: il difetto è latente, non spento.
 *
 * Due condizioni, per due tagli diversi: la riga in più che chiediamo NOI (ne arriva una
 * oltre il limite ⇒ ce n'erano altre) e il taglio SILENZIOSO di PostgREST (esattamente
 * `max_rows` righe). La seconda ha un falso positivo dichiarato — un registro con esatte
 * 1.000 righe confermate direbbe «ce ne sono altre» — e va bene così: invita a restringere
 * il periodo, mentre il falso negativo (righe sparite in silenzio) è il difetto stesso.
 */
function finestraPiena(righeLette: number, limite: number): boolean {
  return righeLette > limite || righeLette === MAX_ROWS_POSTGREST
}

interface PagamentoAbbinato { id: string; scuola_id: string | null; stato: string | null; fattura_stato: string | null }

/**
 * Spezza un elenco di id in blocchi, li chiede TUTTI INSIEME e riunisce le righe.
 *
 * ⚠️ UN BLOCCO CADUTO = BATCH CADUTA, e non è pigrizia: con una risposta metà arricchita
 * le righe del blocco perduto uscirebbero indistinguibili da quelle che non hanno davvero
 * una fattura — cioè «da fatturare» detto per ignoranza, sulle righe di cui non sappiamo
 * niente. Meglio dichiarare l'intero degrado (`fatturazione_disponibile: false`) che
 * mentire su una metà che nessuno può riconoscere.
 *
 * PostgREST non lancia: l'errore sta nel valore di ritorno, e si guarda blocco per blocco.
 *
 * Qui c'è SOLO il taglio: la query la scrive l'handler, e non per stile. Un `.from()` a
 * livello di modulo esce dal perimetro di `__tests__/architecture/isolamento-sede-coverage`,
 * che ragiona per handler — la lettura resterebbe non dichiarata, cioè invisibile proprio
 * al lock che esiste per vederla.
 */
async function aBlocchi<T>(
  ids: string[],
  chiedi: (blocco: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ righe: T[] | null; errore: unknown }> {
  const blocchi: string[][] = []
  for (let i = 0; i < ids.length; i += BLOCCO_PAGAMENTI) blocchi.push(ids.slice(i, i + BLOCCO_PAGAMENTI))
  const esiti = await Promise.all(blocchi.map((blocco) => chiedi(blocco)))
  const caduto = esiti.find((e) => e.error != null || e.data == null)
  if (caduto) return { righe: null, errore: caduto.error ?? null }
  return { righe: esiti.flatMap((e) => e.data ?? []), errore: null }
}

/**
 * Il codice di un errore, per la riga di log — mai la sua prosa.
 *
 * `error_code` è in lista bianca (`@/lib/logging/redact`) e passa in chiaro solo se ha la
 * forma di un enumerato: ci sta `PGRST301`, non ci sta un messaggio con gli spazi. I numeri
 * passano per tipo, quindi lo status (quando c'è: il 431 non è un errore PostgREST e un
 * `code` non ce l'ha) esce sotto `stato_errore`.
 *
 * Il perché di tutto questo: le due righe del degrado erano `info` senza codice, e sul 431
 * misurato il messaggio persistito era VUOTO — cioè una riga in `app_log` che diceva soltanto
 * «è andata male», su un canale in cui nessuno guarda gli `info`.
 */
function dettaglioErrore(e: unknown): { error_code: string; stato_errore?: number } {
  const err = e as { code?: unknown; status?: unknown } | null
  const codice = typeof err?.code === 'string' && err.code.trim() !== '' ? err.code.trim() : 'sconosciuto'
  const stato = typeof err?.status === 'number' && Number.isFinite(err.status) ? err.status : undefined
  return stato === undefined ? { error_code: codice } : { error_code: codice, stato_errore: stato }
}

/**
 * LA RIGA NELLA FORMA CHE IL MOTORE SI ASPETTA — e il cast sta QUI, in un punto solo.
 *
 * `MovimentoRiga` è volutamente largo (`[k: string]: unknown`): è la riga come torna da
 * PostgREST, più i campi che ci appendiamo. Il motore invece vuole i quattro campi
 * tipizzati. La conversione è un adattatore, non una politica: dentro non c'è nessuna
 * decisione su che cosa sia «fatturato».
 */
function perFatturazione(r: MovimentoArricchito): RigaListaDiLavoro {
  return {
    // Lo stato del MOVIMENTO, non della fattura: senza, chi compone la lista di
    // lavoro dovrebbe rimetterci sopra la propria congiunzione — ed è la seconda
    // copia che il lock esiste per impedire.
    stato: r.stato,
    pagamento_id: typeof r.pagamento_id === 'string' && r.pagamento_id !== '' ? r.pagamento_id : null,
    pagamento_stato: r.pagamento_stato,
    fattura_stato: r.fattura_stato,
    fattura: (r.fattura ?? null) as FatturaMovimentoUi | null,
  }
}

/**
 * IL FILTRO CHIEDE AL MOTORE, esattamente come il chip — e non è una comodità.
 *
 * Si applica IN MEMORIA, dopo l'arricchimento, e non può essere altrimenti: il dato su cui
 * filtra non sta su `riconciliazione_movimenti` ma su `pagamenti`, e PostgREST non filtra
 * una tabella per una colonna dell'altra senza una join che qui non esiste (il legame è
 * `pagamento_id`, nullable). Il costo è nullo: le righe sono al massimo 500 (`.limit(500)`),
 * 5.000 quando `?fattura=` è attivo.
 *
 * Fino al 2026-09-06 questa politica era scritta qui una seconda volta, e le due copie
 * divergevano sul DOCUMENTO SINTETICO: qui sotto ogni riga abbinata riceve
 * `{ stato: 'da_fatturare', numeri: [] }` quando in `fatture_emesse` non c'è nessuna
 * riga, quindi «un documento» c'era sempre e il ripiego sul riassunto non scattava mai.
 * Il chip invece ci ripiega ogni volta che il documento non dice `emessa`/`scartata`.
 *
 * Il caso in cui si contraddicevano è quello che `src/lib/aruba/emissione.ts` chiama «il
 * caso più velenoso» (fattura partita, `fatture_emesse` non scritta, `fattura_stato` a
 * `in_attesa` senza documento): il chip diceva «In attesa SDI», il filtro la spediva fra
 * le «Da fatturare e scartate» — dove non si può agire, perché su `in_attesa` il pulsante
 * di emissione non c'è — e la toglieva da «Fatturate e in attesa», che è l'elenco con cui
 * si controlla che le fatture siano uscite. Lock:
 * `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts` (di copie
 * ce n'è una) e `__tests__/pagamenti/riconciliazione-ui.test.ts` (le 75 combinazioni su
 * cui chip e filtro non si contraddicono mai).
 */
function filtraFattura(
  righe: MovimentoArricchito[],
  fattura: 'da_fatturare' | 'fatturate' | undefined,
): MovimentoArricchito[] {
  if (!fattura) return righe
  // `da_fatturare` pretende anche il movimento CONFERMATO e il pagamento SALDATO: su un
  // pagamento parziale la fattura non si emette, e mostrarlo fra i «da fatturare»
  // manderebbe l'operatore contro un rifiuto. È una regola della LISTA DI LAVORO, non
  // della fattura — e dal 2026-09-07 sta nel motore insieme all'altra, perché le caselle
  // del lotto di fatture (`RiconciliazionePanel`) devono spuntare esattamente le righe
  // che questo filtro mostra: la stessa congiunzione scritta in due file è la divergenza
  // che il lock `fatturazione-riconciliazione-un-motore-solo` racconta di sé stesso.
  if (fattura === 'da_fatturare') {
    return righe.filter((r) => daFatturareInListaDiLavoro(perFatturazione(r)))
  }
  return righe.filter((r) => fatturaGiaFatta(perFatturazione(r)))
}

const OPERAZIONE_GET = 'pagamenti/riconciliazione:GET'

/** Le sole colonne di `fatture_emesse` che servono al chip: nessun intestatario, nessun XML. */
const FATTURE_SELECT = 'pagamento_id, numero, anno, sezionale, sdi_stato, quota_adult_id'

interface RigaFatturaMovimento {
  pagamento_id: string
  numero: number | null
  anno: number | null
  sezionale: string | null
  sdi_stato: number | null
  quota_adult_id: string | null
}

/**
 * Lo stato della fatturazione di UN movimento già abbinato, come lo legge la lista.
 *
 * È il TIPO DEL CLIENT, importato e non ricopiato: questa forma viaggia nel JSON del GET
 * e il chip la legge dall'altra parte. Due dichiarazioni gemelle in due file resterebbero
 * uguali finché qualcuno non ne cambia una — e il compilatore non direbbe niente, perché
 * fra i due estremi c'è un `JSON.parse`.
 */
type FatturaMovimento = FatturaMovimentoUi

/**
 * IL NUMERO SCRITTO COM'È SUL DOCUMENTO — e le righe storiche che non hanno un sezionale.
 *
 * `formattaNumeroFattura` LANCIA su un sezionale che non sia `Asilo` o `FPR`, e in
 * `fatture_emesse` la colonna è nullable: le righe scritte prima del 09/08 non ce l'hanno.
 * Farla lanciare qui vorrebbe dire un 500 sull'INTERA lista dei movimenti per una riga
 * vecchia — la lista sparirebbe per colpa di un'etichetta. Quindi il sezionale si verifica
 * prima di chiamarla, e senza si ripiega su `numero/anno`, che è come quel documento è
 * sempre stato citato.
 */
function numeroLeggibile(r: RigaFatturaMovimento): string | null {
  const numero = Number(r.numero)
  const anno = Number(r.anno)
  if (!Number.isInteger(numero) || numero < 1) return null
  if (!Number.isInteger(anno) || anno < 1000 || anno > 9999) return null
  if (r.sezionale === 'Asilo' || r.sezionale === 'FPR') {
    return formattaNumeroFattura(r.sezionale, numero, anno)
  }
  return `${numero}/${anno}`
}

/**
 * Da righe di `fatture_emesse` allo stato per PAGAMENTO.
 *
 * Le righe VIVE sono quelle che non sono uno scarto SDI (2/4/9), stessa definizione di
 * `emissione.ts`: uno scarto non è un documento in circolazione, è un tentativo fallito che
 * si riemette. Poi una riga per QUOTA, tenendo il numero massimo (un pagamento ripartito fra
 * due genitori ha due fatture, e una quota riemessa dopo uno scarto non deve comparire due
 * volte) — la stessa regola di `pagamenti/fattura/list`.
 *
 * ⚠️ «Nessuna riga viva» e «nessuna riga affatto» sono stati DIVERSI: la prima è una fattura
 * scartata da riemettere, la seconda un bonifico che non è mai stato fatturato. Confonderle
 * farebbe sembrare «da fare» un lavoro già fatto e finito male.
 */
function fattureDeiPagamenti(righe: RigaFatturaMovimento[]): Map<string, FatturaMovimento> {
  // pagamento → (quota → riga viva col numero più alto). La mappa esiste anche quando è
  // VUOTA: è la differenza fra «tutte scartate» e «mai fatturato».
  const vivePerPagamento = new Map<string, Map<string, RigaFatturaMovimento>>()
  for (const r of righe) {
    const pid = r.pagamento_id
    if (typeof pid !== 'string' || pid === '') continue
    let vive = vivePerPagamento.get(pid)
    if (!vive) {
      vive = new Map<string, RigaFatturaMovimento>()
      vivePerPagamento.set(pid, vive)
    }
    if (r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto) continue
    const quota = r.quota_adult_id ?? '__unica__'
    const corrente = vive.get(quota)
    if (!corrente || Number(r.numero ?? 0) >= Number(corrente.numero ?? 0)) vive.set(quota, r)
  }
  const out = new Map<string, FatturaMovimento>()
  for (const [pid, vive] of vivePerPagamento) {
    if (vive.size === 0) {
      out.set(pid, { stato: 'scartata', numeri: [] })
      continue
    }
    const numeri = [...vive.values()]
      .sort((a, b) => Number(a.numero ?? 0) - Number(b.numero ?? 0))
      .map(numeroLeggibile)
      .filter((n): n is string => n !== null)
    out.set(pid, { stato: 'emessa', numeri })
  }
  return out
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
//
// ─── E TRE COSE CHE IL PRIMO GIRO AVEVA SBAGLIATO (2026-09-05, tre report) ───────────────
//  1. LA BATCH VA A BLOCCHI (`BLOCCO_PAGAMENTI`): una `.in()` con 500 uuid sfonda gli 8 KB
//     della request line e torna 431 — cioè degrado, cioè lista vuota.
//  2. IL DEGRADO NON FILTRA (vedi il ramo `errSedi`): su righe il cui `fattura_stato` è null
//     PER COSTRUZIONE, `?fattura=da_fatturare` rispondeva «niente da fatturare».
//  3. LA FINESTRA SEGUE IL FILTRO (`LIMITE_FATTURAZIONE`, `troncato`): filtrare in memoria
//     dopo 500 righe nascondeva le più vecchie, che sono esattamente quelle dimenticate.
export const GET = withRoute('pagamenti/riconciliazione:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()

    /**
     * IL FILTRO DI FATTURAZIONE CAMBIA LA FINESTRA, non solo ciò che si tiene.
     *
     * Filtrando in memoria dopo un `.limit(500)`, «Da fatturare» rispondeva sulle ultime
     * 500 righe per data: le più vecchie — quelle che nessuno ha fatturato, cioè le sole
     * che questa lista serve a trovare — restavano fuori senza un segnale. Quindi quando
     * `?fattura=` è attivo si restringe alla riga che può portare quel dato
     * (`stato=confermato`, gli unici su cui la fatturazione esista) e si alza il tetto.
     */
    const filtroFattura = q.data.fattura
    /**
     * `?conteggi=1`: si conta, non si elenca. Stessa finestra e stesso motore del
     * filtro — è l'unico modo perché il numero sulla pillola e l'elenco che la pillola
     * apre non possano dire due cose diverse — ma con una SELECT leggera e `data: []`.
     */
    const soloConteggi = q.data.conteggi === '1'
    // I due casi che guardano l'INTERO registro dei confermati, e non la sua ultima
    // pagina: il filtro di fatturazione e il conteggio che lo precede.
    const finestraFatturazione = Boolean(filtroFattura) || soloConteggi
    const limite = finestraFatturazione ? LIMITE_FATTURAZIONE : LIMITE_REGISTRO
    // La riga in più si chiede SEMPRE, non solo sulla finestra larga: è l'unico
    // modo per sapere che ce n'erano altre, e costa una riga.
    const limiteChiesto = limite + 1
    /**
     * LE COLONNE DEL CONTEGGIO SONO TRE, E `suggerimenti` NON È FRA LORO.
     *
     * `suggerimenti` è il JSONB della tabella — l'elenco dei candidati con nome del
     * minore, punteggio e motivi — cioè di gran lunga la colonna più pesante di una
     * riga di registro. Il motore della fatturazione non la guarda mai: gli servono
     * `pagamento_id` (per legare il pagamento), `stato` (i confermati) e `id`. Chiederla
     * per un conteggio vorrebbe dire trasportare fino a 5.000 blob per restituire due
     * interi — e portarsi dietro nomi di minori che nessuno leggerà.
     */
    const COLONNE_CONTEGGIO = 'id, stato, pagamento_id'
    const COLONNE_REGISTRO = 'id, import_id, scuola_id, data_operazione, importo, causale, controparte, stato, suggerimenti, pagamento_id, confermato_il'
    /**
     * ⚠️ IL CAST SU UNA STRINGA, ED È L'UNICO MODO DI TENERE INSIEME DUE COSE VERE.
     *
     * Il tipo di `.select()` di supabase-js PARSA le colonne a compile time, e
     * pretende un LETTERALE: con un ternario fra due letterali gli arriva
     * un'unione e `tsc` cade con un `ParserError`; allargando a `string` deduce
     * `GenericStringError[]` e cade lo stesso, tre righe più sotto, con un
     * messaggio che non nomina né la fatturazione né il conteggio.
     *
     * Si dichiara quindi la forma PIÙ RICCA (il registro intero) e la si
     * restringe subito dopo a `MovimentoRiga`, dove ogni campo è opzionale: sul
     * ramo del conteggio le colonne non chieste sono `undefined`, che è
     * esattamente ciò che sono. Nessun codice raggiunto dal conteggio le legge —
     * il motore della fatturazione guarda `stato`, `pagamento_id` e i due campi
     * che gli appendiamo noi.
     */
    const colonne = (soloConteggi ? COLONNE_CONTEGGIO : COLONNE_REGISTRO) as typeof COLONNE_REGISTRO
    let query = supabase
      .from('riconciliazione_movimenti')
      .select(colonne)
      .order('data_operazione', { ascending: false })
      .limit(limiteChiesto)
    // `?fattura=` implica `stato=confermato` e lo IMPONE. Non contraddice `?stato=`: la
    // fatturazione esiste solo sui confermati, quindi ogni altra combinazione darebbe zero
    // righe anche filtrando in memoria (l'interfaccia infatti azzera il sottofiltro quando
    // si sceglie un altro stato). Imporlo qui serve alla FINESTRA: restringere la query è
    // ciò che permette di alzarne il tetto senza leggere tutto il registro.
    const statoRichiesto = finestraFatturazione ? 'confermato' : q.data.stato
    if (statoRichiesto) query = query.eq('stato', statoRichiesto)
    if (q.data.import_id) query = query.eq('import_id', q.data.import_id)
    if (q.data.importoDa !== undefined) query = query.gte('importo', q.data.importoDa)
    if (q.data.importoA !== undefined) query = query.lte('importo', q.data.importoA)
    // La ricerca sta sul SERVER, non in memoria, per tre ragioni: in memoria
    // filtrerebbe una pagina già tagliata (un filtro che mente, il difetto n°3 che
    // questa rotta ha già pagato su `?fattura=`); l'`ilike` restringe PRIMA del
    // `.limit()`, quindi rende il troncamento meno probabile invece che più
    // insidioso; e l'evasione dei metacaratteri esiste già in un posto solo.
    //
    // ⚠️ La guardia `if (condizioni)` non è cosmetica: una ricerca fatta di sole
    // virgole si riduce a stringa vuota, e `.or('')` è un filtro che passa TUTTO
    // scritto come se restringesse.
    //
    // Il termine NON entra in nessun log: 105 movimenti su 239 hanno un codice
    // fiscale in forma esatta dentro causale o ordinante.
    const termine = termineOr(q.data.q ?? '')
    const condizioni = termine ? orIlike(['causale', 'controparte'], termine) : ''
    if (condizioni) query = query.or(condizioni)
    if (q.data.da) query = query.gte('data_operazione', q.data.da)
    if (q.data.a) query = query.lte('data_operazione', q.data.a)

    const { data, error } = await query
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) {
        // Il registro non esiste su questo database: non c'è niente da contare, e
        // `null` lo dice — uno zero direbbe «nessuna fattura da fare», che è un'altra
        // affermazione e sarebbe falsa.
        return NextResponse.json({ success: true, data: [], disponibile: false, ...(soloConteggi ? { conteggi: null } : {}) })
      }
      return NextResponse.json({ error: 'Errore nel recupero dei movimenti' }, { status: 500 })
    }
    const lette = (data || []) as MovimentoRiga[]
    // La riga in più chiesta sopra non si mostra: serve solo a sapere che c'era.
    const troncato = finestraPiena(lette.length, limite)
    const finestra = lette.slice(0, limite)
    if (troncato) {
      // `warn`, non `info`: la lista di lavoro sta nascondendo delle righe, e chi la usa
      // per non saltare una fattura deve poterlo sapere anche dai log, non solo a schermo.
      logEvento('pagamento', 'warn', {
        operazione: OPERAZIONE_GET,
        esito: 'finestra_piena',
        righe: finestra.length,
        // `tipo` è in lista bianca (`redact`) e dice QUALE taglio è pieno: una chiave
        // fuori lista uscirebbe `[redatto:str/12]`, cioè un campo che occupa posto e
        // non risponde a niente.
        tipo: filtroFattura ?? (soloConteggi ? 'conteggi' : 'registro'),
      })
    }

    // ─── LO STATO DELLA FATTURA, DAI DOCUMENTI (2026-09-05, fusione con la PR #118) ──
    //
    // Sono DUE letture e due domande diverse, e nessuna delle due sostituisce l'altra:
    //   · `pagamenti.fattura_stato` (la batch qui sotto) è il riassunto scritto
    //     dall'emissione: dice «in attesa» / «da fatturare» e, con lo stato del
    //     pagamento, se c'è davvero qualcosa da fare;
    //   · `fatture_emesse` (questa) sono i DOCUMENTI registrati, quota per quota, col
    //     loro NUMERO — «Fattura FPR 1947/26» dice quale documento cercare, «Fatturata»
    //     no — e con lo stato SdI vero, che su un riassunto fermo a `emessa` non si vede.
    //
    // Le due sono INDIPENDENTI di proposito: se cade solo questa il chip ripiega sugli
    // stati del pagamento (`fatturazione_disponibile` resta `true`, il filtro ha
    // lavorato); se cade solo la batch valgono i documenti e il degrado dichiarato.
    // Confonderle in una sola lettura vorrebbe dire perdere entrambe insieme.
    //
    // «Già abbinato» è `pagamento_id != null` (lo scrive solo la conferma). Per quelle
    // righe si legge `fatture_emesse` una volta per l'intera pagina — mai una query per
    // riga: 500 movimenti confermati farebbero 500 round-trip su una lista che oggi ne fa
    // una. Se nessuna riga è abbinata non si interroga affatto.
    //
    // Si leggono solo NUMERO e STATO: nessun intestatario, nessun importo, nessun XML.
    // La riga bancaria è globale per tutte le segreterie (l'estratto conto è uno), quindi
    // ciò che si aggiunge qui deve restare non identificante — il nome del minore vive nei
    // `suggerimenti`, ed è lì che continua a essere filtrato per sede.
    //
    // ⚠️ A BLOCCHI, con lo STESSO helper della batch su `pagamenti` (`aBlocchi`), e non
    // per simmetria: gli id finiscono nella query string, e con `?fattura=` la finestra
    // sale a `LIMITE_FATTURAZIONE` — cioè fino a 5.000 pagamenti abbinati, dove una `.in()`
    // sola sfonderebbe gli 8 KB della request line e tornerebbe 431 (vedi la nota su
    // `BLOCCO_PAGAMENTI`). Sotto i 100 id resta una query sola, come prima.
    //
    // ⚠️ LIMITE DICHIARATO, perché nessuno lo scopra da solo: PostgREST tronca le risposte
    // lunghe (`db-max-rows`, oggi 1000) SENZA dirlo. Ogni blocco chiede al massimo 100
    // pagamenti, quindi morderebbe solo se quei 100 avessero in media più di dieci righe di
    // fattura a testa (quote di genitori separati + riemissioni dopo uno scarto); allora le
    // righe non arrivate diventerebbero «da fatturare» — un «no» falso e silenzioso. Il
    // rilevatore, se un giorno servisse, è `{ count: 'exact' }` confrontato con le righe
    // ricevute, e il degrado onesto è lo stesso della lettura fallita: `fattura: null`.
    const pagamentiAbbinati = [...new Set(
      finestra
        .map((r) => r.pagamento_id)
        .filter((v): v is string => typeof v === 'string' && v !== ''),
    )]
    // `null` non è «da fatturare»: è «non lo so». Sono due chip diversi, e uno dei due
    // sarebbe una bugia detta con sicurezza.
    let fattureDi: Map<string, FatturaMovimento> | null = new Map()
    if (pagamentiAbbinati.length > 0) {
      const { righe: fatture, errore: errFatture } = await aBlocchi<RigaFatturaMovimento>(
        pagamentiAbbinati,
        (blocco) => supabase.from('fatture_emesse').select(FATTURE_SELECT).in('pagamento_id', blocco),
      )
      if (errFatture || !fatture) {
        fattureDi = null
        const codice = (errFatture as { code?: string } | null)?.code ?? ''
        // Sul DB E2E della CI la colonna `sezionale` può non esistere: è una
        // configurazione attesa, non un guasto. Tutto il resto sì.
        if (SCHEMA_MANCANTE.has(codice)) {
          logEvento('pagamento', 'info', {
            operazione: OPERAZIONE_GET,
            esito: 'fatture_movimenti_schema_assente',
            n: pagamentiAbbinati.length,
          }, errFatture)
        } else {
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE_GET,
            esito: 'fatture_movimenti_non_risolte',
            n: pagamentiAbbinati.length,
          }, errFatture)
        }
      } else {
        fattureDi = fattureDeiPagamenti(fatture)
      }
    }
    // L'arricchimento sta QUI, prima di ogni uscita: sotto ce ne sono tre (nessun
    // pagamento da risolvere, sedi non risolte, elenco minimizzato) e la fattura deve
    // comparire su tutte e tre. Una riga NON abbinata non porta il campo affatto: assente e
    // «da fatturare» sono cose diverse anche per il client.
    const righe: MovimentoRiga[] = finestra.map((r) => {
      const pid = typeof r.pagamento_id === 'string' && r.pagamento_id !== '' ? r.pagamento_id : null
      if (!pid) return r
      if (fattureDi === null) return { ...r, fattura: null }
      return { ...r, fattura: fattureDi.get(pid) ?? { stato: 'da_fatturare', numeri: [] } }
    })


    /**
     * I DUE NUMERI DELLE PILLOLE — o `null`, che è una risposta e non un guasto.
     *
     * ⚠️ REGOLA 1: se la fatturazione non si è potuta leggere si risponde `null`, mai
     * `{ da_fatturare: 0, fatturate: 0 }`. Uno zero su una pillola è un'AFFERMAZIONE
     * («non ne resta nessuna da fare») e qui non la sappiamo: un numero non letto è un
     * numero inventato.
     *
     * ⚠️ REGOLA 2: se la finestra era piena i numeri escono lo stesso, ma con
     * `parziale: true` — la schermata scriverà «≥ 12» e mai «12». Un minimo è vero e
     * utile; un parziale che sembra un totale è la bugia peggiore di questa schermata,
     * perché una fattura saltata non la ferma nessuna guardia.
     *
     * ⚠️ La TERZA regola non è qui, e non ci può stare: la pillola «Tutte» non porta
     * nessun numero. Non è un bidone — è l'assenza del filtro — e contarci dentro la
     * finestra corrente risponderebbe a una domanda diversa da quella che sembra.
     * Quella regola vive dove si disegna la pillola (`numeroPillolaFattura`).
     *
     * Si conta chiedendo al MOTORE, con la stessa funzione che filtra: un `.filter()`
     * scritto qui sarebbe la seconda tabella di verità che il lock
     * `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts` vieta,
     * e il numero sulla pillola potrebbe smentire l'elenco che la pillola apre.
     */
    function conteggiDi(arricchite: MovimentoArricchito[], fatturazioneDisponibile: boolean) {
      if (!fatturazioneDisponibile) return null
      return {
        da_fatturare: filtraFattura(arricchite, 'da_fatturare').length,
        fatturate: filtraFattura(arricchite, 'fatturate').length,
        parziale: troncato,
      }
    }

    /**
     * La risposta del GET, in un posto solo — e riceve le righe ARRICCHITE, mai già
     * filtrate.
     *
     * ⚠️ IL FILTRO È QUI DENTRO, E NON PER COMODITÀ. La regola «quando la fatturazione
     * non si è potuta leggere NON si filtra» era una disciplina di chi scriveva il ramo:
     * ogni `return` doveva ricordarsene, e il giorno in cui uno se ne dimenticò
     * `?fattura=da_fatturare` rispose l'elenco VUOTO su righe il cui `fattura_stato` era
     * `null` per costruzione — cioè «non c'è niente da fatturare» detto dalla funzione
     * nata per impedire che una fattura venga saltata. Legandola al flag che DICHIARA il
     * degrado, la regola non si può più dimenticare: `fatturazione_disponibile === false`
     * significa insieme «non ho filtrato» e «te lo sto dicendo».
     *
     * `fatturazione_disponibile` esce SEMPRE, per la stessa ragione per cui escono sempre
     * `pagamento_stato` e `fattura_stato`: senza, il client non può distinguere «filtrato,
     * e non c'è niente» da «non ho potuto filtrare» — e le due cose a schermo diventavano
     * la stessa frase, «Nessun movimento in questo stato».
     *
     * ⚠️ E I DUE NUMERI SI CONTANO SULLE RIGHE NON FILTRATE, non su `dati`: sono le due
     * risposte alla domanda «se premo questa pillola, quante ne trovo?», e una delle due
     * riguarda sempre il bidone che in questo momento NON è aperto.
     */
    /**
     * ⚠️ I NOMI DELLE SEDI STANNO NELLA BUSTA, NON SU OGNI RIGA.
     *
     * Il filtro per sede ha bisogno del nome anche per le righe CONFERMATE, dove
     * `sede_dedotta` è `null` per decisione (lì la sede è nota, non dedotta):
     * appendere il nome a ogni riga lascerebbe senza nome proprio quelle. E su 500
     * righe sarebbe lo stesso nome ripetuto cinquecento volte.
     *
     * Solo `id → nome`: nessun indirizzo, nessun dato di sede oltre a come si
     * chiama — che è già quello che il pannello mostra da sempre nell'avviso
     * «sembra di un'altra sede».
     */
    const sediPerNome: Record<string, string> = {}
    const rispondi = (arricchite: MovimentoArricchito[], fatturazioneDisponibile: boolean) => {
      const dati = fatturazioneDisponibile ? filtraFattura(arricchite, filtroFattura) : arricchite
      return NextResponse.json({
        success: true,
        sedi: sediPerNome,
        // Al conteggio le righe non servono: chiederle e poi buttarle sarebbe traffico
        // pagato per niente su una finestra che arriva a 5.000.
        data: soloConteggi ? [] : dati,
        fatturazione_disponibile: fatturazioneDisponibile,
        ...(troncato ? { troncato: true } : {}),
        ...(soloConteggi ? { conteggi: conteggiDi(arricchite, fatturazioneDisponibile) } : {}),
      })
    }

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
    // Nessun pagamento citato da nessuna parte: niente da risolvere, ma i due campi escono
    // lo stesso — e la fatturazione è «disponibile»: non c'è nessun guasto da dichiarare,
    // il filtro ha guardato tutto ciò che c'era.
    if (pagIds.length === 0) {
      return rispondi(righe.map((r) => conFatturazione(r)), true)
    }

    const sediAttive = new Set(await resolveScuoleAttive(request, supabase, auth.user))
    // A BLOCCHI DI `BLOCCO_PAGAMENTI`, mai in una `.in()` sola: gli id finiscono nella query
    // string, e 500 uuid la fanno rifiutare con un 431 (vedi la nota sulla costante).
    const { righe: pagSedi, errore: errSedi } = await aBlocchi<PagamentoAbbinato>(pagIds, (blocco) =>
      supabase.from('pagamenti').select('id, scuola_id, stato, fattura_stato').in('id', blocco))
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
      //
      // ⚠️ `warn`, non più `info`, e col CODICE dell'errore accanto. Un `info` è un fatto
      // normale — qui invece la schermata sta perdendo un dato — e senza codice la riga in
      // `app_log` diceva soltanto «è andata male»: sul 431 misurato (query string troppo
      // lunga, vedi `BLOCCO_PAGAMENTI`) il messaggio persistito era perfino vuoto.
      const dettaglio = dettaglioErrore(errSedi)
      logEvento('pagamento', 'warn', { operazione: OPERAZIONE_GET, esito: 'sedi_suggerimenti_non_risolte', ...dettaglio }, errSedi)
      logEvento('pagamento', 'warn', {
        operazione: OPERAZIONE_GET,
        esito: 'fatturazione_movimenti_non_risolta',
        ...dettaglio,
        // Quante righe verdi restano senza stato di fatturazione: è la misura del buco,
        // e distingue «due righe» da «tutto il registro».
        confermate_senza_stato: confermateConPagamento.length,
      }, errSedi)
      // ⚠️ E `altra_sede` RESTA `null` SU TUTTE LE RIGHE (è il default di
      // `conFatturazione`), che è la terza conseguenza della stessa query caduta e
      // merita di essere detta: senza la mappa non si sa né chi è dentro né chi è
      // fuori, quindi «questo bonifico sembra di un'altra sede» qui sarebbe un
      // verdetto INVENTATO — e nominerebbe un plesso a caso a una segreteria che
      // non ha modo di verificarlo. Il campo esce lo stesso, a `null`: «non lo so».
      const oscurati = righe.map((r) =>
        conFatturazione(
          r.suggerimenti ? { ...r, suggerimenti: r.suggerimenti.map((s) => ({ ...s, label: null })) } : r,
        ),
      )
      /**
       * ⚠️ QUI NON SI FILTRA, ED È IL CUORE DELLA CORREZIONE.
       *
       * Su queste righe `fattura_stato` è `null` PER COSTRUZIONE — non perché la fattura
       * manchi, ma perché non l'abbiamo potuta leggere. Applicarci `filtraFattura` con
       * `?fattura=da_fatturare` restituiva l'elenco VUOTO, che a schermo diventava «Nessun
       * movimento in questo stato»: cioè «non c'è niente da fatturare», detto proprio dalla
       * funzione nata per impedire che una fattura venga saltata. `null` vuol dire «non lo
       * so» e non si può leggere come «no».
       *
       * Il `false` qui sotto è ciò che lo IMPEDISCE, e non solo ciò che lo dichiara: da
       * quando i due numeri delle pillole si contano nella stessa funzione, `rispondi`
       * salta il filtro esattamente quando la fatturazione non è disponibile — e per la
       * stessa ragione i conteggi escono `null` invece che a zero. Il client mostra la
       * lista intera, non scrive nessun numero, e dice sopra che il filtro non è stato
       * applicato.
       */
      return rispondi(oscurati, false)
    }
    const pagDi = new Map(pagSedi.map((p) => [p.id, p]))

    /**
     * ─── «QUESTO BONIFICO SEMBRA DI UN'ALTRA SEDE» (2026-09-07) ──────────────
     *
     * IL DIFETTO, misurato in produzione: i suggerimenti si calcolano contro i
     * pagamenti aperti di TUTTE le sedi — deliberato, l'estratto conto della
     * banca è unico — ma qui sotto si tengono solo quelli della PROPRIA sede.
     * Rimisurato il 2026-09-07: su 236 movimenti con suggerimenti, 86 hanno
     * candidati in più plessi e, per l'operatore di Giugliano, **64 righe non
     * confermate hanno l'aggancio forte altrove e candidati locali deboli** — 64
     * righe che lo invitavano a registrare l'incasso sulla voce di un bambino di
     * un altro plesso. (I «234 / 85 / 67» scritti qui prima erano di qualche ora
     * prima e comprendevano le confermate: il registro cresce, e un numero senza
     * data né perimetro invecchia in silenzio.)
     *
     * ⚠️ IL VERDETTO SI CALCOLA QUI, PRIMA DEL `.filter()` QUI SOTTO. Dopo,
     * l'informazione non c'è più: il filtro toglie proprio i candidati fuori sede
     * su cui la domanda si pone. Non è una preferenza d'ordine, è l'unico punto
     * in cui il dato esiste.
     *
     * ⚠️ COSTA ZERO QUERY: la mappa `pagamento → scuola_id` è quella che la batch
     * qui sopra ha già letto per minimizzare i label. La sola lettura in più è
     * quella dei NOMI delle sedi nominate, e solo quando ce n'è almeno una.
     *
     * La regola (soglia, distacco, ignoti, cf_match) vive tutta in
     * `agganciaFuoriSede`, con le STESSE due soglie del matcher: qui c'è solo
     * l'adattatore fra la riga come torna da PostgREST — dove `score` e
     * `cf_match` sono `unknown`, perché `suggerimenti` è un JSONB — e i candidati
     * che la funzione pura si aspetta.
     *
     * ⚠️ SU UNA RIGA GIÀ CONFERMATA NON SI CHIEDE NIENTE, e non è un'ottimizzazione.
     * Questo campo esiste per impedire un abbinamento sbagliato PRIMA che venga
     * fatto — il riquadro del popup vive dentro `{puoAbbinare && …}`, il chip di
     * riga dice «questa non la lavori tu». Su una riga confermata la scelta è
     * fatta e i `suggerimenti` sono la fotografia dell'import: calcolare il
     * verdetto lì marcava «sembra di un'altra sede» anche la riga PIÙ
     * correttamente lavorata che esista — confermata su un pagamento della propria
     * sede. Restava invisibile solo perché nessuno montava il chip; montandolo
     * (2026-09-07) sarebbe diventato un falso allarme su una riga giusta.
     * `ignorato` invece resta: quella riga si può ancora abbinare.
     */
    const verdetti = righe.map((r) =>
      r.stato === 'confermato' ? null : agganciaFuoriSede(
        (r.suggerimenti ?? []).map((s) => ({
          pagamento_id: s.pagamento_id,
          score: Number(s.score) || 0,
          cf_match: s.cf_match === true,
        })),
        (pagamentoId: string) => pagDi.get(pagamentoId)?.scuola_id,
        sediAttive,
      ),
    )

    /**
     * ─── DI QUALE SEDE SEMBRA, PER IL FILTRO (2026-09-07) ────────────────────
     *
     * `riconciliazione_movimenti.scuola_id` è NULL finché il movimento non viene
     * confermato: il registro è cross-sede per progetto, e la sede si assegna solo
     * alla conferma. Quindi per le righe che l'operatore deve ancora lavorare —
     * cioè per il lavoro — la sede non esiste come colonna, e si può solo DEDURRE
     * dai suggerimenti.
     *
     * ⚠️ SOLO SULLE RIGHE NON CONFERMATE, esattamente come `agganciaFuoriSede`, e
     * per la stessa ragione scritta qui sopra: su una confermata i `suggerimenti`
     * sono la fotografia dell'import, e dedurne la sede rimetterebbe in piedi
     * proprio il falso positivo che quel paragrafo racconta. E non serve: sulle
     * confermate `scuola_id` sta GIÀ sulla riga (è in `COLONNE_REGISTRO`), quindi
     * è nota, non dedotta.
     *
     * ⚠️ SI CALCOLA PRIMA DELLA MINIMIZZAZIONE, come il verdetto di perimetro:
     * dopo, i candidati fuori sede sono stati tolti e l'informazione non c'è più.
     */
    const sediDedotte = righe.map((r) =>
      r.stato === 'confermato' ? null : sedeDedotta(
        (r.suggerimenti ?? []).map((s) => ({
          pagamento_id: s.pagamento_id,
          score: Number(s.score) || 0,
          cf_match: s.cf_match === true,
        })),
        (pagamentoId: string) => pagDi.get(pagamentoId)?.scuola_id,
      ),
    )

    /**
     * IL NOME DELLA SEDE — una `.in()` sugli id distinti, come fa `GET /api/pagamenti`.
     *
     * Nessun blocco da 100 qui, e non per dimenticanza: le sedi dell'intero
     * registro sono TRE (più le due di prova), quindi `idSediFuori` non può
     * superare quel numero — la request line resta di poche decine di byte, e il
     * 431 che ha imposto `aBlocchi` sui pagamenti non è raggiungibile.
     *
     * ⚠️ IL DEGRADO È `nome: null`, MAI UNA STRINGA INVENTATA: la schermata dirà
     * «sembra di un'altra sede» senza nominarla, che è vero. Un placeholder tipo
     * «un'altra sede» scritto qui sarebbe indistinguibile da un nome davvero
     * letto, e il giorno in cui una sede si chiamasse così nessuno lo saprebbe.
     * `warn` e non `info`: la schermata sta perdendo un dato che aveva.
     */
    /**
     * ⚠️ SI CHIEDONO I NOMI DI TUTTE LE SEDI CITATE, non solo di quelle «fuori».
     * `idSediFuori` conteneva soltanto i plessi per cui il verdetto di perimetro
     * era scattato: non la sede di casa, non quelle dedotte sotto la soglia del
     * verdetto, non quelle delle righe confermate. Con quella lista il filtro per
     * sede sarebbe nato senza nome proprio sulle righe che l'operatore usa di più.
     *
     * Resta UNA query: le sedi dell'intero registro sono tre più le due di prova,
     * quindi la `.in()` cresce di poche decine di byte.
     */
    const idSediCitate = [...new Set([
      ...verdetti.filter((v): v is VerdettoAltraSede => v !== null).map((v) => v.scuola_id),
      ...sediDedotte.filter((v): v is NonNullable<typeof v> => v !== null).map((v) => v.scuola_id),
      ...righe.map((r) => r.scuola_id).filter((x): x is string => typeof x === 'string' && x !== ''),
    ])]
    const nomiSedi = new Map<string, string>()
    if (idSediCitate.length > 0) {
      // PostgREST non lancia: l'errore sta nel valore di ritorno, e si guarda.
      const { data: sedi, error: errNomi } = await supabase.from('scuole').select('id, nome').in('id', idSediCitate)
      if (errNomi || !sedi) {
        logEvento('pagamento', 'warn', {
          operazione: OPERAZIONE_GET,
          esito: 'sedi_nome_non_risolto',
          n: idSediCitate.length,
          ...dettaglioErrore(errNomi),
        }, errNomi)
      } else {
        for (const s of sedi as { id: string; nome: string | null }[]) {
          if (typeof s.nome === 'string' && s.nome.trim() !== '') {
            nomiSedi.set(s.id, s.nome)
            sediPerNome[s.id] = s.nome
          }
        }
      }
    }

    const minimizzate = righe.map((r, i) => {
      const verdetto = verdetti[i]
      const altraSede: AltraSedeUi | null = verdetto
        ? { nome: nomiSedi.get(verdetto.scuola_id) ?? null }
        : null
      /**
       * ⚠️ LA CHIAVE È L'UUID, il nome è solo per gli occhi. Spedire il nome da
       * solo vorrebbe dire filtrare confrontando stringhe che degradano già a
       * `null` quando la lettura delle sedi cade: il filtro metterebbe nello
       * stesso bidone due sedi ignote e una sede vera senza nome.
       *
       * ⚠️ ESCE SEMPRE, anche a `null` — la stessa regola degli altri campi
       * derivati: `undefined` significherebbe insieme «non ho una sede» e «questa
       * risposta non porta l'informazione», che sono opposti, e il pannello deve
       * poter distinguere «l'app non ha capito» da «non ho potuto chiedere».
       */
      const dedotta = sediDedotte[i]
      const sedeDedottaUi: SedeDedottaUi | null = dedotta
        ? { scuola_id: dedotta.scuola_id, certa: dedotta.certa }
        : null
      const conSuggerimenti = r.suggerimenti
        ? {
            ...r,
            suggerimenti: r.suggerimenti.filter((s) => {
              const sede = pagDi.get(s.pagamento_id)?.scuola_id
              return sede != null && sediAttive.has(sede)
            }),
          }
        : r
      /**
       * CHE COSA SI MINIMIZZA PER SEDE, ESATTAMENTE — e che cosa NO.
       *
       * ⚠️ Fino al 2026-09-06 qui c'era scritto che «lo stato di fatturazione si mostra
       * SOLO sulle proprie sedi», e non era vero: `r.fattura` — i DOCUMENTI, col loro
       * numero — è attaccato sopra a ogni riga abbinata senza nessun filtro di sede, e il
       * chip preferisce quello al riassunto. Su una riga di un altro plesso il chip
       * mostrava (e mostra) «Fattura FPR 1947/26». Un commento che descrive una
       * protezione inesistente è la cosa che questo repository ha già pagato due volte:
       * meglio scrivere la regola vera.
       *
       * LA REGOLA VERA, ed è una decisione, non un residuo:
       *  · i due campi DERIVATI dal pagamento (`pagamento_stato`, `fattura_stato`) si
       *    mostrano solo sulle proprie sedi, come i label dei suggerimenti. Sono quelli
       *    che invitano ad AGIRE — «da fatturare» — e su un plesso non proprio l'azione
       *    non c'è: l'emissione la rifiuterebbe;
       *  · i DOCUMENTI restano cross-sede. Il registro È l'estratto conto unico del
       *    titolare: la riga bancaria porta già data, importo, causale e il nome
       *    dell'ORDINANTE a tutte le segreterie. Un numero di fattura è meno di così, e
       *    serve — dice «questa riga di un altro plesso è a posto, non toccarla».
       *
       * ⚠️ LA CONSEGUENZA, dichiarata invece che scoperta: i due bidoni di `?fattura=` non
       * hanno la stessa portata. «Da fatturare» pretende anche `pagamento_stato ===
       * 'pagato'`, che sulle altre sedi è `null`, quindi è di fatto la lista di lavoro
       * della PROPRIA sede; «Fatturate» guarda i documenti e resta cross-sede. È voluto:
       * la prima è una lista di cose da fare, la seconda un controllo.
       *
       * Lock: `__tests__/api/pagamenti-riconciliazione-fatturazione.test.ts`.
       */
      const pag = r.stato === 'confermato' && typeof r.pagamento_id === 'string'
        ? pagDi.get(r.pagamento_id)
        : undefined
      const visibile = pag != null && pag.scuola_id != null && sediAttive.has(pag.scuola_id)
      return visibile
        ? conFatturazione(conSuggerimenti, pag.stato ?? null, normalizzaFattura(pag.fattura_stato), altraSede, sedeDedottaUi)
        : conFatturazione(conSuggerimenti, null, null, altraSede, sedeDedottaUi)
    })
    return rispondi(minimizzate, true)
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_GET, stato: 500 }, err)
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
