import {
  DECODER_RICHIESTI,
  ENCODER_RICHIESTI,
  FFMPEG_GZ_SHA256,
  FFMPEG_SHA256,
  FFPROBE_GZ_SHA256,
  FFPROBE_SHA256,
  FILTRI_RICHIESTI,
} from '../build'
import type { CodiceRunnerVideo } from './codici'

/**
 * LA PREPARAZIONE — tutto ciò che si può decidere PRIMA di aprire una MicroVM.
 *
 * Nomi, percorsi, lo script di provvista della build e la lettura del suo
 * inventario: sono funzioni pure su stringhe, senza rete e senza `@vercel/sandbox`.
 * È voluto. Il collaudo di questo modulo non ha bisogno di un Sandbox, e ciò che
 * qui NON si può provare — che `sh` interpreti lo script come crediamo — resta una
 * cosa sola, dichiarata, invece di essere sparsa dentro l'orchestrazione.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * IL NOME DEL SANDBOX
 * ──────────────────────────────────────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Il nome della MicroVM: deterministico, e con dentro il `fence_epoch`.
 *
 * ─── PERCHÉ IL FENCE STA NEL NOME ────────────────────────────────────────────
 *
 * `Sandbox.get({ name })` riaggancia una MicroVM viva **da un altro processo**: è
 * ciò che rende durevole questo disegno senza un orchestratore esterno, ed è anche
 * ciò che lo renderebbe pericoloso se il nome dipendesse dal solo job. Lo scenario
 * è concreto: un worker perde la lease (rete), il database la fa scadere, un
 * secondo worker riscatta il job — `video_job_claim` alza `fence_epoch` — e apre la
 * propria conversione. Se poi il primo torna in vita e chiama `Sandbox.get` con il
 * nome del job, si ritrova in mano la MicroVM del successore: due `ffmpeg` sullo
 * stesso file, due `kill`, un `stop()` che spegne il lavoro di un altro.
 *
 * Col fence nel nome quel riaggancio semplicemente non trova niente. È una quarta
 * guardia che si aggiunge alle tre che il database ha già (`LEASE_ACTIVE`,
 * `FENCE_MISMATCH`, `OUTPUT_CONFLICT`), e vive a un livello che quelle non
 * raggiungono: la piattaforma. Le tre del database impediscono di **scrivere**
 * l'esito; questa impedisce di **toccare** il processo.
 *
 * La forma è quella di un nome DNS — minuscolo, cifre e trattini, niente punti —
 * perché i nomi di Sandbox finiscono in sottodomini quando si espone una porta. Il
 * conto della lunghezza: 8 (`kv-video-`, senza il trattino finale) + 32 (uuid senza
 * trattini) + 1 + 16 (il fence più grande che un `Number` sicuro rappresenta) = 57,
 * sotto i 63 di un'etichetta DNS.
 */
export function nomeSandboxVideo(jobId: string, fenceEpoch: number): string {
  if (typeof jobId !== 'string' || !UUID.test(jobId)) {
    throw new TypeError('jobId non è un uuid')
  }
  if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch < 0) {
    throw new TypeError('fenceEpoch non è un intero non negativo')
  }
  return `kv-video-${jobId.replace(/-/g, '').toLowerCase()}-${fenceEpoch}`
}

/**
 * Dove finisce l'uscita dentro `video_processing`.
 *
 * `video_jobs_output_unico` è `UNIQUE (output_bucket, output_path)`: un secondo
 * tentativo che riscrivesse lo stesso percorso otterrebbe `OUTPUT_CONFLICT` da
 * `video_job_ready` **dopo** aver pagato la conversione. Il discriminante è il
 * `fence_epoch` — che `video_job_claim` incrementa a ogni presa in carico, quindi è
 * il tentativo, non una sua approssimazione.
 */
export function percorsoUscitaVideo(job: {
  id: string
  owner_id: string
  fence_epoch: number
}): string {
  if (!UUID.test(job.id) || !UUID.test(job.owner_id)) {
    throw new TypeError('job.id / job.owner_id non sono uuid')
  }
  if (!Number.isSafeInteger(job.fence_epoch) || job.fence_epoch < 0) {
    throw new TypeError('fence_epoch non è un intero non negativo')
  }
  return `${job.owner_id.toLowerCase()}/${job.id.toLowerCase()}/${job.fence_epoch}.mp4`
}

/* ────────────────────────────────────────────────────────────────────────────
 * LO SCRIPT DI PROVVISTA
 * ──────────────────────────────────────────────────────────────────────────── */

/** Dove vivono i binari dentro la MicroVM. Assoluti: nessun comando dipende dal `cwd`. */
export const CARTELLA_BUILD = '/tmp/kv-ffmpeg'
export const FFMPEG = `${CARTELLA_BUILD}/ffmpeg`
export const FFPROBE = `${CARTELLA_BUILD}/ffprobe`

/**
 * I nomi delle variabili d'ambiente con cui gli URL firmati dei due `.gz` entrano nella
 * MicroVM. Gli URL stanno SOLO lì: nell'`env` del comando di preparazione, mai negli
 * argomenti di un processo (finirebbero in `ps` e in ogni log che stampa la riga di
 * comando) e mai nell'`env` della conversione, dove i binari ci sono già e un URL
 * firmato in più sarebbe soltanto un segreto in più da tenere fuori dai log.
 */
export const ENV_URL_FFMPEG = 'KV_URL_FFMPEG'
export const ENV_URL_FFPROBE = 'KV_URL_FFPROBE'

/**
 * Le tre uscite dello script, una per modo di fallire.
 *
 * Numeri alti e distinti di proposito: 1 e 2 li usa già mezza `coreutils`, e una
 * collisione farebbe leggere «lo sha non torna» dove invece `sh` non ha trovato un
 * comando. Restano sotto 125, che è dove cominciano i codici riservati alla shell.
 *
 * Una variabile d'ambiente non passata NON ha un'uscita sua: `${VAR:?}` esce con 1 (bash)
 * o con 2 (dash), e `codiceDaUscitaPreparazione` la legge come ogni uscita che non
 * conosce — cioè chiude, invece di proseguire.
 */
export const USCITE_PREPARAZIONE = {
  scarico: 21,
  impronta: 22,
  estrazione: 23,
} as const

/**
 * Scarica i due `.gz` della build dal NOSTRO bucket, ne verifica le impronte, li
 * decomprime, verifica le impronte dei binari, e SOLO ALLORA li rende eseguibili.
 *
 * ─── NIENTE INTERNET, NIENTE GESTORI DI PACCHETTI ────────────────────────────
 *
 * Lo script non contiene un solo indirizzo: i due URL firmati di sola lettura
 * (`urlLettura` su `video_build`) entrano dall'ambiente del comando, in `KV_URL_FFMPEG`
 * e `KV_URL_FFPROBE`. E non contiene `dnf`, `sudo`, `xz` né `tar`. Il 29/09/2026 la
 * conversione si è fermata perché la release BtbN è stata cancellata (404); a ogni
 * MicroVM nuova, prima ancora, `dnf` scaricava ~76 MB di metadati dai mirror di Amazon
 * per installare `xz`: due download esterni a runtime, entrambi punti di rottura fuori
 * dal nostro controllo. `gzip` invece c'è su ogni immagine (Amazon Linux 2023, Ubuntu)
 * senza installare niente.
 *
 * ─── L'ORDINE È LA SOSTANZA DI QUESTA FUNZIONE ───────────────────────────────
 *
 *     curl  →  sha256 dei `.gz`  →  `gzip -dc`  →  sha256 dei binari  →  `chmod`
 *
 * Quello che sta per entrare nella MicroVM è codice che fra poco leggerà il video
 * che un'insegnante ha caricato. Perciò **un binario non verificato non è mai
 * eseguibile**: `gzip -dc >` lo scrive coi permessi di default, senza il bit di
 * esecuzione, e il `chmod 0755` sta DOPO la seconda verifica. Se un'impronta non torna
 * `set -e` fa il resto: la riga successiva non parte. Le due verifiche non sono
 * ridondanti — la prima prova che il file arrivato dalla rete è quello che abbiamo
 * caricato (prima ancora di decomprimerlo), la seconda che ciò che è uscito dal `.gz` è
 * il binario collaudato.
 *
 * Il `>&2` sulle verifiche porta la riga `FAILED` di `sha256sum` nella diagnosi: sullo
 * stdout resterebbe un «OK» che nessuno legge, sullo stderr si legge QUALE dei due file
 * non torna.
 *
 * ─── SE NON TORNA, IL JOB SI RITENTA: MA NON SI ESEGUE MAI ───────────────────
 *
 * Fino al 2026-10-02 qui c'era scritto «se non torna, non si riprova»: l'archivio veniva
 * da una release pubblica che poteva cambiare sotto i piedi, e riscaricarlo voleva dire
 * soltanto sbagliare più in fretta. Adesso la fonte è nostra e non cambia (si carica con
 * `upsert: false`): un'impronta che non torna è un trasferimento troncato o un guasto
 * nostro, e il job si ritenta riscaricando e riverificando (`./ritentativi.ts`). In
 * nessun caso si esegue un binario che non abbia superato entrambe le verifiche.
 *
 * Gli argomenti di `curl`, uno per uno: `-f` fa fallire su 4xx/5xx invece di salvare la
 * pagina d'errore dentro il file — è così che nella diagnosi si legge `returned error:
 * 404`; `-sS` tace il progresso ma NON gli errori, che sono l'unica cosa che poi si
 * legge nel log; `--retry 3 --retry-all-errors` ripete un trasporto che cade;
 * `--connect-timeout 10 --max-time 60` fissano il tetto di OGNI tentativo, perché un
 * download appeso non deve consumare l'invocazione. Non c'è `-L`: un URL firmato dello
 * Storage non fa redirect.
 */
export function scriptPreparazioneBuild(): string {
  const ffmpegGz = `${CARTELLA_BUILD}/ffmpeg.gz`
  const ffprobeGz = `${CARTELLA_BUILD}/ffprobe.gz`
  const opzioniCurl = '-fsS --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60'
  return [
    'set -eu',
    `: "\${${ENV_URL_FFMPEG}:?}" "\${${ENV_URL_FFPROBE}:?}"`,
    `mkdir -p ${CARTELLA_BUILD}`,
    `curl ${opzioniCurl} -o ${ffmpegGz} "$${ENV_URL_FFMPEG}" || exit ${USCITE_PREPARAZIONE.scarico}`,
    `curl ${opzioniCurl} -o ${ffprobeGz} "$${ENV_URL_FFPROBE}" || exit ${USCITE_PREPARAZIONE.scarico}`,
    `printf '%s  %s\\n%s  %s\\n' '${FFMPEG_GZ_SHA256}' ${ffmpegGz} '${FFPROBE_GZ_SHA256}' ${ffprobeGz} | sha256sum -c - >&2 || exit ${USCITE_PREPARAZIONE.impronta}`,
    `gzip -dc ${ffmpegGz} > ${FFMPEG} || exit ${USCITE_PREPARAZIONE.estrazione}`,
    `gzip -dc ${ffprobeGz} > ${FFPROBE} || exit ${USCITE_PREPARAZIONE.estrazione}`,
    `printf '%s  %s\\n%s  %s\\n' '${FFMPEG_SHA256}' ${FFMPEG} '${FFPROBE_SHA256}' ${FFPROBE} | sha256sum -c - >&2 || exit ${USCITE_PREPARAZIONE.impronta}`,
    `rm -f ${CARTELLA_BUILD}/*.gz`,
    `chmod 0755 ${FFMPEG} ${FFPROBE} || exit ${USCITE_PREPARAZIONE.estrazione}`,
    `test -x ${FFMPEG} && test -x ${FFPROBE} || exit ${USCITE_PREPARAZIONE.estrazione}`,
  ].join('\n')
}

/**
 * Il codice d'errore che corrisponde all'uscita dello script. `null` solo per lo zero.
 *
 * FAIL-CLOSED su tutto il resto, e vale la pena dire perché: un 137 è il SIGKILL di
 * un tetto di tempo, un 127 è «comando non trovato», un 1 è un `set -e` su qualcosa
 * che non abbiamo previsto (o una variabile d'ambiente che nessuno ha passato).
 * Nessuno di loro è «è andata bene», e farli ricadere su `null` significherebbe
 * proseguire verso `ffmpeg` con una cartella vuota — cioè scoprire il guasto tre passi
 * più in là, dove la diagnosi non c'è più.
 */
export function codiceDaUscitaPreparazione(uscita: number): CodiceRunnerVideo | null {
  if (uscita === 0) return null
  if (uscita === USCITE_PREPARAZIONE.impronta) return 'BUILD_HASH_MISMATCH'
  if (uscita === USCITE_PREPARAZIONE.estrazione) return 'BUILD_EXTRACT_FAILED'
  return 'BUILD_DOWNLOAD_FAILED'
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'INVENTARIO DELLA BUILD
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il separatore fra le tre sezioni dell'inventario.
 *
 * Non `===`: le sezioni dell'apparecchio (`./script.ts`) si chiamano `===BYTE===` e
 * simili, e un separatore che è sottostringa di un altro taglia l'uscita nel punto
 * sbagliato — silenziosamente, e solo quando le due cose viaggiano insieme.
 */
export const SEPARATORE_INVENTARIO = '---SEZIONE---'

/**
 * Il comando che chiede alla build di raccontarsi. Una chiamata sola invece di tre:
 * ogni giro verso la MicroVM costa, e qui non c'è niente da guadagnare a separarli.
 */
export function comandoInventarioBuild(): string {
  return [
    'set -eu',
    `${FFMPEG} -hide_banner -filters`,
    `echo '${SEPARATORE_INVENTARIO}'`,
    `${FFMPEG} -hide_banner -decoders`,
    `echo '${SEPARATORE_INVENTARIO}'`,
    `${FFMPEG} -hide_banner -encoders`,
  ].join('\n')
}

export interface InventarioBuild {
  filtri: ReadonlySet<string>
  decoder: ReadonlySet<string>
  encoder: ReadonlySet<string>
}

/**
 * Una riga di elenco di FFmpeg: spazi, la colonna delle bandierine, il nome.
 *
 * Le bandierine sono 2 caratteri nei filtri (` TS overlay`) e 6 nei codec
 * (` VFS..D av1`), e sono fatte di lettere e punti. Il nome è il token successivo,
 * ed è per costruzione alfanumerico. Le righe di legenda (`T.. = Timeline support`)
 * non passano: il loro token successivo è `=`, che non è un nome. Le righe di
 * separazione (`------`) nemmeno: il trattino non è una bandierina.
 */
const RIGA_ELENCO = /^\s+[A-Za-z.]{2,8}\s+([A-Za-z0-9_]+)(?:\s|$)/

function nomiDi(sezione: string | undefined): Set<string> {
  const nomi = new Set<string>()
  for (const riga of (sezione ?? '').split('\n')) {
    const trovato = RIGA_ELENCO.exec(riga)
    if (trovato) nomi.add(trovato[1])
  }
  return nomi
}

/** Legge l'uscita di `comandoInventarioBuild` e ne ricava i tre insiemi di nomi. */
export function inventarioDellaBuild(stdout: string): InventarioBuild {
  const sezioni = (typeof stdout === 'string' ? stdout : '').split(SEPARATORE_INVENTARIO)
  return {
    filtri: nomiDi(sezioni[0]),
    decoder: nomiDi(sezioni[1]),
    encoder: nomiDi(sezioni[2]),
  }
}

/**
 * Che cosa manca, rispetto a ciò che `build.ts` dichiara indispensabile.
 *
 * ─── PERCHÉ SI CONTROLLA, INVECE DI FIDARSI DELLE IMPRONTE ───────────────────
 *
 * Dal 2026-10-02 le impronte SHA-256 che lo script verifica sono quattro: quelle dei
 * due `.gz` scaricati dal nostro bucket e quelle dei due binari che ne escono (non più
 * quella dell'archivio, che è soltanto la provenienza). Dimostrano che i binari sono
 * quelli attesi; non dimostrano che i binari attesi sappiano fare ciò che serve. Sono
 * due domande diverse e la seconda ha già avuto la sua risposta sbagliata in questo
 * repo: `brew install ffmpeg` produce un binario che passa qualunque verifica di
 * integrità e **non ha `zscale`**, perché Homebrew non compila libzimg — e `zscale` è
 * il primo filtro della catena HDR→SDR. Il guasto non si vede all'installazione: si
 * vede al primo video HDR di un genitore, con un «No such filter» dentro uno stderr
 * che nessuno guarda.
 *
 * La testata di `build.ts` lo mette per iscritto: «chi risolve un binario verifica
 * questa lista e si rifiuta di partire se manca qualcosa, invece di scoprirlo per
 * via di uno stderr». Questa funzione è quella riga.
 *
 * L'ordine dell'elenco restituito è quello delle tre liste di `build.ts`: serve a
 * rendere il messaggio d'errore stabile fra un'esecuzione e l'altra.
 */
export function mancanzeDellaBuild(inventario: InventarioBuild): string[] {
  return [
    ...FILTRI_RICHIESTI.filter((nome) => !inventario.filtri.has(nome)),
    ...DECODER_RICHIESTI.filter((nome) => !inventario.decoder.has(nome)),
    ...ENCODER_RICHIESTI.filter((nome) => !inventario.encoder.has(nome)),
  ]
}
