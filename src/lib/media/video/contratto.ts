import { z } from 'zod'

import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from './limiti'
import type { VideoProbeErrorCode } from './probe'
import type { VideoOutputVerificationErrorCode } from './verify'

/**
 * IL CONTRATTO CONDIVISO DELLA PIPELINE VIDEO — quello che client e server si
 * dicono, scritto una volta sola.
 *
 * ─── PERCHÉ UN FILE SOLO, E PERCHÉ QUI ──────────────────────────────────────
 *
 * La pipeline video attraversa cinque confini: il browser (o la WebView nativa)
 * che sceglie il file, la route che apre l'intento, lo Storage che riceve
 * l'upload TUS, il convertitore che gira nel Sandbox, e il database che tiene
 * insieme la coda. Ogni confine è un punto in cui due idee di «che cosa ci si
 * sta scambiando» possono divergere in silenzio: il client crede di aver
 * mandato la durata in millisecondi, la route la legge in secondi, e nessun
 * test è rosso.
 *
 * Questo modulo è la fonte unica di quelle forme. Lo importano **entrambi i
 * lati**: perciò non contiene nulla di server — niente `fs`, niente client
 * Supabase, niente segreti — e il lock `__tests__/lib/video-contratto.test.ts`
 * lo verifica seguendo anche gli import per transitività.
 *
 * ─── LA REGOLA CHE VALE PIÙ DI TUTTE: COSA ESCE VERSO UNA FAMIGLIA ──────────
 *
 * La pipeline produce SESSANTUNO codici d'errore diversi, e quasi nessuno di
 * loro è un'informazione per chi ha caricato il video della recita.
 * `INTENT_CHANGED_RETRY` è il vocabolario del protocollo di coda;
 * `OUTPUT_DURATION_MISMATCH` è il verdetto di `verifyVideoOutput`;
 * `LEASE_EXPIRED` racconta com'è fatto il worker. Mostrarli vorrebbe dire
 * mettere l'architettura davanti a un genitore, ed è la stessa famiglia di
 * difetto del collaudo del 2026-07-31 (una segretaria a cui veniva mostrato il
 * nome di una colonna del database).
 *
 * Quindi qui gli elenchi sono DUE e la mappa fra loro è ESPLICITA:
 *
 *  · `CODICI_ESITO_VIDEO` — tutto ciò che la pipeline sa produrre. Vive nei
 *    log, in `video_jobs.error_code`, nelle risposte delle RPC. **Non esce mai
 *    verso il client**: lo schema `schemaStatoJobVideo` rifiuta un codice che
 *    non sia mostrabile, così la regola non dipende dalla memoria di chi scrive
 *    la prossima route.
 *  · `CODICI_MOSTRATI_VIDEO` — i pochi che una famiglia può leggere, ciascuno
 *    con la sua chiave nei due cataloghi (`messages/{it,en}/shared.json`).
 *
 * `MAPPA_MESSAGGIO_VIDEO` è totale su tutti i codici interni: TypeScript non
 * lascia dimenticarne uno, e il test lo rimisura sulle fonti vere.
 *
 * ─── DOVE NASCONO I CODICI, E PERCHÉ NON SI COPIANO A MANO ──────────────────
 *
 *  1. `./limiti.ts`  → `VideoInputSizeErrorCode` (3)
 *  2. `./probe.ts`   → `VideoProbeErrorCode` (10, più i 3 dei limiti)
 *  3. `./verify.ts`  → `VideoOutputVerificationErrorCode` (18)
 *  4. `supabase/migrations/*_video_*.sql` → i `code` delle RPC (30)
 *
 * L'elenco qui sotto è la loro unione, e il test la RIMISURA leggendo quelle
 * fonti: se qualcuno aggiunge un ramo a `verifyVideoOutput` o un `code` a una
 * RPC, diventa rosso e chiede di dichiarare il codice nuovo **e** di decidere
 * che cosa la famiglia ne legge. Le due cose insieme, perché separate la
 * seconda si dimentica — e un codice senza messaggio, a schermo, è
 * indistinguibile dal silenzio.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * I VOCABOLARI CHIUSI
 * ──────────────────────────────────────────────────────────────────────────── */

/** I due canali che accettano video. Vale il `CHECK` di `video_jobs_channel_chk`. */
export const CANALI_VIDEO = ['gallery', 'news'] as const
export type CanaleVideo = (typeof CANALI_VIDEO)[number]

/** Che cosa si chiede di fare con i video, da `video_intents_requested_action_chk`. */
export const AZIONI_INTENT_VIDEO = [
  'attach_private',
  'submit_proposal',
  'publish',
  'schedule',
] as const
export type AzioneIntentVideo = (typeof AZIONI_INTENT_VIDEO)[number]

/** Gli stati di un job, da `video_jobs_status_chk`, nell'ordine in cui si attraversano. */
export const STATI_JOB_VIDEO = [
  'awaiting_upload',
  'queued',
  'processing',
  'ready',
  'rejected',
  'failed',
  'cancelled',
] as const
export type StatoJobVideo = (typeof STATI_JOB_VIDEO)[number]

/** Il bucket privato degli originali: è il solo indirizzo di scrittura del client. */
export const BUCKET_ORIGINALI_VIDEO = 'video_originals'

/**
 * Quanti video può portare un solo intento. La Galleria ne accetta uno per
 * volta (`SINGLE_JOB_CHANNEL`); una News è un post con più allegati, e il tetto
 * serve a non far partire cinquanta conversioni con un tocco.
 */
export const MAX_VIDEO_PER_INTENT_NEWS = 10

/* ────────────────────────────────────────────────────────────────────────────
 * I CODICI DELLA PIPELINE — l'unione misurata delle quattro fonti
 * ──────────────────────────────────────────────────────────────────────────── */

export const CODICI_ESITO_VIDEO = [
  // ── 1. `./limiti.ts` — la dimensione dichiarata dal client e quella vera.
  'INVALID_FILE_SIZE',
  'EMPTY_FILE',
  'FILE_TOO_LARGE',

  // ── 2. `./probe.ts` — che cosa dice ffprobe del file caricato.
  'INVALID_PROBE',
  'UNKNOWN_DURATION',
  'VIDEO_TOO_LONG',
  'MISSING_VIDEO_STREAM',
  'ENCRYPTED_VIDEO',
  'UNSUPPORTED_CONTAINER',
  'UNSUPPORTED_VIDEO_CODEC',
  'UNKNOWN_AUDIO_CODEC',
  'DUPLICATE_STREAM_INDEX',
  'FFPROBE_ERROR',

  // ── 3. `./verify.ts` — la verifica dell'uscita, dopo la conversione.
  'INVALID_OUTPUT_SIZE',
  'OUTPUT_TOO_LARGE',
  'INVALID_DECODE_EVIDENCE',
  'OUTPUT_DECODE_FAILED',
  'OUTPUT_NO_DECODED_FRAMES',
  'INVALID_OUTPUT_PROBE',
  'OUTPUT_FFPROBE_ERROR',
  'OUTPUT_CONTAINER_INVALID',
  'OUTPUT_VIDEO_INVALID',
  'OUTPUT_ROTATION_INVALID',
  'OUTPUT_DIMENSIONS_INVALID',
  'OUTPUT_FPS_INVALID',
  'OUTPUT_DURATION_UNKNOWN',
  'OUTPUT_DURATION_MISMATCH',
  'OUTPUT_AUDIO_MISSING',
  'OUTPUT_AUDIO_UNEXPECTED',
  'OUTPUT_AUDIO_INVALID',
  'OUTPUT_NOT_SDR',

  // ── 4. Le RPC di coordinamento (`*_video_*.sql`): coda, lease, intenti.
  'ALREADY_SENT',
  'ALREADY_SUPERSEDED',
  'BAD_INPUT',
  'EMPTY_QUEUE',
  'ERROR_CONFLICT',
  'FENCE_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'INTENT_CHANGED_RETRY',
  'INTENT_INACTIVE',
  'INTENT_PUBLISHED',
  'INTENT_REVOKED',
  'INVALID_STATE',
  'JOBS_NOT_READY',
  'LEASE_ACTIVE',
  'LEASE_EXPIRED',
  'LEASE_MISMATCH',
  'NOT_CONFIRMED',
  'NOT_FOUND',
  'NO_JOBS',
  'ORIGINAL_PATH_SCOPE',
  'ORIGINAL_PATH_TAKEN',
  'OUTPUT_CONFLICT',
  'OWNER_MISMATCH',
  'REVISION_MISMATCH',
  'REVISION_TAKEN',
  'SCOPE_CHANGED',
  'SCOPE_REQUIRED',
  'SINGLE_JOB_CHANNEL',
  'SOURCE_CONFLICT',
  'TARGET_CONFLICT',
  'UNIQUE_CONFLICT',
  // Le due risposte con cui `video_retention_originale_rimosso` RIFIUTA di timbrare un
  // originale come cancellato: rilegge la scadenza sotto lock invece di obbedire a chi
  // chiama. Non raggiungono nessuno schermo — sta parlando un cron con una RPC — ma
  // stanno qui perché la mappa è totale, e perché il lock di esaustività le ha trovate
  // da solo appena la migrazione è comparsa nell'albero.
  'NON_ANCORA_SCADUTO',
  'SENZA_SCADENZA',

  // ── La QUINTA fonte: il runner (`runner/codici.ts`), nata dopo le altre quattro.
  // Fino al 2026-09-18 questo elenco non la conosceva, e il lock non la scandiva:
  // `codiceMessaggioVideo()` ripiegava sul messaggio generico, quindi niente si
  // rompeva e nessuno se ne accorgeva — la forma di guasto silenzioso che questo
  // repository combatte. Dieci nomi e non uno solo perché `video_jobs.error_code` è
  // la colonna su cui si risponde a «perché i video non escono più?», e le dieci
  // cause si riparano in dieci posti diversi.
  'BUILD_DOWNLOAD_FAILED',
  'BUILD_HASH_MISMATCH',
  'BUILD_EXTRACT_FAILED',
  'BUILD_INCOMPLETE',
  'SANDBOX_UNAVAILABLE',
  'SOURCE_DOWNLOAD_FAILED',
  'PROBE_COMMAND_FAILED',
  'ENCODE_FAILED',
  'OUTPUT_UPLOAD_FAILED',
  'CONVERSION_TIMEOUT',
] as const
export type CodiceEsitoVideo = (typeof CODICI_ESITO_VIDEO)[number]

/** I codici che hanno già un tipo in TypeScript: `probe.ts` e `verify.ts`. */
export type CodiceVideoTipizzato = VideoProbeErrorCode | VideoOutputVerificationErrorCode

/**
 * LA SECONDA RETE, e gira nel COMPILATORE.
 *
 * Il test rimisura i codici leggendo le fonti come testo — anche l'SQL, che un
 * tipo non ce l'ha. Ma per le due fonti che un tipo ce l'hanno, aspettare il
 * test è aspettare troppo: qui `Exclude` vale `never` solo se l'elenco copre
 * ogni membro delle due unioni, e se una fonte ne aggiunge uno questa riga
 * smette di compilare — prima ancora di far girare qualcosa.
 *
 * Le due reti non sono ridondanti: questa è immediata e cieca sull'SQL, quella
 * del test è più lenta e vede tutto. Una che manca si nota solo il giorno in cui
 * serviva.
 */
export const COPERTURA_CODICI_TIPIZZATI: Exclude<
  CodiceVideoTipizzato,
  CodiceEsitoVideo
> extends never
  ? true
  : never = true

/**
 * I codici che NASCONO al bordo API e non esistono in nessuna delle quattro
 * fonti. Si dichiarano qui invece che dentro `probe.ts` o `verify.ts`, che sono
 * moduli di calcolo e non sanno niente di HTTP.
 *
 * `CLIENT_UPDATE_REQUIRED` è il 409 che il piano impone per un client legacy: la
 * vecchia app aveva una coda di upload che parla un protocollo diverso, e
 * lasciarla proseguire vorrebbe dire scrivere video che nessuno convertirà mai.
 * L'elenco può solo restare corto: un codice che una fonte produce davvero non è
 * un codice di bordo, e il test lo rifiuta.
 */
export const CODICI_BORDO_VIDEO = ['CLIENT_UPDATE_REQUIRED'] as const
export type CodiceBordoVideo = (typeof CODICI_BORDO_VIDEO)[number]

/** Tutto ciò che la pipeline può produrre, dal probe al bordo HTTP. */
export type CodiceInternoVideo = CodiceEsitoVideo | CodiceBordoVideo

/* ────────────────────────────────────────────────────────────────────────────
 * CIÒ CHE UNA FAMIGLIA LEGGE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I soli codici che possono uscire verso il client. Sono pochi di proposito: un
 * messaggio in più ha senso solo se cambia ciò che la persona può FARE. «Il
 * video supera i tre minuti» le dice di accorciarlo; «la revisione non
 * corrisponde» non le dice niente che possa usare.
 */
export const CODICI_MOSTRATI_VIDEO = [
  /** Il file non è un video utilizzabile: vuoto, troncato, senza immagini. */
  'VIDEO_FILE_NON_VALIDO',
  /** Oltre il tetto di `MAX_VIDEO_INPUT_BYTES`. */
  'VIDEO_TROPPO_GRANDE',
  /** Oltre il tetto di `MAX_VIDEO_DURATION_SECONDS`. */
  'VIDEO_TROPPO_LUNGO',
  /** Contenitore o codifica fuori dalla matrice di `limiti.ts`. */
  'VIDEO_FORMATO_NON_SUPPORTATO',
  /** Protetto da copia: nessuna conversione è possibile, e non è un guasto. */
  'VIDEO_PROTETTO',
  /** ffprobe non riesce a descrivere il file: quasi sempre è danneggiato. */
  'VIDEO_NON_LEGGIBILE',
  /** La conversione è partita e non è arrivata a un risultato valido. */
  'VIDEO_CONVERSIONE_NON_RIUSCITA',
  /** Qualcosa è cambiato mentre si lavorava: ricaricare e riprovare basta. */
  'VIDEO_RIPROVA',
  /** L'intento è già stato pubblicato, ritirato o sostituito: è finita. */
  'VIDEO_GIA_CONCLUSO',
  /** I video non hanno ancora finito: non è un errore, è un'attesa. */
  'VIDEO_NON_ANCORA_PRONTO',
  /** Il caricamento non esiste più, o non è mai esistito. */
  'VIDEO_NON_TROVATO',
  /** Il caricamento è di un'altra persona, o di un altro plesso. */
  'VIDEO_NON_AUTORIZZATO',
  /** L'app installata non sa parlare con questa pipeline (409 legacy). */
  'VIDEO_APP_DA_AGGIORNARE',
  /** Il ripiego: qualcosa non ha funzionato e non c'è altro di utile da dire. */
  'VIDEO_OPERAZIONE_NON_RIUSCITA',
  /**
   * Più sedi accessibili e nessuna indicata. NON è un codice nuovo: è quello che
   * `rifiutoSede` manda già da 137 route (`src/lib/auth/rifiuto-sede.ts`), con la
   * sua voce di catalogo. Inventarne un secondo per i video vorrebbe dire due
   * frasi diverse per lo stesso rifiuto — che è esattamente il difetto chiuso il
   * 2026-08-01.
   */
  'SEDE_DA_SPECIFICARE',
] as const
export type CodiceMostratoVideo = (typeof CODICI_MOSTRATI_VIDEO)[number]

/**
 * La chiave di catalogo di ogni codice mostrato (namespace `shared`, presente in
 * `messages/it` e `messages/en`).
 *
 * ⚠️ Perché la mappa sta QUI e non solo in `CODICI_ERRORE`
 * (`src/lib/ui/esito-fetch.ts`): quel file è l'elenco unico che il lock
 * `__tests__/architecture/errori-con-codice.test.ts` controlla, e queste voci
 * vanno innestate lì — `...CHIAVI_MESSAGGIO_VIDEO` — nel microtask che porta le
 * route (V07). Fino ad allora nessuna risposta HTTP manda questi codici, quindi
 * il lock non ha niente da controllare e resta verde senza allargare nessuna
 * allowlist; ma la mappa esiste già, così chi scrive le route non deve inventare
 * né i nomi né i testi.
 */
export const CHIAVI_MESSAGGIO_VIDEO: Record<CodiceMostratoVideo, string> = {
  VIDEO_FILE_NON_VALIDO: 'erroreVideoFileNonValido',
  VIDEO_TROPPO_GRANDE: 'erroreVideoTroppoGrande',
  VIDEO_TROPPO_LUNGO: 'erroreVideoTroppoLungo',
  VIDEO_FORMATO_NON_SUPPORTATO: 'erroreVideoFormatoNonSupportato',
  VIDEO_PROTETTO: 'erroreVideoProtetto',
  VIDEO_NON_LEGGIBILE: 'erroreVideoNonLeggibile',
  VIDEO_CONVERSIONE_NON_RIUSCITA: 'erroreVideoConversioneNonRiuscita',
  VIDEO_RIPROVA: 'erroreVideoRiprova',
  VIDEO_GIA_CONCLUSO: 'erroreVideoGiaConcluso',
  VIDEO_NON_ANCORA_PRONTO: 'erroreVideoNonAncoraPronto',
  VIDEO_NON_TROVATO: 'erroreVideoNonTrovato',
  VIDEO_NON_AUTORIZZATO: 'erroreVideoNonAutorizzato',
  VIDEO_APP_DA_AGGIORNARE: 'erroreVideoAppDaAggiornare',
  VIDEO_OPERAZIONE_NON_RIUSCITA: 'erroreVideoOperazioneNonRiuscita',
  SEDE_DA_SPECIFICARE: 'erroreSedeDaSpecificare',
}

/** Il ripiego di `codiceMessaggioVideo`: mai `undefined`, mai schermata muta. */
export const CODICE_VIDEO_DI_RIPIEGO: CodiceMostratoVideo = 'VIDEO_OPERAZIONE_NON_RIUSCITA'

/**
 * Che cosa legge una famiglia per ciascun codice della pipeline.
 *
 * È un `Record` totale apposta: aggiungere un codice a `CODICI_ESITO_VIDEO`
 * senza decidere che cosa mostrare non compila. È la stessa disciplina dei
 * tetti monotoni delle allowlist — la decisione va presa, non rimandata.
 */
export const MAPPA_MESSAGGIO_VIDEO: Record<CodiceInternoVideo, CodiceMostratoVideo> = {
  // ── Il file scelto: qui la persona può fare qualcosa, e va detto.
  INVALID_FILE_SIZE: 'VIDEO_FILE_NON_VALIDO',
  EMPTY_FILE: 'VIDEO_FILE_NON_VALIDO',
  MISSING_VIDEO_STREAM: 'VIDEO_FILE_NON_VALIDO',
  FILE_TOO_LARGE: 'VIDEO_TROPPO_GRANDE',
  VIDEO_TOO_LONG: 'VIDEO_TROPPO_LUNGO',
  ENCRYPTED_VIDEO: 'VIDEO_PROTETTO',
  UNSUPPORTED_CONTAINER: 'VIDEO_FORMATO_NON_SUPPORTATO',
  UNSUPPORTED_VIDEO_CODEC: 'VIDEO_FORMATO_NON_SUPPORTATO',
  UNKNOWN_AUDIO_CODEC: 'VIDEO_FORMATO_NON_SUPPORTATO',

  // ── Il file non si lascia leggere: quasi sempre è danneggiato dal telefono.
  INVALID_PROBE: 'VIDEO_NON_LEGGIBILE',
  UNKNOWN_DURATION: 'VIDEO_NON_LEGGIBILE',
  DUPLICATE_STREAM_INDEX: 'VIDEO_NON_LEGGIBILE',
  FFPROBE_ERROR: 'VIDEO_NON_LEGGIBILE',

  // ── La conversione: diciotto modi diversi di non essere riusciti, e nessuno
  //    di loro cambia ciò che la famiglia può fare. Dire quale ramo di
  //    `verifyVideoOutput` ha respinto l'uscita è informazione per il log.
  INVALID_OUTPUT_SIZE: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_TOO_LARGE: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  INVALID_DECODE_EVIDENCE: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_DECODE_FAILED: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_NO_DECODED_FRAMES: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  INVALID_OUTPUT_PROBE: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_FFPROBE_ERROR: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_CONTAINER_INVALID: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_VIDEO_INVALID: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_ROTATION_INVALID: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_DIMENSIONS_INVALID: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_FPS_INVALID: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_DURATION_UNKNOWN: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_DURATION_MISMATCH: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_AUDIO_MISSING: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_AUDIO_UNEXPECTED: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_AUDIO_INVALID: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_NOT_SDR: 'VIDEO_CONVERSIONE_NON_RIUSCITA',

  // ── Il protocollo di coda. È rumore tecnico per definizione: lease, fence e
  //    conflitti esistono perché due processi si sono incrociati, e l'unica
  //    cosa vera da dire a chi guarda lo schermo è «riprova».
  INTENT_CHANGED_RETRY: 'VIDEO_RIPROVA',
  FENCE_MISMATCH: 'VIDEO_RIPROVA',
  LEASE_ACTIVE: 'VIDEO_RIPROVA',
  LEASE_EXPIRED: 'VIDEO_RIPROVA',
  LEASE_MISMATCH: 'VIDEO_RIPROVA',
  OUTPUT_CONFLICT: 'VIDEO_RIPROVA',
  SOURCE_CONFLICT: 'VIDEO_RIPROVA',
  ERROR_CONFLICT: 'VIDEO_RIPROVA',
  UNIQUE_CONFLICT: 'VIDEO_RIPROVA',
  IDEMPOTENCY_CONFLICT: 'VIDEO_RIPROVA',
  REVISION_TAKEN: 'VIDEO_RIPROVA',
  REVISION_MISMATCH: 'VIDEO_RIPROVA',
  ORIGINAL_PATH_TAKEN: 'VIDEO_RIPROVA',
  TARGET_CONFLICT: 'VIDEO_RIPROVA',
  SCOPE_CHANGED: 'VIDEO_RIPROVA',

  // ── L'intento è arrivato alla fine, in un modo o nell'altro.
  INTENT_PUBLISHED: 'VIDEO_GIA_CONCLUSO',
  INTENT_REVOKED: 'VIDEO_GIA_CONCLUSO',
  INTENT_INACTIVE: 'VIDEO_GIA_CONCLUSO',
  ALREADY_SUPERSEDED: 'VIDEO_GIA_CONCLUSO',
  ALREADY_SENT: 'VIDEO_GIA_CONCLUSO',

  // ── Si sta chiedendo di concludere qualcosa che non è ancora pronto.
  JOBS_NOT_READY: 'VIDEO_NON_ANCORA_PRONTO',
  NOT_CONFIRMED: 'VIDEO_NON_ANCORA_PRONTO',
  NO_JOBS: 'VIDEO_NON_ANCORA_PRONTO',

  // ── Appartenenza e perimetro.
  NOT_FOUND: 'VIDEO_NON_TROVATO',
  OWNER_MISMATCH: 'VIDEO_NON_AUTORIZZATO',
  ORIGINAL_PATH_SCOPE: 'VIDEO_NON_AUTORIZZATO',
  SCOPE_REQUIRED: 'SEDE_DA_SPECIFICARE',

  // ── Un bordo che ha sbagliato a chiamare la RPC: non è colpa di chi guarda lo
  //    schermo, e non c'è niente che possa fare. Il motivo vero sta nel log.
  BAD_INPUT: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  INVALID_STATE: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  SINGLE_JOB_CHANNEL: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  /**
   * `EMPTY_QUEUE` non raggiunge nessuno schermo: è ciò che `video_job_next`
   * risponde al worker quando non c'è niente da convertire, e infatti lo logga a
   * livello `info`. Sta qui perché la mappa è TOTALE — se un giorno finisse in
   * una risposta HTTP per sbaglio, una famiglia leggerebbe una frase generica
   * invece del nome di una RPC.
   */
  EMPTY_QUEUE: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  /**
   * Come `EMPTY_QUEUE`: sono la risposta di una RPC a un cron, non a una persona.
   * `NON_ANCORA_SCADUTO` significa che la retention ha chiesto di timbrare un originale
   * che non e' ancora scaduto — cioe' che qualcuno ha sbagliato i conti, non che una
   * famiglia abbia fatto qualcosa. `SENZA_SCADENZA` e' peggio e va guardato: un job
   * concluso senza data di cancellazione e' un video di minori invisibile alla
   * retention, ed e' esattamente il difetto che la rete del ramo (c) esiste per pescare.
   */
  NON_ANCORA_SCADUTO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  SENZA_SCADENZA: 'VIDEO_OPERAZIONE_NON_RIUSCITA',

  // ── Il runner. La ripartizione non e' meccanica: separa cio' che passa da solo
  // (rete, piattaforma) da cio' che non passera' mai riprovando.
  /** GitHub irraggiungibile o lento: il prossimo battito riprova, e di solito basta. */
  BUILD_DOWNLOAD_FAILED: 'VIDEO_RIPROVA',
  /**
   * Lo SHA-256 dell'archivio non e' quello atteso. NON e' `VIDEO_RIPROVA`: riprovare a
   * eseguire un binario che non e' quello misurato e' peggio che fermarsi, e nessun
   * numero di tentativi lo fara' diventare quello giusto.
   */
  BUILD_HASH_MISMATCH: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  BUILD_EXTRACT_FAILED: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  BUILD_INCOMPLETE: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  /** La MicroVM non si e' aperta: e' la piattaforma, non il video. */
  SANDBOX_UNAVAILABLE: 'VIDEO_RIPROVA',
  SOURCE_DOWNLOAD_FAILED: 'VIDEO_RIPROVA',
  /** `ffprobe` non e' partito — diverso da «il JSON e' sbagliato», che e' del video. */
  PROBE_COMMAND_FAILED: 'VIDEO_NON_LEGGIBILE',
  ENCODE_FAILED: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_UPLOAD_FAILED: 'VIDEO_RIPROVA',
  CONVERSION_TIMEOUT: 'VIDEO_CONVERSIONE_NON_RIUSCITA',

  // ── Il bordo HTTP.
  CLIENT_UPDATE_REQUIRED: 'VIDEO_APP_DA_AGGIORNARE',
}

/**
 * Il codice da mostrare, a partire da qualunque cosa sia arrivata.
 *
 * Accetta una stringa qualsiasi — non un `CodiceInternoVideo` — perché ciò che
 * torna dal database o da una RPC non è tipizzato: può essere un codice nuovo
 * rilasciato prima del client, un `PGRST204`, o niente. In tutti quei casi si
 * ripiega su una frase generica: `undefined` vorrebbe dire schermata muta, che
 * è il silenzio da cui nasce tutta questa disciplina.
 */
export function codiceMessaggioVideo(codice: string | null | undefined): CodiceMostratoVideo {
  if (!codice) return CODICE_VIDEO_DI_RIPIEGO
  const mappa = MAPPA_MESSAGGIO_VIDEO as Record<string, CodiceMostratoVideo | undefined>
  return mappa[codice] ?? CODICE_VIDEO_DI_RIPIEGO
}

/* ────────────────────────────────────────────────────────────────────────────
 * GLI SCHEMI DEL BORDO
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un tipo MIME dichiarato dal client, **suffisso dei codec compreso**.
 *
 * `MediaRecorder` scrive `video/mp4;codecs=avc1.42E01E,mp4a.40.2`, e il
 * 2026-09-09 un confronto esatto su questa stessa app ha respinto registrazioni
 * valide in due punti diversi. Qui il MIME serve solo a impostare il
 * `Content-Type` dell'upload: l'autorità su che cosa sia davvero il file è
 * ffprobe, e arriva dopo. Perciò la forma è permissiva di proposito.
 */
const MIME_DICHIARABILE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\s*;[^\n]*)?$/i

/**
 * Il percorso di un oggetto nello Storage: nessuna risalita, nessun doppio
 * separatore, nessun inizio con un punto. Un `..` qui vorrebbe dire scrivere
 * nella cartella di un'altra famiglia.
 */
const schemaPercorsoOggetto = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/._-]*$/)
  .refine((percorso) => !percorso.split('/').some((pezzo) => pezzo === '..' || pezzo === ''), {
    message: 'percorso non normalizzato',
  })

/** Un indirizzo di upload: solo `https`, perché ci passa il video di un bambino. */
const schemaEndpointSicuro = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/)

/** Un file che il client dichiara di voler caricare. */
export const schemaFileVideoDichiarato = z.object({
  /**
   * La chiave con cui il client riconosce il proprio file fra un tentativo e
   * l'altro: `video_jobs_owner_channel_idempotency_key_key` la usa per non
   * creare due job quando la rete cade a metà.
   */
  chiaveIdempotenza: z.string().min(1).max(128),
  nome: z.string().min(1).max(255),
  /** Dichiarato dal client e riverificato sul file caricato (`validateVideoInputSize`). */
  byte: z.number().int().min(1).max(MAX_VIDEO_INPUT_BYTES),
  mime: z.string().min(3).max(255).regex(MIME_DICHIARABILE),
  /**
   * Durata dichiarata dal client, quando il telefono la conosce. `null` è
   * ammesso: la misura vera la fa il probe, e rifiutare qui un file solo perché
   * il browser non sa dire quanto dura sarebbe un rifiuto ingiusto.
   */
  durataSecondi: z.number().positive().max(MAX_VIDEO_DURATION_SECONDS).nullable(),
})
export type FileVideoDichiarato = z.infer<typeof schemaFileVideoDichiarato>

/**
 * L'apertura di un intento: che cosa si vuole fare, dove, e con quali file.
 *
 * ⚠️ **Ogni scrittura dichiara la sua sede.** `scuolaId` può essere `null`
 * soltanto per una News che dichiari `ambitoGlobale`, ed è il medesimo vincolo
 * del database (`video_intents_scuola_scope_chk`). Una Galleria senza sede
 * archivierebbe il video nel plesso sbagliato **in silenzio**, che è il difetto
 * per cui esiste `resolveScuolaScrittura`.
 */
export const schemaAperturaIntentVideo = z
  .object({
    canale: z.enum(CANALI_VIDEO),
    azione: z.enum(AZIONI_INTENT_VIDEO),
    scuolaId: z.string().uuid().nullable(),
    ambitoGlobale: z.boolean().default(false),
    /** La News o l'album a cui si allegano i video, quando esiste già. */
    targetId: z.string().uuid().nullable(),
    /** `updated_at` visto dal client: serve a non sovrascrivere modifiche altrui. */
    versioneTargetAttesa: z.string().datetime().nullable(),
    file: z.array(schemaFileVideoDichiarato).min(1).max(MAX_VIDEO_PER_INTENT_NEWS),
  })
  .superRefine((richiesta, ctx) => {
    if (richiesta.canale === 'gallery' && richiesta.file.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'la Galleria accetta un video per volta',
      })
    }

    const chiavi = richiesta.file.map((f) => f.chiaveIdempotenza)
    if (new Set(chiavi).size !== chiavi.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'due file con la stessa chiave di idempotenza',
      })
    }

    if (richiesta.ambitoGlobale && richiesta.canale !== 'news') {
      ctx.addIssue({
        code: 'custom',
        path: ['ambitoGlobale'],
        message: 'l’ambito globale esiste solo per le News',
      })
    }

    if (richiesta.scuolaId === null && !(richiesta.canale === 'news' && richiesta.ambitoGlobale)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scuolaId'],
        message: 'indicare la sede a cui si riferisce questo caricamento',
      })
    }
  })
export type AperturaIntentVideo = z.infer<typeof schemaAperturaIntentVideo>

/** Dove e come il client spedisce i byte dell'originale. */
/**
 * L'unica dimensione di blocco che l'implementazione TUS di Supabase Storage
 * accetta. Verificata sulla documentazione ufficiale il 2026-09-18: «it must be
 * set to 6MB (for now) do not change it». Il «for now» è loro, non nostro: se un
 * giorno cambiasse, cambia QUI e il contratto si adegua da solo dappertutto.
 */
export const DIMENSIONE_BLOCCO_TUS_BYTE = 6 * 1024 * 1024

export const schemaCoordinateCaricamentoVideo = z.object({
  protocollo: z.literal('tus'),
  endpoint: schemaEndpointSicuro,
  bucket: z.literal(BUCKET_ORIGINALI_VIDEO),
  percorso: schemaPercorsoOggetto,
  contentType: z.string().min(3).max(255).regex(MIME_DICHIARABILE),
  /**
   * La dimensione del blocco TUS. Sta nel contratto perché è una proprietà del
   * SERVIZIO, non una preferenza del client: sbagliarla significa upload che
   * ripartono da capo su una rete mobile.
   *
   * ⚠️ È UN VALORE SOLO, NON UN INTERVALLO, e fino al 2026-09-18 questo schema
   * ammetteva `1 MiB … 64 MiB`. La documentazione di Supabase Storage lo dice
   * senza margini — «it must be set to 6MB (for now) do not change it» — quindi
   * quell'intervallo conteneva 64 valori sbagliati su 64: uno schema VERDE
   * poteva produrre coordinate che lo Storage rifiuta al primo blocco, dopo che
   * il genitore ha già iniziato a caricare da un telefono.
   *
   * È esattamente il guasto che il commento qui sopra descriveva, lasciato
   * possibile dal campo che avrebbe dovuto impedirlo. `z.literal` lo rende
   * irrappresentabile: nessuna route può più dichiararne un altro.
   */
  dimensioneBloccoByte: z.literal(DIMENSIONE_BLOCCO_TUS_BYTE),
})
export type CoordinateCaricamentoVideo = z.infer<typeof schemaCoordinateCaricamentoVideo>

/** La risposta all'apertura: un job per file, con le sue coordinate d'upload. */
export const schemaEsitoAperturaIntentVideo = z.object({
  intentId: z.string().uuid(),
  revisione: z.number().int().min(1),
  canale: z.enum(CANALI_VIDEO),
  /** Oltre questo istante le coordinate non valgono più e l'intento va riaperto. */
  scadenzaCaricamentoIl: z.string().datetime(),
  job: z
    .array(
      z.object({
        jobId: z.string().uuid(),
        chiaveIdempotenza: z.string().min(1).max(128),
        caricamento: schemaCoordinateCaricamentoVideo,
        /**
         * La firma con cui il browser autentica l'upload allo Storage, da presentare
         * come intestazione `x-signature`. Senza, il client ha un indirizzo e nessuna
         * chiave: le coordinate da sole non aprono niente.
         *
         * La conia la route con la CHIAVE DI SERVIZIO, non il browser: e' il motivo per
         * cui nessuna policy su `storage.objects` serve — quella strada non attraversa
         * RLS. E scade insieme a `scadenzaCaricamentoIl`, quindi alla ripresa di un
         * upload interrotto se ne chiede una nuova riaprendo l'intento con le stesse
         * chiavi di idempotenza, che restituisce lo STESSO job.
         *
         * Dichiarata qui il 2026-09-18: la route la restituiva gia', ma il contratto non
         * la nominava, e `z.object` scarta in silenzio cio' che non dichiara. Un campo che
         * il client deve usare e che lo schema non conosce e' una dipendenza che nessun
         * test regge.
         */
        firma: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_VIDEO_PER_INTENT_NEWS),
})
export type EsitoAperturaIntentVideo = z.infer<typeof schemaEsitoAperturaIntentVideo>

/**
 * Lo stato di un job letto in polling.
 *
 * Il campo `codice` porta il codice **mostrabile**, non quello interno: la
 * traduzione la fa il bordo con `codiceMessaggioVideo`, e lo schema rifiuta un
 * `OUTPUT_DURATION_MISMATCH` che provasse a uscire. È la stessa idea della
 * redazione dei log: la regola non si affida a chi scrive la prossima route.
 */
export const schemaStatoJobVideo = z
  .object({
    jobId: z.string().uuid(),
    intentId: z.string().uuid(),
    canale: z.enum(CANALI_VIDEO),
    stato: z.enum(STATI_JOB_VIDEO),
    avanzamento: z.number().int().min(0).max(100).nullable(),
    codice: z.enum(CODICI_MOSTRATI_VIDEO).nullable(),
    aggiornatoIl: z.string().datetime(),
  })
  .superRefine((stato, ctx) => {
    const fallito = stato.stato === 'rejected' || stato.stato === 'failed'
    if (fallito && stato.codice === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['codice'],
        message: 'un job fallito senza codice lascia la schermata senza niente da dire',
      })
    }
    if (!fallito && stato.codice !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['codice'],
        message: 'un job che non è fallito non porta un codice d’errore',
      })
    }
  })
export type StatoJobVideoLetto = z.infer<typeof schemaStatoJobVideo>

/**
 * L'avanzamento da mostrare per uno stato.
 *
 * `null` per gli stati che finiscono male o annullati: una barra piena su un
 * fallimento è una bugia, e una barra ferma al 60 % su un job annullato resta
 * lì a far credere che qualcosa stia ancora succedendo. Quando l'avanzamento
 * non significa più niente, si toglie e parla il messaggio.
 */
const AVANZAMENTO_PER_STATO: Record<StatoJobVideo, number | null> = {
  awaiting_upload: 0,
  queued: 25,
  processing: 60,
  ready: 100,
  rejected: null,
  failed: null,
  cancelled: null,
}

export function avanzamentoDaStatoVideo(stato: StatoJobVideo): number | null {
  return AVANZAMENTO_PER_STATO[stato]
}
