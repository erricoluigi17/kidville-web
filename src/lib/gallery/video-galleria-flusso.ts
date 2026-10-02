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
 * I TRE PASSI DEL CLIENT, E CHI FA IL QUARTO.
 *
 *  1. `POST /api/video-uploads` apre l'INTENTO **con i bambini già scelti**
 *     (`destinatari`) e conia le coordinate TUS. Non riceve un byte: il corpo di
 *     una Function su Vercel si ferma a ~4,5 MB, e questi originali arrivano a
 *     2.000.000.000. L'intento nasce confermato: «Invia» è l'impegno, e da lì il
 *     SERVER sa a chi va il video. Attraversa gli stessi cancelli di
 *     `POST /api/gallery` (sede, bambini della sede, liberatoria fotografica): un
 *     422 che nomina i bambini senza liberatoria torna QUI, prima che parta un
 *     solo byte.
 *  2. i byte partono col protocollo TUS (`@/lib/media/video/upload`), che è
 *     ripartibile: è il pezzo che sopravvive alla galleria della metropolitana.
 *     Il rinnovo della firma NON riapre l'intento: `POST …/[id]/firma`.
 *  3. `PATCH … {azione:'caricato'}` dice che i byte sono tutti sullo Storage
 *     (rete di sicurezza: il server se ne accorge anche da solo).
 *
 *  4. Non è del client. Quando la conversione finisce, a pubblicare è il server,
 *     anche a pagina chiusa, e avvisa chi ha caricato. Il client non ha più
 *     nessun ramo di pubblicazione (`POST /api/gallery` con `video_intent_id`
 *     risponde 409 a chi lo prova ancora) e non richiede più i bambini al rientro:
 *     li ha già scelti, una volta, prima dell'invio.
 *
 * ⚠️ Fra il 3 e la pubblicazione possono passare MINUTI. È il motivo per cui
 * l'interfaccia ha uno stato «in preparazione» invece di una rotellina: se dicesse
 * «caricamento» per otto minuti, qualcuno ricaricherebbe e caricherebbe due volte.
 * Lo stato di ogni video lo racconta `GET /api/video-uploads` (l'elenco), da
 * qualunque dispositivo l'abbia mandato.
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
  schemaVoceVideo,
  type CodiceMostratoVideo,
  type CoordinateCaricamentoVideo,
  type DestinatariVideo,
  type StatoJobVideo,
  type StatoJobVideoLetto,
  type VoceVideo as VoceElencoVideo,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, validateVideoInputSize } from '@/lib/media/video/limiti'
import type { NomeTrasportoVideo } from '@/lib/media/video/trasporto'
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
 * ⚠️ PERCHÉ VALE LA PENA CHIEDERGLIELO. Il tetto di durata (`MAX_VIDEO_DURATION_SECONDS`,
 * cinque minuti) lo applica ffprobe DOPO il caricamento: un video da 2 GB e sei
 * minuti verrebbe spedito per intero su rete mobile, messo in coda, e rifiutato.
 * Qui costa qualche decina di millisecondi e chiude il caso prima che parta un byte.
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
 * I destinatari come partono DAVVERO verso il server: in broadcast i tag non partono (il server
 * risponde 400 alla combinazione) e le classi sono quelle della scelta; altrimenti partono i tag e
 * nessuna classe. È la forma che `apriIntentoVideoGalleria` mette nel corpo, ed è la STESSA su cui
 * `chiaveIdempotenzaVideo` costruisce l'impronta: chiave e corpo non possono raccontare due scelte.
 */
export function destinatariDaInviare(d: DestinatariVideo): DestinatariVideo {
  return {
    tagAlunni: d.broadcast ? [] : d.tagAlunni,
    broadcast: d.broadcast,
    classi: d.broadcast ? d.classi : [],
  }
}

/**
 * LA CHIAVE CON CUI IL CLIENT RICONOSCE IL PROPRIO INVIO FRA UN TENTATIVO E L'ALTRO.
 *
 * ═══ LA FORMA: `gv2-<byte>-<data>-<impronta del nome>-<impronta dei destinatari>` ═══════════════
 *
 * Deve essere DETERMINISTICA: `video_jobs_owner_channel_idempotency_key_key` la usa per non creare
 * due job quando la rete cade a metà della `POST`, e una chiave casuale trasformerebbe ogni
 * ritentativo in un secondo caricamento — cioè in un secondo video da convertire e pagare. Lo STESSO
 * invio ripetuto (la risposta si è persa) ritrova il suo intento.
 *
 * ⚠️ PERCHÉ PORTA I DESTINATARI, E PERCHÉ COMINCIA PER `gv2-`.
 * `video_galleria_intent_apri` (spec §5.3) legge la chiave così: stessi destinatari, trasporto e
 * byte → una ripetizione, ritorna lo stesso intento; STESSA chiave con valori diversi →
 * `IDEMPOTENCY_CONFLICT`; chiave già usata da un intento del flusso VECCHIO → `IDEMPOTENCY_CONFLICT`,
 * perché quell'intento non ha i bambini e non si adotta. La route lo traduce in 409 `VIDEO_RIPROVA`,
 * e a schermo esce «Ricarica la pagina e riprova»: una frase che non può riuscire, se il client
 * rimanda sempre la stessa chiave. La chiave di prima (`g-<byte>-<data>-<impronta del nome>`, senza
 * i destinatari, identica a quella del client in produzione) prendeva quel 409:
 *  · per ogni file già mandato col client in produzione — compresi i video che la scheda dice
 *    «questo video va ricaricato: scegli di nuovo il file e invialo», cioè il gesto che la scheda
 *    CHIEDE: dove nome, peso e data restano gli stessi (un browser da PC, Android) falliva sempre;
 *  · per lo stesso file rimandato con altri bambini, per esempio dopo «Rimuovi».
 * Il prefisso `gv2-` non può ritrovare una chiave del flusso vecchio (`g-…`), e l'impronta dei
 * destinatari fa aprire un intento NUOVO quando i bambini cambiano. NON tornare a `g-`, e non
 * togliere i destinatari: i server finti di una volta rispondevano 201 a qualunque chiave e non
 * l'avrebbero visto. Lo vedono `video-galleria-chiave-rpc.test.ts`, che parla con la funzione SQL
 * vera, e il server finto con la semantica del §5.3 di `video-galleria-recupero.test.tsx`.
 *
 * I destinatari entrano come INSIEMI (ordine e doppioni non contano, come li legge la RPC; la grafia
 * dell'uuid nemmeno: il contratto li porta in minuscolo) e nella forma in cui partono
 * (`destinatariDaInviare`): in broadcast contano le classi e non i tag, altrimenti il contrario.
 *
 * ⚠️ NON PUÒ CONTENERE IL NOME DEL FILE NÉ UN UUID DI BAMBINO. La chiave viaggia al server, viene
 * scritta in chiaro in `video_jobs.idempotency_key` e compare nel contesto di log della route:
 * `recita-bambina-rossi.mov` è anagrafica di un minore, e un uuid di bambino ne è l'identificativo.
 * Di entrambi restano impronte a 32 bit, che distinguono due invii senza dire quali siano.
 *
 * ⚠️ NEL LIMITE DEI 128 CARATTERI (zod `chiaveIdempotenza`, e `video_intent_open`) anche col
 * suffisso `-<uuid>` che `avviaVideo` aggiunge quando l'intento ritrovato è già concluso: il caso
 * peggiore — due gigabyte, una data a 13 cifre — fa 46 caratteri, più 37 del suffisso.
 */
export function chiaveIdempotenzaVideo(
  file: { name: string; size: number; lastModified?: number },
  destinatari: DestinatariVideo,
): string {
  // Una data intera in millisecondi: `File.lastModified` lo è, ma una cifra decimale o un esponente
  // metterebbero un carattere fuori da `[a-z0-9-]` dentro una chiave che finisce in tabella e nei log.
  const data = Math.trunc(Number(file.lastModified))
  const quando = Number.isSafeInteger(data) ? data : 0
  const inviati = destinatariDaInviare(destinatari)
  const tag = [...new Set(inviati.tagAlunni.map((id) => id.toLowerCase()))].sort()
  const classi = [...new Set(inviati.classi)].sort()
  const bambini = improntaBreve(JSON.stringify([tag, inviati.broadcast, classi]))
  return `gv2-${file.size}-${quando}-${improntaBreve(file.name)}-${bambini}`
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
 * `traduci` è un parametro perché le chiamate hanno due regole diverse, e la
 * differenza è misurata:
 *  · le route video mandano SEMPRE un `codice` dichiarato, e la loro prosa nasce
 *    italiana dentro una route dove il locale non esiste → `soloCatalogoDaCorpo`;
 *  · l'apertura con i bambini attraversa i cancelli di `POST /api/gallery`, che
 *    mandano anche rifiuti SENZA codice cui la prosa aggiunge l'unica cosa utile
 *    (i nomi dei bambini senza liberatoria) → `traduciRifiutoApertura`.
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
 * Il testo di un rifiuto dell'APERTURA: il catalogo, e la prosa del server per UN caso solo.
 *
 * Le route video mandano sempre un `codice` dichiarato e la loro prosa nasce italiana in una
 * route dove il locale non esiste, quindi di norma si legge il catalogo (`soloCatalogoDaCorpo`).
 * Ma l'apertura con i bambini attraversa i cancelli di `POST /api/gallery`, e il rifiuto del
 * Privacy Lock — il 422 — non porta un `codice`: porta `nomi`, e la sua prosa dice QUALI bambini
 * togliere dalla scelta. Il catalogo non può conoscerli, e senza di loro la persona leggerebbe
 * «non è riuscito» senza sapere che cosa correggere. È la scelta che questa schermata fa dal
 * 2026-08-03 (`messaggioDaCorpo`); si limita al corpo che i nomi li porta davvero, così un 400 di
 * validazione o un 502 dell'infrastruttura non fanno comparire prosa italiana in un'interfaccia
 * inglese.
 */
function traduciRifiutoApertura(corpo: unknown, ripiego: string): string {
  const nomi = (corpo as { nomi?: unknown } | null)?.nomi
  if (Array.isArray(nomi) && nomi.length > 0) return messaggioDaCorpo(corpo, ripiego)
  return soloCatalogoDaCorpo(corpo, ripiego)
}

/**
 * ⚠️ `file` è una FORMA, non un `File`: nome, byte e MIME bastano all'apertura, e la schermata
 * la chiama con il `File` appena scelto.
 *
 * `destinatari` è il motivo per cui questa funzione esiste nella forma di oggi: i bambini si
 * scelgono PRIMA dell'invio e viaggiano con l'apertura, e il server pubblica da solo quando il
 * video è pronto. In broadcast i tag non partono (il server risponde 400 alla combinazione) e le
 * classi sono quelle della scelta. Senza destinatari il server risponde 409
 * `VIDEO_APP_DA_AGGIORNARE`: è un client col JS vecchio.
 *
 * `trasporto` dichiara come arriveranno i byte (`scegliTrasporto().nome`): oggi sempre `tus`.
 *
 * ⚠️ `chiaveIdempotenza` è quella di `chiaveIdempotenzaVideo` calcolata su QUESTI STESSI destinatari:
 * il server rifiuta (`IDEMPOTENCY_CONFLICT`, 409 `VIDEO_RIPROVA`) la stessa chiave con bambini diversi.
 */
export async function apriIntentoVideoGalleria(
  rete: Rete,
  dati: {
    file: { name: string; size: number; type: string }
    scuolaId: string
    durataSecondi: number | null
    chiaveIdempotenza: string
    destinatari: DestinatariVideo
    trasporto: NomeTrasportoVideo
    ripiego: string
  },
): Promise<EsitoFlusso<IntentoApertoVideo>> {
  const durata =
    typeof dati.durataSecondi === 'number' && Number.isFinite(dati.durataSecondi) && dati.durataSecondi > 0
      ? dati.durataSecondi
      : null
  const destinatari = destinatariDaInviare(dati.destinatari)

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
      destinatari,
      trasporto: dati.trasporto,
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
      traduci: traduciRifiutoApertura,
      // Conteggi e un booleano: mai un identificativo di bambino (il 422 li porta a schermo e basta).
      campi: { byte: dati.file.size, n_tag: destinatari.tagAlunni.length, broadcast: destinatari.broadcast },
    },
  )
  if (!esito.ok) return esito

  const primo = Array.isArray(esito.dati.job) ? esito.dati.job[0] : undefined
  const intentId = typeof esito.dati.intentId === 'string' ? esito.dati.intentId : ''
  const revisione = Number(esito.dati.revisione)
  const jobId = typeof primo?.jobId === 'string' ? primo.jobId : ''
  const firma = typeof primo?.firma === 'string' ? primo.firma : ''
  const needsUpload = primo?.needs_upload !== false
  // Si è chiesto `tus`: se la risposta porta un altro protocollo il server e il client non si
  // capiscono, e spedire i byte con le coordinate di un'altra strada non finirebbe da nessuna parte.
  const protocollo = (primo?.caricamento as { protocollo?: unknown } | undefined)?.protocollo

  if (
    !intentId || !jobId || (needsUpload && !firma) || !Number.isInteger(revisione) || revisione < 1
    || (protocollo !== undefined && protocollo !== 'tus')
  ) {
    // La porta ha risposto 201 e non ha restituito ciò che promette: è un difetto
    // NOSTRO, e va visto — senza questa riga il caricamento morirebbe dopo, dentro
    // tus, con un errore che la causa non la nomina.
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: 'video-galleria-apertura-incompleta',
      campi: { con_intento: Boolean(intentId), con_job: Boolean(jobId), con_firma: Boolean(firma), protocollo_tus: protocollo === undefined || protocollo === 'tus' },
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

/**
 * Il «Riprova» di una pubblicazione fallita in modo definitivo: solo l'autore, solo se il video è
 * ancora pronto e l'uscita c'è. Il server decide (409 `VIDEO_RIPROVA_NON_POSSIBILE` se non si può
 * più) e riporta l'intento a «da pubblicare»: a pubblicare di nuovo è lui, non il client. Non porta
 * nient'altro: l'intento è quello dell'URL e i job sono «tutti i pronti».
 */
export function riprovaPubblicazioneVideo(
  rete: Rete,
  dati: { intentId: string; ripiego: string },
): Promise<EsitoFlusso<StatoIntentoVideo>> {
  return azione(
    rete,
    dati.intentId,
    { azione: 'riprova-pubblicazione' },
    { ripiego: dati.ripiego, operazione: 'riprova-pubblicazione' },
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
 * 3 · L'ELENCO — i miei video, da qualunque dispositivo
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * L'elenco dei video dell'insegnante nella sede indicata: `GET /api/video-uploads?canale=gallery&scuolaId=…`.
 *
 * ⚠️ OGNI VOCE SI VERIFICA DA SOLA, e una voce che non rispetta il contratto non fa cadere le
 * altre: l'elenco è l'unico posto in cui un'insegnante vede un video mandato da un altro
 * dispositivo, e buttarlo intero per una voce storta vorrebbe dire non vederne nessuno. Le
 * scartate si CONTANO e si loggano (un difetto del server non deve passare in silenzio), senza
 * un solo valore: sono identificativi.
 *
 * Il server manda solo numeri, stati, uuid e il codice mostrabile — mai nomi di file né di
 * bambini — quindi dell'elenco nessun dato personale finisce in un log.
 */
export async function leggiElencoVideoGalleria(
  rete: Rete,
  dati: { scuolaId: string; ripiego: string },
): Promise<EsitoFlusso<{ voci: VoceElencoVideo[] }>> {
  const esito = await chiama<{ voci?: unknown }>(
    rete,
    `/api/video-uploads?canale=gallery&scuolaId=${encodeURIComponent(dati.scuolaId)}`,
    undefined,
    { ripiego: dati.ripiego, operazione: 'elenco', traduci: soloCatalogoDaCorpo },
  )
  if (!esito.ok) return esito

  const grezze = esito.dati?.voci
  if (!Array.isArray(grezze)) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: 'video-galleria-elenco-fuori-contratto',
      campi: { forma: typeof grezze },
    })
    return { ok: false, codice: null, messaggio: dati.ripiego, stato: null }
  }

  const voci: VoceElencoVideo[] = []
  for (const grezza of grezze) {
    const letta = schemaVoceVideo.safeParse(grezza)
    if (letta.success) voci.push(letta.data)
  }
  if (voci.length !== grezze.length) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      route: '/teacher/gallery',
      messaggio: 'video-galleria-voci-fuori-contratto',
      campi: { ricevute: grezze.length, scartate: grezze.length - voci.length },
    })
  }
  return { ok: true, dati: { voci } }
}
