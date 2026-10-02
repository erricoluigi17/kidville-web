import { Upload, defaultOptions, type HttpRequest, type HttpStack } from 'tus-js-client'

import { mimeBase } from '@/lib/gallery/limiti'
import { logClient, nomeErrore } from '@/lib/logging/client'

import {
  codiceMessaggioVideo,
  type CanaleVideo,
  type CodiceMostratoVideo,
  type CoordinateCaricamentoVideo,
} from '../contratto'
import { validateVideoInputSize } from '../limiti'
import type { ArchivioCaricamentiVideo } from './archivio'
import { ErroreByteVideo, eCopiaAnnullata, type ByteVideo } from './byte-video'
import { LettoreBlob } from './lettore-blob'
import {
  caricamentiDaPotare,
  caricamentiDaRiprendere,
  caricamentiDaSeguire,
  nuovoCaricamento,
  type CaricamentoVideoLocale,
} from './stato'

/**
 * L'UPLOADER TUS — il pezzo che porta i byte dal telefono di un genitore al bucket
 * privato, e che deve sopravvivere a una rete mobile e alla chiusura dell'app.
 *
 * ─── I DUE CRITERI, E COME SONO SODDISFATTI ────────────────────────────────
 *
 * **1. Un upload interrotto riprende da dove era.** Non lo fa la buona volontà:
 * lo fa il protocollo TUS, a condizione che il client conservi l'URL della
 * sessione. Quell'URL è `CaricamentoVideoLocale.urlTus` e viene scritto
 * nell'archivio appena il server lo comunica (`onUploadUrlAvailable`); alla
 * ripresa lo si passa a tus come `uploadUrl`, tus manda una `HEAD`, e l'offset da
 * cui ripartire lo dice il SERVER contando i byte che ha davvero. Se quell'URL non
 * fosse persistito non ci sarebbe nessun errore: partirebbe una `POST` nuova e si
 * ricomincerebbe da zero, in silenzio, su una rete mobile.
 *
 * **2. L'app chiusa dopo il completamento non perde il job.** I byte spariscono
 * (due gigabyte sul telefono non si tengono per sport) ma la RIGA resta, con
 * `jobId`, `intentId` e canale: è quello che `jobDaSeguire()` restituisce al
 * rientro, ed è l'unico modo perché la schermata sappia che cosa tornare a
 * interrogare mentre il Sandbox converte.
 *
 * ─── LA COPIA LOCALE È IN BACKGROUND, E NON FA PIÙ DA CANCELLO ──────────────
 *
 * Fino al 2026-10-02 `accodaCaricamentoVideo` copiava l'originale intero in
 * IndexedDB PRIMA di far partire qualunque cosa: due gigabyte di Blob, minuti di
 * «preparazione» con la persona ferma davanti allo schermo, e solo dopo il primo
 * byte in rete. Ora scrive la riga, ricorda il `File` scelto (la «sorgente viva»,
 * più sotto) e basta: la copia parte per conto suo, NON viene attesa, e il
 * trasferimento comincia subito, leggendo dal `File`.
 *
 * La copia serve a una cosa sola — la ripresa dopo la chiusura dell'app, quando il
 * `File` è morto con la pagina — ed è quindi un lavoro che può diventare inutile
 * prima di finire. Per questo ha un `AbortSignal`, ed è lo stesso `AbortController`
 * (UNO per job) che ferma il trasferimento:
 *
 *  · il trasferimento arriva in fondo prima della copia → la copia si ferma e si
 *    cancella, invece di scrivere gigabyte che un attimo dopo si buttano;
 *  · la persona toglie il video (`annullaCaricamentoVideo`) → si fermano insieme il
 *    trasferimento TUS e la copia: «Rimuovi» ferma davvero ciò che sta girando;
 *  · sul dispositivo non c'è lo spazio per tenerla (`navigator.storage.estimate`) →
 *    la copia non parte, e un log `warn` con i soli byte lo dice. Il video parte lo
 *    stesso: per QUEL video manca solo la ripresa dopo la chiusura dell'app.
 *
 * Chi chiude l'app prima che la copia sia finita ritrova la riga ma non i byte, e
 * `caricaVideo` lo dice (`video-upload-byte-spariti`) invece di tacere: è lo stesso
 * esito del browser che sfratta IndexedDB. È il prezzo di non far aspettare chi
 * carica, ed è una scelta, non una svista.
 *
 * ─── LE DIPENDENZE SONO INIETTATE, E NON PER ELEGANZA ──────────────────────
 *
 * Qui non c'è un server TUS, non c'è Supabase Storage e non ci sarà finché non si
 * arriva al collaudo su dispositivo (M12). Con l'archivio e lo strato HTTP
 * iniettabili, la ripresa si collauda contro un server finto che interrompe
 * DAVVERO una `PATCH` a metà — offset parziale, non un flag — e il `tus.Upload`
 * che gira nel test è quello vero.
 *
 * ─── COSA NON PASSA MAI DI QUI ─────────────────────────────────────────────
 *
 * Il token. `intestazioni()` è una FUNZIONE e viene chiamata a ogni partenza:
 * l'archivio non contiene credenziali e la ripresa dopo tre giorni usa una
 * sessione nuova, non quella scaduta di allora.
 *
 * Il nome del file nei log. `IMG_bambina-rossi.mov` è anagrafica di un minore, e
 * `app_log` lo terrebbe trenta giorni interrogabile in SQL. Nei log escono
 * `jobId`, byte, millisecondi e stati: struttura, mai contenuto.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * LA SUPERFICIE
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DipendenzeCaricamentoVideo {
  archivio: ArchivioCaricamentiVideo
  /**
   * Le intestazioni con cui autenticare l'upload: `{ 'x-signature': <firma> }`.
   *
   * \u26a0\ufe0f NON un `Bearer <access_token>`, e la distinzione non e' formale. L'upload
   * TUS passa da `/upload/resumable/sign`, dove la firma la conia la ROUTE con la
   * chiave di servizio (`POST /api/video-uploads`, campo `firma` accanto alle
   * coordinate): il browser allo Storage non presenta mai un token di sessione, ed e'
   * lo stesso motivo per cui nessuna policy su `storage.objects` e' necessaria — quella
   * strada non attraversa RLS. La testata di
   * `supabase/migrations/20260916190200_video_intent_lifecycle.sql` lo spiega con le misure.
   *
   * E' una FUNZIONE apposta: una firma scade, e alla ripresa ne serve una fresca.
   * Chi la fornisce risponde con quella che ha (in memoria, mai su disco) e la
   * rinnova per conto suo quando sa che sta per scadere; quando invece è lo Storage
   * a rifiutarla a trasferimento avviato, il rinnovo lo chiede la libreria con
   * `rinnovaFirma`, più sotto.
   *
   * È una funzione, non un valore, e la differenza è tutto il punto: un
   * caricamento ripreso tre giorni dopo deve usare la sessione di ADESSO. Con un
   * valore, l'unico modo di averla sarebbe stato conservarla, cioè scrivere una
   * credenziale di un genitore in IndexedDB.
   */
  intestazioni: () => Promise<Record<string, string>> | Record<string, string>
  /**
   * RINNOVA LA FIRMA TUS DI UN JOB — facoltativa, e iniettata come tutto il resto.
   *
   * La firma di un upload vale due ore, e un originale da un gigabyte su una rete
   * mobile ne dura di più: a metà strada lo Storage comincia a rispondere 401/403 a
   * un trasferimento che era sano. Prima di questa dipendenza il rifiuto arrivava
   * alla persona come «interrotto: rientra nell'app», e il rinnovo passava dalla
   * riapertura dell'intento — un'apertura intera per ogni firma (190 aperture per 44
   * job, misurate prima della PR 2). Ora la libreria, appena lo Storage rifiuta la
   * firma, chiama QUESTA funzione e prosegue dallo stesso offset con le intestazioni
   * nuove; la galleria la collega a `POST /api/video-uploads/[id]/firma`, che non
   * riapre niente.
   *
   * Contratto, per chi la scrive:
   *  · riceve il `jobId` e risponde con le intestazioni da usare da ORA IN POI, nella
   *    stessa forma di `intestazioni()` (`{ 'x-signature': <firma nuova> }`);
   *  · se la firma non si può rinnovare (il job non aspetta più i byte, la sessione è
   *    scaduta, la rete è giù) RIFIUTA: la libreria lo scrive nel log e riporta il
   *    rifiuto dello Storage a chi guarda, come se la funzione non ci fosse stata;
   *  · si tiene la firma nuova per le chiamate successive di `intestazioni()`, altrimenti
   *    ogni ripresa riparte dalla vecchia, la prima richiesta prende 403 e si rinnova di nuovo;
   *  · la libreria la chiama al più UNA volta per ogni tratto di trasferimento fatto: un
   *    rinnovo che non fa avanzare nemmeno un byte non ne chiama un secondo.
   *
   * Senza di lei niente cambia: il rifiuto dello Storage resta «interrotto», com'era.
   */
  rinnovaFirma?: (jobId: string) => Promise<Record<string, string>>
  /** Lo strato HTTP di tus. Nel browser si lascia il suo (XHR, con il progresso). */
  pilaHttp?: HttpStack
  /** L'orologio. Iniettabile perché i timestamp siano verificabili. */
  adesso?: () => Date
  /**
   * I ritardi fra un ritentativo e l'altro, in millisecondi. Il default è
   * `RITARDI_RITENTATIVO_MS` (0, 1, 3, 5, 10, 20, 30 e 60 secondi): più di due minuti
   * di rete assente CONTINUA prima di arrendersi, perché una galleria in metropolitana
   * dura nove secondi e un telefono che ritrova il campo dopo una sospensione ne
   * impiega di più. `[]` disattiva i ritentativi. Vale anche per la chiusura della
   * sessione (`RITARDI_CHIUSURA_SESSIONE_MS` è il default di quella, più corto: non
   * deve tenere in ostaggio un annullamento).
   */
  ritardiRitentativo?: number[]
}

/**
 * I ritardi fra un ritentativo e l'altro di UN trasferimento, in millisecondi.
 *
 * Erano i quattro di tus (`[0, 1000, 3000, 5000]`, nove secondi in tutto): bastavano
 * per un tunnel, non per una cella agganciata male. tus azzera il contatore a ogni blocco
 * accettato, quindi il tetto — due minuti e un quarto — riguarda solo un'assenza di rete
 * ininterrotta, mai la durata del trasferimento. Oltre, `caricaVideo` risponde «interrotto»
 * e la ripresa automatica (backoff 5-15-30-60 s, galleria) prende il testimone.
 */
export const RITARDI_RITENTATIVO_MS: readonly number[] = [0, 1_000, 3_000, 5_000, 10_000, 20_000, 30_000, 60_000]

/**
 * I ritardi della DELETE che chiude la sessione TUS. I quattro di prima: chi annulla un
 * video con la rete assente non deve aspettare due minuti di ritentativi di una richiesta
 * che comunque non serve a lui — la sessione abbandonata la porta via la ritenzione.
 */
export const RITARDI_CHIUSURA_SESSIONE_MS: readonly number[] = [0, 1_000, 3_000, 5_000]

/**
 * Quante firme si rinnovano al massimo in un solo `caricaVideo`. Il vero freno è che ogni
 * rinnovo deve essere seguito da byte accettati; questo è il tetto di sicurezza, perché un
 * ciclo di rinnovi che non finisce mai consumerebbe richieste a un server che ha già detto di no.
 */
const MAX_RINNOVI_FIRMA = 6

export interface OpzioniCaricamento {
  /**
   * Annulla il caricamento. Si inoltra all'`AbortController` del job — lo stesso che
   * `annullaCaricamentoVideo` annulla da fuori — quindi ferma anche la copia locale in
   * background, e termina la sessione TUS: nessun orfano.
   */
  segnale?: AbortSignal
  /** Byte spediti / byte totali. Non tocca il disco: serve solo alla barra. */
  alProgresso?: (fatti: number, totali: number) => void
}

export interface IngressoAccodamento {
  jobId: string
  intentId: string
  canale: CanaleVideo
  ownerId?: string | null
  scuolaId?: string | null
  chiaveIdempotenza: string
  coordinate: CoordinateCaricamentoVideo
  file: File
}

export type EsitoAccodamento =
  | { ok: true; riga: CaricamentoVideoLocale }
  | { ok: false; codice: CodiceMostratoVideo }

export type EsitoCaricamentoVideo =
  /** I byte sono tutti sullo Storage: da qui in poi il lavoro è del server. */
  | { esito: 'caricato'; jobId: string; byteCaricati: number }
  /**
   * Non è finita e non è fallita: la riga resta ripescabile e i byte pure.
   * `codice` è valorizzato solo quando c'è qualcosa che una persona può FARE
   * (rientrare, tipicamente); per una rete caduta è `null`, perché «riprova» a
   * qualcuno che non ha campo non è un'informazione.
   */
  | { esito: 'interrotto'; jobId: string; offsetByte: number; codice: CodiceMostratoVideo | null }
  | { esito: 'annullato'; jobId: string }
  /** Riprovare questi byte non può funzionare: la riga si chiude, il peso si libera. */
  | { esito: 'fallito'; jobId: string; codice: CodiceMostratoVideo }

export interface JobDaSeguire {
  jobId: string
  intentId: string
  canale: CanaleVideo
}

type CampiLog = Record<string, string | number | boolean>

/* ────────────────────────────────────────────────────────────────────────────
 * I LOG
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ LO STATO HTTP STA IN `campi`, NON NEL CAMPO `stato`, ed è deliberato.
 *
 * `livelloEvento` (in `@/lib/logging/client`) SOPPRIME gli eventi che portano uno
 * `stato` 4xx ordinario: giustamente, perché quei rifiuti li registra già il
 * nostro server. Qui il rifiuto NON viene dal nostro server — viene da Supabase
 * Storage, che i nostri log non li scrive — e l'evento è «il video di un genitore
 * non è partito», che nessun altro registrerà. Passandolo come `stato` sparirebbe.
 * È la stessa scelta, e la stessa ragione, di `logFlush` in `syncEngine.ts`.
 *
 * Il `messaggio` porta il `jobId` perché la chiave di deduplica di `logClient` è
 * `evento|messaggio|stato`: senza, due caricamenti diversi nello stesso minuto
 * collasserebbero in una riga sola e «due video persi» sarebbe indistinguibile da
 * «uno».
 */
function segnala(
  livello: 'warn' | 'error',
  messaggio: string,
  jobId: string,
  campi: CampiLog,
): void {
  logClient({ livello, evento: 'fetch', messaggio: `${messaggio}: job=${jobId}`, campi })
}

/** Dexie mette la causa vera di un abort in `inner` (è lì che c'è «quota»). */
function campiErrore(err: unknown): CampiLog {
  const interno = (err as { inner?: unknown } | null | undefined)?.inner
  return interno ? { error_code: nomeErrore(err), causa: nomeErrore(interno) } : { error_code: nomeErrore(err) }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA SORGENTE VIVA
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il `File` scelto in QUESTA sessione, accanto all'archivio che l'ha accodato.
 *
 * Finché la pagina resta aperta tus legge da qui e non dai blocchi salvati: la
 * copia in IndexedDB serve alla ripresa dopo la chiusura dell'app, non al
 * trasferimento. Tre conseguenze, tutte misurate dal critico del 2026-09-26:
 * un salvataggio locale fallito (telefono pieno) non impedisce più l'invio, una
 * riscrittura dello stesso video mentre parte non toglie i byte da sotto il
 * trasferimento, e l'invio non contende IndexedDB con la copia di un altro video.
 *
 * Chiave: l'istanza dell'archivio. Una pagina nuova ha un archivio nuovo, cioè
 * nessuna sorgente viva — esattamente come un'app riaperta.
 */
const sorgentiVive = new WeakMap<ArchivioCaricamentiVideo, Map<string, Blob>>()

function ricordaSorgenteViva(archivio: ArchivioCaricamentiVideo, jobId: string, file: Blob): void {
  let perArchivio = sorgentiVive.get(archivio)
  if (!perArchivio) {
    perArchivio = new Map()
    sorgentiVive.set(archivio, perArchivio)
  }
  perArchivio.set(jobId, file)
}

function sorgenteViva(archivio: ArchivioCaricamentiVideo, jobId: string, dimensione: number): Blob | undefined {
  const file = sorgentiVive.get(archivio)?.get(jobId)
  return file && file.size === dimensione ? file : undefined
}

function dimenticaSorgenteViva(archivio: ArchivioCaricamentiVideo, jobId: string): void {
  sorgentiVive.get(archivio)?.delete(jobId)
}

/**
 * La riga è piccola ma senza di lei non c'è caricamento da seguire. Se non si
 * scrive (IndexedDB chiuso o disco pieno) il video si rifiuta con un messaggio:
 * lasciar salire l'eccezione fermerebbe anche il resto del lotto della galleria.
 */
async function scriviRiga(dip: DipendenzeCaricamentoVideo, riga: CaricamentoVideoLocale): Promise<boolean> {
  try {
    await dip.archivio.scrivi(riga)
    return true
  } catch (err) {
    segnala('error', 'video-upload-riga-non-scritta', riga.jobId, campiErrore(err))
    return false
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL LAVORO LOCALE DI UN JOB — un solo AbortController, e la copia in background
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Tutto ciò che QUESTO dispositivo sta facendo per un job, sotto un solo
 * `AbortController`: il trasferimento TUS e la copia dei byte.
 *
 * Perché uno solo. «Rimuovi» deve fermare ciò che gira, tutto insieme: un controllore
 * per il trasferimento e uno per la copia vorrebbero dire due annullamenti da
 * ricordarsi, e il giorno in cui qualcuno ne dimentica uno resta un video tolto
 * dall'elenco che continua a scrivere gigabyte sul disco, o a spedirli in rete.
 *
 * Quando nasce e quando muore:
 *  · nasce con la prima cosa che serve — `accodaCaricamentoVideo`, che avvia la copia,
 *    o `caricaVideo`, che avvia il trasferimento — e lo condividono tutte e due;
 *  · un trasferimento `interrotto` NON lo chiude: la riga resta ripescabile, e la
 *    copia, che serve proprio alla ripresa, deve poter finire;
 *  · ogni esito DEFINITIVO (caricato, fallito, annullato, concluso altrove) lo annulla
 *    e lo toglie: una copia che gira ancora non serve più a nessuno;
 *  · un lavoro già annullato non si riusa: chi arriva dopo — la persona che riseleziona
 *    lo stesso file — ne ottiene uno nuovo.
 *
 * Chiave: l'istanza dell'archivio, come per la sorgente viva.
 */
interface LavoroLocale {
  annulla: AbortController
  /** La copia in background, finché dura. Non rigetta mai: ogni suo errore è già nel log. */
  deposito: Promise<void> | null
}

const lavoriLocali = new WeakMap<ArchivioCaricamentiVideo, Map<string, LavoroLocale>>()

function lavoroDelJob(archivio: ArchivioCaricamentiVideo, jobId: string): LavoroLocale {
  let perArchivio = lavoriLocali.get(archivio)
  if (!perArchivio) {
    perArchivio = new Map()
    lavoriLocali.set(archivio, perArchivio)
  }
  let lavoro = perArchivio.get(jobId)
  if (!lavoro || lavoro.annulla.signal.aborted) {
    lavoro = { annulla: new AbortController(), deposito: null }
    perArchivio.set(jobId, lavoro)
  }
  return lavoro
}

/**
 * Il lavoro locale è finito per sempre, o annullato: si ferma tutto ciò che è ancora
 * in piedi — la copia dei byte, se gira — e si dimentica il file vivo. Idempotente.
 *
 * ⚠️ VA CHIAMATA PRIMA DI `eliminaByte`, non dopo. Sull'archivio vero le operazioni
 * sullo stesso job vanno in fila: un `eliminaByte` messo dietro una copia di due
 * gigabyte aspetterebbe che la copia finisca, per poi cancellarla.
 *
 * `lavoro` si passa quando lo si ha in mano (il trasferimento): così un lavoro NUOVO
 * dello stesso job, nato nel frattempo, non viene annullato da un trasferimento vecchio
 * che sta finendo.
 */
function liberaLavoroLocale(archivio: ArchivioCaricamentiVideo, jobId: string, lavoro?: LavoroLocale): void {
  dimenticaSorgenteViva(archivio, jobId)
  const perArchivio = lavoriLocali.get(archivio)
  const attuale = lavoro ?? perArchivio?.get(jobId)
  if (!attuale) return
  attuale.annulla.abort()
  if (perArchivio?.get(jobId) === attuale) perArchivio.delete(jobId)
}

/**
 * Quanto spazio dice di avere il browser per questa origine, o `null` quando non lo sa:
 * `navigator.storage` manca nelle WebView vecchie e in jsdom, e `estimate()` può rifiutare
 * o rispondere con numeri illeggibili. `null` NON blocca la copia — senza una misura si
 * prova, e se il disco è pieno lo dice `scriviByte` col suo errore di quota, com'era prima
 * di questo controllo. È un filtro, non una garanzia: serve a non cominciare nemmeno una
 * scrittura che si sa già che non finirà (minuti di disco e di batteria per un deposito
 * che lascerebbe comunque il telefono senza ripresa), e il browser può sbagliare la stima.
 */
async function spazioLibero(jobId: string): Promise<number | null> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
  if (!storage || typeof storage.estimate !== 'function') return null
  try {
    const { quota, usage } = await storage.estimate()
    if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) return null
    const usato = typeof usage === 'number' && Number.isFinite(usage) ? usage : 0
    return Math.max(0, quota - usato)
  } catch (err) {
    segnala('warn', 'video-upload-quota-non-letta', jobId, campiErrore(err))
    return null
  }
}

/**
 * Salva i byte per la ripresa, e se non ci riesce NON ferma il caricamento: lo
 * dice e prosegue con la sola sorgente viva. Su un telefono quasi pieno la copia
 * locale fallisce per quota, mentre l'invio allo Storage di spazio non ne chiede.
 * Si perde la ripresa dopo la chiusura dell'app per QUEL video, non il video.
 */
async function salvaPerRipresa(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  file: File,
  segnale: AbortSignal,
): Promise<void> {
  try {
    await dip.archivio.scriviByte(jobId, file, segnale)
  } catch (err) {
    // La copia si ferma perché il lavoro è finito o è stato annullato: non è un guasto,
    // e un `error` qui direbbe «il telefono ha perso la ripresa» di un video che invece
    // è arrivato (o che una persona ha tolto).
    if (segnale.aborted || eCopiaAnnullata(err)) return
    segnala('error', 'video-upload-archivio-degradato', jobId, { byte: file.size, ...campiErrore(err) })
  }
}

/**
 * La copia in background: la decisione se farla e, se sì, la copia. Non rigetta mai.
 *
 * Tre cancelli, nell'ordine in cui costano:
 *  1. stesso job, stesso file: se c'è già un deposito intero (una scelta ripetuta, o una
 *     copia rimasta senza riga) non si ricopiano due gigabyte accanto a quelli; un
 *     deposito illeggibile vale come assente e si riscrive;
 *  2. lo spazio: se non c'è, la copia non parte e il log lo dice con i soli byte;
 *  3. il segnale, prima di ognuno dei passi lunghi: un lavoro annullato mentre si
 *     controllava non comincia a scrivere.
 */
async function eseguiDeposito(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  file: File,
  segnale: AbortSignal,
): Promise<void> {
  try {
    const presente = await dip.archivio.leggiByte(jobId).catch((err: unknown) => {
      segnala('warn', 'video-upload-deposito-da-riscrivere', jobId, campiErrore(err))
      return undefined
    })
    if (segnale.aborted || presente?.size === file.size) return

    const liberi = await spazioLibero(jobId)
    if (liberi !== null && liberi < file.size) {
      segnala('warn', 'video-deposito-saltato-spazio', jobId, { byte: file.size, liberi })
      return
    }
    if (segnale.aborted) return

    await salvaPerRipresa(dip, jobId, file, segnale)
  } catch (err) {
    // Non dovrebbe arrivarci nessuno dei rami sopra, che hanno già il loro `catch`: è
    // la rete di una promessa che nessuno aspetta, e che rigettando finirebbe nel nulla.
    segnala('error', 'video-upload-deposito-fallito', jobId, campiErrore(err))
  }
}

/** Fa partire la copia in background, SENZA aspettarla. Una per job alla volta. */
function avviaDeposito(dip: DipendenzeCaricamentoVideo, jobId: string, file: File): void {
  const lavoro = lavoroDelJob(dip.archivio, jobId)
  // Il doppio tocco non affianca una seconda copia a quella che gira già.
  if (lavoro.deposito) return
  const copia: Promise<void> = eseguiDeposito(dip, jobId, file, lavoro.annulla.signal).finally(() => {
    if (lavoro.deposito === copia) lavoro.deposito = null
  })
  lavoro.deposito = copia
}

/**
 * Aspetta che la copia in background di un job sia finita, o fermata (subito, se non
 * ce n'è una). Non serve a chi carica — che per costruzione NON aspetta — ma a chi deve
 * guardare il disco dopo: i collaudi, e chi vuole sapere da quando la ripresa dopo la
 * chiusura dell'app è possibile per quel video.
 */
export function attendiDepositoVideo(archivio: ArchivioCaricamentiVideo, jobId: string): Promise<void> {
  return lavoriLocali.get(archivio)?.get(jobId)?.deposito ?? Promise.resolve()
}

/* ────────────────────────────────────────────────────────────────────────────
 * ACCODARE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Crea la riga e ricorda il file scelto: è TUTTO ciò che si aspetta. Da qui in poi
 * `caricaVideo` può partire subito, leggendo dal `File`.
 *
 * La copia dei byte in IndexedDB — quella che rende vero «chiudi l'app e ritrovi il
 * lavoro» — parte nello stesso istante ma per conto suo, e NON si aspetta: copiare due
 * gigabyte teneva chi carica fermo su «preparazione» per minuti, prima del primo byte in
 * rete. Finché non è finita, la ripresa dopo la chiusura dell'app per QUEL video non c'è
 * (`attendiDepositoVideo` dice quando c'è); il trasferimento in questa sessione non ne ha
 * bisogno. Se lo spazio non basta la copia non parte, e il log lo dice.
 */
export async function accodaCaricamentoVideo(
  dip: DipendenzeCaricamentoVideo,
  ingresso: IngressoAccodamento,
): Promise<EsitoAccodamento> {
  const { file, coordinate, jobId } = ingresso

  const taglia = validateVideoInputSize(file.size)
  if (!taglia.ok) {
    segnala('warn', 'video-upload-scartato', jobId, { motivo: taglia.code, byte: file.size })
    return { ok: false, codice: codiceMessaggioVideo(taglia.code) }
  }

  // ⚠️ IL PRIMO DEI DUE CONFRONTI SUL MIME. Il tipo che arriva da un `<input>` o
  // da `MediaRecorder` porta i parametri del produttore
  // (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`); confrontarlo per uguaglianza con
  // il `contentType` deciso dal server respinge un file perfettamente valido. È
  // già successo su questa app il 2026-09-08 — 33 tentativi, 8 insegnanti, 3 sedi,
  // un giorno senza un video nuovo — e i confronti da correggere erano DUE: questo
  // e l'header `contentType` dei metadati TUS, più sotto.
  const tipoFile = mimeBase(file.type)
  const tipoAtteso = mimeBase(coordinate.contentType)
  // Un `File` senza tipo non è un file sbagliato: certi selettori Android
  // consegnano `type: ''`. L'autorità su che cosa sia davvero il file è ffprobe e
  // arriva dopo: qui si rifiuta solo una divergenza DICHIARATA.
  if (tipoFile !== '' && tipoFile !== tipoAtteso) {
    segnala('warn', 'video-upload-mime-diverso', jobId, { atteso: tipoAtteso, avuto: tipoFile })
    return { ok: false, codice: 'VIDEO_FORMATO_NON_SUPPORTATO' }
  }

  // IL DOPPIO TOCCO. Un pulsante premuto due volte, o un `useEffect` che rimonta,
  // rifarebbe `nuovoCaricamento` — cioè `urlTus: null` e `offsetByte: 0` scritti
  // sopra una sessione TUS viva. Sarebbe la ripresa buttata via da un tocco, con
  // i byte già sullo Storage che nessuno andrebbe più a riprendere. Se c'è già una
  // riga che ha ancora byte da spedire, quella vale.
  //
  // Un `fallito` o un `annullato` invece si sovrascrivono: lì riaccodare È la
  // richiesta di ricominciare.
  let esistente: CaricamentoVideoLocale | undefined
  try {
    esistente = await dip.archivio.leggi(jobId)
  } catch (err) {
    // Un archivio che non si legge non si scriverà nemmeno: il video si rifiuta
    // con un codice, invece di far salire l'eccezione e fermare il lotto.
    segnala('error', 'video-upload-riga-illeggibile', jobId, campiErrore(err))
    return { ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }
  }
  if (esistente && !['fallito', 'annullato'].includes(esistente.stato)) {
    if ((esistente.ownerId && ingresso.ownerId && esistente.ownerId !== ingresso.ownerId)
      || (esistente.scuolaId && ingresso.scuolaId && esistente.scuolaId !== ingresso.scuolaId)
      || esistente.canale !== ingresso.canale || esistente.dimensioneByte !== file.size) {
      segnala('warn', 'video-upload-contesto-diverso', jobId, {})
      return { ok: false, codice: 'VIDEO_NON_AUTORIZZATO' }
    }
    // Soltanto la nuova selezione esplicita può attribuire una riga legacy.
    const aggiornata = { ...esistente, ownerId: esistente.ownerId ?? ingresso.ownerId ?? null, scuolaId: esistente.scuolaId ?? ingresso.scuolaId ?? null }
    if (!(await scriviRiga(dip, aggiornata))) return { ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }
    if (esistente.stato !== 'caricato') {
      ricordaSorgenteViva(dip.archivio, jobId, file)
      avviaDeposito(dip, jobId, file)
    }
    return { ok: true, riga: aggiornata }
  }

  const riga = nuovoCaricamento({
    jobId,
    intentId: ingresso.intentId,
    canale: ingresso.canale,
    ownerId: ingresso.ownerId,
    scuolaId: ingresso.scuolaId,
    chiaveIdempotenza: ingresso.chiaveIdempotenza,
    nome: file.name,
    dimensioneByte: file.size,
    mime: tipoAtteso,
    coordinate,
    adesso: (dip.adesso ?? (() => new Date()))(),
  })

  // LA RIGA PRIMA DELLA COPIA, che è l'ordine opposto di prima. La riga è piccola e
  // senza di lei non c'è niente da seguire; la copia è lunga, parte dopo e non si
  // aspetta. Se il browser muore a metà copia resta una riga senza byte — il ramo
  // «byte spariti» di `caricaVideo` lo dice, invece di tacere — e i blocchi senza
  // manifest li toglie `potaDepositiOrfani`. Se la copia fallisce (telefono pieno) la
  // riga resta lo stesso: in questa sessione l'invio legge la sorgente viva.
  ricordaSorgenteViva(dip.archivio, jobId, file)
  if (!(await scriviRiga(dip, riga))) {
    dimenticaSorgenteViva(dip.archivio, jobId)
    // La copia non è partita, ma un deposito rimasto da una scelta precedente dello
    // stesso job — intero, senza una riga che lo nomini — non lo riprenderà nessuno:
    // si libera subito lo spazio, che su un telefono pieno è proprio ciò che ha fatto
    // fallire la riga.
    await dip.archivio.eliminaByte(jobId).catch((err: unknown) => {
      segnala('warn', 'video-upload-deposito-non-liberato', jobId, campiErrore(err))
    })
    return { ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }
  }
  avviaDeposito(dip, jobId, file)
  return { ok: true, riga }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA CLASSIFICAZIONE DEI RIFIUTI
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lo stato HTTP di un errore di tus, quando c'è stata una risposta. */
function statoDiErrore(err: unknown): number | null {
  const risposta = (
    err as { originalResponse?: { getStatus?: () => number } | null } | null | undefined
  )?.originalResponse
  if (!risposta || typeof risposta.getStatus !== 'function') return null
  const stato = risposta.getStatus()
  return Number.isFinite(stato) ? stato : null
}

/** Il corpo della risposta di un rifiuto dello Storage, in minuscolo; vuoto se non c'è. */
function corpoDiErrore(err: unknown): string {
  const risposta = (
    err as { originalResponse?: { getBody?: () => unknown } | null } | null | undefined
  )?.originalResponse
  if (!risposta || typeof risposta.getBody !== 'function') return ''
  return String(risposta.getBody() ?? '').toLowerCase()
}

/** Ciò che lo Storage scrive quando rifiuta la FIRMA di un upload: «Invalid Compact JWS», «jwt expired», «Invalid signature». */
const CORPO_FIRMA_RIFIUTATA = /\bjw[st]\b|signature|expired/

/**
 * Lo Storage ha rifiutato la FIRMA dell'upload, non i byte?
 *
 * 401 e 403, sempre. In più un 400 il cui corpo dice che il guaio è la firma: è lo stesso
 * `400 Invalid Compact JWS` che lo Storage risponde a una `POST` senza credenziali (misurato il
 * 2026-09-17, migrazione `20260916190200`), e per costruzione è ciò che risponde anche a una
 * firma scaduta o rovinata — ⚠️ la scadenza a metà trasferimento NON è stata misurata sul vivo
 * (la firma vale due ore e non si può accorciare), quindi qui si guarda il CORPO invece di
 * fidarsi del solo numero. Un altro 400 — il tipo MIME rifiutato (`invalid_mime_type`) o
 * un corpo che non c'è — NON è una firma, e resta il rifiuto definitivo di sempre.
 */
function eRifiutoDiFirma(err: unknown): boolean {
  const stato = statoDiErrore(err)
  if (stato === 401 || stato === 403) return true
  return stato === 400 && CORPO_FIRMA_RIFIUTATA.test(corpoDiErrore(err))
}

type Classificazione =
  | { tipo: 'interrotto'; codice: CodiceMostratoVideo | null }
  | { tipo: 'fallito'; codice: CodiceMostratoVideo }

/**
 * Che cosa fare di un rifiuto — e la regola NON è «4xx uguale morto».
 *
 * 401 e 403 sono «no» che una PERSONA toglie di mezzo — la sessione è scaduta,
 * basta rientrare — ed è la stessa politica che la coda della primaria applica ai
 * suoi (`RIMEDIABILI` in `syncEngine.ts`): la riga deve essere ancora lì quando
 * qualcuno rimedia, e i byte pure. Buttarli vorrebbe dire chiedere a un genitore
 * di riscegliere un video da due gigabyte perché il token aveva un'ora. Lo stesso
 * vale per un 400 che dice «firma» nel corpo (`eRifiutoDiFirma`): è lo stesso «no».
 *
 * 409 e 423 sono i due 4xx che lo stesso tus considera ritentabili (conflitto di
 * offset, risorsa momentaneamente bloccata); i 5xx lo sono per definizione.
 *
 * Restano definitivi il 413 — lo Storage non accetterà mai questi byte — e il
 * 404/410: la sessione TUS non c'è più, le coordinate sono scadute e l'intento va
 * riaperto, che è esattamente ciò che `VIDEO_RIPROVA` racconta a chi guarda
 * («qualcosa è cambiato mentre si lavorava: ricaricare e riprovare basta»).
 */
function classifica(stato: number | null, firmaRifiutata: boolean): Classificazione {
  if (stato === null) return { tipo: 'interrotto', codice: null }
  if (firmaRifiutata) {
    return { tipo: 'interrotto', codice: 'VIDEO_NON_AUTORIZZATO' }
  }
  if (stato === 413) return { tipo: 'fallito', codice: 'VIDEO_TROPPO_GRANDE' }
  if (stato === 404 || stato === 410) return { tipo: 'fallito', codice: 'VIDEO_RIPROVA' }
  if (stato === 409 || stato === 423 || stato >= 500) {
    return { tipo: 'interrotto', codice: null }
  }
  return { tipo: 'fallito', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }
}

type FineTus = { fine: 'riuscito' } | { fine: 'errore'; err: unknown } | { fine: 'annullato' }

/* ────────────────────────────────────────────────────────────────────────────
 * CARICARE — che è anche RIPRENDERE, di proposito
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Carica (o riprende) un caricamento già accodato.
 *
 * È volutamente la STESSA funzione per le due cose: «partire» e «riprendere»
 * differiscono solo per la presenza di `urlTus` nell'archivio, e tenerle separate
 * vorrebbe dire due strade che possono divergere — con la seconda esercitata solo
 * quando la rete cade, cioè quasi mai in collaudo e sempre in produzione.
 */
const trasferimentiInCorso = new Map<string, Promise<EsitoCaricamentoVideo>>()

export function caricaVideo(dip: DipendenzeCaricamentoVideo, jobId: string, opzioni: OpzioniCaricamento = {}): Promise<EsitoCaricamentoVideo> {
  const esistente = trasferimentiInCorso.get(jobId)
  if (esistente) return esistente
  const promessa = eseguiCaricamentoVideo(dip, jobId, opzioni).finally(() => trasferimentiInCorso.delete(jobId))
  trasferimentiInCorso.set(jobId, promessa)
  return promessa
}

/**
 * Il giro di UN trasferimento, dentro il lavoro locale del job.
 *
 * Il segnale di chi chiama (`opzioni.segnale`) non ferma più il trasferimento da solo:
 * si inoltra all'`AbortController` del job, che è lo stesso su cui lavora la copia in
 * background e che `annullaCaricamentoVideo` può annullare da fuori, senza avere in mano
 * il segnale di chi aveva avviato il trasferimento. Un annullamento — da qualunque delle
 * due parti — ferma TUS e copia insieme.
 *
 * A un esito definitivo il lavoro locale si chiude: la copia che gira ancora non serve
 * più a nessuno. Un `interrotto` no, perché la riga resta ripescabile e la copia serve
 * proprio alla ripresa.
 */
async function eseguiCaricamentoVideo(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  opzioni: OpzioniCaricamento = {},
): Promise<EsitoCaricamentoVideo> {
  const lavoro = lavoroDelJob(dip.archivio, jobId)
  const segnale = opzioni.segnale
  const inoltra = () => lavoro.annulla.abort()
  // Si ascolta da SUBITO, prima di qualunque `await`: un segnale che scatta mentre si
  // leggono la riga e il deposito deve fermare il trasferimento che sta per partire.
  segnale?.addEventListener('abort', inoltra, { once: true })
  try {
    const esito = await trasferisciVideo(dip, jobId, opzioni, lavoro)
    if (esito.esito !== 'interrotto') liberaLavoroLocale(dip.archivio, jobId, lavoro)
    return esito
  } finally {
    segnale?.removeEventListener('abort', inoltra)
  }
}

/**
 * Imposta sulla richiesta le intestazioni di autenticazione.
 *
 * Si scrive SOLO qui, a ogni richiesta: XMLHttpRequest concatena `setRequestHeader`
 * ripetuti, e impostare la firma anche in `headers` produrrebbe "firma, firma",
 * rifiutata dallo Storage con Invalid Compact JWS prima del primo byte.
 */
type ImpostaIntestazioni = (richiesta: HttpRequest) => Promise<void>

/** Le intestazioni si chiedono alla fonte a OGNI richiesta, mai una volta per tutte: una firma scade. */
function intestazioniDa(
  fonte: () => Promise<Record<string, string>> | Record<string, string>,
): ImpostaIntestazioni {
  return async (richiesta) => {
    const attuali = await fonte()
    for (const [chiave, valore] of Object.entries(attuali)) richiesta.setHeader(chiave, valore)
  }
}

/**
 * Le opzioni con cui si chiude una sessione TUS (la `DELETE`): le stesse intestazioni
 * dell'upload, ma i ritardi del DEFAULT di chiusura — più corti di quelli del
 * trasferimento (`RITARDI_CHIUSURA_SESSIONE_MS`). Un annullamento con la rete assente non
 * deve restare due minuti a ritentare una richiesta che a chi annulla non serve.
 */
function opzioniChiusuraSessione(dip: DipendenzeCaricamentoVideo, impostaIntestazioni: ImpostaIntestazioni) {
  return {
    onBeforeRequest: impostaIntestazioni,
    retryDelays: dip.ritardiRitentativo ?? [...RITARDI_CHIUSURA_SESSIONE_MS],
    ...(dip.pilaHttp ? { httpStack: dip.pilaHttp } : {}),
  }
}

async function trasferisciVideo(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  opzioni: OpzioniCaricamento,
  lavoro: LavoroLocale,
): Promise<EsitoCaricamentoVideo> {
  const orologio = dip.adesso ?? (() => new Date())
  const riga = await dip.archivio.leggi(jobId)

  if (!riga) {
    segnala('error', 'video-upload-riga-assente', jobId, {})
    return { esito: 'fallito', jobId, codice: 'VIDEO_NON_TROVATO' }
  }

  // Idempotenza: «riprendi tutto» può arrivare due volte (rientro in pagina più
  // evento `online`), e un caricamento già concluso non si rifà.
  if (riga.stato === 'caricato') {
    return { esito: 'caricato', jobId, byteCaricati: riga.dimensioneByte }
  }
  if (riga.stato === 'annullato') return { esito: 'annullato', jobId }
  if (riga.stato === 'fallito') {
    return {
      esito: 'fallito',
      jobId,
      codice: (riga.codice as CodiceMostratoVideo | null) ?? 'VIDEO_OPERAZIONE_NON_RIUSCITA',
    }
  }

  if (opzioni.segnale?.aborted) {
    await chiudiComeAnnullato(dip, jobId, orologio(), lavoro)
    segnala('warn', 'video-upload-annullato', jobId, { offset: riga.offsetByte, ms: 0 })
    return { esito: 'annullato', jobId }
  }

  const viva = sorgenteViva(dip.archivio, jobId, riga.dimensioneByte)
  let letti: ByteVideo | undefined = viva
  if (!letti) {
    try {
      letti = await dip.archivio.leggiByte(jobId)
    } catch (err) {
      // Un deposito rotto non si ripara riprovando: si chiude e si chiede di
      // riscegliere il file. Un IndexedDB momentaneamente irraggiungibile invece
      // sì: i byte sono ancora lì, e la riga resta ripescabile.
      if (err instanceof ErroreByteVideo) return chiudiPerByteLocali(dip, jobId, orologio(), riga.offsetByte, err, lavoro)
      segnala('warn', 'video-upload-deposito-illeggibile', jobId, campiErrore(err))
      return { esito: 'interrotto', jobId, offsetByte: riga.offsetByte, codice: null }
    }
  }
  if (!letti) {
    // Un'altra scheda può aver finito (e liberato i byte) fra la lettura della
    // riga e quella del deposito: allora non c'è niente di sparito.
    const altrove = await conclusoAltrove(dip, jobId, lavoro, { byte: riga.dimensioneByte })
    if (altrove) return altrove
    // IL GUASTO CHE SAREBBE MUTO: il browser ha sfrattato IndexedDB per fare
    // posto e si è portato via i Blob, lasciando i metadati — o l'app è stata chiusa
    // prima che la copia in background arrivasse in fondo, che è lo stesso esito.
    // Senza questo ramo si entrerebbe in tus con un `undefined` e si uscirebbe con un
    // errore che la causa non la nomina.
    segnala('error', 'video-upload-byte-spariti', jobId, { byte: riga.dimensioneByte })
    liberaLavoroLocale(dip.archivio, jobId, lavoro)
    await dip.archivio.aggiorna(jobId, {
      stato: 'fallito',
      codice: 'VIDEO_RIPROVA',
      aggiornatoIl: orologio().toISOString(),
    })
    return { esito: 'fallito', jobId, codice: 'VIDEO_RIPROVA' }
  }
  const byte: ByteVideo = letti

  // LA SESSIONE CHE NON SI RINNOVA. `intestazioni()` chiama il client Supabase e
  // può rigettare (rete giù, refresh token invalido). Lasciandola propagare,
  // `caricaVideo` rigetterebbe e la schermata che l'ha chiamata resterebbe con la
  // rotellina — e di quel guasto non ci sarebbe una riga da nessuna parte.
  // È «interrotto» e non «fallito» per la stessa ragione del 401: è un «no» che
  // una persona toglie di mezzo rientrando, e i byte devono essere ancora lì.
  try {
    await dip.intestazioni()
  } catch (err) {
    segnala('error', 'video-upload-sessione-non-risolta', jobId, {
      error_code: nomeErrore(err),
    })
    await dip.archivio.aggiorna(jobId, {
      stato: 'in_corso',
      codice: 'VIDEO_NON_AUTORIZZATO',
      aggiornatoIl: orologio().toISOString(),
    })
    return {
      esito: 'interrotto',
      jobId,
      offsetByte: riga.offsetByte,
      codice: 'VIDEO_NON_AUTORIZZATO',
    }
  }

  await dip.archivio.aggiorna(jobId, {
    stato: 'in_corso',
    codice: null,
    aggiornatoIl: orologio().toISOString(),
  })

  const partenza = Date.now()
  let offsetVisto = riga.offsetByte
  /** Le scritture lanciate dai callback di tus: si aspettano prima di uscire. */
  const scritture: Promise<void>[] = []

  const annota = (modifiche: Partial<CaricamentoVideoLocale>) => {
    scritture.push(
      dip.archivio.aggiorna(jobId, modifiche).catch((err: unknown) => {
        // Un archivio che non scrive è la ripresa che non funzionerà: il
        // caricamento in corso prosegue — i byte stanno partendo lo stesso — ma
        // dev'esserci una riga che lo dica, altrimenti domani sarà un video
        // ricominciato da zero senza spiegazione.
        segnala('error', 'video-upload-archivio-non-scrive', jobId, {
          error_code: nomeErrore(err),
        })
      }),
    )
  }

  /**
   * L'URL della sessione TUS: parte da quello salvato nella riga e segue la sessione
   * viva. Serve a un secondo tentativo — dopo un rinnovo di firma — per riprendere dalla
   * STESSA sessione (tus manda una `HEAD` e riparte dall'offset contato dal server) invece
   * di aprirne una nuova.
   */
  let urlSessione = riga.urlTus
  /**
   * Le intestazioni che `rinnovaFirma` ha dato a questo giro: valgono per tutte le
   * richieste successive, `DELETE` di chiusura compresa. Finché è `null` si chiede a
   * `intestazioni()`, come sempre.
   */
  let intestazioniRinnovate: Record<string, string> | null = null
  const impostaIntestazioni = intestazioniDa(() => intestazioniRinnovate ?? dip.intestazioni())

  /**
   * Una lettura LOCALE fallita (file vivo non più leggibile, deposito rotto o
   * irraggiungibile) non si ripara riprovando subito la stessa sorgente: tus
   * userebbe quattro `HEAD` per ottenere quattro volte lo stesso errore. Il file
   * vivo si dimentica, così il prossimo tentativo legge il deposito salvato.
   */
  let letturaLocaleFallita = false
  const lettore = new LettoreBlob(() => {
    letturaLocaleFallita = true
    if (viva) dimenticaSorgenteViva(dip.archivio, jobId)
  })

  /**
   * UN tentativo di trasferimento, dal punto in cui si trova la sessione. È una funzione
   * perché può servirne più di uno: dopo un rinnovo di firma si riparte con un `Upload`
   * nuovo, con le intestazioni nuove, dalla stessa sessione.
   */
  const avviaTentativo = (): Promise<FineTus> => new Promise<FineTus>((risolvi) => {
    // Un listener che sopravvive alla propria operazione tiene in vita l'upload a cui
    // era appeso: si stacca appena la promessa si è risolta, comunque sia andata.
    let staccaSegnale: () => void = () => {}
    const concludi = (fine: FineTus) => {
      staccaSegnale()
      risolvi(fine)
    }

    // Le dichiarazioni TUS elencano solo le sorgenti del reader predefinito.
    // Il nostro fileReader è l'unico a leggere questa sorgente lazy e non
    // richiede che sia un Blob: espone size e lettura asincrona dell'intervallo.
    const caricamento = new Upload(byte as Blob, {
      endpoint: riga.coordinate.endpoint,
      // È QUESTO CAMPO A RENDERE POSSIBILE LA RIPRESA. Con l'URL, tus manda una
      // `HEAD` e riparte dall'offset che il server ha contato; senza, crea una
      // sessione nuova e rispedisce tutto — senza dirlo a nessuno.
      uploadUrl: urlSessione,
      chunkSize: riga.coordinate.dimensioneBloccoByte,
      retryDelays: dip.ritardiRitentativo ?? [...RITARDI_RITENTATIVO_MS],
      // La firma può scadere fra due chunk. La callback mantiene la cache breve
      // nel chiamante e rinnova soltanto quando necessario, mai su disco; se lo
      // Storage la rifiuta lo stesso, il rinnovo lo chiede `rinnovaFirma` (più sotto).
      onBeforeRequest: impostaIntestazioni,
      metadata: {
        bucketName: riga.coordinate.bucket,
        objectName: riga.coordinate.percorso,
        // ⚠️ IL SECONDO DEI DUE CONFRONTI SUL MIME, e quello che costa di più
        // sbagliare: lo Storage misura questo valore contro `allowed_mime_types`
        // per uguaglianza, DOPO che il file è partito per intero. Misurato il
        // 2026-09-09 sullo Storage di produzione: `video/mp4;codecs=avc1` → 400
        // `invalid_mime_type`; `video/mp4` → 200. `riga.mime` è già ridotto al
        // solo container da `nuovoCaricamento`.
        contentType: riga.mime,
        // Il default dello Storage. Questi originali sono privati e vivono sette
        // giorni: il valore non cambia niente, ma ometterlo lascerebbe decidere al
        // servizio invece che a noi.
        cacheControl: '3600',
      },
      ...(dip.pilaHttp ? { httpStack: dip.pilaHttp } : {}),
      // Il lettore è nostro e si passa sempre: in `lettore-blob.ts` c'è la misura
      // che l'ha reso necessario (sotto vitest si risolve la build node di tus,
      // che un `Blob` non lo sa affettare).
      fileReader: lettore,
      onShouldRetry: (err, tentativo, opzioniTus) =>
        !letturaLocaleFallita
        && (defaultOptions.onShouldRetry ? defaultOptions.onShouldRetry(err, tentativo, opzioniTus) : true),
      // L'impronta è il `jobId`: deterministica, e senza il nome del file dentro.
      // Quella predefinita del browser userebbe `file.name`, che finirebbe nella
      // chiave del `localStorage` di tus — cioè un nome di bambino su disco.
      fingerprint: async () => jobId,
      // L'URL della sessione lo conserviamo NOI, in un posto solo. La memoria di
      // tus (`localStorage`) sarebbe una seconda fonte di verità sullo stesso
      // fatto, e due fonti divergono il giorno in cui una viene ripulita.
      storeFingerprintForResuming: false,
      onUploadUrlAvailable: () => {
        if (!caricamento.url) return
        urlSessione = caricamento.url
        annota({ urlTus: caricamento.url })
      },
      onProgress: (fatti) => {
        offsetVisto = fatti
        opzioni.alProgresso?.(fatti, byte.size)
      },
      onChunkComplete: (_dimensione, accettati) => {
        // Si scrive su disco a BLOCCO finito, non a ogni evento di progresso: su
        // un originale da due gigabyte quello sarebbe qualche migliaio di
        // scritture in IndexedDB per far muovere una barra.
        offsetVisto = accettati
        annota({ offsetByte: accettati })
      },
      onSuccess: () => concludi({ fine: 'riuscito' }),
      onError: (err) => concludi({ fine: 'errore', err }),
    })

    // IL SEGNALE È QUELLO DEL JOB, non quello di chi ha chiamato: lo stesso che ferma
    // la copia in background (`annullaCaricamentoVideo` lo annulla da fuori).
    const segnale = lavoro.annulla.signal
    const suAnnullamento = () => {
      void (async () => {
        try {
          // I byte si fermano SUBITO, e la sessione si chiude dopo: è la `DELETE` che
          // evita un upload a metà nel bucket privato, che nessuno cerca e nessuno
          // cancella. Prima era `abort(true)`, che usa i ritardi del trasferimento: con
          // la rete assente la chiusura avrebbe ritentato per due minuti.
          await caricamento.abort(false)
          const url = caricamento.url ?? urlSessione
          if (url) await Upload.terminate(url, opzioniChiusuraSessione(dip, impostaIntestazioni))
        } catch (err) {
          // Non si rilancia: l'annullamento è comunque avvenuto dal lato di chi
          // guarda lo schermo. Resta la riga che dice che sullo Storage potrebbe
          // essere rimasto un troncone — è ciò che la riconciliazione di V14
          // andrà a cercare.
          segnala('warn', 'video-upload-terminazione-fallita', jobId, {
            error_code: nomeErrore(err),
          })
        }
        concludi({ fine: 'annullato' })
      })()
    }
    segnale.addEventListener('abort', suAnnullamento, { once: true })
    staccaSegnale = () => segnale.removeEventListener('abort', suAnnullamento)

    // Annullato mentre ci si preparava (le letture di sopra, o l'attesa di un rinnovo):
    // l'evento è già scattato e non scatterà più, quindi si guarda lo stato. Senza
    // questo controllo il trasferimento partirebbe lo stesso, su un video già tolto.
    if (segnale.aborted) {
      suAnnullamento()
      return
    }

    caricamento.start()
  })

  let fine = await avviaTentativo()

  // LA FIRMA CHE SCADE A METÀ STRADA. Lo Storage la rifiuta (401/403, o un 400 che nomina
  // la firma: `eRifiutoDiFirma`) e il trasferimento — che era sano — si ferma: invece di restituirlo a una persona come «interrotto», si
  // chiede la firma nuova a chi l'ha iniettata (`rinnovaFirma`) e si riparte dallo stesso
  // offset. Ogni rinnovo deve essere seguito da byte accettati: un 403 che il rinnovo non
  // toglie (un'altra causa) non si insegue, e ricade nel rifiuto di sempre.
  let rinnovi = 0
  let offsetAlRinnovo = -1
  const rifiutoDiFirma = (esito: FineTus): boolean => esito.fine === 'errore' && eRifiutoDiFirma(esito.err)
  while (
    dip.rinnovaFirma
    && rifiutoDiFirma(fine)
    && rinnovi < MAX_RINNOVI_FIRMA
    && offsetVisto > offsetAlRinnovo
  ) {
    try {
      intestazioniRinnovate = await dip.rinnovaFirma(jobId)
    } catch (err) {
      segnala('warn', 'video-upload-firma-non-rinnovata', jobId, { offset: offsetVisto, ...campiErrore(err) })
      break
    }
    rinnovi++
    offsetAlRinnovo = offsetVisto
    segnala('warn', 'video-upload-firma-rinnovata', jobId, { offset: offsetVisto, rinnovi })
    fine = await avviaTentativo()
  }

  await Promise.all(scritture)
  const durata = Date.now() - partenza

  if (fine.fine === 'annullato') {
    await chiudiComeAnnullato(dip, jobId, orologio(), lavoro)
    segnala('warn', 'video-upload-annullato', jobId, { offset: offsetVisto, ms: durata })
    return { esito: 'annullato', jobId }
  }

  if (fine.fine === 'riuscito') {
    // Prima si ferma la copia in background, poi si libera il peso: sull'archivio vero un
    // `eliminaByte` messo in fila dietro una copia di due gigabyte aspetterebbe che la
    // copia finisca, per cancellarla subito dopo.
    liberaLavoroLocale(dip.archivio, jobId, lavoro)
    await dip.archivio.aggiorna(jobId, {
      stato: 'caricato',
      offsetByte: byte.size,
      codice: null,
      aggiornatoIl: orologio().toISOString(),
    })
    // I byte hanno finito il loro lavoro. La riga no: è quella che, al rientro
    // nell'app, dirà che c'è un job da tornare a interrogare.
    await dip.archivio.eliminaByte(jobId)
    // AGENTS.md §5: gli eventi critici loggano ANCHE il successo. Con i soli
    // errori, «nessun log» non distingue «tutto ok» da «non è mai partito
    // niente» — ed è l'ambiguità che ha tenuto nascosto per mesi il guasto delle
    // email di credenziali.
    segnala('warn', 'video-upload-riuscito', jobId, {
      byte: byte.size,
      ms: durata,
      canale: riga.canale,
    })
    return { esito: 'caricato', jobId, byteCaricati: byte.size }
  }

  // tus avvolge in un `DetailedError` anche un errore del NOSTRO lettore: la causa
  // vera sta in `causingError`, e senza di lei un deposito rotto e una rete caduta
  // lascerebbero nei log la stessa riga.
  const causa = (fine.err as { causingError?: unknown } | null | undefined)?.causingError
  const stato = statoDiErrore(fine.err)
  const campi: CampiLog = {
    offset: offsetVisto,
    byte: byte.size,
    ms: durata,
    error_code: nomeErrore(fine.err),
  }
  if (causa !== undefined && causa !== null) campi.causa = nomeErrore(causa)
  if (letturaLocaleFallita) campi.lettura_locale = true
  if (stato !== null) campi.stato_http = stato
  if (rinnovi > 0) campi.rinnovi = rinnovi

  // L'errore resta scritto anche quando vince uno stato concluso altrove.
  const altrove = await conclusoAltrove(dip, jobId, lavoro, campi)
  if (altrove) return altrove

  if (causa instanceof ErroreByteVideo) {
    return chiudiPerByteLocali(dip, jobId, orologio(), offsetVisto, causa, lavoro, durata)
  }

  const verdetto = classifica(stato, eRifiutoDiFirma(fine.err))

  if (verdetto.tipo === 'interrotto') {
    await dip.archivio.aggiorna(jobId, {
      stato: 'in_corso',
      offsetByte: offsetVisto,
      codice: verdetto.codice,
      aggiornatoIl: orologio().toISOString(),
    })
    segnala('warn', 'video-upload-interrotto', jobId, campi)
    return { esito: 'interrotto', jobId, offsetByte: offsetVisto, codice: verdetto.codice }
  }

  liberaLavoroLocale(dip.archivio, jobId, lavoro)
  await dip.archivio.aggiorna(jobId, {
    stato: 'fallito',
    offsetByte: offsetVisto,
    codice: verdetto.codice,
    aggiornatoIl: orologio().toISOString(),
  })
  await dip.archivio.eliminaByte(jobId)
  segnala('error', 'video-upload-fallito', jobId, campi)
  return { esito: 'fallito', jobId, codice: verdetto.codice }
}

/**
 * Mentre questo trasferimento era in volo il caricamento può essersi chiuso da
 * un'altra parte: un'altra scheda l'ha finito, o chi carica l'ha tolto
 * dall'elenco (e con lui i byte, che è ciò che ha fatto fallire la lettura).
 * Quello stato vince: un errore arrivato dopo non lo riscrive in «fallito».
 */
async function conclusoAltrove(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  lavoro: LavoroLocale,
  campi: CampiLog = {},
): Promise<EsitoCaricamentoVideo | null> {
  let attuale: CaricamentoVideoLocale | undefined
  try {
    attuale = await dip.archivio.leggi(jobId)
  } catch (err) {
    segnala('warn', 'video-upload-stato-non-riletto', jobId, campiErrore(err))
    return null
  }
  if (attuale && attuale.stato !== 'caricato' && attuale.stato !== 'annullato') return null
  segnala('warn', 'video-upload-concluso-altrove', jobId, { ...campi, stato: attuale?.stato ?? 'rimosso' })
  liberaLavoroLocale(dip.archivio, jobId, lavoro)
  return attuale?.stato === 'caricato'
    ? { esito: 'caricato', jobId, byteCaricati: attuale.dimensioneByte }
    : { esito: 'annullato', jobId }
}

/**
 * I byte salvati sul dispositivo sono rotti (un blocco manca, il manifest non si
 * legge): riprovare darebbe lo stesso errore a ogni apertura dell'app. Si chiude
 * come fallito con `VIDEO_RIPROVA` — «riscegli il file» — e si libera il deposito.
 */
async function chiudiPerByteLocali(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  quando: Date,
  offset: number,
  err: ErroreByteVideo,
  lavoro: LavoroLocale,
  ms = 0,
): Promise<EsitoCaricamentoVideo> {
  liberaLavoroLocale(dip.archivio, jobId, lavoro)
  const altrove = await conclusoAltrove(dip, jobId, lavoro)
  if (altrove) return altrove
  await dip.archivio.aggiorna(jobId, {
    stato: 'fallito',
    offsetByte: offset,
    codice: 'VIDEO_RIPROVA',
    aggiornatoIl: quando.toISOString(),
  })
  await dip.archivio.eliminaByte(jobId)
  segnala('error', 'video-upload-byte-locali-rotti', jobId, { offset, ms, error_code: err.codice })
  return { esito: 'fallito', jobId, codice: 'VIDEO_RIPROVA' }
}

/* ────────────────────────────────────────────────────────────────────────────
 * RIENTRARE NELL'APP
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Riprende, uno alla volta, tutto ciò che era rimasto a metà.
 *
 * In serie e non in parallelo: tre video da un gigabyte spediti insieme su una
 * rete mobile si rubano la banda a vicenda e finiscono tutti e tre più tardi di
 * quanto ci avrebbero messo in fila.
 */
export async function riprendiCaricamentiVideo(
  dip: DipendenzeCaricamentoVideo,
  opzioni: OpzioniCaricamento = {},
): Promise<EsitoCaricamentoVideo[]> {
  const righe = caricamentiDaRiprendere(await dip.archivio.elenca())
  const esiti: EsitoCaricamentoVideo[] = []
  for (const riga of righe) {
    if (opzioni.segnale?.aborted) break
    esiti.push(await caricaVideo(dip, riga.jobId, opzioni))
  }
  return esiti
}

/**
 * I job che il server sta ancora lavorando e che la schermata deve tornare a
 * interrogare. È la seconda metà del criterio «l'app chiusa non perde il job»:
 * senza questo elenco, chi riapre l'app vedrebbe una galleria senza il proprio
 * video e niente che spieghi perché.
 */
export async function jobDaSeguire(dip: DipendenzeCaricamentoVideo): Promise<JobDaSeguire[]> {
  return caricamentiDaSeguire(await dip.archivio.elenca()).map((r) => ({
    jobId: r.jobId,
    intentId: r.intentId,
    canale: r.canale,
  }))
}

/* ────────────────────────────────────────────────────────────────────────────
 * CHIUDERE
 * ──────────────────────────────────────────────────────────────────────────── */

/** Marca annullato e libera il peso. Non manda niente in rete: lo fa chi chiama. */
async function chiudiComeAnnullato(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  quando: Date,
  lavoro?: LavoroLocale,
): Promise<void> {
  liberaLavoroLocale(dip.archivio, jobId, lavoro)
  await dip.archivio.aggiorna(jobId, {
    stato: 'annullato',
    codice: null,
    aggiornatoIl: quando.toISOString(),
  })
  await dip.archivio.eliminaByte(jobId)
}

/**
 * Annulla un caricamento — in volo o fermo — su QUESTO dispositivo, e ferma tutto ciò
 * che sta girando per lui.
 *
 * ─── «RIMUOVI» FERMA DAVVERO IL TRASFERIMENTO ──────────────────────────────
 *
 * L'`AbortController` del job (uno solo: `LavoroLocale`) ferma insieme il trasferimento
 * TUS e la copia dei byte in background, anche quando chi annulla non ha in mano il
 * segnale con cui il trasferimento era partito. Se il trasferimento era in volo si
 * aspetta che finisca di chiudersi — chiude da solo la sessione TUS (la `DELETE`) e la
 * riga —, senza rifare la stessa `DELETE` una seconda volta; il log
 * `video-upload-annullato-in-volo` dice che cosa girava (solo il job e due sì/no).
 *
 * ─── E UNA RIGA FERMA ───────────────────────────────────────────────────────
 *
 * Quella che si tocca da un elenco, giorni dopo, non ha niente in volo: termina comunque
 * la sessione TUS se ce n'è una aperta (senza, nel bucket privato resterebbe un troncone
 * che nessuno cerca e che solo la ritenzione a sette giorni porterebbe via), la marca
 * annullata e libera il peso.
 *
 * ⚠️ Questa funzione chiude il lato CLIENT. Il job sul server lo chiude la route
 * di annullamento (V07): le due cose sono separate perché le coordinate di
 * `video_jobs` non appartengono a questo modulo, e perché un cancel remoto deve
 * poter avvenire anche da un altro dispositivo.
 */
export async function annullaCaricamentoVideo(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
): Promise<void> {
  const orologio = dip.adesso ?? (() => new Date())

  // PRIMA DI TUTTO si ferma ciò che questo dispositivo sta facendo adesso, in un colpo
  // solo: TUS e copia. Va fatto prima di leggere la riga, perché ogni `await` che li
  // precede è un pezzo di video in più spedito, o scritto sul disco, per niente.
  const trasferimento = trasferimentiInCorso.get(jobId)
  const lavoro = lavoriLocali.get(dip.archivio)?.get(jobId)
  const inVolo = { trasferimento: trasferimento !== undefined, deposito: !!lavoro?.deposito }
  if (lavoro) liberaLavoroLocale(dip.archivio, jobId, lavoro)
  if (inVolo.trasferimento || inVolo.deposito) {
    segnala('warn', 'video-upload-annullato-in-volo', jobId, inVolo)
  }

  if (trasferimento) {
    const esito = await trasferimento.catch((err: unknown) => {
      segnala('warn', 'video-upload-annullamento-non-atteso', jobId, campiErrore(err))
      return null
    })
    // Il trasferimento ha chiuso da sé la sessione e la riga: rifarlo vorrebbe dire una
    // seconda `DELETE` su una sessione che non c'è più, e un log di guasto che non lo è.
    if (esito?.esito === 'annullato') return
  }

  const riga = await dip.archivio.leggi(jobId)
  if (!riga) {
    segnala('warn', 'video-upload-annulla-riga-assente', jobId, {})
    return
  }

  if (riga.urlTus) {
    try {
      await Upload.terminate(riga.urlTus, opzioniChiusuraSessione(dip, intestazioniDa(() => dip.intestazioni())))
    } catch (err) {
      segnala('warn', 'video-upload-terminazione-fallita', jobId, {
        error_code: nomeErrore(err),
      })
    }
  }

  await chiudiComeAnnullato(dip, jobId, orologio())
  segnala('warn', 'video-upload-annullato', jobId, { offset: riga.offsetByte, ms: 0 })
}

/**
 * I byte sono GIÀ sullo Storage — l'apertura dell'intento ha risposto che non c'è niente
 * da caricare, perché il job li aveva ricevuti da un altro tentativo o da un altro
 * dispositivo — e il lavoro locale non serve più: la riga passa a «caricato» e si libera
 * il peso.
 *
 * Esiste perché `accodaCaricamentoVideo` ha già avviato la copia in background, che qui
 * sarebbe pesante e inutile. Chi chiude la riga a mano (`aggiorna` + `eliminaByte`)
 * lascerebbe l'`eliminaByte` in fila dietro la copia — sull'archivio vero aspetterebbe che
 * finisca, per poi cancellarla —: questa ferma prima la copia.
 */
export async function concludiCaricamentoVideo(
  dip: Pick<DipendenzeCaricamentoVideo, 'archivio' | 'adesso'>,
  jobId: string,
): Promise<void> {
  const orologio = dip.adesso ?? (() => new Date())
  liberaLavoroLocale(dip.archivio, jobId)
  const riga = await dip.archivio.leggi(jobId)
  if (!riga) {
    segnala('warn', 'video-upload-concludi-riga-assente', jobId, {})
    return
  }
  await dip.archivio.aggiorna(jobId, {
    stato: 'caricato',
    offsetByte: riga.dimensioneByte,
    codice: null,
    aggiornatoIl: orologio().toISOString(),
  })
  await dip.archivio.eliminaByte(jobId)
}

/**
 * Toglie dal dispositivo le righe ferme da più del TTL, byte compresi.
 *
 * Va chiamata all'avvio dell'app. Senza, l'unico modo che ha un deposito di Blob
 * da due gigabyte di sparire è che il browser sfratti l'intero database — cioè
 * mai, finché c'è spazio, e tutto insieme quando non ce n'è più.
 */
export async function potaArchivioCaricamenti(
  dip: DipendenzeCaricamentoVideo,
): Promise<number> {
  const orologio = dip.adesso ?? (() => new Date())
  const daPotare = caricamentiDaPotare(await dip.archivio.elenca(), orologio().getTime())
  for (const riga of daPotare) {
    liberaLavoroLocale(dip.archivio, riga.jobId)
    await dip.archivio.elimina(riga.jobId)
  }
  if (daPotare.length > 0) {
    segnala('warn', 'video-upload-potatura', 'archivio', { righe: daPotare.length })
  }
  // I depositi che nessuna riga nomina, o che nessun manifest completa: una copia
  // interrotta dalla chiusura dell'app (prima che la riga fosse scritta, o — dal
  // 2026-10-02, con la copia in background — a metà). Un fallimento qui non ferma
  // l'avvio della schermata: resta il log, e la prossima apertura riprova.
  if (dip.archivio.potaDepositiOrfani) {
    try {
      const orfani = await dip.archivio.potaDepositiOrfani()
      if (orfani > 0) segnala('warn', 'video-upload-potatura-orfani', 'archivio', { depositi: orfani })
    } catch (err) {
      segnala('warn', 'video-upload-potatura-orfani-fallita', 'archivio', campiErrore(err))
    }
  }
  return daPotare.length
}
