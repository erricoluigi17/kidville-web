import { Upload, type HttpStack } from 'tus-js-client'

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
   * Riaprire l'intento con le stesse chiavi di idempotenza restituisce LO STESSO job
   * con una firma nuova — e' il percorso deterministico su cui le due meta' di questa
   * pipeline si incontrano.
   *
   * È una funzione, non un valore, e la differenza è tutto il punto: un
   * caricamento ripreso tre giorni dopo deve usare la sessione di ADESSO. Con un
   * valore, l'unico modo di averla sarebbe stato conservarla, cioè scrivere una
   * credenziale di un genitore in IndexedDB.
   */
  intestazioni: () => Promise<Record<string, string>> | Record<string, string>
  /** Lo strato HTTP di tus. Nel browser si lascia il suo (XHR, con il progresso). */
  pilaHttp?: HttpStack
  /** L'orologio. Iniettabile perché i timestamp siano verificabili. */
  adesso?: () => Date
  /**
   * I ritardi fra un ritentativo e l'altro, in millisecondi. Il default è quello
   * di tus (`[0, 1000, 3000, 5000]`): quattro tentativi su nove secondi coprono
   * la galleria della metropolitana senza far girare a vuoto la radio del
   * telefono. `[]` disattiva i ritentativi.
   */
  ritardiRitentativo?: number[]
}

export interface OpzioniCaricamento {
  /** Annulla il caricamento. Termina anche la sessione TUS: nessun orfano. */
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

/* ────────────────────────────────────────────────────────────────────────────
 * ACCODARE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Mette i byte al sicuro e crea la riga. Da qui in poi il caricamento sopravvive
 * alla chiusura dell'app anche se non è mai partito.
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
  const esistente = await dip.archivio.leggi(jobId)
  if (esistente && !['fallito', 'annullato'].includes(esistente.stato)) {
    if ((esistente.ownerId && ingresso.ownerId && esistente.ownerId !== ingresso.ownerId)
      || (esistente.scuolaId && ingresso.scuolaId && esistente.scuolaId !== ingresso.scuolaId)
      || esistente.canale !== ingresso.canale || esistente.dimensioneByte !== file.size) {
      segnala('warn', 'video-upload-contesto-diverso', jobId, {})
      return { ok: false, codice: 'VIDEO_NON_AUTORIZZATO' }
    }
    // Soltanto la nuova selezione esplicita può attribuire una riga legacy.
    const aggiornata = { ...esistente, ownerId: esistente.ownerId ?? ingresso.ownerId ?? null, scuolaId: esistente.scuolaId ?? ingresso.scuolaId ?? null }
    await dip.archivio.scrivi(aggiornata)
    if (esistente.stato !== 'caricato') await dip.archivio.scriviByte(jobId, file)
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

  // I byte PRIMA della riga: se il browser muore in mezzo resta un deposito senza
  // riga — che la potatura non vedrà, ma che non promette niente a nessuno —
  // invece di una riga che promette byte che non ci sono.
  await dip.archivio.scriviByte(jobId, file)
  await dip.archivio.scrivi(riga)
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
 * di riscegliere un video da due gigabyte perché il token aveva un'ora.
 *
 * 409 e 423 sono i due 4xx che lo stesso tus considera ritentabili (conflitto di
 * offset, risorsa momentaneamente bloccata); i 5xx lo sono per definizione.
 *
 * Restano definitivi il 413 — lo Storage non accetterà mai questi byte — e il
 * 404/410: la sessione TUS non c'è più, le coordinate sono scadute e l'intento va
 * riaperto, che è esattamente ciò che `VIDEO_RIPROVA` racconta a chi guarda
 * («qualcosa è cambiato mentre si lavorava: ricaricare e riprovare basta»).
 */
function classifica(stato: number | null): Classificazione {
  if (stato === null) return { tipo: 'interrotto', codice: null }
  if (stato === 401 || stato === 403) {
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

async function eseguiCaricamentoVideo(
  dip: DipendenzeCaricamentoVideo,
  jobId: string,
  opzioni: OpzioniCaricamento = {},
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
    await chiudiComeAnnullato(dip, jobId, orologio())
    segnala('warn', 'video-upload-annullato', jobId, { offset: riga.offsetByte, ms: 0 })
    return { esito: 'annullato', jobId }
  }

  const byte = await dip.archivio.leggiByte(jobId)
  if (!byte) {
    // IL GUASTO CHE SAREBBE MUTO: il browser ha sfrattato IndexedDB per fare
    // posto e si è portato via i Blob, lasciando i metadati. Senza questo ramo si
    // entrerebbe in tus con un `undefined` e si uscirebbe con un errore che la
    // causa non la nomina.
    segnala('error', 'video-upload-byte-spariti', jobId, { byte: riga.dimensioneByte })
    await dip.archivio.aggiorna(jobId, {
      stato: 'fallito',
      codice: 'VIDEO_RIPROVA',
      aggiornatoIl: orologio().toISOString(),
    })
    return { esito: 'fallito', jobId, codice: 'VIDEO_RIPROVA' }
  }

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

  let staccaSegnale: () => void = () => {}

  const fine = await new Promise<FineTus>((risolvi) => {
    const caricamento = new Upload(byte, {
      endpoint: riga.coordinate.endpoint,
      // È QUESTO CAMPO A RENDERE POSSIBILE LA RIPRESA. Con l'URL, tus manda una
      // `HEAD` e riparte dall'offset che il server ha contato; senza, crea una
      // sessione nuova e rispedisce tutto — senza dirlo a nessuno.
      uploadUrl: riga.urlTus,
      chunkSize: riga.coordinate.dimensioneBloccoByte,
      retryDelays: dip.ritardiRitentativo ?? [0, 1000, 3000, 5000],
      // La firma può scadere fra due chunk. La callback mantiene la cache breve
      // nel chiamante e rinnova soltanto quando necessario, mai su disco.
      // Si scrive SOLO qui: XMLHttpRequest concatena setRequestHeader ripetuti.
      // Anche impostarla in `headers` produrrebbe "firma, firma", rifiutata dallo
      // Storage con Invalid Compact JWS prima del primo byte.
      onBeforeRequest: async (request) => {
        const attuali = await dip.intestazioni()
        for (const [chiave, valore] of Object.entries(attuali)) request.setHeader(chiave, valore)
      },
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
      fileReader: new LettoreBlob(),
      // L'impronta è il `jobId`: deterministica, e senza il nome del file dentro.
      // Quella predefinita del browser userebbe `file.name`, che finirebbe nella
      // chiave del `localStorage` di tus — cioè un nome di bambino su disco.
      fingerprint: async () => jobId,
      // L'URL della sessione lo conserviamo NOI, in un posto solo. La memoria di
      // tus (`localStorage`) sarebbe una seconda fonte di verità sullo stesso
      // fatto, e due fonti divergono il giorno in cui una viene ripulita.
      storeFingerprintForResuming: false,
      onUploadUrlAvailable: () => {
        if (caricamento.url) annota({ urlTus: caricamento.url })
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
      onSuccess: () => risolvi({ fine: 'riuscito' }),
      onError: (err) => risolvi({ fine: 'errore', err }),
    })

    const segnale = opzioni.segnale
    if (segnale) {
      const suAnnullamento = () => {
        // `abort(true)`: ferma i byte E manda la `DELETE` che chiude la sessione
        // sullo Storage. Senza il `true` resterebbe un upload a metà nel bucket
        // privato, che nessuno cerca e nessuno cancella.
        void caricamento
          .abort(true)
          .catch((err: unknown) => {
            // Non si rilancia: l'annullamento è comunque avvenuto dal lato di chi
            // guarda lo schermo. Resta la riga che dice che sullo Storage potrebbe
            // essere rimasto un troncone — è ciò che la riconciliazione di V14
            // andrà a cercare.
            segnala('warn', 'video-upload-terminazione-fallita', jobId, {
              error_code: nomeErrore(err),
            })
          })
          .then(() => risolvi({ fine: 'annullato' }))
      }
      segnale.addEventListener('abort', suAnnullamento, { once: true })
      // Un listener che sopravvive alla propria operazione tiene in vita l'upload
      // a cui era appeso: si stacca appena la promessa si è risolta, comunque sia
      // andata.
      staccaSegnale = () => segnale.removeEventListener('abort', suAnnullamento)
    }

    caricamento.start()
  })

  staccaSegnale()
  await Promise.all(scritture)
  const durata = Date.now() - partenza

  if (fine.fine === 'annullato') {
    await chiudiComeAnnullato(dip, jobId, orologio())
    segnala('warn', 'video-upload-annullato', jobId, { offset: offsetVisto, ms: durata })
    return { esito: 'annullato', jobId }
  }

  if (fine.fine === 'riuscito') {
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

  const stato = statoDiErrore(fine.err)
  const verdetto = classifica(stato)
  const campi: CampiLog = {
    offset: offsetVisto,
    byte: byte.size,
    ms: durata,
    error_code: nomeErrore(fine.err),
  }
  if (stato !== null) campi.stato_http = stato

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
): Promise<void> {
  await dip.archivio.aggiorna(jobId, {
    stato: 'annullato',
    codice: null,
    aggiornatoIl: quando.toISOString(),
  })
  await dip.archivio.eliminaByte(jobId)
}

/**
 * Annulla un caricamento che NON è in volo — quello che si tocca da un elenco,
 * giorni dopo.
 *
 * Termina comunque la sessione TUS se ce n'è una aperta: senza, nel bucket
 * privato resterebbe un troncone che nessuno cerca e che solo la ritenzione a
 * sette giorni porterebbe via. Il caso «in volo» passa invece dall'`AbortSignal`
 * di `caricaVideo`, dove `abort(true)` fa già la stessa `DELETE`.
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
  const riga = await dip.archivio.leggi(jobId)
  if (!riga) {
    segnala('warn', 'video-upload-annulla-riga-assente', jobId, {})
    return
  }

  if (riga.urlTus) {
    try {
      await Upload.terminate(riga.urlTus, {
        headers: await dip.intestazioni(),
        retryDelays: dip.ritardiRitentativo ?? [0, 1000, 3000, 5000],
        ...(dip.pilaHttp ? { httpStack: dip.pilaHttp } : {}),
      })
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
    await dip.archivio.elimina(riga.jobId)
  }
  if (daPotare.length > 0) {
    segnala('warn', 'video-upload-potatura', 'archivio', { righe: daPotare.length })
  }
  return daPotare.length
}
