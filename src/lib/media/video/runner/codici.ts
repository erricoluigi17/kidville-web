/**
 * I CODICI CHE NASCONO NEL RUNNER — e che `contratto.ts` non conosce ancora.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ QUESTO ELENCO VA FUSO IN `CODICI_ESITO_VIDEO` E IN `MAPPA_MESSAGGIO_VIDEO`
 * (`../contratto.ts`), E NON L'HA FATTO QUESTO MODULO.
 *
 * La testata di `contratto.ts` dice che i codici della pipeline nascono da quattro
 * fonti — `limiti.ts`, `probe.ts`, `verify.ts`, le RPC — e che il lock
 * `__tests__/lib/video-contratto.test.ts` le RIMISURA leggendole come testo. Il
 * runner è la QUINTA fonte, ed è nata dopo: il lock non la scandisce, quindi i nomi
 * qui sotto non rendono rosso niente. È una lacuna, non un permesso.
 *
 * Cosa succede finché la fusione non avviene, detto per intero invece che scoperto
 * poi: `codiceMessaggioVideo()` accetta una stringa qualunque e ripiega su
 * `VIDEO_OPERAZIONE_NON_RIUSCITA`. Quindi niente si rompe — una famiglia legge una
 * frase generica invece di quella giusta. Degradare così è voluto, ma è comunque un
 * peggioramento, e il costo di lasciarlo è che nessuno se ne accorge: è esattamente
 * la forma di guasto silenzioso che tutto questo repository combatte.
 *
 * La mappatura proposta, perché chi fonde non debba ridecidere:
 *
 *   BUILD_DOWNLOAD_FAILED   → VIDEO_RIPROVA                     (rete, transitorio)
 *   BUILD_HASH_MISMATCH     → VIDEO_CONVERSIONE_NON_RIUSCITA    (grave, non ritentare)
 *   BUILD_EXTRACT_FAILED    → VIDEO_CONVERSIONE_NON_RIUSCITA
 *   BUILD_INCOMPLETE        → VIDEO_CONVERSIONE_NON_RIUSCITA
 *   SANDBOX_UNAVAILABLE     → VIDEO_RIPROVA                     (piattaforma)
 *   SOURCE_DOWNLOAD_FAILED  → VIDEO_RIPROVA
 *   PROBE_COMMAND_FAILED    → VIDEO_NON_LEGGIBILE               (ffprobe non è partito)
 *   ENCODE_FAILED           → VIDEO_CONVERSIONE_NON_RIUSCITA
 *   OUTPUT_UPLOAD_FAILED    → VIDEO_RIPROVA
 *   CONVERSION_TIMEOUT      → VIDEO_CONVERSIONE_NON_RIUSCITA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PERCHÉ DIECI NOMI E NON UNO SOLO. La tentazione è un `CONVERSION_FAILED` unico:
 * costa meno e dice di meno. Ma `video_jobs.error_code` è la colonna su cui si
 * risponde alla domanda «perché i video non escono più?», e le dieci cause qui
 * sotto si riparano in dieci posti diversi — GitHub irraggiungibile, una build
 * cambiata sotto i piedi, il Sandbox che non parte, lo Storage che rifiuta. Un
 * codice unico le renderebbe indistinguibili in SQL, che è il modo in cui in questo
 * progetto un `403` è rimasto per mesi senza il suo «the domain is not verified».
 */
export const CODICI_RUNNER_VIDEO = [
  /** L'archivio della build pinnata non si è scaricato (rete, 404, uscita imprevista). */
  'BUILD_DOWNLOAD_FAILED',
  /**
   * Lo SHA-256 dell'archivio non è quello atteso. **Non si riprova e non si estrae**:
   * ciò che è arrivato non è la build che abbiamo misurato, e un binario diverso da
   * quello atteso sta per leggere i file dei bambini.
   */
  'BUILD_HASH_MISMATCH',
  /** L'archivio è integro ma `tar` non ha tirato fuori i due binari. */
  'BUILD_EXTRACT_FAILED',
  /** La build gira, ma le manca un filtro/decoder/encoder che il filtergraph nomina. */
  'BUILD_INCOMPLETE',
  /** La MicroVM non si è aperta o non si è riagganciata. */
  'SANDBOX_UNAVAILABLE',
  /** L'originale non si è scaricato dallo Storage dentro il Sandbox. */
  'SOURCE_DOWNLOAD_FAILED',
  /** `ffprobe` non è partito o non ha stampato niente (diverso da «il JSON è sbagliato»). */
  'PROBE_COMMAND_FAILED',
  /** `ffmpeg` è uscito con un codice diverso da zero. */
  'ENCODE_FAILED',
  /** L'uscita è stata prodotta e verificata, ma non è arrivata nello Storage. */
  'OUTPUT_UPLOAD_FAILED',
  /** Il tetto di tempo della sorveglianza è scaduto con la conversione ancora in corso. */
  'CONVERSION_TIMEOUT',
] as const

export type CodiceRunnerVideo = (typeof CODICI_RUNNER_VIDEO)[number]
