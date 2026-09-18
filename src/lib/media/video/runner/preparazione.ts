import {
  ARCHIVIO_FFMPEG_SHA256,
  ARCHIVIO_FFMPEG_URL,
  DECODER_RICHIESTI,
  ENCODER_RICHIESTI,
  FFMPEG_NELL_ARCHIVIO,
  FFPROBE_NELL_ARCHIVIO,
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
export const FFMPEG = `${CARTELLA_BUILD}/${FFMPEG_NELL_ARCHIVIO}`
export const FFPROBE = `${CARTELLA_BUILD}/${FFPROBE_NELL_ARCHIVIO}`

/**
 * Le tre uscite dello script, una per modo di fallire.
 *
 * Numeri alti e distinti di proposito: 1 e 2 li usa già mezza `coreutils`, e una
 * collisione farebbe leggere «lo sha non torna» dove invece `sh` non ha trovato un
 * comando. Restano sotto 125, che è dove cominciano i codici riservati alla shell.
 */
export const USCITE_PREPARAZIONE = {
  scarico: 21,
  impronta: 22,
  estrazione: 23,
} as const

/**
 * Scarica la build pinnata, ne verifica lo SHA-256, e SOLO ALLORA la estrae.
 *
 * ─── L'ORDINE È LA SOSTANZA DI QUESTA FUNZIONE ───────────────────────────────
 *
 * Quello che sta per entrare nella MicroVM è codice preso da una release pubblica
 * su Internet, e fra poco leggerà il video che un genitore ha caricato. `tar` che
 * gira su un archivio non verificato è già l'esecuzione di codice altrui: scrive
 * percorsi decisi dall'archivio. Perciò `sha256sum -c` sta **prima** di `tar`, e
 * `set -e` fa il resto — se l'impronta non torna, la riga successiva non parte.
 *
 * E se non torna, non si riprova. `curl` ha `--retry` perché un TCP che cade è un
 * incidente di trasporto; un'impronta sbagliata non lo è: o la release è cambiata
 * sotto i piedi (allora `build.ts` va aggiornato da una persona, dopo aver guardato
 * cosa è cambiato), o qualcuno sta servendo un archivio diverso. In entrambi i casi
 * riscaricare vuol dire soltanto sbagliare più in fretta.
 *
 * Gli argomenti di `curl`, uno per uno: `-f` fa fallire su 4xx/5xx invece di
 * salvare la pagina d'errore dentro il file; `-sS` tace il progresso ma NON gli
 * errori, che sono l'unica cosa che poi si legge nel log; `-L` segue il redirect
 * con cui GitHub serve gli asset delle release.
 *
 * Dall'archivio si estraggono **solo i due binari nominati da `build.ts`**, non
 * tutto: `tar` con i percorsi espliciti non scrive niente che non abbiamo chiesto.
 */
export function scriptPreparazioneBuild(): string {
  const archivio = `${CARTELLA_BUILD}.tar.xz`
  return [
    'set -eu',
    `mkdir -p ${CARTELLA_BUILD}`,
    `curl -fsSL --retry 3 --retry-all-errors -o ${archivio} '${ARCHIVIO_FFMPEG_URL}' || exit ${USCITE_PREPARAZIONE.scarico}`,
    `echo '${ARCHIVIO_FFMPEG_SHA256}  ${archivio}' | sha256sum -c - || exit ${USCITE_PREPARAZIONE.impronta}`,
    `tar -xJf ${archivio} -C ${CARTELLA_BUILD} '${FFMPEG_NELL_ARCHIVIO}' '${FFPROBE_NELL_ARCHIVIO}' || exit ${USCITE_PREPARAZIONE.estrazione}`,
    `rm -f ${archivio}`,
    `test -x ${FFMPEG} && test -x ${FFPROBE} || exit ${USCITE_PREPARAZIONE.estrazione}`,
  ].join('\n')
}

/**
 * Il codice d'errore che corrisponde all'uscita dello script. `null` solo per lo zero.
 *
 * FAIL-CLOSED su tutto il resto, e vale la pena dire perché: un 137 è il SIGKILL di
 * un tetto di tempo, un 127 è «comando non trovato», un 1 è un `set -e` su qualcosa
 * che non abbiamo previsto. Nessuno di loro è «è andata bene», e farli ricadere su
 * `null` significherebbe proseguire verso `ffmpeg` con una cartella vuota — cioè
 * scoprire il guasto tre passi più in là, dove la diagnosi non c'è più.
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
 * ─── PERCHÉ SI CONTROLLA, INVECE DI FIDARSI DELLO SHA ────────────────────────
 *
 * Lo SHA-256 dimostra che l'archivio è quello atteso; non dimostra che l'archivio
 * atteso sappia fare ciò che serve. Sono due domande diverse e la seconda ha già
 * avuto la sua risposta sbagliata in questo repo: `brew install ffmpeg` produce un
 * binario che passa qualunque verifica di integrità e **non ha `zscale`**, perché
 * Homebrew non compila libzimg — e `zscale` è il primo filtro della catena HDR→SDR.
 * Il guasto non si vede all'installazione: si vede al primo video HDR di un
 * genitore, con un «No such filter» dentro uno stderr che nessuno guarda.
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
