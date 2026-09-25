/**
 * V11 · IL FLUSSO DI UN VIDEO DI GALLERIA VISTO DAL TELEFONO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE UN MODULO, E NON DELLE FUNZIONI DENTRO LA PAGINA.
 *
 * Il collaudo nel browser in locale qui è impossibile: il middleware rimanda al
 * login e produce falsi verdi. L'unica copertura vera resta l'E2E in CI e il
 * dispositivo (V15). Quindi tutto ciò che si può decidere FUORI da React — quale
 * sede dichiarare, quale chiave di idempotenza, che cosa rifiutare prima di
 * spedire due gigabyte da una rete mobile, come si legge un rifiuto del server —
 * vive qui, dove un test lo può eseguire davvero.
 *
 * Alla pagina restano il montaggio, gli stati di React e il disegno: le cose che
 * in jsdom si collaudano male e che comunque vanno guardate su un telefono vero.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * I QUATTRO PASSI, E PERCHÉ SONO QUATTRO.
 *
 *  1. `POST /api/video-uploads` apre l'INTENTO e conia le coordinate TUS. Non
 *     riceve un byte: il corpo di una Function su Vercel si ferma a ~4,5 MB, e
 *     questi originali arrivano a 2.000.000.000.
 *  2. i byte partono col protocollo TUS (`@/lib/media/video/upload`), che è
 *     ripartibile: è il pezzo che sopravvive alla galleria della metropolitana.
 *  3. `PATCH … {azione:'caricato'}` mette il job in coda, `PATCH … {azione:'conferma'}`
 *     è l'istante in cui chi carica SI IMPEGNA — da lì in poi può chiudere l'app.
 *  4. quando il job è `ready`, `POST /api/gallery` con `video_intent_id` copia
 *     l'uscita dentro il bucket e scrive la riga, attraversando i quattro cancelli
 *     del dominio (ruolo, sede, tag nel perimetro, liberatoria fotografica).
 *
 * ⚠️ Fra il 3 e il 4 possono passare MINUTI. È il motivo per cui l'interfaccia ha
 * uno stato «in preparazione» invece di una rotellina: se dicesse «caricamento»
 * per otto minuti, qualcuno ricaricherebbe e caricherebbe due volte.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DUE REGOLE CHE QUESTO FILE NON PUÒ PERMETTERSI DI DIMENTICARE.
 *
 * **Il MIME porta il suffisso del codec.** `MediaRecorder` consegna
 * `video/mp4;codecs=avc1.42E01E,mp4a.40.2`, e un confronto per uguaglianza lo
 * respinge. Il 2026-09-08 questo ha fermato TUTTI i video della galleria: 33
 * tentativi, 8 insegnanti, 3 sedi, un giorno intero. I confronti da correggere
 * erano DUE. Qui si passa sempre da `mimeBase`.
 *
 * **Niente nome di file nei log.** `recita-bambina-rossi.mov` è anagrafica di un
 * minore e in `app_log` resterebbe trenta giorni interrogabile in SQL. Nei log di
 * questo modulo escono uuid, byte e codici: struttura, mai contenuto.
 */

import { logClient, nomeErrore } from '@/lib/logging/client'
import {
  codiceMessaggioVideo,
  schemaStatoJobVideo,
  type CodiceMostratoVideo,
  type CoordinateCaricamentoVideo,
  type StatoJobVideo,
  type StatoJobVideoLetto,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, validateVideoInputSize } from '@/lib/media/video/limiti'
import { messaggioDaCorpo, soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'

import { mimeBase } from './limiti'

/* ────────────────────────────────────────────────────────────────────────────
 * LA SEDE — «ogni scrittura dichiara la sua sede»
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il cookie che il cockpit scrive quando si scelgono le sedi da guardare. */
const COOKIE_SEDI = 'sedi_attive'

/**
 * Le sedi selezionate nel cockpit, lette da `document.cookie`.
 *
 * Il cookie NON è un segreto e non è httpOnly: è una preferenza d'interfaccia, e
 * il server la ri-valida sempre contro le sedi accessibili (`scuoleDiUtente`).
 * Leggerlo qui serve a una cosa sola: non chiedere DI NUOVO a chi ha già scelto.
 */
export function sediDalCookie(cookie: string | null | undefined): string[] {
  if (!cookie) return []
  const voce = cookie.split('; ').find((c) => c.startsWith(`${COOKIE_SEDI}=`))
  if (!voce) return []
  const grezzo = decodeURIComponent(voce.slice(COOKIE_SEDI.length + 1))
  const viste = new Set<string>()
  const sedi: string[] = []
  for (const pezzo of grezzo.split(',')) {
    const id = pezzo.trim()
    if (!id) continue
    const chiave = id.toLowerCase()
    if (viste.has(chiave)) continue
    viste.add(chiave)
    sedi.push(id)
  }
  return sedi
}

export interface IdentitaPerSede {
  /** Il ruolo applicativo di chi carica: solo `admin` può avere più plessi. */
  ruolo: string | null
  /** `utenti.scuola_id`: la sede primaria del profilo. */
  scuolaPrimaria: string | null
  /** Le sedi scelte nel cockpit (cookie `sedi_attive`). */
  sediSelezionate: string[]
  /** Le sedi accessibili, quando si sanno; `null` = non interrogate. */
  sediAccessibili: string[] | null
}

/**
 * LA SEDE DA DICHIARARE, O `null` SE NON SI PUÒ SAPERE.
 *
 * ⚠️ `null` è una risposta, non un guasto — ed è la parte che conta. Una route
 * che «indovina» la sede archivia i dati nel plesso sbagliato **in silenzio**:
 * è il difetto misurato il 2026-07-31 su un admin che aveva scelto Aversa e si
 * vedeva scrivere su Giugliano, e la ragione per cui `resolveScuolaScrittura`
 * risponde **400** invece di scegliere per conto suo.
 *
 * Qui si rifà la sua stessa regola, nell'ordine in cui la applica lui:
 *  1. la sede SCELTA, quando ne resta una sola dentro il perimetro;
 *  2. l'unica sede accessibile, quando ce n'è una sola;
 *  3. la sede del profilo, ma **solo** per chi non è admin — `scuoleDiUtente`
 *     restituisce il solo `utenti.scuola_id` a tutti gli altri ruoli, quindi lì
 *     «la primaria» e «l'unica» sono lo stesso valore;
 *  4. altrimenti `null`, e l'interfaccia chiede di scegliere invece di partire.
 *
 * Il punto 3 non vale per l'admin proprio perché per lui i due valori divergono,
 * ed è esattamente il caso in cui un video finirebbe nel plesso sbagliato.
 */
export function sedeDelCaricamento(identita: IdentitaPerSede): string | null {
  const { ruolo, scuolaPrimaria, sediSelezionate, sediAccessibili } = identita

  const forma = (id: string) => id.trim().toLowerCase()
  const dentroIlPerimetro = sediAccessibili
    ? sediSelezionate.filter((s) => sediAccessibili.some((a) => forma(a) === forma(s)))
    : sediSelezionate
  if (dentroIlPerimetro.length === 1) return dentroIlPerimetro[0]

  if (sediAccessibili && sediAccessibili.length === 1) return sediAccessibili[0]

  if (!sediAccessibili && ruolo !== 'admin' && scuolaPrimaria) return scuolaPrimaria

  return null
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL RIFIUTO LOCALE — prima di spedire, non dopo
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il motivo per cui questo file non può entrare nella pipeline, o `null`.
 *
 * I tetti NON sono scritti qui: arrivano da `@/lib/media/video/limiti`, che è la
 * stessa fonte che il server riverifica sul file caricato e che il database
 * impone all'uscita. Una copia qui divergerebbe il giorno in cui uno dei due
 * cambia, e la differenza sarebbe la fascia di video che l'applicazione lascia
 * scegliere e la pipeline poi rifiuta — dopo il caricamento, su rete mobile.
 *
 * La DURATA è best-effort: `null` (o `NaN`) significa «il telefono non sa dirlo»,
 * e non è un motivo di rifiuto. La misura vera la fa ffprobe dopo; rifiutare qui
 * un file perché il browser non ne ha letto i metadati sarebbe un rifiuto ingiusto.
 */
export function rifiutoLocaleVideo(
  file: { size: number },
  durataSecondi: number | null | undefined,
): CodiceMostratoVideo | null {
  const taglia = validateVideoInputSize(file.size)
  if (!taglia.ok) return codiceMessaggioVideo(taglia.code)

  if (typeof durataSecondi === 'number' && Number.isFinite(durataSecondi)) {
    if (durataSecondi > MAX_VIDEO_DURATION_SECONDS) return codiceMessaggioVideo('VIDEO_TOO_LONG')
  }

  return null
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA DURATA, CHIESTA AL BROWSER
 * ──────────────────────────────────────────────────────────────────────────── */

/** Oltre questo tempo si smette di aspettare i metadati e si dichiara «non lo so». */
const TETTO_METADATI_MS = 4_000;

/**
 * Quanto dura questo video, secondo il browser — e `null` quando non lo sa.
 *
 * ⚠️ PERCHÉ VALE LA PENA CHIEDERGLIELO. Il tetto di tre minuti lo applica ffprobe
 * DOPO il caricamento: un video da 2 GB e quattro minuti verrebbe spedito per
 * intero su rete mobile, messo in coda, e rifiutato. Qui costa qualche decina di
 * millisecondi e chiude il caso prima che parta un byte.
 *
 * ⚠️ E PERCHÉ NON CI SI PUÒ FIDARE. `preload="metadata"` è un SUGGERIMENTO che il
 * browser può ignorare — su Safari/iOS in Risparmio Energetico o su rete
 * cellulare succede — e certi file registrati dal telefono danno `Infinity`
 * finché non si cerca dentro. Perciò l'esito è `null` in tutti i casi dubbi, e
 * `rifiutoLocaleVideo` tratta `null` come «non è un motivo di rifiuto»: l'autorità
 * resta ffprobe.
 *
 * ⚠️ E PERCHÉ C'È UN TETTO DI TEMPO. Senza, un `<video>` che non emette né
 * `loadedmetadata` né `error` lascerebbe questa promessa appesa per sempre, e con
 * lei il caricamento che la aspetta: una rotellina infinita al posto di un video.
 */
export async function durataVideoDalFile(
  file: Blob,
  dip: {
    creaVideo?: () => HTMLVideoElement
    creaUrl?: (b: Blob) => string
    revocaUrl?: (url: string) => void
    tettoMs?: number
  } = {},
): Promise<number | null> {
  const creaVideo = dip.creaVideo ?? (() => document.createElement('video'))
  const creaUrl = dip.creaUrl ?? ((b: Blob) => URL.createObjectURL(b))
  const revocaUrl = dip.revocaUrl ?? ((u: string) => URL.revokeObjectURL(u))
  const tettoMs = dip.tettoMs ?? TETTO_METADATI_MS

  let url: string
  try {
    url = creaUrl(file)
  } catch (err) {
    // Nessun objectURL (WebView con lo storage bloccato, quota esaurita): la
    // durata non si può misurare, e non è un guasto — è un'informazione in meno.
    logClient({
      livello: 'warn',
      evento: 'js',
      route: '/teacher/gallery',
      messaggio: 'video-galleria-durata-non-misurabile',
      campi: { error_code: nomeErrore(err) },
    })
    return null
  }

  const elemento = creaVideo()
  return new Promise<number | null>((risolvi) => {
    let chiuso = false
    const chiudi = (valore: number | null) => {
      if (chiuso) return
      chiuso = true
      clearTimeout(orologio)
      elemento.removeEventListener('loadedmetadata', suMetadati)
      elemento.removeEventListener('error', suErrore)
      // Il Blob può essere due gigabyte: l'objectURL si revoca SEMPRE, su tutte e
      // tre le uscite. Un solo ramo che se ne dimentica lo tiene in memoria fino
      // al ricaricamento della pagina.
      revocaUrl(url)
      risolvi(valore)
    }
    const suMetadati = () => {
      const d = elemento.duration
      chiudi(Number.isFinite(d) && d > 0 ? d : null)
    }
    const suErrore = () => chiudi(null)
    const orologio = setTimeout(() => chiudi(null), tettoMs)

    elemento.addEventListener('loadedmetadata', suMetadati)
    elemento.addEventListener('error', suErrore)
    elemento.preload = 'metadata'
    elemento.src = url
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA CHIAVE DI IDEMPOTENZA
 * ──────────────────────────────────────────────────────────────────────────── */

/** FNV-1a a 32 bit: serve a distinguere due file, non a nascondere un segreto. */
function improntaBreve(testo: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < testo.length; i++) {
    h ^= testo.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * LA CHIAVE CON CUI IL CLIENT RICONOSCE IL PROPRIO FILE FRA UN TENTATIVO E L'ALTRO.
 *
 * Deve essere DETERMINISTICA: `video_jobs_owner_channel_idempotency_key_key` la
 * usa per non creare due job quando la rete cade a metà della `POST`, e una
 * chiave casuale trasformerebbe ogni ritentativo in un secondo caricamento —
 * cioè in un secondo video da convertire e pagare.
 *
 * ⚠️ E NON PUÒ CONTENERE IL NOME DEL FILE. La chiave viaggia al server, viene
 * scritta in chiaro in `video_jobs.idempotency_key` e compare nel contesto di log
 * della route: `recita-bambina-rossi.mov` è anagrafica di un minore. Del nome
 * resta un'impronta a 32 bit, che distingue due file senza dire quali siano.
 */
export function chiaveIdempotenzaVideo(file: { name: string; size: number; lastModified?: number }): string {
  const quando = Number.isFinite(file.lastModified) ? Number(file.lastModified) : 0
  return `g-${file.size}-${quando}-${improntaBreve(file.name)}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL TRASPORTO
 * ──────────────────────────────────────────────────────────────────────────── */

/** La `fetch` che il chiamante inietta: nel browser è quella del browser. */
export type Rete = (url: string, init?: RequestInit) => Promise<Response>

export type EsitoFlusso<T> =
  | { ok: true; dati: T }
  | {
      ok: false
      /** Il codice dichiarato dal server, quando c'è. Serve a decidere, non a mostrare. */
      codice: string | null
      /** La frase già tradotta da mostrare. Mai vuota: il silenzio è il difetto di partenza. */
      messaggio: string
      /** Lo status HTTP, o `null` quando la richiesta non è mai arrivata a destinazione. */
      stato: number | null
      /** I nomi che il 422 del Privacy Lock porta con sé: a schermo, mai nei log. */
      nomi?: string[]
    }

/**
 * Una chiamata alla pipeline, con il corpo letto UNA volta sola.
 *
 * `res.json()` consuma lo stream: chi ha bisogno del corpo anche per altro — il
 * 422 del Privacy Lock porta `nomi`, che dicono all'insegnante QUALI bambini
 * togliere dai tag — non può rileggerlo. Perciò il corpo si legge qui e si passa
 * intero al traduttore.
 *
 * `traduci` è un parametro perché le due porte hanno due regole diverse, e la
 * differenza è misurata:
 *  · le route video mandano SEMPRE un `codice` dichiarato, e la loro prosa nasce
 *    italiana dentro una route dove il locale non esiste → `soloCatalogoDaCorpo`;
 *  · `POST /api/gallery` manda anche rifiuti SENZA codice cui la prosa aggiunge
 *    l'unica cosa utile (i nomi dei bambini senza liberatoria) → `messaggioDaCorpo`,
 *    che è la scelta già in vigore su questa schermata dal 2026-08-03.
 */
async function chiama<T>(
  rete: Rete,
  url: string,
  init: RequestInit | undefined,
  opzioni: {
    ripiego: string
    operazione: string
    traduci: (corpo: unknown, ripiego: string) => string
    campi?: Record<string, string | number | boolean>
  },
): Promise<EsitoFlusso<T>> {
  let res: Response
  try {
    res = await rete(url, init)
  } catch (err) {
    // Una rete caduta NON è una schermata muta: è il guasto che il 2026-09-07 si
    // presentava come «Errore durante il caricamento» senza nient'altro.
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: `video-galleria-rete: ${opzioni.operazione}`,
      campi: { error_code: nomeErrore(err), ...(opzioni.campi ?? {}) },
    })
    return { ok: false, codice: null, messaggio: opzioni.ripiego, stato: null }
  }

  const corpo = (await res.json().catch((err: unknown) => {
    logClient({ livello: 'error', evento: 'fetch', route: '/teacher/gallery', messaggio: 'video-risposta-illeggibile', campi: { error_code: nomeErrore(err) } })
    return null
  })) as Record<string, unknown> | null

  if (!res.ok) {
    const codice = typeof corpo?.codice === 'string' ? corpo.codice : null
    // `stato` è parte della chiave di deduplica di `logClient` (`evento|messaggio|stato`)
    // ed è ciò che separa un 413 da un 422 da un 503. È anche ciò che fa applicare la
    // politica dei livelli: un 4xx della NOSTRA porta lo registra già il server, e
    // duplicarlo qui riempirebbe `app_log` di rumore.
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: `video-galleria-rifiutata: ${opzioni.operazione}`,
      stato: res.status,
      campi: { error_code: codice ?? 'SENZA_CODICE', ...(opzioni.campi ?? {}) },
    })
    const nomi = Array.isArray(corpo?.nomi)
      ? (corpo.nomi as unknown[]).filter((n): n is string => typeof n === 'string')
      : undefined
    return {
      ok: false,
      codice,
      messaggio: opzioni.traduci(corpo, opzioni.ripiego),
      stato: res.status,
      ...(nomi && nomi.length > 0 ? { nomi } : {}),
    }
  }

  return { ok: true, dati: (corpo ?? {}) as T }
}

const json = (corpo: unknown, intestazioni: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...intestazioni },
  body: JSON.stringify(corpo),
})

/* ────────────────────────────────────────────────────────────────────────────
 * 1 · APRIRE L'INTENTO
 * ──────────────────────────────────────────────────────────────────────────── */

export interface IntentoApertoVideo {
  intentId: string
  revisione: number
  jobId: string
  chiaveIdempotenza: string
  coordinate: CoordinateCaricamentoVideo
  /** La firma `x-signature` con cui il browser autentica l'upload allo Storage. */
  firma: string
  statoIntent: string
  statoJob: StatoJobVideo
  needsUpload: boolean
  expiresAt: string | null
}

/**
 * ⚠️ `file` è una FORMA, non un `File`, e serve alla RIPRESA.
 *
 * Un caricamento interrotto tre giorni fa riparte da una riga di IndexedDB, non
 * da un `File`: quello muore con la pagina che l'ha scelto. La riga conserva nome,
 * byte e MIME — tutto ciò che serve a riaprire lo stesso intento con la stessa
 * chiave di idempotenza e ottenere una firma fresca, che è l'unico modo di
 * riprendere invece di ricominciare.
 */
export async function apriIntentoVideoGalleria(
  rete: Rete,
  dati: {
    file: { name: string; size: number; type: string }
    scuolaId: string
    durataSecondi: number | null
    chiaveIdempotenza: string
    ripiego: string
  },
): Promise<EsitoFlusso<IntentoApertoVideo>> {
  const durata =
    typeof dati.durataSecondi === 'number' && Number.isFinite(dati.durataSecondi) && dati.durataSecondi > 0
      ? dati.durataSecondi
      : null

  const esito = await chiama<{
    intentId?: unknown
    revisione?: unknown
    intent?: { status?: unknown }
    job?: Array<{ jobId?: unknown; chiaveIdempotenza?: unknown; caricamento?: unknown; firma?: unknown; status?: unknown; needs_upload?: unknown; expires_at?: unknown }>
  }>(
    rete,
    '/api/video-uploads',
    json({
      canale: 'gallery',
      // `publish` e non `attach_private`: in Galleria un video si carica per
      // pubblicarlo, e l'azione dichiarata è ciò che l'intento promette.
      azione: 'publish',
      scuolaId: dati.scuolaId,
      ambitoGlobale: false,
      targetId: null,
      versioneTargetAttesa: null,
      file: [
        {
          chiaveIdempotenza: dati.chiaveIdempotenza,
          nome: dati.file.name,
          byte: dati.file.size,
          mime: dati.file.type || 'video/mp4',
          durataSecondi: durata,
        },
      ],
    }),
    {
      ripiego: dati.ripiego,
      operazione: 'apertura',
      traduci: soloCatalogoDaCorpo,
      campi: { byte: dati.file.size },
    },
  )
  if (!esito.ok) return esito

  const primo = Array.isArray(esito.dati.job) ? esito.dati.job[0] : undefined
  const intentId = typeof esito.dati.intentId === 'string' ? esito.dati.intentId : ''
  const revisione = Number(esito.dati.revisione)
  const jobId = typeof primo?.jobId === 'string' ? primo.jobId : ''
  const firma = typeof primo?.firma === 'string' ? primo.firma : ''
  const needsUpload = primo?.needs_upload !== false

  if (!intentId || !jobId || (needsUpload && !firma) || !Number.isInteger(revisione) || revisione < 1) {
    // La porta ha risposto 201 e non ha restituito ciò che promette: è un difetto
    // NOSTRO, e va visto — senza questa riga il caricamento morirebbe dopo, dentro
    // tus, con un errore che la causa non la nomina.
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: 'video-galleria-apertura-incompleta',
      campi: { con_intento: Boolean(intentId), con_job: Boolean(jobId), con_firma: Boolean(firma) },
    })
    return { ok: false, codice: null, messaggio: dati.ripiego, stato: null }
  }

  return {
    ok: true,
    dati: {
      intentId,
      revisione,
      jobId,
      chiaveIdempotenza:
        typeof primo?.chiaveIdempotenza === 'string' ? primo.chiaveIdempotenza : dati.chiaveIdempotenza,
      coordinate: primo?.caricamento as CoordinateCaricamentoVideo,
      firma,
      statoIntent: typeof esito.dati.intent?.status === 'string' ? esito.dati.intent.status : 'pending',
      statoJob: (typeof primo?.status === 'string' ? primo.status : 'awaiting_upload') as StatoJobVideo,
      needsUpload,
      expiresAt: typeof primo?.expires_at === 'string' ? primo.expires_at : null,
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2 · LO STATO E LE AZIONI
 * ──────────────────────────────────────────────────────────────────────────── */

export interface StatoIntentoVideo {
  intentId: string
  revisione: number
  statoIntent: string
  aggiornatoIl: string
  job: StatoJobVideoLetto[]
}

/** Lo stato restituito dalla route, verificato contro il contratto prima di usarlo. */
function leggiCorpoStato(corpo: unknown, operazione: string): StatoIntentoVideo | null {
  const c = corpo as {
    intentId?: unknown
    revisione?: unknown
    statoIntent?: unknown
    aggiornatoIl?: unknown
    job?: unknown
  } | null
  if (!c || typeof c.intentId !== 'string' || !Array.isArray(c.job)) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: `video-galleria-stato-fuori-contratto: ${operazione}`,
      campi: { forma: typeof (c as { job?: unknown })?.job },
    })
    return null
  }
  const job: StatoJobVideoLetto[] = []
  for (const riga of c.job) {
    const letto = schemaStatoJobVideo.safeParse(riga)
    if (!letto.success) {
      // Uno stato che il contratto non riconosce non diventa una schermata
      // inventata: meglio dire «non lo so» che disegnare una barra su un dato
      // che non si capisce.
      logClient({
        livello: 'error',
        evento: 'fetch',
        route: '/teacher/gallery',
        messaggio: `video-galleria-job-fuori-contratto: ${operazione}`,
        campi: { stato: String((riga as { stato?: unknown })?.stato ?? 'assente') },
      })
      return null
    }
    job.push(letto.data)
  }
  return {
    intentId: c.intentId,
    revisione: Number(c.revisione) || 0,
    statoIntent: typeof c.statoIntent === 'string' ? c.statoIntent : '',
    aggiornatoIl: typeof c.aggiornatoIl === 'string' ? c.aggiornatoIl : '',
    job,
  }
}

async function azione(
  rete: Rete,
  intentId: string,
  corpo: Record<string, unknown>,
  opzioni: { ripiego: string; operazione: string },
): Promise<EsitoFlusso<StatoIntentoVideo>> {
  const esito = await chiama<unknown>(
    rete,
    `/api/video-uploads/${intentId}`,
    { ...json(corpo), method: 'PATCH' },
    { ripiego: opzioni.ripiego, operazione: opzioni.operazione, traduci: soloCatalogoDaCorpo },
  )
  if (!esito.ok) return esito
  const letto = leggiCorpoStato(esito.dati, opzioni.operazione)
  if (!letto) return { ok: false, codice: null, messaggio: opzioni.ripiego, stato: null }
  return { ok: true, dati: letto }
}

/**
 * «I byte sono tutti sullo Storage»: il job esce da `awaiting_upload` ed entra in
 * coda. Byte e MIME si DICHIARANO e la RPC li confronta con l'oggetto vero.
 *
 * ⚠️ `mimeBase`: il tipo che arriva da un `<input>` porta i parametri del
 * produttore, e qui finirebbe dentro `video_jobs.source_mime` accanto a un
 * confronto per uguaglianza.
 */
export function segnalaVideoCaricato(
  rete: Rete,
  dati: { intentId: string; jobId: string; byte: number; mime: string; ripiego: string },
): Promise<EsitoFlusso<StatoIntentoVideo>> {
  return azione(
    rete,
    dati.intentId,
    { azione: 'caricato', jobId: dati.jobId, byte: dati.byte, mime: mimeBase(dati.mime) },
    { ripiego: dati.ripiego, operazione: 'caricato' },
  )
}

/** L'istante in cui chi carica si impegna: da qui in poi può chiudere l'app. */
export function confermaIntentoVideo(
  rete: Rete,
  dati: { intentId: string; revisione: number; ripiego: string },
): Promise<EsitoFlusso<StatoIntentoVideo>> {
  return azione(
    rete,
    dati.intentId,
    { azione: 'conferma', revisione: dati.revisione },
    { ripiego: dati.ripiego, operazione: 'conferma' },
  )
}

/** Il ritiro dell'intento intero: il video non si pubblicherà. */
export function annullaIntentoVideo(
  rete: Rete,
  dati: { intentId: string; revisione: number; ripiego: string },
): Promise<EsitoFlusso<StatoIntentoVideo>> {
  return azione(
    rete,
    dati.intentId,
    { azione: 'annulla', revisione: dati.revisione },
    { ripiego: dati.ripiego, operazione: 'annulla' },
  )
}

/**
 * Lo stato di TUTTO l'intento con una richiesta sola.
 *
 * Una GET per job vorrebbe dire dieci richieste per ogni giro di polling su rete
 * mobile: nel settembre 2026 il polling di questa applicazione ha prodotto 2,23
 * milioni di richieste al giorno, ed è la ragione per cui la route è per intento.
 */
export async function leggiStatoIntentoVideo(
  rete: Rete,
  dati: { intentId: string; ripiego: string },
): Promise<EsitoFlusso<StatoIntentoVideo>> {
  const esito = await chiama<unknown>(rete, `/api/video-uploads/${dati.intentId}`, undefined, {
    ripiego: dati.ripiego,
    operazione: 'stato',
    traduci: soloCatalogoDaCorpo,
  })
  if (!esito.ok) return esito
  const letto = leggiCorpoStato(esito.dati, 'stato')
  if (!letto) return { ok: false, codice: null, messaggio: dati.ripiego, stato: null }
  return { ok: true, dati: letto }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3 · PUBBLICARE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Conclude l'impegno: `POST /api/gallery` copia l'uscita convertita dentro il
 * bucket, scrive la riga e chiama `video_intent_finalize` nella stessa richiesta.
 *
 * ⚠️ NESSUN `file_url`. Il percorso nel bucket lo decide il server dopo la copia,
 * e mandarne uno qui è un 400 di validazione (`postBodySchemaCoerente`): due
 * sorgenti per un file solo, con una delle due ignorata in silenzio.
 *
 * ⚠️ E LA SEDE SI DICHIARA, la stessa con cui l'intento è stato aperto: la route
 * rilegge l'intento con `scuola_id` DENTRO la query, quindi una sede diversa non
 * è un rifiuto leggibile ma un 404 «non trovato».
 */
export async function pubblicaVideoInGalleria(
  rete: Rete,
  dati: {
    intentId: string
    revisione: number
    utenteId: string
    didascalia: string
    tagAlunni: string[]
    broadcast: boolean
    classi: string[]
    scuolaId: string | null
    ripiego: string
  },
): Promise<EsitoFlusso<unknown>> {
  return chiama<unknown>(
    rete,
    '/api/gallery',
    json(
      {
        uploaded_by: dati.utenteId,
        file_type: 'video',
        caption: dati.didascalia,
        // In broadcast i tag non partono: la foto (o il video) va a tutta la
        // classe, e il server rifiuta la combinazione con un 400 dedicato.
        tag_students: dati.broadcast ? [] : dati.tagAlunni,
        is_broadcast: dati.broadcast,
        target_classes: dati.broadcast ? dati.classi : null,
        ...(dati.scuolaId ? { scuola_id: dati.scuolaId } : {}),
        video_intent_id: dati.intentId,
        video_revisione: dati.revisione,
      },
      { 'x-user-id': dati.utenteId },
    ),
    {
      ripiego: dati.ripiego,
      operazione: 'pubblicazione',
      // `messaggioDaCorpo` e non `soloCatalogoDaCorpo`: il 422 del Privacy Lock
      // non porta un codice, e la sua prosa dice QUALI bambini togliere dai tag.
      traduci: messaggioDaCorpo,
    },
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4 · LE FASI — ciò che una persona legge mentre aspetta
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Le fasi mostrabili. Sono meno degli stati del database di proposito: `rejected`
 * e `failed` sono due diagnosi diverse per chi indaga e la stessa notizia per chi
 * guarda lo schermo («non è riuscita»), mentre `queued` e `processing` sono la
 * stessa notizia per il database e due attese diverse per una persona — la prima
 * dura secondi, la seconda minuti.
 */
export type FaseVideo = 'caricamento' | 'in-coda' | 'conversione' | 'pronto' | 'fallito' | 'annullato'

const FASE_PER_STATO: Record<StatoJobVideo, FaseVideo> = {
  awaiting_upload: 'caricamento',
  queued: 'in-coda',
  processing: 'conversione',
  ready: 'pronto',
  rejected: 'fallito',
  failed: 'fallito',
  cancelled: 'annullato',
}

export function faseDelJob(stato: StatoJobVideo): FaseVideo {
  return FASE_PER_STATO[stato]
}
