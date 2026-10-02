/**
 * I CODICI CHE NASCONO NEL RUNNER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA QUINTA FONTE DEI CODICI D'ERRORE, e dove vanno a finire.
 *
 * I codici della pipeline nascono da cinque fonti — `limiti.ts`, `probe.ts`, `verify.ts`, le
 * RPC e questo elenco — e `../contratto.ts` li ha fusi tutti in `CODICI_ESITO_VIDEO`, poi
 * mappati in `MAPPA_MESSAGGIO_VIDEO` sul messaggio che leggono le famiglie. Il lock
 * `__tests__/lib/video-contratto.test.ts` li RIMISURA leggendo l'elenco qui sotto come
 * testo: un codice aggiunto qui senza una voce nel contratto rende rosso quel test, invece
 * di ripiegare in silenzio sul messaggio generico.
 *
 * ⚠️ DUE DOMANDE DIVERSE, E DUE POSTI DIVERSI. Questo file dice SOLO come si chiama un guasto.
 *
 *  · **Che cosa ne leggono le famiglie** — la frase mostrata a chi ha caricato il video — sta
 *    nel contratto, nella mappa dei messaggi.
 *  · **Che cosa ne fa il runner** — di chi è il guasto e se il job si ritenta — sta in
 *    `./ritentativi.ts`: ogni punto in cui il runner può fallire dichiara la CLASSE del
 *    guasto (`file`, `non-ritentabile`, `infra-transitoria`, `infra-permanente`) e
 *    `esegui.ts` ne ricava `video_job_retry` (guasto nostro, fino a quattro tentativi in
 *    un'ora) oppure `video_job_fail`. La tabella punto per punto è al §4.5 della spec
 *    `docs/superpowers/specs/2026-10-02-video-pr1-hotfix-ffmpeg-design.md`.
 *
 * Il nome di un codice NON dice se si ritenta: `BUILD_HASH_MISMATCH` ha una classe, e
 * `ENCODE_FAILED` ne ha due (`file` se la geometria è impossibile, `infra-transitoria` se la
 * MicroVM non ha scritto gli argomenti). Chi vuole sapere come finisce un codice legge
 * `ritentativi.ts`, non indovina dal nome.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PERCHÉ UNDICI NOMI E NON UNO SOLO. La tentazione è un `CONVERSION_FAILED` unico:
 * costa meno e dice di meno. Ma `video_jobs.error_code` è la colonna su cui si
 * risponde alla domanda «perché i video non escono più?», e le undici cause qui
 * sotto si riparano in undici posti diversi — lo Storage che non rilascia la build, una
 * build che non torna, il Sandbox che non parte, lo Storage che rifiuta. Un
 * codice unico le renderebbe indistinguibili in SQL, che è il modo in cui in questo
 * progetto un `403` è rimasto per mesi senza il suo «the domain is not verified».
 *
 * L'undicesimo, `ORIGINALE_DIVERSO`, è dalla PR 2 (spec §10.4) e non nasce qui: lo dichiara
 * già il contratto (`../contratto.ts`) e lo scrive già SQL, quando la dimensione dell'originale
 * arrivato non è quella dichiarata. Qui lo produce una SECONDA fonte, il Sandbox: lo
 * `sha256` dichiarato all'apertura (caricamento nativo) non coincide con quello del file
 * scaricato. Il guasto è del FILE — la classe è `file`, e non si ritenta mai.
 */
export const CODICI_RUNNER_VIDEO = [
  /**
   * La build di FFmpeg non è arrivata: la firma dei due `.gz` nel bucket privato `video_build`
   * non è stata rilasciata, oppure il download dentro la MicroVM è fallito (rete, 4xx, 5xx,
   * un'uscita imprevista dell'apparecchio).
   */
  'BUILD_DOWNLOAD_FAILED',
  /**
   * Un'impronta SHA-256 — dei `.gz` o dei binari — non è quella attesa. **Un binario che non
   * l'ha superata non si esegue mai**: lo script lo lascia non eseguibile. Dal 2026-10-02 il
   * job si ritenta, riscaricando e riverificando: la fonte è il nostro bucket e non cambia, quindi
   * un'impronta che non torna è un trasferimento troncato o un guasto nostro, non più una release
   * pubblica cambiata sotto i piedi.
   */
  'BUILD_HASH_MISMATCH',
  /** I `.gz` sono integri ma `gzip -dc` o `chmod` non hanno lasciato i due binari eseguibili. */
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
  /**
   * Lo SHA-256 dell'originale scaricato nel Sandbox non è quello dichiarato all'apertura
   * (`video_jobs.sha256_dichiarato`, solo `put-nativo`): il file che è arrivato non è quello che
   * l'app aveva detto di caricare. Si controlla PRIMA di convertire, e non si ritenta mai.
   */
  'ORIGINALE_DIVERSO',
] as const

export type CodiceRunnerVideo = (typeof CODICI_RUNNER_VIDEO)[number]
