import { mimeBase } from '@/lib/gallery/limiti'
import { logClient, nomeErrore } from '@/lib/logging/client'
import {
  CODICI_MOSTRATI_VIDEO,
  codiceMessaggioVideo,
  schemaEsitoAperturaIntentVideo,
  schemaStatoJobVideo,
  type CodiceMostratoVideo,
  type CoordinateCaricamentoVideo,
  type StatoJobVideoLetto,
} from '@/lib/media/video/contratto'
import {
  MAX_VIDEO_DURATION_SECONDS,
  validateVideoInputSize,
} from '@/lib/media/video/limiti'

// =============================================================================
// IL FLUSSO CHE L'EDITOR DELLE COMUNICAZIONI PERCORRE PER UN VIDEO.
//
// Sta fuori dal componente per una ragione sola: qui si può misurare. Una
// schermata React che apre un intento, spedisce due gigabyte, dichiara il
// caricamento e poi interroga lo stato è collaudabile solo montandola; queste
// funzioni prendono il `fetch` come dipendenza e si provano una per una.
//
// ─── CHE COSA *NON* FA ──────────────────────────────────────────────────────
//
// Non tocca i byte. Il trasporto è di `@/lib/media/video/upload` (TUS, ripresa
// dall'offset, archivio su IndexedDB): quel modulo esiste già, ha i suoi test, e
// duplicarne anche un pezzo qui vorrebbe dire due strade che divergono — con la
// seconda esercitata solo quando la rete cade, cioè quasi mai in collaudo.
// =============================================================================

/**
 * CHE COSA ACCETTA IL SELETTORE DI FILE, e perché è un jolly.
 *
 * ⚠️ NON è un elenco di tipi esatti, ed è una decisione. Il browser confronta
 * l'`accept` con il `type` del file, e il `type` che arriva da un telefono porta
 * spesso i parametri del produttore (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`):
 * una voce `video/mp4` scritta per esteso non lo riconosce, e il file non compare
 * nemmeno nella finestra di scelta. Diversi selettori Android consegnano invece
 * `type: ''`, che nessun elenco esatto può soddisfare.
 *
 * ⚠️ E NON si costruisce da `SUPPORTED_VIDEO_CONTAINERS`: quell'elenco sono i
 * nomi che `ffprobe` dà ai contenitori (`matroska`, `mpegts`, `mxf`), non tipi
 * MIME. Tradurli qui significherebbe inventare una mappa che nessuno verifica, e
 * l'autorità su che cosa sia davvero il file è comunque ffprobe, che gira DOPO
 * l'upload. Il jolly lascia scegliere, i limiti veri li applica il preflight qui
 * sotto e la matrice la applica il server.
 */
export const ACCEPT_VIDEO_NEWS = 'video/*'

/**
 * Il tipo dichiarato quando il file non ne porta uno utilizzabile.
 *
 * Il bucket degli originali accetta qualunque tipo (`allowed_mime_types = NULL`,
 * `20260916190000_video_jobs.sql`) proprio perché il verdetto è di ffprobe:
 * dichiarare «non lo so» è più onesto che inventare `video/mp4` su un `.mov`.
 */
const MIME_SCONOSCIUTO = 'application/octet-stream'

/** La forma minima di un tipo MIME: `tipo/sottotipo`. */
const FORMA_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

export interface DipendenzeFlussoVideoNews {
  /** Iniettato: nei test non esiste una rete, e in produzione non deve esistere un globale. */
  fetch: typeof fetch
  /** Chi sta caricando: la route lo legge da `x-user-id` come tutte le altre di News. */
  userId: string
}

/** Il minimo che serve sapere di un file per decidere se può partire. */
export interface FileScelto {
  name: string
  size: number
  type: string
}

export type EsitoPreflight =
  | { ok: true; mime: string }
  | { ok: false; codice: CodiceMostratoVideo }

export interface EsitoAperturaIntento {
  ok: true
  intentId: string
  revisione: number
  jobId: string
  chiaveIdempotenza: string
  coordinate: CoordinateCaricamentoVideo
  firma: string
}

export type EsitoVideoNews<T> = T | { ok: false; codice: CodiceMostratoVideo }

/* ────────────────────────────────────────────────────────────────────────────
 * PRIMA DI SPEDIRE UN SOLO BYTE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I limiti veri, applicati sul dispositivo.
 *
 * Non sostituiscono il controllo del server — lo anticipano: rifiutare qui costa
 * un istante, rifiutare dopo costa due gigabyte di rete mobile di un genitore.
 * I due tetti arrivano da `@/lib/media/video/limiti`, che è lo stesso posto da
 * cui li prende la pipeline: riscriverli qui vorrebbe dire un secondo tetto che
 * diverge al primo ripensamento.
 *
 * La DURATA è ammessa nulla, e non è una svista: `schemaFileVideoDichiarato` la
 * dichiara `nullable` perché la misura vera la fa il probe. Un browser che non
 * sa dire quanto dura un filmato non è un motivo per rifiutarlo.
 */
export function preflightVideoNews(file: FileScelto, durataSecondi: number | null): EsitoPreflight {
  const taglia = validateVideoInputSize(file.size)
  if (!taglia.ok) {
    return { ok: false, codice: codiceMessaggioVideo(taglia.code) }
  }

  // `Infinity` è ciò che un `<video>` restituisce quando la durata non è nota:
  // è un «non lo so», non un filmato lungo mezzo giorno.
  if (
    durataSecondi !== null &&
    Number.isFinite(durataSecondi) &&
    durataSecondi > MAX_VIDEO_DURATION_SECONDS
  ) {
    return { ok: false, codice: 'VIDEO_TROPPO_LUNGO' }
  }

  return { ok: true, mime: mimeDichiarabile(file.type) }
}

/**
 * Il tipo da dichiarare al server: base, senza i parametri del produttore.
 *
 * La normalizzazione avviene QUI, una volta sola, perché il valore finisce in due
 * posti che i parametri non tollerano — l'estensione dell'oggetto sullo Storage e
 * il `contentType` delle coordinate, che il client riconfronta col tipo del file.
 */
function mimeDichiarabile(tipo: string): string {
  const base = mimeBase(tipo ?? '')
  return FORMA_MIME.test(base) ? base : MIME_SCONOSCIUTO
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL CODICE CHE LA SCHERMATA MOSTRA
 * ──────────────────────────────────────────────────────────────────────────── */

const MOSTRABILI = new Set<string>(CODICI_MOSTRATI_VIDEO)

/** Il ripiego: mai `undefined`, mai una schermata muta. */
const RIPIEGO: CodiceMostratoVideo = 'VIDEO_OPERAZIONE_NON_RIUSCITA'

/**
 * Il codice d'errore di una risposta del server.
 *
 * ⚠️ NON passa da `codiceMessaggioVideo`, e la differenza non è di stile.
 * Quella funzione traduce i codici INTERNI della pipeline (`FILE_TOO_LARGE`) in
 * codici mostrabili; le route però mandano già il codice mostrabile
 * (`rispostaVideo` in `src/app/api/video-uploads/risposte.ts`), e `VIDEO_TROPPO_GRANDE`
 * non è una chiave di `MAPPA_MESSAGGIO_VIDEO`. Rimapparlo lo farebbe cadere sul
 * ripiego generico: «questo video supera i 2 GB» diventerebbe «l’operazione non è
 * riuscita», che non dice a nessuno che cosa fare.
 */
export function codiceMostrato(corpo: unknown): CodiceMostratoVideo {
  const codice = (corpo as { codice?: unknown } | null)?.codice
  if (typeof codice === 'string' && MOSTRABILI.has(codice)) return codice as CodiceMostratoVideo
  return RIPIEGO
}

/* ────────────────────────────────────────────────────────────────────────────
 * I LOG
 *
 * ⚠️ MAI IL NOME DEL FILE. Un video di una comunicazione si chiama
 * `recita-di-mario.mov`: è anagrafica di un minore, e in `app_log` resterebbe
 * trenta giorni interrogabile in SQL. Passano il tipo, i byte e i codici.
 * ──────────────────────────────────────────────────────────────────────────── */

function segnala(
  livello: 'warn' | 'error',
  messaggio: string,
  campi: Record<string, string | number | boolean>,
  stato?: number,
): void {
  logClient({
    livello,
    evento: 'fetch',
    messaggio,
    route: '/admin/news',
    ...(stato === undefined ? {} : { stato }),
    campi,
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE CHIAMATE
 * ──────────────────────────────────────────────────────────────────────────── */

/** L'intestazione comune: la stessa convenzione delle altre route di News. */
function intestazioni(userId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-user-id': userId }
}

type Risposta = { ok: true; corpo: unknown } | { ok: false; codice: CodiceMostratoVideo }

/**
 * Una chiamata alla pipeline, con i tre esiti distinti.
 *
 * Un `catch` muto qui sarebbe il guasto invisibile: chi ha appena scelto il video
 * della recita resterebbe davanti a un pulsante che non fa niente, e nessuna riga
 * direbbe perché. La rete caduta si logga (nessun altro la vede), il rifiuto del
 * server si logga col suo stato (il server l'ha già registrato di suo: la
 * politica dei livelli di `logClient` sopprime i 4xx ordinari, ed è giusto così).
 */
async function chiama(
  dip: DipendenzeFlussoVideoNews,
  url: string,
  init: RequestInit,
  operazione: string,
): Promise<Risposta> {
  let res: Response
  try {
    res = await dip.fetch(url, init)
  } catch (err) {
    segnala('error', `video-news-rete-caduta: ${operazione}`, { error_code: nomeErrore(err) }, 0)
    return { ok: false, codice: RIPIEGO }
  }

  const corpo = (await res.json().catch(() => null)) as unknown

  if (!res.ok) {
    const codice = codiceMostrato(corpo)
    segnala('warn', `video-news-rifiutato: ${operazione}`, { error_code: codice }, res.status)
    return { ok: false, codice }
  }

  return { ok: true, corpo }
}

/**
 * Apre l'intento e restituisce le coordinate con cui spedire i byte.
 *
 * ⚠️ OGNI SCRITTURA DICHIARA LA SUA SEDE. `scuolaId` può essere nullo soltanto
 * insieme a `ambitoGlobale: true` — è il vincolo di `schemaAperturaIntentVideo` ed
 * è lo stesso del database (`video_intents_scuola_scope_chk`). Un intento che
 * «indovina» il plesso archivierebbe il video nella sede sbagliata in silenzio.
 *
 * L'azione è `attach_private`: un video allegato a una comunicazione non pubblica
 * niente da solo. Sarà il salvataggio dell'articolo, con i suoi gate, a decidere
 * che cosa una famiglia vede.
 */
export async function apriIntentoVideoNews(
  dip: DipendenzeFlussoVideoNews,
  ingresso: {
    scuolaId: string | null
    ambitoGlobale: boolean
    chiaveIdempotenza: string
    file: FileScelto
    mime: string
    durataSecondi: number | null
  },
): Promise<EsitoVideoNews<EsitoAperturaIntento>> {
  const esito = await chiama(
    dip,
    `/api/video-uploads?userId=${encodeURIComponent(dip.userId)}`,
    {
      method: 'POST',
      headers: intestazioni(dip.userId),
      body: JSON.stringify({
        canale: 'news',
        azione: 'attach_private',
        scuolaId: ingresso.scuolaId,
        ambitoGlobale: ingresso.ambitoGlobale,
        targetId: null,
        versioneTargetAttesa: null,
        file: [
          {
            chiaveIdempotenza: ingresso.chiaveIdempotenza,
            nome: ingresso.file.name,
            byte: ingresso.file.size,
            mime: ingresso.mime,
            durataSecondi: ingresso.durataSecondi,
          },
        ],
      }),
    },
    'apertura',
  )
  if (!esito.ok) return esito

  // La risposta si RIVERIFICA contro il contratto invece di fidarsi: da qui
  // escono l'indirizzo dell'upload e la dimensione del blocco TUS, e un valore
  // sbagliato non produce un errore — produce un caricamento che riparte da capo
  // su una rete mobile, o che non parte affatto.
  const letto = schemaEsitoAperturaIntentVideo.safeParse(esito.corpo)
  if (!letto.success || letto.data.job.length === 0) {
    segnala('error', 'video-news-apertura-fuori-contratto', { esito: 'schema' }, 0)
    return { ok: false, codice: RIPIEGO }
  }

  const job = letto.data.job[0]
  return {
    ok: true,
    intentId: letto.data.intentId,
    revisione: letto.data.revisione,
    jobId: job.jobId,
    chiaveIdempotenza: job.chiaveIdempotenza,
    coordinate: job.caricamento,
    firma: job.firma,
  }
}

/** Una delle azioni della `PATCH`, con il corpo già deciso dal chiamante. */
async function azione(
  dip: DipendenzeFlussoVideoNews,
  intentId: string,
  corpo: Record<string, unknown>,
  operazione: string,
): Promise<EsitoVideoNews<{ ok: true }>> {
  const esito = await chiama(
    dip,
    `/api/video-uploads/${encodeURIComponent(intentId)}?userId=${encodeURIComponent(dip.userId)}`,
    { method: 'PATCH', headers: intestazioni(dip.userId), body: JSON.stringify(corpo) },
    operazione,
  )
  return esito.ok ? { ok: true } : esito
}

/**
 * «I byte sono tutti sullo Storage»: da qui il job entra in coda.
 *
 * Byte e tipo si RIDICHIARANO perché la RPC li confronta con quelli dell'oggetto
 * caricato: è il controllo che distingue «l'upload è finito» da «l'upload si è
 * interrotto e il client lo crede finito».
 */
export function segnalaVideoCaricato(
  dip: DipendenzeFlussoVideoNews,
  intentId: string,
  jobId: string,
  misura: { byte: number; mime: string },
): Promise<EsitoVideoNews<{ ok: true }>> {
  return azione(dip, intentId, { azione: 'caricato', jobId, byte: misura.byte, mime: misura.mime }, 'caricato')
}

/** L'istante in cui la persona si impegna: da qui in poi può chiudere l'app. */
export function confermaIntentoVideoNews(
  dip: DipendenzeFlussoVideoNews,
  intentId: string,
  revisione: number,
): Promise<EsitoVideoNews<{ ok: true }>> {
  return azione(dip, intentId, { azione: 'conferma', revisione }, 'conferma')
}

/** Toglie UN allegato: la comunicazione resta, il video no. */
export function annullaJobVideoNews(
  dip: DipendenzeFlussoVideoNews,
  intentId: string,
  jobId: string,
): Promise<EsitoVideoNews<{ ok: true }>> {
  return azione(dip, intentId, { azione: 'annulla-job', jobId }, 'annulla-job')
}

/**
 * Lo stato dei job dell'intento: è ciò che l'operatore guarda mentre aspetta.
 *
 * Gli stati che il contratto non riconosce si SCARTANO e si loggano invece di
 * essere mostrati: un job fallito senza codice lascerebbe la schermata con una
 * riga rossa e niente da dire, e un avanzamento su un job annullato resterebbe
 * lì a far credere che qualcosa stia ancora succedendo.
 */
export async function leggiStatoIntentoVideoNews(
  dip: DipendenzeFlussoVideoNews,
  intentId: string,
): Promise<EsitoVideoNews<{ ok: true; job: StatoJobVideoLetto[] }>> {
  const esito = await chiama(
    dip,
    `/api/video-uploads/${encodeURIComponent(intentId)}?userId=${encodeURIComponent(dip.userId)}`,
    { method: 'GET', headers: intestazioni(dip.userId) },
    'stato',
  )
  if (!esito.ok) return esito

  const righe = (esito.corpo as { job?: unknown } | null)?.job
  const job: StatoJobVideoLetto[] = []
  let scartate = 0
  for (const riga of Array.isArray(righe) ? righe : []) {
    const letta = schemaStatoJobVideo.safeParse(riga)
    if (letta.success) job.push(letta.data)
    else scartate++
  }
  if (scartate > 0) {
    segnala('error', 'video-news-stato-fuori-contratto', { n_righe: scartate }, 0)
  }
  return { ok: true, job }
}
