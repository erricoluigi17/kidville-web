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
 * La pipeline produce quasi cento codici d'errore diversi (erano settantacinque
 * prima della PR 2 «server e web» del 2026-10-02, e novantatré subito dopo: il
 * numero preciso lo rimisura il test, non questo commento), e quasi nessuno di
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
 *  4. `supabase/migrations/*_video_*.sql` → ogni codice che SQL scrive: i `code` che le RPC
 *     rispondono, gli `error_code` che SQL mette da solo su un job (la retention) e le
 *     RAISE che portano un codice (cresce con le migrazioni: lo conta il test)
 *  5. `./runner/codici.ts` → `CODICI_RUNNER_VIDEO` (10)
 *
 * L'elenco qui sotto è la loro unione, e il test la RIMISURA leggendo quelle
 * fonti: se qualcuno aggiunge un ramo a `verifyVideoOutput` o un `code` a una
 * RPC, diventa rosso e chiede di dichiarare il codice nuovo **e** di decidere
 * che cosa la famiglia ne legge. Le due cose insieme, perché separate la
 * seconda si dimentica — e un codice senza messaggio, a schermo, è
 * indistinguibile dal silenzio.
 *
 * ─── LA PR 2 «SERVER E WEB»: COSA C'È DI NUOVO, E DOVE STA ──────────────────
 *
 * Questo modulo è anche il contratto della pubblicazione lato server: i bambini si
 * scelgono PRIMA dell'invio e il video esce da solo. I nomi sono scelti qui, una volta,
 * e chi scrive le route e i client li prende da qui invece di inventarne di suoi:
 *
 *  · apertura — `TRASPORTI_VIDEO`, `MAX_BAMBINI_PER_VIDEO`, `MAX_CLASSI_PER_VIDEO`,
 *    `schemaDestinatariVideo`, e i campi nuovi di `schemaAperturaIntentVideo`
 *    (`destinatari`, `trasporto`) e di `schemaFileVideoDichiarato` (`sha256`, PER FILE:
 *    descrive i byte di quel file, come `byte` e `mime`);
 *  · risposta di apertura — `schemaRispostaAperturaVideo` (`caricamento` è l'unione
 *    discriminata su `protocollo`, `schemaCaricamentoVideo`: `tus` come oggi, `put` con
 *    `schemaCoordinatePutVideo` e, accanto, il `rinnovo` di `schemaRinnovoVideo`);
 *    `schemaEsitoAperturaIntentVideo` resta la forma di oggi, solo TUS, per le News e per
 *    chi non conosce il PUT;
 *  · rinnovo e firma — `INTESTAZIONE_TOKEN_RINNOVO`, `PREFISSO_TOKEN_RINNOVO`,
 *    `BYTE_CASUALI_TOKEN_RINNOVO`, `schemaTokenRinnovoVideo`, `schemaRispostaRinnovoVideo`,
 *    `schemaCorpoFirmaVideo`, `schemaRispostaFirmaVideo`;
 *  · azioni e runner — `schemaAzioneRiprovaPubblicazioneVideo`, `schemaCorpoRunnerVideo`;
 *  · elenco — `FASI_VOCE_VIDEO`, `schemaVoceVideo` (`VoceVideo`), `schemaQueryElencoVideo`,
 *    `schemaRispostaElencoVideo`, `MAX_VOCI_ELENCO_VIDEO`;
 *  · il codice da mostrare per un job — `codiceMostrabileDelJob` (e `JobVideoGrezzo`): la
 *    regola del secondario #37, che usano l'elenco, lo stato e le notifiche; la soglia dei
 *    tentativi che la regge è `ATTEMPT_DELLA_PRIMA_PRESA` / `ATTEMPT_DEL_PRIMO_RITENTATIVO`,
 *    la stessa di `riprovaAutomaticaInCorso`.
 *
 * I CODICI NUOVI stanno in `CODICI_ESITO_VIDEO` (sezione «PR 2», più i due `error_code` della
 * retention), con la loro destinazione in `MAPPA_MESSAGGIO_VIDEO` e il loro numero HTTP in
 * `src/app/api/video-uploads/risposte.ts`. Le cinque frasi nuove sono i codici mostrati
 * `VIDEO_ORIGINALE_NON_COINCIDE`, `VIDEO_DESTINATARI_MANCANTI`, `VIDEO_NESSUN_DESTINATARIO`,
 * `VIDEO_PUBBLICAZIONE_NON_RIUSCITA` e `VIDEO_RIPROVA_NON_POSSIBILE`; `VIDEO_APP_DA_AGGIORNARE`
 * esisteva già e si riusa.
 *
 * Gli errori dei cancelli della Galleria (`TAG_FUORI_SEDE`, il broadcast riservato alla
 * Direzione, il broadcast con tag, la liberatoria mancante col 422 che porta `nomi` e `ids`)
 * NON sono codici di questo modulo: li costruisce il modulo condiviso dei cancelli, con lo
 * stesso corpo di `POST /api/gallery`, e `POST /api/video-uploads` li restituisce com'è.
 * Dichiararli qui vorrebbe dire due definizioni dello stesso rifiuto. L'unico nome che si
 * incrocia è `BROADCAST_CON_TAG`, perché la RPC di apertura lo risponde davvero (è la rete
 * sotto il cancello): il contratto lo dichiara per poterlo tradurre, ma a chi guarda arriva la
 * frase del cancello, non quella del ripiego.
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

/**
 * Come i byte dell'originale arrivano allo Storage. È una colonna dell'INTENTO
 * (`video_intents.trasporto`, con il suo `CHECK`), e il vocabolario è chiuso:
 *
 *  · `tus` — il caricamento a blocchi che fanno il browser e le app 1.0/1.1, firmato con
 *    `x-signature`. È il predefinito, e l'unico delle News;
 *  · `put-nativo` — una PUT sola su un URL firmato SENZA upsert, che l'app 1.2 manda dal
 *    sistema operativo anche a app chiusa. Porta con sé un token di rinnovo e lo `sha256`
 *    dichiarato, che il Sandbox riverifica prima di convertire.
 */
export const TRASPORTI_VIDEO = ['tus', 'put-nativo'] as const
export type TrasportoVideo = (typeof TRASPORTI_VIDEO)[number]

/**
 * Quanti bambini può nominare UN video della Galleria, e quante classi. Sono i `CHECK` di
 * `video_intents.tag_alunni` (cardinalità ≤ 200) e di `classi_destinatarie` (≤ 20): lo schema
 * del bordo li respinge prima di scrivere una riga che il database rifiuterebbe con un
 * `23514` anonimo, cioè con un 500 al posto di un 400 leggibile.
 */
export const MAX_BAMBINI_PER_VIDEO = 200
export const MAX_CLASSI_PER_VIDEO = 20

/**
 * Quante voci porta al massimo l'elenco dei video dell'insegnante (`GET /api/video-uploads`):
 * gli intenti non conclusi più quelli conclusi da poco, i più recenti per primi. Il tetto è
 * una promessa del server (la query ha il suo `limit`) e lo schema della risposta la fa
 * rispettare anche a chi la legge.
 */
export const MAX_VOCI_ELENCO_VIDEO = 50

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
  // La risposta con cui `video_job_claim` RIFIUTA un job che `video_job_retry` ha rimesso in
  // coda e che sta ancora aspettando il suo turno (`20261002065952_video_job_ritentativi.sql`):
  // parla una RPC a un runner, non a una persona, e vuol dire «non ancora». Il nome è quello
  // letterale della migrazione: il lock qui sotto lo rilegge da lì.
  'RETRY_NOT_DUE',
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
  // I due `error_code` che SQL scrive DA SOLO su un job, senza passare dal runner:
  // `video_retention_scadenze` (`20260918110000_video_retention_riconciliazione.sql`) chiude
  // `failed` un caricamento rimasto a metà per 48 ore e una coda ferma da una settimana.
  // La retention li scrive dal 2026-09-18 e il contratto non li dichiarava, perché il lock
  // leggeva solo i `code` delle RPC: `codiceMessaggioVideo()` ripiegava sul messaggio generico,
  // e nessun test lo diceva. Ora il lock legge anche gli `error_code` letterali, e li trova.
  'UPLOAD_ABBANDONATO',
  'CONVERSIONE_INCAGLIATA',

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

  // ── PR 2 «server e web» (2026-10-02): il file arrivato, i destinatari, la pubblicazione.
  // Dichiarati QUI, dal compito del contratto, prima delle fonti che li produrranno (le RPC
  // e il trigger d'arrivo in SQL, il pubblicatore e la route in TypeScript): chi li scrive
  // trova il nome, la frase e il numero HTTP già decisi. Il lock sulle fonti li tollera
  // finché la fonte non esiste, con una mappa dichiarata e un tetto che può solo scendere.
  /** Il file arrivato pesa diversamente da quanto dichiarato all'apertura (o ha uno `sha256` diverso). */
  'ORIGINALE_DIVERSO',
  /** L'originale è stato riscritto dopo il suo arrivo: non è più il file che si era verificato. */
  'ORIGINALE_SOSTITUITO',
  /** I Sandbox in lavorazione sono già quanti ne ammette il tetto: «non ora», non un guasto. */
  'CAPACITA_PIENA',
  /** Il token di rinnovo è assente, sconosciuto, scaduto o revocato: per fuori è sempre lo stesso 404. */
  'TOKEN_NON_VALIDO',
  /** L'apertura di un video di Galleria senza bambini e senza broadcast. */
  'DESTINATARI_MANCANTI',
  /** Alla pubblicazione nessuno dei bambini scelti è più nella sede: il video non esce. */
  'NESSUN_DESTINATARIO',
  /** La pubblicazione è fallita in modo definitivo: ne parte la notifica col «Riprova». */
  'PUBBLICAZIONE_NON_RIUSCITA',
  /** Il «Riprova» non è più possibile: già pubblicato, ritirato, scaduto o non è dell'autore. */
  'RIPROVA_NON_POSSIBILE',
  /** La RPC di pubblicazione ha ricevuto fra i bambini effettivi uno che l'intento non nominava. */
  'TAG_NON_DELL_INTENTO',
  // Gli altri sette codici che le RPC di `20261002215600_video_pubblicazione_automatica.sql`
  // rispondono e che la spec non nominava uno per uno: il lock li ha trovati nel testo della
  // migrazione scritta dal compito T2a, e qui hanno la loro destinazione.
  /** Un broadcast che porta bambini: i due vanno insieme solo nella testa di chi chiama. */
  'BROADCAST_CON_TAG',
  /** Il percorso della copia in galleria non ha la forma `uploads/<autore>/<un-segmento>.<ext>`. */
  'FILE_URL_NON_VALIDO',
  /** `video_intent_finalize` ha rifiutato senza dire perché: il ripiego di un rifiuto muto. */
  'FINALIZE_RIFIUTATO',
  /** Un'altra invocazione sorveglia già questo job: «non ora», un esito tranquillo. */
  'GIA_SORVEGLIATO',
  /** L'intento è del flusso vecchio: nessun server lo pubblica da solo. */
  'NON_AUTOMATICA',
  /** `video_runner_kick`: la richiesta al runner non è partita (la rete di `pg_net`). */
  'POST_FALLITO',
  /** `video_runner_kick`: nella configurazione del cron non c'è l'indirizzo del runner. */
  'URL_ASSENTE',
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
 * video supera i cinque minuti» le dice di accorciarlo; «la revisione non
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
  /**
   * Il guasto è NOSTRO — la macchina che prepara i video, la rete fra noi e lo Storage —
   * e il filmato non c'entra. È il messaggio dei tentativi esauriti: mentre il runner
   * ritenta da solo non è un errore ma un'attesa, e lo dice `riprovaAutomatica`.
   * Distinto da `VIDEO_CONVERSIONE_NON_RIUSCITA` perché dice la cosa che conta: non è colpa
   * del file, quindi riscegliere un altro video non serve — basta ricaricare più tardi.
   */
  'VIDEO_GUASTO_NOSTRO',
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
  // ── PR 2 «server e web»: cinque frasi nuove, ciascuna perché cambia ciò che la persona fa.
  /**
   * Il file arrivato da noi non è quello che si era scelto (peso o impronta diversi, oppure
   * riscritto dopo l'arrivo): il video non è stato usato e va caricato di nuovo. Due codici
   * interni (`ORIGINALE_DIVERSO`, `ORIGINALE_SOSTITUITO`) e una frase sola, perché l'azione
   * è la stessa: ricaricare.
   */
  'VIDEO_ORIGINALE_NON_COINCIDE',
  /** Un video di Galleria senza bambini: serve sceglierne almeno uno prima di inviarlo. */
  'VIDEO_DESTINATARI_MANCANTI',
  /** Il video è pronto ma nessuno dei bambini scelti è più nella sede: non è stato pubblicato. */
  'VIDEO_NESSUN_DESTINATARIO',
  /** Il video è pronto e la pubblicazione non è riuscita: si può riprovare dalla galleria. */
  'VIDEO_PUBBLICAZIONE_NON_RIUSCITA',
  /** Il «Riprova» è stato rifiutato: il video va cercato in galleria o ricaricato. */
  'VIDEO_RIPROVA_NON_POSSIBILE',
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
  VIDEO_GUASTO_NOSTRO: 'erroreVideoGuastoNostro',
  VIDEO_RIPROVA: 'erroreVideoRiprova',
  VIDEO_GIA_CONCLUSO: 'erroreVideoGiaConcluso',
  VIDEO_NON_ANCORA_PRONTO: 'erroreVideoNonAncoraPronto',
  VIDEO_NON_TROVATO: 'erroreVideoNonTrovato',
  VIDEO_NON_AUTORIZZATO: 'erroreVideoNonAutorizzato',
  VIDEO_APP_DA_AGGIORNARE: 'erroreVideoAppDaAggiornare',
  VIDEO_OPERAZIONE_NON_RIUSCITA: 'erroreVideoOperazioneNonRiuscita',
  VIDEO_ORIGINALE_NON_COINCIDE: 'erroreVideoOriginaleNonCoincide',
  VIDEO_DESTINATARI_MANCANTI: 'erroreVideoDestinatariMancanti',
  VIDEO_NESSUN_DESTINATARIO: 'erroreVideoNessunDestinatario',
  VIDEO_PUBBLICAZIONE_NON_RIUSCITA: 'erroreVideoPubblicazioneNonRiuscita',
  VIDEO_RIPROVA_NON_POSSIBILE: 'erroreVideoRiprovaNonPossibile',
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
  /**
   * Il «non ancora» di `video_job_claim` su un job in attesa del ritentativo. Non raggiunge
   * nessuno schermo (lo sente il runner), ma sta qui perché la mappa è totale: se mai
   * finisse in una risposta, l'unica cosa vera da dire resta «riprova».
   */
  RETRY_NOT_DUE: 'VIDEO_RIPROVA',

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

  // ── Il runner. La ripartizione separa ciò che è NOSTRO da ciò che è del FILE.
  //    I sette codici di infrastruttura — la provvista di FFmpeg, la MicroVM, il
  //    trasferimento dell'originale e dell'uscita — dicono tutti la stessa cosa a chi
  //    guarda lo schermo: il guasto non è del video. Il runner li RITENTA da solo
  //    (`runner/ritentativi.ts`: quattro tentativi in un'ora), e questa frase arriva a una
  //    persona solo a tentativi esauriti, quando il job è `failed`: «caricalo più tardi».
  //    Finché si ritenta la scheda non legge un errore ma `riprovaAutomatica`
  //    (`schemaStatoJobVideo`), cioè «lo stiamo riprovando».
  //    I tre codici che restano fuori sono quelli in cui il file c'entra, o in cui
  //    riprovare non cambierebbe niente: li commenta ciascuno.
  /** La provvista dei binari non è andata a buon fine: la rete, o il nostro Storage. */
  BUILD_DOWNLOAD_FAILED: 'VIDEO_GUASTO_NOSTRO',
  /**
   * Un'impronta SHA-256 dei binari non è quella misurata. Il runner non esegue MAI un
   * binario non verificato: il job si ritenta riscaricando e riverificando. Il file non
   * c'entra, quindi la frase è la stessa degli altri guasti nostri.
   */
  BUILD_HASH_MISMATCH: 'VIDEO_GUASTO_NOSTRO',
  BUILD_EXTRACT_FAILED: 'VIDEO_GUASTO_NOSTRO',
  BUILD_INCOMPLETE: 'VIDEO_GUASTO_NOSTRO',
  /** La MicroVM non si è aperta: è la piattaforma, non il video. */
  SANDBOX_UNAVAILABLE: 'VIDEO_GUASTO_NOSTRO',
  SOURCE_DOWNLOAD_FAILED: 'VIDEO_GUASTO_NOSTRO',
  /**
   * `ffprobe` non è partito o non ha stampato niente — diverso da «il JSON è sbagliato»,
   * che è del video. Invariato: il runner lo ritenta solo quando lo stderr mostra un errore
   * di rete; senza rete in mezzo è un file che non si lascia aprire, e si dice così.
   *
   * ⚠️ Questa riga dice cosa legge chi ha UN SOLO tentativo alle spalle. A tentativi esauriti
   * (job `failed` con `attempt > 1`) il guasto che si è ritentato era nostro, qualunque codice
   * abbia chiuso l'ultimo giro: lo decide `codiceMostrabileDelJob`, non questa mappa.
   */
  PROBE_COMMAND_FAILED: 'VIDEO_NON_LEGGIBILE',
  /**
   * Invariato: `ffmpeg` è uscito con un errore, e quasi sempre la ragione sta nel file. Stessa
   * avvertenza di `PROBE_COMMAND_FAILED`: dopo i ritentativi il codice mostrato è quello del
   * guasto nostro (`codiceMostrabileDelJob`).
   */
  ENCODE_FAILED: 'VIDEO_CONVERSIONE_NON_RIUSCITA',
  OUTPUT_UPLOAD_FAILED: 'VIDEO_GUASTO_NOSTRO',
  /** Invariato: la conversione non è finita entro il tetto di tempo della sorveglianza. */
  CONVERSION_TIMEOUT: 'VIDEO_CONVERSIONE_NON_RIUSCITA',

  // ── I due `error_code` che SQL scrive da solo (la retention).
  /**
   * Il telefono non ha mai detto «ho finito» e dopo 48 ore il job è stato chiuso. Per chi ha
   * caricato è un caricamento «scaduto»: la frase di `VIDEO_NON_TROVATO` dice già la cosa che
   * serve («ricomincia dall'inizio»), e una frase nuova per lo stesso gesto sarebbe un secondo
   * modo di dire la stessa cosa.
   */
  UPLOAD_ABBANDONATO: 'VIDEO_NON_TROVATO',
  /**
   * La coda è rimasta ferma una settimana con la lease scaduta: il filmato non c'entra, ed è
   * esattamente il caso per cui esiste la frase del «problema nostro».
   */
  CONVERSIONE_INCAGLIATA: 'VIDEO_GUASTO_NOSTRO',

  // ── PR 2 «server e web»: il file arrivato, i destinatari, la pubblicazione, il rinnovo.
  //    ⚠️ Per ciascuno vale la domanda del contratto intero: cambia ciò che la persona può FARE?
  //    Se sì ha la frase sua; se non lo cambia, cade su una frase che esiste già.
  /** Il file non è quello dichiarato: l'unica cosa da fare è caricarlo di nuovo. */
  ORIGINALE_DIVERSO: 'VIDEO_ORIGINALE_NON_COINCIDE',
  /** Come `ORIGINALE_DIVERSO`: stessa azione, quindi stessa frase. */
  ORIGINALE_SOSTITUITO: 'VIDEO_ORIGINALE_NON_COINCIDE',
  /**
   * «Non ora»: i Sandbox in lavorazione sono già quanti ne ammette il tetto. Lo sente il runner,
   * non una persona — come `RETRY_NOT_DUE`, di cui è parente stretto — e se mai finisse in una
   * risposta l'unica cosa vera da dire è «riprova».
   */
  CAPACITA_PIENA: 'VIDEO_RIPROVA',
  /**
   * Token di rinnovo assente, sconosciuto, scaduto o revocato. Per fuori è sempre e solo
   * «non esiste»: distinguere i quattro casi direbbe a chi indovina che quel token è esistito.
   * Per questo il 404 uniforme del rinnovo porta proprio `VIDEO_NON_TROVATO`.
   */
  TOKEN_NON_VALIDO: 'VIDEO_NON_TROVATO',
  /** Un video di Galleria senza bambini e senza broadcast: ne serve almeno uno. */
  DESTINATARI_MANCANTI: 'VIDEO_DESTINATARI_MANCANTI',
  /** Nessuno dei bambini scelti è più nella sede: il video non esce, e il perché va detto. */
  NESSUN_DESTINATARIO: 'VIDEO_NESSUN_DESTINATARIO',
  /** Il video è pronto e la pubblicazione non è riuscita: la frase manda al «Riprova». */
  PUBBLICAZIONE_NON_RIUSCITA: 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA',
  /** Il «Riprova» non è più possibile: la frase manda a controllare la galleria o a ricaricare. */
  RIPROVA_NON_POSSIBILE: 'VIDEO_RIPROVA_NON_POSSIBILE',
  /**
   * La RPC di pubblicazione ha rifiutato un bambino che l'intento non nominava. Non è una
   * situazione che una persona possa causare né correggere: è un difetto NOSTRO, e il guardiano
   * che lo ferma (la pubblicazione non esce mai verso chi non è stato scelto) vuole un 500
   * e una riga `error`, non una frase che sembri una richiesta sbagliata.
   */
  TAG_NON_DELL_INTENTO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',

  // ── Gli altri sette delle RPC di `video_pubblicazione_automatica`. Nessuno è una cosa che la
  //    persona possa correggere: o è un difetto di chi chiama la RPC (la frase del ripiego, e il
  //    motivo vero nel log), o è un «non ora» che sente il runner.
  /** Il cancello della Galleria lo ferma prima (con la sua frase, identica a `POST /api/gallery`): qui è la rete. */
  BROADCAST_CON_TAG: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  FILE_URL_NON_VALIDO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  FINALIZE_RIFIUTATO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  /** «Non ora», come `LEASE_ACTIVE`: lo sente il runner, e l'unica cosa vera da dire è «riprova». */
  GIA_SORVEGLIATO: 'VIDEO_RIPROVA',
  /** Una variante di `INVALID_STATE`: l'intento non è nello stato che la richiesta pretende. */
  NON_AUTOMATICA: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  POST_FALLITO: 'VIDEO_OPERAZIONE_NON_RIUSCITA',
  URL_ASSENTE: 'VIDEO_OPERAZIONE_NON_RIUSCITA',

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

/**
 * A CHI È DESTINATO UN VIDEO DELLA GALLERIA — scelto PRIMA dell'invio, e conosciuto dal server.
 *
 * Fino alla PR 2 i bambini vivevano solo nella memoria della pagina: il server non li
 * conosceva, la pubblicazione la faceva il browser quando il job era pronto, e un video
 * convertito con la pagina chiusa restava lì, mai pubblicato (11 casi misurati il 2026-10-01).
 * Adesso viaggiano con l'apertura, si scrivono sull'intento (`video_intents.tag_alunni`,
 * `broadcast`, `classi_destinatarie`) e il server pubblica da solo quando il video è pronto.
 *
 * ⚠️ LO SCHEMA VALIDA LA FORMA, NON LE REGOLE. Che un bambino sia della sede, che il broadcast
 * sia riservato alla Direzione e non porti bambini, che la liberatoria ci sia: sono i cancelli
 * della Galleria, e la risposta di ciascuno è quella di `POST /api/gallery`, identica. Se questo
 * schema ne respingesse uno, il client riceverebbe un 400 di validazione al posto del 403/422
 * con i nomi che oggi sa leggere. Per lo stesso motivo `{}` è un `destinatari` valido: è la
 * route a dire `DESTINATARI_MANCANTI`, con la sua frase.
 *
 *  · `tagAlunni` — uuid dei bambini ritratti, in minuscolo e senza doppioni. `z.guid()` e non
 *    `z.uuid()`: sono identificatori di un'altra tabella, e lo strict RFC rifiuterebbe gli id
 *    seedati in dev (stessa ragione di `zUuid`, che qui non si importa per non trascinare un
 *    modulo di validazione nel bundle del client);
 *  · `broadcast` — la comunicazione a un'intera classe o sede: riservata alla Direzione e senza
 *    bambini, ma queste due regole stanno nei cancelli;
 *  · `classi` — i NOMI delle classi destinatarie di un broadcast: è lo stesso tipo di
 *    `galleria_media_v2.target_classes` e di `target_classes` in `POST /api/gallery` (`text[]`,
 *    confrontato per nome).
 */
export const schemaDestinatariVideo = z.object({
  tagAlunni: z
    .array(z.guid().transform((id) => id.toLowerCase()))
    .max(MAX_BAMBINI_PER_VIDEO)
    .transform((ids) => [...new Set(ids)])
    .default([]),
  broadcast: z.boolean().default(false),
  classi: z.array(z.string().min(1).max(255)).max(MAX_CLASSI_PER_VIDEO).default([]),
})
export type DestinatariVideo = z.infer<typeof schemaDestinatariVideo>

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
  /**
   * L'impronta SHA-256 dei byte del file, in esadecimale (64 caratteri), dichiarata dall'app 1.2
   * con il trasporto `put-nativo`: il Sandbox la ricalcola sull'originale scaricato PRIMA di
   * convertire, e se non torna il job è respinto (`ORIGINALE_DIVERSO`, mai ritentato). È la prova
   * che i byte arrivati sono quelli scelti, per una PUT che non si può riprendere a metà.
   *
   * PER FILE e non per intento, come `byte` e `mime`: descrive il contenuto di QUEL file (sul job
   * è `video_jobs.sha256_dichiarato`). Ammessa SOLO con `put-nativo` e OBBLIGATORIA con
   * `put-nativo`: i due controlli stanno in `schemaAperturaIntentVideo`, perché dipendono dal
   * trasporto e non dal singolo file. Il web, che carica in TUS, non la manda. Si normalizza in
   * minuscolo, com'è scritta dal Sandbox.
   */
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .transform((impronta) => impronta.toLowerCase())
    .optional(),
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
 *
 * ─── DAL 2026-10-02: DESTINATARI E TRASPORTO ────────────────────────────────
 * `destinatari` porta i bambini scelti PRIMA dell'invio (vedi `schemaDestinatariVideo`) ed è
 * facoltativo nello schema, perché la sua ASSENZA è un'informazione: una Galleria che apre un
 * intento senza destinatari è un client vecchio (una pagina non ricaricata, un client col JS di
 * prima del rilascio), e la route risponde 409 `VIDEO_APP_DA_AGGIORNARE` invece di scrivere un video
 * che nessuno potrebbe più pubblicare. Le News non ne hanno mai.
 * `trasporto` è `tus` se manca: chi non lo conosce continua a funzionare.
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
    /** A chi si mostra il video: solo Galleria, solo `publish`, un file. Vedi la testata. */
    destinatari: schemaDestinatariVideo.optional(),
    /** Come arrivano i byte. `put-nativo` è solo della Galleria e porta lo `sha256` del file. */
    trasporto: z.enum(TRASPORTI_VIDEO).default('tus'),
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

    // I destinatari sono della Galleria: una News è un testo con degli allegati, non ha
    // bambini a cui mostrarsi. E un video con destinatari si PUBBLICA: nessun'altra azione
    // ha senso, e nessuna sa che farsene. (Che ce ne sia almeno uno, o il broadcast, non lo
    // dice questo schema: lo dice la route, con `DESTINATARI_MANCANTI`.)
    if (richiesta.destinatari !== undefined) {
      if (richiesta.canale !== 'gallery') {
        ctx.addIssue({
          code: 'custom',
          path: ['destinatari'],
          message: 'i destinatari esistono solo per la Galleria',
        })
      }
      if (richiesta.azione !== 'publish') {
        ctx.addIssue({
          code: 'custom',
          path: ['azione'],
          message: 'un video con destinatari si pubblica: l’azione è `publish`',
        })
      }
    }

    // Il trasporto nativo è della Galleria (le News si allegano da una pagina, in TUS), e lo
    // `sha256` si dichiara solo con lui: è il trasporto che non può riprendere a metà, e per
    // questo si fa dire l'impronta dei byte prima di fidarsene. Il web, in TUS, non la manda
    // e il Sandbox salta quel controllo: una promessa fatta con l'altro trasporto resterebbe
    // una frase che nessuno rilegge.
    //
    // ⚠️ E CON IL TRASPORTO NATIVO È OBBLIGATORIA (decisione del titolare, 02/10: «sha256
    // dichiarato all'apertura e verificato nel Sandbox»). Era facoltativa nello schema, e un
    // client che la omettesse apriva un caricamento che il Sandbox non avrebbe mai verificato:
    // la garanzia che il file arrivato è quello scelto — l'unica che regge una PUT da 2 GB che
    // non si riprende a metà — sarebbe esistita solo per i client che si ricordano di chiederla.
    // Qui il rifiuto è un 400 di validazione col suo percorso (`file.N.sha256`), non una
    // conversione che parte senza il controllo.
    if (richiesta.trasporto === 'put-nativo' && richiesta.canale !== 'gallery') {
      ctx.addIssue({
        code: 'custom',
        path: ['trasporto'],
        message: 'il trasporto nativo esiste solo per la Galleria',
      })
    }
    richiesta.file.forEach((file, indice) => {
      if (file.sha256 !== undefined && richiesta.trasporto !== 'put-nativo') {
        ctx.addIssue({
          code: 'custom',
          path: ['file', indice, 'sha256'],
          message: 'lo sha256 si dichiara solo con il trasporto nativo',
        })
      }
      if (file.sha256 === undefined && richiesta.trasporto === 'put-nativo') {
        ctx.addIssue({
          code: 'custom',
          path: ['file', indice, 'sha256'],
          message: 'il trasporto nativo dichiara lo sha256 di ogni file: il Sandbox lo verifica prima di convertire',
        })
      }
    })
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

/**
 * I campi di un job aperto che NON dipendono da come arrivano i byte: gli stessi per il TUS di
 * oggi (`schemaEsitoAperturaIntentVideo`) e per la risposta estesa che conosce anche il PUT
 * (`schemaRispostaAperturaVideo`, in fondo al modulo). Una definizione sola: la risposta
 * all'apertura è il confine su cui la route e due client si fidano l'uno dell'altro, e due
 * copie dello stesso elenco di campi divergono alla prima modifica.
 */
const campiJobAperto = {
  jobId: z.string().uuid(),
  chiaveIdempotenza: z.string().min(1).max(128),
  /**
   * La firma con cui il browser autentica l'upload allo Storage, da presentare
   * come intestazione `x-signature`. Senza, il client ha un indirizzo e nessuna
   * chiave: le coordinate da sole non aprono niente.
   *
   * La conia la route con la CHIAVE DI SERVIZIO, non il browser: e' il motivo per
   * cui nessuna policy su `storage.objects` serve — quella strada non attraversa
   * RLS. E scade insieme a `scadenzaCaricamentoIl`, quindi alla ripresa di un
   * upload interrotto se ne chiede una nuova — dal 2026-10-02 con `POST
   * /api/video-uploads/[id]/firma` (`schemaCorpoFirmaVideo`), che non riapre l'intento: la
   * riapertura restituiva lo STESSO job con una firma nuova, ma costava un'apertura intera
   * (190 aperture per 44 job, misurate prima della PR 2).
   *
   * Solo del TUS: un URL di PUT è già firmato, e `firma` resta vuota.
   *
   * Dichiarata qui il 2026-09-18: la route la restituiva gia', ma il contratto non
   * la nominava, e `z.object` scarta in silenzio cio' che non dichiara. Un campo che
   * il client deve usare e che lo schema non conosce e' una dipendenza che nessun
   * test regge.
   */
  firma: z.string().default(''),
  status: z.enum(STATI_JOB_VIDEO).default('awaiting_upload'),
  needs_upload: z.boolean().default(true),
  expires_at: z.string().datetime().nullable().default(null),
}

/** I campi della risposta all'apertura che non riguardano i singoli job. */
const campiEsitoApertura = {
  intent: z.object({ status: z.string() }).default({ status: 'pending' }),
  intentId: z.string().uuid(),
  revisione: z.number().int().min(1),
  canale: z.enum(CANALI_VIDEO),
  /** Oltre questo istante le coordinate non valgono più e l'intento va riaperto. */
  scadenzaCaricamentoIl: z.string().datetime(),
}

/** Un job aperto in TUS: coordinate a blocchi più la firma da presentare come `x-signature`. */
const schemaJobApertoTus = z
  .object({ ...campiJobAperto, caricamento: schemaCoordinateCaricamentoVideo })
  .superRefine((job, ctx) => {
    if (job.needs_upload && !job.firma) ctx.addIssue({ code: 'custom', path: ['firma'], message: 'Firma necessaria per il trasferimento' })
  })

/** La risposta all'apertura: un job per file, con le sue coordinate d'upload. */
export const schemaEsitoAperturaIntentVideo = z.object({
  ...campiEsitoApertura,
  job: z.array(schemaJobApertoTus).min(1).max(MAX_VIDEO_PER_INTENT_NEWS),
})
export type EsitoAperturaIntentVideo = z.infer<typeof schemaEsitoAperturaIntentVideo>

/**
 * Lo stato di un job letto in polling.
 *
 * Il campo `codice` porta il codice **mostrabile**, non quello interno: la
 * traduzione la fa il bordo con `codiceMessaggioVideo`, e lo schema rifiuta un
 * `OUTPUT_DURATION_MISMATCH` che provasse a uscire. È la stessa idea della
 * redazione dei log: la regola non si affida a chi scrive la prossima route.
 *
 * `riprovaAutomatica` è l'altra metà di quella regola, per il caso in cui NON c'è
 * ancora un errore: dopo un guasto nostro il runner rimette il job in coda e lo
 * ritenta da solo (quattro tentativi in un'ora), e in quel tempo la persona deve
 * leggere «lo stiamo riprovando» invece di una coda che sembra ferma. Non porta il
 * codice interno della causa — resta nel log — e non può esistere su un job che non
 * sta aspettando né lavorando: «lo stiamo riprovando» su un video già pronto, o già
 * fallito, sarebbe una bugia a schermo.
 */
export const schemaStatoJobVideo = z
  .object({
    jobId: z.string().uuid(),
    intentId: z.string().uuid(),
    canale: z.enum(CANALI_VIDEO),
    stato: z.enum(STATI_JOB_VIDEO),
    avanzamento: z.number().int().min(0).max(100).nullable(),
    codice: z.enum(CODICI_MOSTRATI_VIDEO).nullable(),
    /**
     * `false` per default: un server più vecchio del client non manda il campo, e la
     * scheda resta quella di prima invece di rompersi. La calcola la route con
     * `riprovaAutomaticaInCorso`.
     */
    riprovaAutomatica: z.boolean().default(false),
    aggiornatoIl: z.string().datetime(),
  })
  .superRefine((stato, ctx) => {
    if (stato.riprovaAutomatica && stato.stato !== 'queued' && stato.stato !== 'processing') {
      ctx.addIssue({
        code: 'custom',
        path: ['riprovaAutomatica'],
        message: 'solo un job in coda o in lavorazione può essere in ritentativo automatico',
      })
    }
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

/**
 * Il numero del tentativo della PRIMA presa in carico, e di quello che viene dopo.
 *
 * `video_job_claim` conta alla presa, quindi un job mai preso ha `attempt = 0`, il primo giro
 * è `attempt = 1` e ogni valore più grande è un RITENTATIVO — dopo un guasto nostro rimesso in
 * coda da `video_job_retry`, oppure dopo una lease scaduta. È la soglia su cui si accordano,
 * senza copiarla, `riprovaAutomaticaInCorso` (il job che si sta ritentando adesso) e
 * `codiceMostrabileDelJob` (il job che si è ritentato ed è finito male, più sotto).
 */
export const ATTEMPT_DELLA_PRIMA_PRESA = 1
export const ATTEMPT_DEL_PRIMO_RITENTATIVO = ATTEMPT_DELLA_PRIMA_PRESA + 1

/**
 * Il job si sta ritentando da solo dopo un guasto nostro? È la domanda a cui risponde
 * la scheda «lo stiamo riprovando in automatico», e la route la calcola con questa
 * funzione sola: due copie della regola — una nella route, una nello schermo —
 * divergerebbero alla prima modifica dei tentativi.
 *
 * Si deduce dallo stato e dal NUMERO DEL TENTATIVO, perché il database non ha un campo
 * che lo dica e il codice della causa (`last_error_code`) non deve uscire:
 *
 *  · `queued` con `attempt >= 1` è un job RIMESSO IN CODA da `video_job_retry`, in
 *    attesa del suo turno (5, 10 o 15 minuti). L'unica altra strada verso `queued` è
 *    `video_job_uploaded`, e quella lo mette in coda con `attempt = 0`;
 *  · `processing` con `attempt >= 2` è un ritentativo già ripartito: `video_job_claim`
 *    conta il tentativo alla presa in carico, quindi il primo giro è `attempt = 1`.
 *
 * Ogni altro stato non ritenta mai. Un `attempt` assente o non numerico — una riga
 * letta male — vale 0: nel dubbio non si promette un ritentativo che potrebbe non
 * esserci.
 */
export function riprovaAutomaticaInCorso(
  stato: StatoJobVideo,
  attempt: number | null | undefined,
): boolean {
  const tentativo = typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : 0
  return (
    (stato === 'queued' && tentativo >= ATTEMPT_DELLA_PRIMA_PRESA) ||
    (stato === 'processing' && tentativo >= ATTEMPT_DEL_PRIMO_RITENTATIVO)
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * PR 2 «SERVER E WEB» · il codice da mostrare per un job, il rinnovo, la firma, l'elenco
 *
 * I nomi di questo blocco sono elencati nella testata del modulo. Le prime quattro cose
 * (apertura con i destinatari, vocabolari, codici nuovi, `sha256`) stanno più su, vicino agli
 * schemi che estendono; qui c'è tutto ciò che nasce con la PR 2 e non estende niente.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ciò che serve di un job per decidere che cosa leggerà chi lo ha caricato. Le chiavi sono
 * quelle delle colonne di `video_jobs` perché è così che il dato arriva da PostgREST: non
 * tipizzato, quindi con `status` come stringa qualunque e `error_code`/`attempt` che possono
 * mancare.
 */
export interface JobVideoGrezzo {
  status: string
  error_code?: string | null
  attempt?: number | null
}

/**
 * IL CODICE DA MOSTRARE PER UN JOB — e la regola del secondario #37 (PR 1).
 *
 * `null` per un job che non è finito male: la persona legge lo stato (in coda, in
 * conversione, «lo stiamo riprovando»), non un errore. È la stessa regola di
 * `schemaStatoJobVideo`, che rifiuta un codice su un job vivo.
 *
 * Per un job finito male il codice è quello che la mappa dà al suo `error_code`, con UNA
 * eccezione: **un job `failed` con `attempt > 1` è un job che si è ritentato, quindi il guasto
 * che ha esaurito i tentativi era NOSTRO**, e legge sempre `VIDEO_GUASTO_NOSTRO` — qualunque
 * fosse il codice tecnico dell'ultimo giro. Prima di questa regola l'ultimo codice parlava per
 * tutto il percorso: `PROBE_COMMAND_FAILED` (ffprobe su un URL che la rete non ha servito) e
 * `ENCODE_FAILED` (gli argomenti che la MicroVM non è riuscita a scrivere) sono guasti nostri
 * ritentati quattro volte, e a chi aspettava dicevano «il file sembra rovinato» e «la
 * conversione non è riuscita», cioè che la colpa era del suo telefono. Durante i ritentativi il
 * messaggio era giusto (`riprovaAutomatica`); era a tentativi esauriti che mentiva.
 *
 * COME SI ACCORDA CON «IN RIPROVA» E CON «ESAURITO». Un job che sta aspettando o rieseguendo
 * un ritentativo (`riprovaAutomaticaInCorso`) non è fallito: stato `queued`/`processing`, quindi
 * qui `null`, e la scheda dice «lo stiamo riprovando». Quando i tentativi finiscono il job
 * diventa `failed` con `attempt` rimasto a quello dell'ultimo giro (≥ 2): da quel momento
 * «esaurito» è proprio questa funzione a dirlo, con `VIDEO_GUASTO_NOSTRO`. Le due metà usano
 * la stessa soglia (`ATTEMPT_DELLA_PRIMA_PRESA`), e il test le confronta su tutta la tabella.
 *
 * `rejected` NON si tocca mai: è il file che non va bene (probe, verifiche, l'originale che non
 * coincide), e il codice del suo difetto è l'unica cosa utile da dire — anche a `attempt > 1`.
 *
 * ⚠️ IL CASO CHE LA REGOLA SBAGLIA, detto per intero. Un job ritentato per un guasto nostro e poi
 * caduto, al secondo o terzo giro, su un guasto che era DEL FILE e non si ritenta (FFmpeg che
 * esce con un errore: `failed`, non `rejected`) legge «problema nostro» invece di «conversione
 * non riuscita». Il database non ha un campo che dica «esaurito» e `last_error_code` non è
 * affidabile per questo (il runner di oggi non lo allinea all'ultimo codice); la regola messa
 * per iscritto nella spec §6.1 preferisce quell'errore al suo opposto: dire a un'insegnante che
 * il video è rovinato quando il guasto era una release sparita dal server di un terzo. Il
 * dettaglio vero resta in `app_log`, con la coda dell'errore.
 *
 * Accetta una stringa qualunque come `status` (non un `StatoJobVideo`): ciò che torna dal
 * database non è tipizzato, e uno stato che non si riconosce vale «niente da mostrare», mai un
 * errore inventato.
 */
export function codiceMostrabileDelJob(job: JobVideoGrezzo): CodiceMostratoVideo | null {
  if (job.status !== 'failed' && job.status !== 'rejected') return null
  const tentativo =
    typeof job.attempt === 'number' && Number.isFinite(job.attempt) ? job.attempt : 0
  if (job.status === 'failed' && tentativo >= ATTEMPT_DEL_PRIMO_RITENTATIVO) {
    return 'VIDEO_GUASTO_NOSTRO'
  }
  return codiceMessaggioVideo(job.error_code)
}

/**
 * L'URL di una PUT diretta allo Storage, con cui l'app 1.2 manda l'originale dal sistema
 * operativo anche a app chiusa. È firmato SENZA upsert (una seconda PUT sullo stesso percorso è
 * RIFIUTATA — lo Storage risponde HTTP 400 col corpo `statusCode: "409"`, non un 409 vero (secondario
 * #193) — e la 1.2 legge qualunque 4xx come «chiedi il rinnovo», che risponde `arrivato`): la firma sta
 * nell'URL, quindi non c'è un'intestazione `x-signature` come nel TUS. Solo `https`, perché ci
 * passa il video di un bambino. Il `content-type` è quello dichiarato all'apertura: lo Storage
 * lo registra sull'oggetto.
 */
export const schemaCoordinatePutVideo = z.object({
  protocollo: z.literal('put'),
  url: schemaEndpointSicuro,
  metodo: z.literal('PUT'),
  intestazioni: z.object({
    'content-type': z.string().min(3).max(255).regex(MIME_DICHIARABILE),
  }),
})
export type CoordinatePutVideo = z.infer<typeof schemaCoordinatePutVideo>

/**
 * Come si spedisce un originale, in una forma sola: l'UNIONE DISCRIMINATA su `protocollo`.
 * `tus` è la forma di oggi (`schemaCoordinateCaricamentoVideo`, invariata); `put` è la nuova.
 * Chi riceve un `caricamento` guarda il `protocollo` e sa quale delle due ha davanti, senza
 * indovinarlo dai campi presenti.
 */
export const schemaCaricamentoVideo = z.discriminatedUnion('protocollo', [
  schemaCoordinateCaricamentoVideo,
  schemaCoordinatePutVideo,
])
export type CaricamentoVideo = z.infer<typeof schemaCaricamentoVideo>

/**
 * IL TOKEN DI RINNOVO, e perché ha una forma controllata.
 *
 * `kvr_` più 32 byte casuali in base64url (43 caratteri, senza padding): 256 bit, quindi non si
 * indovina. Lo schema ne descrive la forma perché è parte del contratto fra il server che lo
 * conia e l'app che lo tiene nel Keychain: un token di un'altra forma è un token che nessuno
 * ha coniato.
 *
 * ⚠️ Il token viaggia SOLO nell'intestazione `INTESTAZIONE_TOKEN_RINNOVO`, mai in un URL, e non
 * entra MAI in un log (la redazione e un lock dedicato lo garantiscono). Del server si conserva
 * soltanto il suo SHA-256.
 */
export const PREFISSO_TOKEN_RINNOVO = 'kvr_'
export const BYTE_CASUALI_TOKEN_RINNOVO = 32
export const INTESTAZIONE_TOKEN_RINNOVO = 'x-kidville-rinnovo'
export const schemaTokenRinnovoVideo = z
  .string()
  .regex(
    new RegExp(
      `^${PREFISSO_TOKEN_RINNOVO}[A-Za-z0-9_-]{${Math.ceil((BYTE_CASUALI_TOKEN_RINNOVO * 4) / 3)}}$`,
    ),
  )

/**
 * Ciò che l'app tiene per tornare a chiedere un URL quando quello firmato scade o la PUT prende
 * 400/403: il token e l'istante oltre il quale non si può più rinnovare (`scadeIl`, 48 ore
 * dall'apertura: lo stesso orizzonte dell'upload abbandonato). Il rinnovo NON lo allunga.
 */
export const schemaRinnovoVideo = z.object({
  token: schemaTokenRinnovoVideo,
  scadeIl: z.string().datetime(),
})
export type RinnovoVideo = z.infer<typeof schemaRinnovoVideo>

/**
 * Un job aperto, in TUS o in PUT. Le due metà si ricavano dal `protocollo` di `caricamento`:
 *
 *  · `tus` — come oggi: serve la `firma` (`x-signature`) se c'è ancora da caricare, e non c'è
 *    nessun token di rinnovo (la firma si rinnova con `POST /api/video-uploads/[id]/firma`);
 *  · `put` — l'URL è già firmato, quindi `firma` resta vuota, e finché c'è da caricare serve il
 *    `rinnovo`. A caricamento finito (`needs_upload: false`) il token è già revocato: averlo
 *    ancora è un difetto del server, e lo schema lo dice.
 */
const schemaJobApertoEsteso = z
  .object({
    ...campiJobAperto,
    caricamento: schemaCaricamentoVideo,
    rinnovo: schemaRinnovoVideo.optional(),
  })
  .superRefine((job, ctx) => {
    if (job.caricamento.protocollo === 'tus') {
      if (job.needs_upload && !job.firma) {
        ctx.addIssue({ code: 'custom', path: ['firma'], message: 'Firma necessaria per il trasferimento' })
      }
      if (job.rinnovo !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['rinnovo'],
          message: 'il caricamento a blocchi non ha un token di rinnovo: si rinnova con la firma',
        })
      }
      return
    }
    if (job.needs_upload && job.rinnovo === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rinnovo'],
        message: 'un caricamento nativo ancora da fare porta il token di rinnovo',
      })
    }
    if (!job.needs_upload && job.rinnovo !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rinnovo'],
        message: 'il token si revoca all’arrivo del file: a caricamento finito non c’è più',
      })
    }
  })

/**
 * La risposta all'apertura, quando può essere TUS o PUT. `schemaEsitoAperturaIntentVideo` resta
 * la forma di oggi — solo TUS — per le News e per chi non conosce il PUT; questa ne è il
 * sovrainsieme, con gli stessi campi (`campiJobAperto`, `campiEsitoApertura`) e in più il ramo
 * `put` e il `rinnovo`. Chi chiede `trasporto: 'put-nativo'` la legge con questa.
 */
export const schemaRispostaAperturaVideo = z.object({
  ...campiEsitoApertura,
  job: z.array(schemaJobApertoEsteso).min(1).max(MAX_VIDEO_PER_INTENT_NEWS),
})
export type RispostaAperturaVideo = z.infer<typeof schemaRispostaAperturaVideo>

/**
 * La risposta di `POST /api/video-uploads/rinnovo` (gate: il token nell'intestazione, nessuna
 * sessione). Tre stati, e per tutto il resto un 404 uniforme (`VIDEO_NON_TROVATO`): token
 * assente, sconosciuto, scaduto o revocato non si distinguono da fuori.
 *
 *  · `da-caricare` — l'originale non è ancora arrivato: un URL di PUT firmato di nuovo
 *    (`caricamento`, sempre `put`) e `scadeIl`, l'istante oltre il quale il TOKEN non vale più
 *    (immutato dal rinnovo: serve all'app per smettere di insistere);
 *  · `arrivato` — i byte ci sono già (la PUT è stata rifiutata con un 4xx, oppure era riuscita e la risposta si
 *    è persa): l'app non deve fare altro;
 *  · `annullato` — l'insegnante ha ritirato il video: l'app si ferma e cancella la copia locale.
 */
export const schemaRispostaRinnovoVideo = z.discriminatedUnion('stato', [
  z.object({
    stato: z.literal('da-caricare'),
    caricamento: schemaCoordinatePutVideo,
    scadeIl: z.string().datetime(),
  }),
  z.object({ stato: z.literal('arrivato') }),
  z.object({ stato: z.literal('annullato') }),
])
export type RispostaRinnovoVideo = z.infer<typeof schemaRispostaRinnovoVideo>

/**
 * `POST /api/video-uploads/[id]/firma` — una firma TUS nuova per il percorso di un job che sta
 * ancora aspettando i suoi byte, senza riaprire l'intento. `[id]` è l'intento; il corpo nomina
 * il job. La route risponde solo se il job è in `awaiting_upload`: dopo, non c'è più niente da
 * firmare.
 */
export const schemaCorpoFirmaVideo = z.object({ jobId: z.string().uuid() })
export type CorpoFirmaVideo = z.infer<typeof schemaCorpoFirmaVideo>

/**
 * La risposta di `/firma`: le coordinate TUS del job, la firma nuova (`x-signature`) e il suo
 * istante di scadenza. Gli stessi pezzi che l'apertura mette in ogni job, senza il resto.
 */
export const schemaRispostaFirmaVideo = z.object({
  jobId: z.string().uuid(),
  caricamento: schemaCoordinateCaricamentoVideo,
  firma: z.string().min(1),
  scadeIl: z.string().datetime(),
})
export type RispostaFirmaVideo = z.infer<typeof schemaRispostaFirmaVideo>

/**
 * La nuova azione di `PATCH /api/video-uploads/[id]`: l'insegnante preme «Riprova» su un video
 * che non è stato pubblicato. Nessun altro campo: l'intento è quello dell'URL, i job sono
 * «tutti i `ready`», e il server decide se si può (`RIPROVA_NON_POSSIBILE`, 409, se non si può
 * più). Si aggiunge all'unione delle altre azioni della route, che resta chiusa: la pubblicazione
 * non si chiede mai da fuori, e per questo non esiste un'azione «pubblica».
 */
export const schemaAzioneRiprovaPubblicazioneVideo = z.object({
  azione: z.literal('riprova-pubblicazione'),
})
export type AzioneRiprovaPubblicazioneVideo = z.infer<typeof schemaAzioneRiprovaPubblicazioneVideo>

/**
 * Il corpo di `POST /api/video/runner`: `{ job_id?: uuid }`. Il cron senza corpo fa il giro
 * intero; il `video_runner_kick` di SQL (trigger d'arrivo, `PATCH caricato`) nomina il job che
 * ha bisogno di sorveglianza subito. Il corpo VUOTO è ammesso — `parseBody` risponderebbe 400 —
 * ed è la route a leggerlo dopo il gate con `request.text()` e a passare `{}` a questo schema.
 * La chiave è `job_id` e non `jobId`, come la manda `pg_net`.
 *
 * `.strict()` (secondario #19 della PR 2): senza, un `{ "jobId": "<uuid>" }` col refuso passava come
 * `{}` — la chiave sconosciuta veniva scartata in silenzio — e il runner faceva il giro intero del
 * cron senza dire a nessuno che il calcio non era stato capito. Così prende 400, come ogni altra
 * chiave che qui non esiste.
 */
export const schemaCorpoRunnerVideo = z
  .object({
    job_id: z.string().uuid().optional(),
  })
  .strict()
export type CorpoRunnerVideo = z.infer<typeof schemaCorpoRunnerVideo>

/**
 * LE FASI DI UNA VOCE DELL'ELENCO, dal punto di vista di chi ha caricato.
 *
 *  · `da-caricare` — i byte non sono ancora tutti sullo Storage (da un altro dispositivo, o
 *    interrotto: il client lo fonde con la riga locale per l'avanzamento);
 *  · `in-coda` — arrivato, aspetta il suo turno (`queued` alla prima presa);
 *  · `in-conversione` — il Sandbox ci sta lavorando (`processing` al primo giro);
 *  · `in-riprova` — un guasto nostro, e il runner ritenta da solo (`riprovaAutomaticaInCorso`);
 *  · `pronto` — convertito, in attesa che il server lo pubblichi;
 *  · `pubblicato` — in galleria (`mediaId`);
 *  · `non-pubblicato` — convertito ma NON pubblicato, in modo definitivo: nessun bambino scelto
 *    è più nella sede, o la pubblicazione è fallita (da lì il «Riprova», `riprovaPossibile`);
 *  · `fallito` — la conversione non è riuscita (`failed`/`rejected`, con il codice da mostrare);
 *  · `annullato` — l'insegnante l'ha ritirato;
 *  · `da-ricaricare` — un intento del flusso vecchio, revocato perché non ha bambini: «questo
 *    video va ricaricato».
 */
export const FASI_VOCE_VIDEO = [
  'da-caricare',
  'in-coda',
  'in-conversione',
  'in-riprova',
  'pronto',
  'pubblicato',
  'non-pubblicato',
  'fallito',
  'annullato',
  'da-ricaricare',
] as const
export type FaseVoceVideo = (typeof FASI_VOCE_VIDEO)[number]

/**
 * UNA VOCE DELL'ELENCO (`GET /api/video-uploads?canale=gallery&scuolaId=…`): un video
 * dell'insegnante, qualunque sia il dispositivo da cui l'ha mandato.
 *
 * Porta SOLO numeri, stati, uuid e il codice da mostrare: nessun nome di bambino, nessun nome
 * di file, nessun percorso. `nBambini` è un conteggio (sopravvive alla minimizzazione dei
 * `tag_alunni`, che dopo sette giorni si svuotano) e `codice` è un codice MOSTRABILE, mai uno
 * interno — per un job `failed` ritentato è quello del guasto nostro (`codiceMostrabileDelJob`).
 *
 * Le regole di coerenza sono quelle che separano uno stato vero da una bugia a schermo, e le
 * fa rispettare lo schema invece della memoria di chi scrive la route:
 *
 *  · si legge un `codice` solo se il video è andato male (`fallito`, `non-pubblicato`), e in
 *    quel caso c'è sempre: una scheda di errore senza una frase è il silenzio di prima;
 *  · `mediaId` esiste solo per un `pubblicato` (il contrario non è detto: se la foto è stata
 *    tolta dalla galleria il video resta pubblicato e il collegamento no);
 *  · «Riprova» si offre solo su un `non-pubblicato`;
 *  · il broadcast non ha bambini (`video_intents_broadcast_chk`);
 *  · `da-ricaricare` è del flusso vecchio, quindi non è una pubblicazione automatica.
 */
export const schemaVoceVideo = z
  .object({
    intentId: z.string().uuid(),
    jobId: z.string().uuid(),
    fase: z.enum(FASI_VOCE_VIDEO),
    codice: z.enum(CODICI_MOSTRATI_VIDEO).nullable(),
    creatoIl: z.string().datetime(),
    aggiornatoIl: z.string().datetime(),
    trasporto: z.enum(TRASPORTI_VIDEO),
    /** I byte dichiarati all'apertura: `null` per un video del flusso vecchio, che non li dichiarava. */
    byte: z.number().int().min(1).max(MAX_VIDEO_INPUT_BYTES).nullable(),
    /** La durata dichiarata, se il telefono la conosceva. */
    durataS: z.number().positive().max(MAX_VIDEO_DURATION_SECONDS).nullable(),
    nBambini: z.number().int().min(0).max(MAX_BAMBINI_PER_VIDEO),
    broadcast: z.boolean(),
    /** Identificatore di `galleria_media_v2`: di un'altra tabella, quindi `guid` e non `uuid`. */
    mediaId: z.guid().nullable(),
    pubblicazioneAutomatica: z.boolean(),
    riprovaPossibile: z.boolean(),
  })
  .superRefine((voce, ctx) => {
    const conErrore = voce.fase === 'fallito' || voce.fase === 'non-pubblicato'
    if (conErrore && voce.codice === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['codice'],
        message: 'un video andato male senza codice lascia la scheda senza niente da dire',
      })
    }
    if (!conErrore && voce.codice !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['codice'],
        message: 'un video che non è andato male non porta un codice d’errore',
      })
    }
    if (voce.mediaId !== null && voce.fase !== 'pubblicato') {
      ctx.addIssue({
        code: 'custom',
        path: ['mediaId'],
        message: 'solo un video pubblicato ha un elemento di galleria',
      })
    }
    if (voce.riprovaPossibile && voce.fase !== 'non-pubblicato') {
      ctx.addIssue({
        code: 'custom',
        path: ['riprovaPossibile'],
        message: 'il «Riprova» si offre solo su un video non pubblicato',
      })
    }
    if (voce.broadcast && voce.nBambini > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['nBambini'],
        message: 'un video in broadcast non ha bambini',
      })
    }
    if (voce.fase === 'da-ricaricare' && voce.pubblicazioneAutomatica) {
      ctx.addIssue({
        code: 'custom',
        path: ['pubblicazioneAutomatica'],
        message: 'da ricaricare è un intento del flusso vecchio: non è una pubblicazione automatica',
      })
    }
  })
export type VoceVideo = z.infer<typeof schemaVoceVideo>

/**
 * La query di `GET /api/video-uploads`: il canale (oggi si chiede `gallery`) e, facoltativa, la
 * sede. Senza sede l'elenco copre le sedi dell'utente; con la sede ne copre una sola, e la route
 * risponde 403 se non è fra le proprie.
 */
export const schemaQueryElencoVideo = z.object({
  canale: z.enum(CANALI_VIDEO),
  scuolaId: z.string().uuid().optional(),
})
export type QueryElencoVideo = z.infer<typeof schemaQueryElencoVideo>

/** La risposta di `GET /api/video-uploads`: al più `MAX_VOCI_ELENCO_VIDEO` voci, le più recenti prima. */
export const schemaRispostaElencoVideo = z.object({
  voci: z.array(schemaVoceVideo).max(MAX_VOCI_ELENCO_VIDEO),
})
export type RispostaElencoVideo = z.infer<typeof schemaRispostaElencoVideo>
