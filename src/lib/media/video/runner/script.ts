import type { CodiceRunnerVideo } from './codici'
import { videoTemporalProgram, type VideoTemporalEvidence } from '../temporale'
import {
  CARTELLA_BUILD,
  FFMPEG,
  FFPROBE,
  codiceDaUscitaPreparazione,
  comandoInventarioBuild,
  inventarioDellaBuild,
  scriptPreparazioneBuild,
  type InventarioBuild,
} from './preparazione'

/**
 * GLI SCRIPT CHE GIRANO DENTRO LA MICROVM, e i lettori della loro uscita.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PERCHÉ IL LAVORO STA IN DUE PEZZI E NON IN SETTE
 *
 * La tentazione è un comando per passo: scarica, converti, riprova, carica. Ogni
 * comando è una chiamata sincrona da questo processo, e questo processo è una
 * funzione Vercel che dura 300 secondi. Uno scarico di 2 GB, una codifica di dieci
 * minuti e un caricamento di 2 GB, sommati e aspettati qui, non ci stanno — e la
 * parte peggiore è come si romperebbe: l'invocazione verrebbe tagliata a metà
 * codifica, con la MicroVM ancora accesa e nessuno che sappia più che esiste.
 *
 * Perciò i pezzi sono due:
 *
 *  · **l'apparecchio** (`scriptApparecchio`) — provvista della build e lettura del
 *    probe dell'originale. Sincrono, perché è corto per costruzione: la build sono
 *    ~12 secondi misurati, e il probe si legge **dall'URL firmato**, con richieste
 *    di intervallo, senza scaricare il video. Un minuto scarso, non dieci.
 *
 *  · **la conversione** (`scriptConversione`) — tutto il resto, staccato, che
 *    scrive un marcatore quando ha finito. Questo processo non la aspetta: la
 *    sorveglia, e se il tempo finisce se ne va lasciandola accesa.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL MARCATORE, e perché non è l'oggetto `Command` dell'SDK
 *
 * Un `Command` vive nella memoria dell'invocazione che l'ha avviato. L'invocazione
 * successiva — quella che riaggancia il Sandbox per nome — non ce l'ha. Un file sul
 * disco della MicroVM ce l'hanno tutte. È questo che rende ripetibile la ripresa, e
 * quindi durevole l'intero disegno.
 *
 * Il marcatore si scrive **a parte e si sposta**: `mv` su uno stesso filesystem è
 * atomico, quindi o il marcatore non c'è o c'è tutto. Senza, una sorveglianza che
 * legge mentre l'altro scrive vedrebbe un JSON troncato e dichiarerebbe guasta una
 * conversione riuscita — dopo averla pagata.
 *
 * E si scrive **anche quando qualcosa esplode** (`trap … EXIT`): un guasto che non
 * lascia il marcatore lascerebbe la sorveglianza a girare fino al tetto, per poi
 * dire «in corso» su un lavoro morto dieci minuti prima.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** La cartella di lavoro dentro la MicroVM. Assoluta: nessun comando dipende dal `cwd`. */
export const CARTELLA_LAVORO = '/tmp/kv-video'

export const INGRESSO = `${CARTELLA_LAVORO}/ingresso`
export const USCITA = `${CARTELLA_LAVORO}/uscita.mp4`
export const WATERMARK = `${CARTELLA_LAVORO}/watermark.png`
export const FILE_ARGOMENTI = `${CARTELLA_LAVORO}/argomenti`
export const MARCATORE = `${CARTELLA_LAVORO}/esito.txt`

const PROBE_INGRESSO = `${CARTELLA_LAVORO}/ingresso.json`
const PROBE_USCITA = `${CARTELLA_LAVORO}/uscita.json`
const DIARIO = `${CARTELLA_LAVORO}/ffmpeg.log`
const DIARIO_DECODIFICA = `${CARTELLA_LAVORO}/decodifica.log`
const USCITA_DECODIFICA = `${CARTELLA_LAVORO}/decodifica.exit`
const PROVA_TEMPORALE = `${CARTELLA_LAVORO}/temporale.json`
const PARZIALE = `${CARTELLA_LAVORO}/esito.parziale`

/** I nomi delle variabili d'ambiente con cui gli URL firmati entrano nella MicroVM. */
export const ENV_URL_INGRESSO = 'KV_URL_INGRESSO'
export const ENV_URL_USCITA = 'KV_URL_USCITA'
export const ENV_URL_WATERMARK = 'KV_URL_WATERMARK'

const OPZIONI_FFPROBE = '-v error -print_format json -show_format -show_streams'

/* ────────────────────────────────────────────────────────────────────────────
 * L'APPARECCHIO
 * ──────────────────────────────────────────────────────────────────────────── */

/** Le uscite che l'apparecchio aggiunge a quelle della provvista (21–23). */
export const USCITE_APPARECCHIO = {
  dimensione: 24,
  probe: 25,
} as const

/**
 * Provvista della build, inventario, dimensione dell'originale, probe dell'originale.
 *
 * ⚠️ IL PROBE SI LEGGE DALL'URL FIRMATO, NON DAL FILE. `ffprobe` su HTTP chiede
 * solo gli intervalli di byte che gli servono — l'intestazione e, su un MP4 senza
 * faststart, la coda — e risponde in qualche secondo anche su un originale da 2 GB.
 * Scaricare qui vorrebbe dire far aspettare l'invocazione per minuti, cioè
 * rinunciare al motivo per cui l'apparecchio è sincrono.
 *
 * La dimensione arriva dal `content-length` della richiesta HEAD e non da
 * `video_jobs.source_size`: quella colonna la riempie il bordo dell'upload con ciò
 * che il client ha dichiarato, e `parseVideoProbe` usa il numero per decidere se il
 * file è troppo grande. Un limite che si fida del dichiarante non è un limite.
 */
export function scriptApparecchio(): string {
  return [
    scriptPreparazioneBuild(),
    `mkdir -p ${CARTELLA_LAVORO}`,
    "echo '===INVENTARIO==='",
    comandoInventarioBuild(),
    "echo '===BYTE==='",
    `curl -fsSI --retry 3 --retry-all-errors "$${ENV_URL_INGRESSO}" | tr -d '\\r' ` +
      `| awk 'tolower($1)=="content-length:"{print $2}' | tail -1 ` +
      `| grep -E '^[0-9]+$' || exit ${USCITE_APPARECCHIO.dimensione}`,
    "echo '===PROBE==='",
    `${FFPROBE} ${OPZIONI_FFPROBE} "$${ENV_URL_INGRESSO}" > ${PROBE_INGRESSO} ` +
      `|| exit ${USCITE_APPARECCHIO.probe}`,
    `cat ${PROBE_INGRESSO}`,
  ].join('\n')
}

/**
 * Il codice d'errore di un apparecchio finito male.
 *
 * Le uscite della provvista restano quelle: si delega, invece di riscriverle. Due
 * copie di una tabella non divergono il giorno in cui nascono — divergono il giorno
 * in cui qualcuno ne corregge una sola.
 */
export function codiceDaUscitaApparecchio(uscita: number): CodiceRunnerVideo | null {
  if (uscita === USCITE_APPARECCHIO.dimensione) return 'SOURCE_DOWNLOAD_FAILED'
  if (uscita === USCITE_APPARECCHIO.probe) return 'PROBE_COMMAND_FAILED'
  return codiceDaUscitaPreparazione(uscita)
}

export interface LetturaApparecchio {
  inventario: InventarioBuild
  byte: number | null
  probeGrezzo: string
}

/** Separa le tre sezioni dell'apparecchio. Niente si fida della posizione: solo dei titoli. */
export function leggiApparecchio(stdout: string): LetturaApparecchio {
  const testo = typeof stdout === 'string' ? stdout : ''
  const inventario = fra(testo, '===INVENTARIO===', '===BYTE===')
  const byte = interoPositivo(fra(testo, '===BYTE===', '===PROBE===').trim())
  return {
    inventario: inventarioDellaBuild(inventario),
    byte,
    probeGrezzo: dopo(testo, '===PROBE===').trim(),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * GLI ARGOMENTI DI FFMPEG
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Scrive gli argomenti di `buildVideoEncodeArgs` in un file, separati da NUL.
 *
 * ⚠️ NON si interpolano in una riga di shell. Il filtergraph della Galleria contiene
 * già apici singoli (`overlay=x='(main_w-overlay_w)/2'`), e appiattire un array in
 * una stringa significa inventarsi un quoting: funziona finché non arriva il caso
 * strano, e il caso strano arriva in produzione.
 *
 * Il trucco è `sh -c 'script' nome arg1 arg2 …`: gli argomenti viaggiano nell'array
 * di `execve`, `"$@"` li rilegge esattamente com'erano, e `printf '%s\0'` li scrive
 * separati da un byte che in un argomento non può comparire. Dall'altra parte
 * `xargs -0` li ricompone identici.
 */
export function comandoScritturaArgomenti(argomenti: string[]): { cmd: string; args: string[] } {
  return {
    cmd: 'sh',
    args: [
      '-c',
      `mkdir -p ${CARTELLA_LAVORO} && printf '%s\\0' "$@" > ${FILE_ARGOMENTI}`,
      'kv-argomenti',
      ...argomenti,
    ],
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA CONVERSIONE
 * ──────────────────────────────────────────────────────────────────────────── */

export const USCITE_CONVERSIONE = {
  scarico: 31,
  codifica: 32,
  probe: 33,
  caricamento: 34,
} as const

/**
 * Lo script staccato: scarica, converte, riprova l'uscita, ne prova la decodifica,
 * carica. E scrive il marcatore comunque vada.
 *
 * La prova di decodifica è la stessa di `__tests__/fixtures/ffmpeg.ts`:
 * `-xerror -err_detect explode` è ciò che distingue «ffprobe ha letto
 * l'intestazione» da «i frame escono davvero». Il suo esito NON interrompe lo
 * script — è una misura, e a giudicarla è `verifyVideoOutput`.
 *
 * Il caricamento è un `PUT` con `-T`, che *trasmette* il file invece di caricarlo
 * in memoria: è la forma che regge un'uscita da un gigabyte.
 */
export function scriptConversione(p: { conWatermark: boolean; videoIndex: number; audioIndex: number | null; sourceFps: number }): string {
  const righe = [
    'set -u',
    `mkdir -p ${CARTELLA_LAVORO}`,
    `rm -f ${MARCATORE} ${PARZIALE}`,
    `: > ${DIARIO}`,
    '',
    'marcatore() {',
    '  E=$?',
    '  {',
    '    echo "KV_ESITO_EXIT=$E"',
    `    echo "KV_BYTE_SORGENTE=$(stat -c %s ${INGRESSO} 2>/dev/null || echo 0)"`,
    `    echo "KV_BYTE_USCITA=$(stat -c %s ${USCITA} 2>/dev/null || echo 0)"`,
    `    echo "KV_DECODE_EXIT=$(cat ${USCITA_DECODIFICA} 2>/dev/null || echo 1)"`,
    `    echo "KV_TEMPORAL=$(cat ${PROVA_TEMPORALE} 2>/dev/null || echo null)"`,
    `    echo "KV_DECODE_FRAMES=$(grep -o 'frame=[ ]*[0-9]*' ${DIARIO_DECODIFICA} 2>/dev/null ` +
      `| tail -1 | tr -dc '0-9' || echo 0)"`,
    "    echo '===PROBE_SORGENTE==='",
    `    cat ${PROBE_INGRESSO} 2>/dev/null || true`,
    "    echo '===PROBE_USCITA==='",
    `    cat ${PROBE_USCITA} 2>/dev/null || true`,
    "    echo '===DIAGNOSI==='",
    `    tail -c 2000 ${DIARIO} 2>/dev/null || true`,
    `  } > ${PARZIALE} 2>/dev/null`,
    // `mv` sullo stesso filesystem è atomico: o il marcatore non c'è, o c'è tutto.
    `  mv ${PARZIALE} ${MARCATORE}`,
    '}',
    'trap marcatore EXIT',
    '',
    `curl -fsSL --retry 3 --retry-all-errors -o ${INGRESSO} "$${ENV_URL_INGRESSO}" 2>>${DIARIO} ` +
      `|| exit ${USCITE_CONVERSIONE.scarico}`,
  ]

  if (p.conWatermark) {
    righe.push(
      `curl -fsSL --retry 3 --retry-all-errors -o ${WATERMARK} "$${ENV_URL_WATERMARK}" 2>>${DIARIO} ` +
        `|| exit ${USCITE_CONVERSIONE.scarico}`,
    )
  }

  righe.push(
    `xargs -0 -a ${FILE_ARGOMENTI} ${FFMPEG} >>${DIARIO} 2>&1 || exit ${USCITE_CONVERSIONE.codifica}`,
    `${FFPROBE} ${OPZIONI_FFPROBE} ${USCITA} > ${PROBE_USCITA} 2>>${DIARIO} ` +
      `|| exit ${USCITE_CONVERSIONE.probe}`,
    // La prova di decodifica non interrompe: il suo esito è un dato, non un verdetto.
    `${FFMPEG} -hide_banner -nostdin -v error -stats -xerror -err_detect explode ` +
      `-i ${USCITA} -fps_mode passthrough -f null - > ${DIARIO_DECODIFICA} 2>&1; echo "$?" > ${USCITA_DECODIFICA}`,
    // Il programma produce SOLO un'attestazione compatta: i frame non attraversano
    // stdout del comando Vercel, il marcatore, la DB RPC o il logger.
    `node - ${FFPROBE} ${INGRESSO} ${USCITA} > ${PROVA_TEMPORALE} 2>>${DIARIO} <<'KV_TEMPORAL_PROGRAM'`,
    videoTemporalProgram(p),
    'KV_TEMPORAL_PROGRAM',
    `curl -fsS --retry 3 --retry-all-errors -T ${USCITA} ` +
      `-H 'content-type: video/mp4' -H 'x-upsert: true' "$${ENV_URL_USCITA}" >>${DIARIO} 2>&1 ` +
      `|| exit ${USCITE_CONVERSIONE.caricamento}`,
    'exit 0',
  )

  return righe.join('\n')
}

/** Il comando che chiede «hai finito?» e, se sì, consegna il marcatore. */
export function comandoMarcatore(): { cmd: string; args: string[] } {
  return { cmd: 'sh', args: ['-c', `test -f ${MARCATORE} && cat ${MARCATORE}`] }
}

/**
 * Ferma la conversione. Best-effort per costruzione: si arriva qui solo quando il
 * job non è più nostro, e subito dopo la MicroVM viene spenta comunque.
 */
export function comandoInterruzione(): { cmd: string; args: string[] } {
  return { cmd: 'sh', args: ['-c', `pkill -f ${CARTELLA_BUILD} || true`] }
}

export function codiceDaUscitaConversione(uscita: number): CodiceRunnerVideo | null {
  if (uscita === 0) return null
  if (uscita === USCITE_CONVERSIONE.scarico) return 'SOURCE_DOWNLOAD_FAILED'
  if (uscita === USCITE_CONVERSIONE.probe) return 'PROBE_COMMAND_FAILED'
  if (uscita === USCITE_CONVERSIONE.caricamento) return 'OUTPUT_UPLOAD_FAILED'
  // Fail-closed, compreso il 137 di un SIGKILL: «non lo so» non è «è andata bene».
  return 'ENCODE_FAILED'
}

export interface LetturaEsitoConversione {
  uscita: number
  byteSorgente: number | null
  byteUscita: number | null
  prova: { exitCode: number; decodedFrames: number; temporal: VideoTemporalEvidence | null } | null
  probeSorgente: string
  probeUscita: string
  diagnosi: string
}

/**
 * Legge il marcatore.
 *
 * Fail-closed su tutto: un marcatore illeggibile — troncato, sovrascritto, vuoto —
 * non deve produrre `uscita: 0`, che significherebbe «conversione riuscita» su
 * un'uscita che nessuno ha guardato.
 */
export function leggiEsitoConversione(testo: string): LetturaEsitoConversione {
  const t = typeof testo === 'string' ? testo : ''
  const uscita = interoPositivo(valoreDi(t, 'KV_ESITO_EXIT'), true)
  const decodeExit = interoPositivo(valoreDi(t, 'KV_DECODE_EXIT'), true)
  const decodeFrames = interoPositivo(valoreDi(t, 'KV_DECODE_FRAMES'), true)
  let temporal: VideoTemporalEvidence | null = null
  try {
    const parsed = JSON.parse(valoreDi(t, 'KV_TEMPORAL') ?? 'null') as VideoTemporalEvidence | null
    if (parsed?.version === 1) temporal = parsed
  } catch {
    // Un marcatore troncato diventa prova assente: verifyVideoOutput lo rifiuta e
    // il runner registra OUTPUT_FPS_INVALID senza loggare la sonda.
  }
  return {
    // `1` e non `0`: senza la riga non sappiamo com'è finita, e non saperlo è un guasto.
    uscita: uscita ?? 1,
    byteSorgente: interoPositivo(valoreDi(t, 'KV_BYTE_SORGENTE')),
    byteUscita: interoPositivo(valoreDi(t, 'KV_BYTE_USCITA')),
    prova:
      decodeExit === null || decodeFrames === null
        ? null
        : { exitCode: decodeExit, decodedFrames: decodeFrames, temporal },
    probeSorgente: fra(t, '===PROBE_SORGENTE===', '===PROBE_USCITA===').trim(),
    probeUscita: fra(t, '===PROBE_USCITA===', '===DIAGNOSI===').trim(),
    diagnosi: dopo(t, '===DIAGNOSI===').trim(),
  }
}

/**
 * Toglie gli URL da un testo diagnostico prima che finisca in un log.
 *
 * ⚠️ Non è prudenza generica. La diagnosi è lo stderr di `curl` e di `ffmpeg`, e
 * `curl`, quando un caricamento fallisce, scrive l'indirizzo per intero — token
 * compreso. Quel token autorizza a scrivere nel bucket privato dei video, e
 * `app_log` dura trenta giorni ed è interrogabile in SQL. Il motivo del guasto
 * resta (`403`, `connection reset`): sparisce solo l'indirizzo.
 */
export function senzaUrl(testo: string): string {
  return (typeof testo === 'string' ? testo : '').replace(/https?:\/\/\S+/gi, '[url-firmato]')
}

/* ────────────────────────────────────────────────────────────────────────────
 * Lettori difensivi
 * ──────────────────────────────────────────────────────────────────────────── */

function fra(testo: string, apertura: string, chiusura: string): string {
  const i = testo.indexOf(apertura)
  if (i < 0) return ''
  const j = testo.indexOf(chiusura, i + apertura.length)
  return testo.slice(i + apertura.length, j < 0 ? undefined : j)
}

function dopo(testo: string, apertura: string): string {
  const i = testo.indexOf(apertura)
  return i < 0 ? '' : testo.slice(i + apertura.length)
}

function valoreDi(testo: string, chiave: string): string {
  const trovato = new RegExp(`^${chiave}=(.*)$`, 'm').exec(testo)
  return trovato ? trovato[1].trim() : ''
}

function interoPositivo(grezzo: string, ammettiZero = false): number | null {
  if (!/^[0-9]+$/.test(grezzo)) return null
  const n = Number(grezzo)
  if (!Number.isSafeInteger(n)) return null
  return n > 0 || ammettiZero ? n : null
}
