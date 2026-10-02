import { FFMPEG_SHA256, FFPROBE_SHA256 } from '../build'
import type { CodiceRunnerVideo } from './codici'
import { videoTemporalProgram, type VideoTemporalEvidence } from '../temporale'
import {
  CARTELLA_BUILD,
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
 * LA PR 2 AGGIUNGE DUE COSE, e nessuna cambia gli script di prima
 *
 *  · **Dove stanno i binari è un parametro.** Una MicroVM nata dallo snapshot li ha già in
 *    `/opt/kv-ffmpeg`: l'apparecchio li VERIFICA invece di scaricarli (`scriptVerificaBinari`,
 *    uscita 26 se non tornano → il runner ripiega nella stessa MicroVM), e la conversione li
 *    chiama da lì. Senza parametri ogni funzione dà lo script della PR 1, parola per parola.
 *  · **Lo `sha256` dichiarato** (caricamento nativo) si verifica dentro la conversione, subito dopo
 *    lo scarico e prima di convertire (uscita 35 → `ORIGINALE_DIVERSO`, mai ritentato).
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

/**
 * Le uscite che l'apparecchio aggiunge a quelle della provvista (21–23).
 *
 * `binari` (26) è dell'apparecchio di una MicroVM nata dallo SNAPSHOT (PR 2): i due binari che
 * lo snapshot doveva già contenere mancano, o non sono eseguibili, o la loro impronta non è quella
 * attesa. È la sola uscita che il runner NON legge come un guasto: vuol dire «ripiega nella stessa
 * MicroVM con la provvista dal bucket», e lo fa gridando (`ambiente-pronto-assente`).
 */
export const USCITE_APPARECCHIO = {
  dimensione: 24,
  probe: 25,
  binari: 26,
} as const

/**
 * I binari di uno snapshot, VERIFICATI e non scaricati: la stessa seconda metà della provvista
 * (impronte dei due BINARI, `sha256sum -c -`) senza la prima (rete, `.gz`, decompressione).
 *
 * ⚠️ NON è una cortesia verso lo snapshot, è la ragione per cui lo snapshot si può usare. Un
 * binario che sta sul disco di una MicroVM da settimane è codice che fra poco leggerà il video di
 * un bambino, e «l'abbiamo messo noi» non è una verifica: l'immagine può essere stata ricostruita,
 * lo snapshot sostituito con un altro, la cartella toccata. Le due costanti sono quelle della
 * provvista (`../build.ts`) e del lock `fixture-video-reali`: nessuna impronta nuova.
 *
 * Due controlli, in quest'ordine: i file ci sono e sono eseguibili (`test -x`: un'assenza dice
 * subito «manca» invece di una riga `No such file` di `sha256sum`), poi le impronte. Il `>&2` porta
 * la riga `FAILED` di `sha256sum` nella diagnosi, dove si legge QUALE dei due non torna. Entrambi i
 * modi di fallire escono con la stessa uscita (26): per il runner la risposta è una sola.
 */
export function scriptVerificaBinari(cartella: string = CARTELLA_BUILD): string {
  const ffmpeg = `${cartella}/ffmpeg`
  const ffprobe = `${cartella}/ffprobe`
  return [
    'set -eu',
    `test -x ${ffmpeg} && test -x ${ffprobe} || exit ${USCITE_APPARECCHIO.binari}`,
    `printf '%s  %s\\n%s  %s\\n' '${FFMPEG_SHA256}' ${ffmpeg} '${FFPROBE_SHA256}' ${ffprobe} | sha256sum -c - >&2 || exit ${USCITE_APPARECCHIO.binari}`,
  ].join('\n')
}

export interface OpzioniApparecchio {
  /** Dove stanno i binari. Predefinita: la cartella del ripiego (`CARTELLA_BUILD`), come nella PR 1. */
  cartella?: string
  /**
   * I binari ci sono GIÀ (una MicroVM nata dallo snapshot): si verificano (`scriptVerificaBinari`)
   * invece di scaricarli dal bucket. Predefinito: falso, cioè la provvista della PR 1.
   */
  binariGiaPresenti?: boolean
}

/**
 * Provvista della build (o, nello snapshot, la sua verifica), inventario, dimensione
 * dell'originale, probe dell'originale.
 *
 * Senza opzioni è lo script della PR 1: gli URL firmati dei due `.gz` entrano dall'ambiente e la
 * provvista scarica, verifica, decomprime. Con `binariGiaPresenti` la prima parte si sostituisce
 * con la verifica dei binari che lo snapshot porta già: l'inventario, la HEAD e il probe restano
 * IDENTICI, perché ciò che si chiede a una build non cambia con il posto da cui viene.
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
 *
 * ⚠️ L'USCITA DI CURL SI CATTURA PRIMA DELLA PIPELINE, e non è una finezza. In una
 * pipeline l'esito è quello dell'ULTIMO comando, e qui l'ultimo è `grep`: con `curl -fsSI`
 * un 4xx/5xx scrive comunque le intestazioni su stdout — compreso il `Content-Length`
 * del CORPO D'ERRORE — e `grep` trova la cifra, quindi la pipeline usciva 0 mentre curl
 * aveva appena detto «returned error: 400». MISURATO il 2026-10-02 sul Sandbox vero
 * (F1, prova P7): per un URL firmato il cui oggetto non esiste più lo Storage risponde 400
 * con un corpo JSON di 88 byte, e lo script prendeva 88 per la dimensione del video,
 * proseguiva verso ffprobe e usciva 25 (`PROBE_COMMAND_FAILED`, non ritentabile) invece
 * di 24 (`SOURCE_DOWNLOAD_FAILED`). Con `VAR=$(curl …) || exit 24` il guasto di curl
 * ferma lo script lì, e `pipefail` non serve: non c'è in ogni `sh` (dash non lo ha), e
 * questa forma regge identica in dash, in bash e nello `sh` della MicroVM.
 */
export function scriptApparecchio(opzioni: OpzioniApparecchio = {}): string {
  const cartella = opzioni.cartella ?? CARTELLA_BUILD
  return [
    opzioni.binariGiaPresenti === true
      ? scriptVerificaBinari(cartella)
      : scriptPreparazioneBuild(cartella),
    `mkdir -p ${CARTELLA_LAVORO}`,
    "echo '===INVENTARIO==='",
    comandoInventarioBuild(cartella),
    "echo '===BYTE==='",
    `INTESTAZIONI=$(curl -fsSI --retry 3 --retry-all-errors "$${ENV_URL_INGRESSO}") ` +
      `|| exit ${USCITE_APPARECCHIO.dimensione}`,
    `printf '%s\\n' "$INTESTAZIONI" | tr -d '\\r' ` +
      `| awk 'tolower($1)=="content-length:"{print $2}' | tail -1 ` +
      `| grep -E '^[0-9]+$' || exit ${USCITE_APPARECCHIO.dimensione}`,
    "echo '===PROBE==='",
    `${cartella}/ffprobe ${OPZIONI_FFPROBE} "$${ENV_URL_INGRESSO}" > ${PROBE_INGRESSO} ` +
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
 *
 * L'uscita 26 (binari dello snapshot non verificati) ha il suo codice, anche se il runner la
 * intercetta PRIMA di arrivare qui: la risposta a quel guasto è il ripiego, non un job fallito.
 * Se per un domani un altro percorso la facesse arrivare fin qui, il nome giusto è quello di
 * un'impronta che non torna, non il `BUILD_DOWNLOAD_FAILED` con cui una tabella fail-closed
 * leggerebbe un numero che non conosce.
 */
export function codiceDaUscitaApparecchio(uscita: number): CodiceRunnerVideo | null {
  if (uscita === USCITE_APPARECCHIO.dimensione) return 'SOURCE_DOWNLOAD_FAILED'
  if (uscita === USCITE_APPARECCHIO.probe) return 'PROBE_COMMAND_FAILED'
  if (uscita === USCITE_APPARECCHIO.binari) return 'BUILD_HASH_MISMATCH'
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

/**
 * Le uscite della conversione staccata (31–35).
 *
 * `impronta` (35, PR 2) è lo `sha256` dichiarato all'apertura che non coincide con quello
 * dell'originale appena scaricato. Mappa su `ORIGINALE_DIVERSO`, classe `file`: il filmato che è
 * arrivato non è quello che l'app aveva detto di caricare, e riconvertirlo darebbe lo stesso
 * identico rifiuto.
 */
export const USCITE_CONVERSIONE = {
  scarico: 31,
  codifica: 32,
  probe: 33,
  caricamento: 34,
  impronta: 35,
} as const

/**
 * Il nome della variabile d'ambiente con cui lo `sha256` dichiarato entra nella conversione.
 *
 * Nell'AMBIENTE e non negli argomenti, come gli URL firmati: un valore che sta in un argomento è
 * leggibile con un `ps` dentro la MicroVM e compare nella console di Vercel accanto al comando. Lo
 * `sha256` di un video non è un segreto come un token, ma è l'impronta del filmato di un bambino, e
 * l'unico posto da cui il runner lo fa partire è la riga del job: non c'è motivo che viaggi altrove.
 */
export const ENV_SHA256_ATTESO = 'KV_SHA256_ATTESO'

/**
 * Lo `sha256` dichiarato, com'è nella riga del job, letto con la stessa severità con cui si
 * verifica.
 *
 * `video_jobs.sha256_dichiarato` è un `bytea` di 32 byte (CHECK `octet_length = 32`), e dentro il
 * `to_jsonb(riga)` con cui le RPC restituiscono il job diventa la stringa `\x<64 cifre esadecimali>`:
 * è ciò che il runner trova nel campo, ed è l'unica forma che passa.
 *
 *  · `assente` — `null` o campo mancante: il job non ha dichiarato nulla (web e TUS, le News), e il
 *    passo si SALTA. È il caso normale.
 *  · `ok` — la forma giusta. `hex` è in minuscolo, 64 cifre: l'unica cosa che entra in una riga di shell.
 *  · `illeggibile` — c'è qualcosa, ma non è un'impronta. Chi chiama NON deve trattarlo come «assente»:
 *    un controllo di integrità richiesto e non eseguibile non passa in silenzio (vedi `esegui.ts`).
 *
 * Accetta anche le 64 cifre senza il prefisso `\x` (un serializzatore diverso), mai altro. Il valore
 * NON esce da qui in nessun altro modo: niente log, niente messaggio d'errore.
 */
export type Sha256Dichiarato =
  | { stato: 'assente' }
  | { stato: 'ok'; hex: string }
  | { stato: 'illeggibile' }

const FORMA_SHA256_DICHIARATO = /^(?:\\x)?([0-9a-fA-F]{64})$/

export function leggiSha256Dichiarato(grezzo: unknown): Sha256Dichiarato {
  if (grezzo === undefined || grezzo === null) return { stato: 'assente' }
  if (typeof grezzo !== 'string') return { stato: 'illeggibile' }
  const trovato = FORMA_SHA256_DICHIARATO.exec(grezzo)
  return trovato === null ? { stato: 'illeggibile' } : { stato: 'ok', hex: trovato[1].toLowerCase() }
}

/** Quanto del diario entra nel marcatore: gli ultimi 2000 byte. */
const BYTE_CODA_DIARIO = 2000

/**
 * Le righe di shell che mettono nel marcatore la CODA del diario: gli ultimi 2000 byte,
 * **senza la prima riga quando il diario li supera**.
 *
 * ⚠️ `tail -c 2000` taglia dove cade il byte e non dove finisce una riga: la prima riga di
 * ciò che restituisce è quasi sempre MEZZA. Ed è il caso peggiore per ciò che il diario
 * porta con sé (lo stderr di ffmpeg e di curl): le regole di `diagnosi.ts` che tolgono i
 * metadati personali riconoscono un tag dal NOME o da una forma INTERA, e di una riga cui
 * manca l'inizio — il resto di una coordinata GPS, `8+014.2681+012.345/` — non vedono più
 * né l'uno né l'altra. Perciò, quando c'è stato un taglio, la prima riga si butta.
 *
 * Ma SOLO se c'è stato un taglio: un diario di 300 byte arriva intero, e la sua prima riga è
 * una riga vera (spesso la più informativa). Il confronto è sulla dimensione del file, con
 * `wc -c` — non `stat -c`, che è GNU e su macOS non esiste — e il ramo «tieni tutto» è quello
 * che richiede una risposta esplicita: se `wc` non risponde, `[` fallisce e si ripiega sul
 * ramo che butta la prima riga, perché perdere una riga è il male minore.
 *
 * Con UNA riga sola (un diario che è un unico rigo più lungo di 2000 byte) `awk` la tiene:
 * buttarla vorrebbe dire non scrivere niente, e di un errore illeggibile resta almeno la
 * fine, che è la parte che serve.
 */
function righeCodaDiario(rientro: string): string[] {
  const coda = `tail -c ${BYTE_CODA_DIARIO} ${DIARIO} 2>/dev/null`
  return [
    `${rientro}if [ "$(wc -c < ${DIARIO} | tr -d ' ')" -le ${BYTE_CODA_DIARIO} ] 2>/dev/null; then`,
    `${rientro}  ${coda} || true`,
    `${rientro}else`,
    `${rientro}  ${coda} | awk '{ r[NR] = $0 } END { for (i = (NR > 1 ? 2 : 1); i <= NR; i++) print r[i] }' || true`,
    `${rientro}fi`,
  ]
}

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
 *
 * ─── LO `sha256` DICHIARATO, PRIMA DI CONVERTIRE (PR 2, spec §10.4) ──────────────────────
 *
 * Con `verificaSha256` lo script, appena scaricato l'originale e PRIMA di ogni altra cosa (il
 * watermark, la codifica, la sonda), ne calcola lo SHA-256 e lo confronta con quello che l'app ha
 * dichiarato all'apertura (`$KV_SHA256_ATTESO`). Se non torna esce con `35` (`ORIGINALE_DIVERSO`,
 * classe `file`, mai ritentato) senza aver speso un solo secondo di CPU: è la prova che il
 * contenuto che sta per essere convertito è quello che il dispositivo ha spedito, e non un file
 * qualunque messo sullo stesso percorso da chi ha rubato un token di rinnovo.
 *
 * Senza `verificaSha256` (web e TUS, le News: nessuno `sha256` dichiarato) il passo NON c'è: lo
 * script è identico a quello di prima. Il valore atteso viaggia nell'ambiente, mai fra gli argomenti,
 * e `sha256sum -c` scrive nel diario solo `<file>: OK` o `FAILED`: l'impronta non esce da nessuna parte.
 *
 * ─── LA CARTELLA DEI BINARI È UN PARAMETRO ────────────────────────────────────────────────
 *
 * `cartellaBuild` dice dove sono `ffmpeg` e `ffprobe`: la cartella del ripiego (`/tmp/kv-ffmpeg`) o
 * quella dello snapshot (`/opt/kv-ffmpeg`). Il runner passa quella che ha VERIFICATO, perché la
 * conversione parte staccata e dopo non c'è modo di cambiare idea.
 */
export function scriptConversione(p: {
  conWatermark: boolean
  videoIndex: number
  audioIndex: number | null
  sourceFps: number
  /**
   * Durata, larghezza e altezza dell'INGRESSO, dal suo probe: arrivano tali e quali a
   * `videoTemporalProgram`, che ne ricava il timeout PROPORZIONALE della sonda temporale
   * (`timeoutSondaTemporaleMs`). Facoltativi per chi non ha un probe (le prove di shell), ma chi ce
   * l'ha li passa SEMPRE: senza, la sonda parte col tetto di 900 s invece dei 120-250 s che servono a
   * un Full HD di tre minuti (secondario #9 della PR 2, annotato dal critico di T9 e chiuso in `esegui.ts`).
   */
  durationSeconds?: number
  width?: number
  height?: number
  /** Dove stanno `ffmpeg` e `ffprobe`. Predefinita: la cartella del ripiego, come nella PR 1. */
  cartellaBuild?: string
  /** Verifica lo `sha256` dell'originale contro `$KV_SHA256_ATTESO` (il chiamante lo passa nell'`env`). */
  verificaSha256?: boolean
}): string {
  const cartella = p.cartellaBuild ?? CARTELLA_BUILD
  const ffmpeg = `${cartella}/ffmpeg`
  const ffprobe = `${cartella}/ffprobe`
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
    ...righeCodaDiario('    '),
    `  } > ${PARZIALE} 2>/dev/null`,
    // `mv` sullo stesso filesystem è atomico: o il marcatore non c'è, o c'è tutto.
    `  mv ${PARZIALE} ${MARCATORE}`,
    '}',
    'trap marcatore EXIT',
    '',
    `curl -fsSL --retry 3 --retry-all-errors -o ${INGRESSO} "$${ENV_URL_INGRESSO}" 2>>${DIARIO} ` +
      `|| exit ${USCITE_CONVERSIONE.scarico}`,
  ]

  // PRIMA di tutto il resto: un originale che non è quello dichiarato non merita né il watermark né
  // la codifica. `sha256sum -c -` legge «impronta  percorso» da stdin: l'impronta viene dall'ambiente.
  if (p.verificaSha256 === true) {
    righe.push(
      `printf '%s  %s\\n' "$${ENV_SHA256_ATTESO}" ${INGRESSO} | sha256sum -c - >>${DIARIO} 2>&1 ` +
        `|| exit ${USCITE_CONVERSIONE.impronta}`,
    )
  }

  if (p.conWatermark) {
    righe.push(
      `curl -fsSL --retry 3 --retry-all-errors -o ${WATERMARK} "$${ENV_URL_WATERMARK}" 2>>${DIARIO} ` +
        `|| exit ${USCITE_CONVERSIONE.scarico}`,
    )
  }

  righe.push(
    `xargs -0 -a ${FILE_ARGOMENTI} ${ffmpeg} >>${DIARIO} 2>&1 || exit ${USCITE_CONVERSIONE.codifica}`,
    `${ffprobe} ${OPZIONI_FFPROBE} ${USCITA} > ${PROBE_USCITA} 2>>${DIARIO} ` +
      `|| exit ${USCITE_CONVERSIONE.probe}`,
    // La prova di decodifica non interrompe: il suo esito è un dato, non un verdetto.
    `${ffmpeg} -hide_banner -nostdin -v error -stats -xerror -err_detect explode ` +
      `-i ${USCITA} -fps_mode passthrough -f null - > ${DIARIO_DECODIFICA} 2>&1; echo "$?" > ${USCITA_DECODIFICA}`,
    // Il programma produce SOLO un'attestazione compatta: i frame non attraversano
    // stdout del comando Vercel, il marcatore, la DB RPC o il logger.
    `node - ${ffprobe} ${INGRESSO} ${USCITA} > ${PROVA_TEMPORALE} 2>>${DIARIO} <<'KV_TEMPORAL_PROGRAM'`,
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
 * Il modello con cui si riconoscono i processi dei binari: `kv-ffmpeg`, il nome della cartella
 * che li contiene QUALUNQUE sia (`/tmp/kv-ffmpeg` del ripiego, `/opt/kv-ffmpeg` dello snapshot).
 *
 * ⚠️ È `[k]v-ffmpeg` e non `kv-ffmpeg`, e la parentesi non è un vezzo. `pkill -f` confronta il modello
 * con la RIGA DI COMANDO di ogni processo, e quella di `sh -c 'pkill -f kv-ffmpeg'` — il comando che sta
 * girando — la contiene: `pkill` esclude sé stesso, ma NON la shell che lo ha lanciato, che morirebbe
 * prima di arrivare al `|| true`. Con la classe `[k]` il modello riconosce `kv-ffmpeg` (le righe dei
 * binari) e non riconosce il proprio testo `[k]v-ffmpeg`. Dalla PR 2 non basta più nominare `/tmp`: una
 * MicroVM nata dallo snapshot ha i binari in `/opt`, e un `pkill -f /tmp/kv-ffmpeg` lascerebbe `ffmpeg`
 * acceso a convertire un job che non è più nostro.
 */
export const MODELLO_PROCESSI_DEI_BINARI = '[k]v-ffmpeg'

/**
 * Ferma la conversione. Best-effort per costruzione: si arriva qui solo quando il
 * job non è più nostro, e subito dopo la MicroVM viene spenta comunque.
 */
export function comandoInterruzione(): { cmd: string; args: string[] } {
  return { cmd: 'sh', args: ['-c', `pkill -f '${MODELLO_PROCESSI_DEI_BINARI}' || true`] }
}

export function codiceDaUscitaConversione(uscita: number): CodiceRunnerVideo | null {
  if (uscita === 0) return null
  if (uscita === USCITE_CONVERSIONE.scarico) return 'SOURCE_DOWNLOAD_FAILED'
  if (uscita === USCITE_CONVERSIONE.probe) return 'PROBE_COMMAND_FAILED'
  if (uscita === USCITE_CONVERSIONE.caricamento) return 'OUTPUT_UPLOAD_FAILED'
  if (uscita === USCITE_CONVERSIONE.impronta) return 'ORIGINALE_DIVERSO'
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
