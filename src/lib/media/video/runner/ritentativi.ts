import { USCITE_PREPARAZIONE } from './preparazione'
import { USCITE_APPARECCHIO, USCITE_CONVERSIONE } from './script'

/**
 * LE CLASSI DI GUASTO E I RITENTATIVI — che cosa si fa di una conversione che non è riuscita.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA DOMANDA, E COSA NON FA QUESTO MODULO
 *
 * Fino al 2026-10-02 ogni guasto del runner rendeva il job definitivo al primo colpo
 * (`video_job_fail`), qualunque ne fosse la causa. Il 29/09 l'archivio della build di
 * FFmpeg ha cominciato a rispondere 404 e 17 job su 17 sono finiti `failed` al primo
 * tentativo: un guasto NOSTRO, pagato dalle insegnanti. L'errore opposto costa quasi
 * quanto — ritentare un filmato illeggibile apre una MicroVM per ottenere, identico,
 * lo stesso rifiuto — ed è per questo che un guasto ha una CLASSE.
 *
 * Qui si risponde a una domanda sola, «di chi è il guasto e vale la pena riprovare?»,
 * con funzioni PURE: niente rete, niente SDK del Sandbox, niente database, niente log.
 * Il log lo scrive chi le chiama (`esegui.ts`) e la rimessa in coda è la RPC
 * `video_job_retry`.
 *
 * ⚠️ La diagnosi (lo stderr di curl e di ffmpeg) qui si LEGGE e non si restituisce mai:
 * ne escono un numero o un sì/no. Può contenere indirizzi firmati e metadati di video
 * di bambini, e un modulo che la ritornasse intera sarebbe un secondo posto da cui
 * farla uscire.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE QUATTRO CLASSI
 *
 *  · `file` — il filmato non va bene (probe e verifiche del file). Il job è RIFIUTATO e
 *    non si ritenta mai.
 *  · `non-ritentabile` — non è provato che il file c'entri, ma non si ritenta lo
 *    stesso: FFmpeg uscito con errore, probe dell'uscita, ffprobe sull'originale senza
 *    segni di rete. Il job FALLISCE e non si ritenta mai.
 *  · `infra-transitoria` — guasto nostro che può passare da solo (rete, 5xx, MicroVM che
 *    non si apre). Si ritenta; ogni ritentativo si logga a livello `warn`.
 *  · `infra-permanente` — guasto nostro che da solo non passa (oggetto mancante,
 *    impronta che non torna, build incompleta). Si ritenta LO STESSO e si logga a livello
 *    `error`, con la causa leggibile: «permanente» descrive la causa, non la decisione.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL BILANCIO DEI TENTATIVI (decisione del titolare)
 *
 * Quattro tentativi in tutto — il primo e tre ritentativi — con attese di 5, 10 e 15
 * minuti, tutto dentro un'ora; poi il job è `failed`. `attempt` è quello di
 * `video_jobs`: `video_job_claim` lo incrementa a ogni presa, quindi il job che ha
 * appena fallito al primo tentativo ha `attempt = 1`.
 *
 * Quattro invarianti tengono insieme i numeri, e li prova
 * `__tests__/lib/video-runner-ritentativi.test.ts`:
 *
 *   1. `ATTESE_FRA_TENTATIVI_S.length === TENTATIVI_MASSIMI_GUASTO_NOSTRO - 1`;
 *   2. le attese crescono;
 *   3. `somma(attese) + tentativi × cadenza ≤ finestra`, cioè 1800 + 4 × 300 = 3000 ≤ 3600:
 *      un tentativo parte al primo giro del cron dopo la scadenza dell'attesa, quindi
 *      ognuno dei quattro può slittare fino a una cadenza;
 *   4. `CADENZA_CRON_RUNNER_S` è lo schedule vero di `20260918120000_video_runner_tick.sql`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COME SI USA (compito T5, `esegui.ts`)
 *
 *  · uscita dell'apparecchio → `classeDaUscitaApparecchio(uscita, stderr)`;
 *  · uscita della conversione → `classeDaUscitaConversione(uscita, diagnosi)`;
 *  · firma dell'originale o della build che non è riuscita → `classeDelDownload(stato,
 *    codiceStorage)`. ⚠️ Per la firma dell'ORIGINALE chi chiama passa solo 400 o 404, altrimenti
 *    `null`: `classeDelDownload` è la regola della BUILD, e uno stato 403 o 429 passato così com'è
 *    renderebbe «permanente» un guasto che la tabella del §4.5 vuole transitorio;
 *  · i punti che non hanno un'uscita (MicroVM che non si apre, firma dell'uscita,
 *    scrittura degli argomenti, build incompleta, probe e verifiche del file) la classe
 *    la dichiarano da sé: la tabella completa è al §4.5 della spec
 *    `docs/superpowers/specs/2026-10-02-video-pr1-hotfix-ffmpeg-design.md`;
 *  · poi `decidiRitentativo(job.attempt, classe)`: se ritentare e con quale attesa.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * I NUMERI
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il primo tentativo più tre ritentativi (decisione del titolare). */
export const TENTATIVI_MASSIMI_GUASTO_NOSTRO = 4

/**
 * Le attese, in secondi, fra un tentativo e il successivo: dopo il 1° si aspettano 5
 * minuti, dopo il 2° dieci, dopo il 3° quindici. Il 4° non ha un'attesa dopo di sé:
 * è l'ultimo.
 */
export const ATTESE_FRA_TENTATIVI_S = [300, 600, 900] as const

/**
 * Ogni quanto gira il cron del runner, in secondi. Uguale al passo dello schedule
 * `1,6,…,56` di `20260918120000_video_runner_tick.sql`: il test lo legge da lì, non da
 * un commento.
 */
export const CADENZA_CRON_RUNNER_S = 300

/** La finestra entro cui i tentativi devono finire: un'ora. */
export const FINESTRA_TENTATIVI_S = 3600

export type ClasseGuasto = 'file' | 'non-ritentabile' | 'infra-transitoria' | 'infra-permanente'

/* ────────────────────────────────────────────────────────────────────────────
 * LO STATO HTTP DENTRO LA DIAGNOSI
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Le forme in cui uno stato HTTP arriva nello stderr, MISURATE il 2026-10-02 in locale con
 * le opzioni degli script (curl 8.7.1, ffprobe 8.1.2 con `-v error`, contro un server su
 * localhost):
 *
 *  · curl con `-f`: «curl: (22) The requested URL returned error: 404» — e con
 *    `--retry` la riga si ripete identica a ogni tentativo fallito (e resta anche se il
 *    tentativo dopo riesce: vedi `RIGHE_DI_CURL`);
 *  · ffprobe: «<indirizzo>: Server returned 404 Not Found»;
 *  · ffprobe e ffmpeg col log di default (senza `-v error`): «[http @ …] HTTP error 503
 *    Service Unavailable», con la cifra anche per i 5xx;
 *  · una riga di stato: «HTTP/1.1 404 Not Found» (con `curl -I`). ⚠️ Quella riga va su STDOUT
 *    (misurato: `curl -fsSI URL > out 2> err` lascia su stderr solo «curl: (22) … 404») e
 *    nello stderr dell'apparecchio non arriva: le intestazioni della HEAD finiscono in `awk`.
 *    Resta fra le forme riconosciute perché la spec §4.5 la vuole («HTTP/1.1 503»). La
 *    variante «HTTP/2 404» è la stessa riga senza il punto: quella NON l'ho misurata.
 *
 * Si ancorano alle FORMULE e non a un numero di tre cifre qualunque: lo stderr
 * dell'apparecchio porta con sé di tutto («76 MB», «Amazon Linux 2023 repository») e
 * un numero non è uno stato HTTP.
 *
 * Il flag `g` serve a `matchAll`, che lavora su una copia: lo stato di queste
 * espressioni non viene mai toccato.
 */
const FORME_DELLO_STATO_HTTP: readonly RegExp[] = [
  /returned error:\s*(\d{3})\b/gi,
  /\bHTTP\/\d(?:\.\d)?\s+(\d{3})\b/gi,
  /\bServer returned (\d{3})\b/gi,
  /\bHTTP error (\d{3})\b/gi,
]

/**
 * Lo stato HTTP di un guasto, letto dallo stderr — o `null` se non c'è.
 *
 * Contano solo i 4xx e i 5xx: un «HTTP/1.1 200 OK» o un 302 in mezzo allo stderr non
 * sono il guasto. Se gli stati sono più d'uno vince l'ULTIMO nel testo, che per UN comando
 * è il verdetto finale dopo i ritentativi di curl. Quando il testo mette insieme più
 * comandi (lo stderr dell'apparecchio, il diario della conversione) l'ultimo stato non è per
 * forza quello del comando che ha fatto uscire lo script, e per le uscite 21, 24, 31 e 34 si
 * passa da `statoDellUltimoCurl`.
 *
 * ⚠️ Per i 5xx ffprobe non scrive nessuna cifra («Server returned 5XX Server Error
 * reply»): qui torna `null`. Che quella riga sia comunque un errore di rete lo riconosce
 * `mostraErroreDiRete`, che è la domanda dell'uscita 25.
 */
export function httpDallaDiagnosi(diagnosi: string): number | null {
  if (typeof diagnosi !== 'string') return null
  let ultimo: { posizione: number; stato: number } | null = null
  for (const forma of FORME_DELLO_STATO_HTTP) {
    for (const trovato of diagnosi.matchAll(forma)) {
      const stato = Number(trovato[1])
      if (stato < 400 || stato > 599) continue
      const posizione = trovato.index ?? 0
      if (ultimo === null || posizione > ultimo.posizione) ultimo = { posizione, stato }
    }
  }
  return ultimo === null ? null : ultimo.stato
}

/**
 * I segni di un errore di rete che non portano uno stato HTTP con le cifre. Sono la domanda
 * dell'uscita 25 (D3): ffprobe sull'URL ha fallito, per la rete o per il file?
 *
 * MISURATI il 2026-10-02 con ffprobe 8.1.2 e `-v error`, contro un server su localhost:
 *  · la RIGA FIRMATA da uno strato di rete — «[tcp @ …] Connection to tcp://… failed:
 *    Connection refused», «[tcp @ …] Failed to resolve hostname …», «[http @ …] Stream ends
 *    prematurely at 100, should be 100000», «[http @ …] Error reading HTTP response: …»
 *    (che finisce con `End of file`, `Connection reset by peer` o `Operation timed out`, a
 *    seconda del guasto), «[tls @ …] error:…:SSL routines::wrong version number». Con
 *    `-v error` ogni riga firmata `[tcp|tls|http|https @` è già un errore, e basta da sola;
 *  · «Server returned 5XX Server Error reply»: per i 5xx lo stato c'è ma senza cifre;
 *  · «Connection reset by peer» DA SOLA: con un RST a metà corpo ffprobe non scrive nessuna
 *    riga firmata, solo «<indirizzo>: Connection reset by peer». È il caso che giustifica le
 *    formule testuali: la riga firmata può mancare.
 *
 * NON MISURATI (non li ho provocati, o il Mac usa un'altra libreria; il Sandbox è Linux):
 * `Connection timed out` (l'errno di Linux: il Mac scrive «Operation timed out»), `Network is
 * unreachable`, `No route to host`, `Input/output error` da solo (nelle mie prove segue sempre
 * una riga firmata) e la riga generica «Server returned 4XX Client Error…». Stanno qui perché
 * una forma mancante rende non ritentabile un guasto di rete; se il Sandbox vero ne scrivesse
 * un'altra, va aggiunta.
 *
 * ⚠️ Questi segni si cercano nello stderr SENZA le righe di curl (`senzaRigheDiCurl`). Lo stderr
 * dell'apparecchio mette insieme tutti i comandi, e curl scrive «curl: (28) Operation timed
 * out…» o «curl: (56) Recv failure: Connection reset by peer» per ogni tentativo fallito, anche
 * quando quello dopo riesce e l'uscita è 0. Ma all'uscita 25 i curl dell'apparecchio hanno già
 * finito, e bene: se uno dei due della build fosse fallito lo script sarebbe uscito con 21, e se
 * fosse fallita la HEAD con 24 (salvo l'eccezione descritta in `RIGHE_DI_CURL`). Le loro righe
 * sono tentativi RECUPERATI e non la causa, e ffprobe non scrive mai righe «curl: (». Lasciarle
 * dentro rendeva ritentabile un file illeggibile con un 503 o un timeout recuperati alle spalle,
 * contro D3.
 *
 * Un filmato rotto dice un'altra cosa — «Invalid data found when processing input» (misurato
 * su un corpo non-MP4 e su un corpo vuoto), «moov atom not found» — e non deve finire qui.
 */
const SEGNALI_DI_RETE: readonly RegExp[] = [
  /\[(?:tcp|tls|https?)\s*@/i,
  /\bServer returned [45]XX\b/i,
  /\b(?:Connection (?:refused|timed out|reset by peer)|Network is unreachable|No route to host|Operation timed out)\b/i,
  /\bInput\/output error\b/i,
]

/**
 * Le righe d'errore di curl: «curl: (22) The requested URL returned error: 503», «curl: (28)
 * Operation timed out after 1010 milliseconds with 0 bytes received», «curl: (56) Recv failure:
 * Connection reset by peer». Con `-sS` curl ne scrive UNA per ogni tentativo fallito, e le
 * scrive anche quando il tentativo dopo riesce.
 *
 * MISURATO il 2026-10-02 (curl 8.7.1, `--retry 3 --retry-all-errors`, contro un server su
 * 127.0.0.1): un 503 al primo colpo e un 200 dopo, sia con GET sia con HEAD (`-I`) → uscita 0 e
 * «curl: (22) … 503» ancora su stderr; un primo colpo oltre `--max-time 1` e poi un 200 → uscita 0
 * e «curl: (28) …» ancora su stderr. La riga dice che un tentativo è fallito, non che il comando
 * lo sia.
 *
 * Lo stderr dell'apparecchio (e il diario della conversione) mette insieme più comandi, e quelle
 * righe ci finiscono tutte. Da qui due regole, una per domanda:
 *
 *  · uscita 25 (ffprobe) → `senzaRigheDiCurl`: i curl hanno già finito bene, le loro righe sono
 *    tentativi recuperati e non la causa del guasto;
 *  · uscite 21, 24, 31 e 34 (un curl è fallito) → `statoDellUltimoCurl`: decide il tentativo
 *    FINALE del curl che ha fatto uscire lo script, cioè l'ultima riga «curl: (». Le righe di
 *    prima sono tentativi, o curl, recuperati.
 *
 * ⚠️ Un'eccezione alla prima regola, MISURATA il 2026-10-02 e preesistente (`script.ts`: la
 * pipeline della HEAD non ha `pipefail`): con `curl -fsSI` un 404 che porta `Content-Length`
 * scrive le intestazioni su stdout, `grep` trova la cifra e la pipeline esce 0 invece di 24. Lo
 * script prosegue, e ffprobe sullo stesso URL scrive il suo «Server returned 404 Not Found».
 * All'uscita 25 le righe di curl sono allora la causa vera e non un tentativo recuperato, ma
 * `senzaRigheDiCurl` le toglie lo stesso e la classe non cambia: il segno di rete lo porta la
 * riga di ffprobe, che resta (è il caso `curlConStato(404)` + `Server returned 404` del test).
 * Il difetto è di `script.ts` e fuori da questo modulo.
 *
 * ⚠️ Il flag `g` serve a `replace` e a `match`, che ripartono da zero a ogni chiamata. Mai con
 * `test` o `exec`: lì l'espressione si ricorda l'ultima posizione e la chiamata dopo partirebbe
 * da metà del testo.
 */
const RIGHE_DI_CURL = /^curl: \(\d+\).*$/gm

/**
 * Il testo senza le righe di curl: ciò che resta lo hanno scritto gli altri comandi (ffprobe,
 * sha256sum). Non è esportata, e il testo ripulito non esce dal modulo: lo legge solo
 * `mostraErroreDiRete`, che ne ricava un sì o un no.
 */
function senzaRigheDiCurl(diagnosi: string): string {
  if (typeof diagnosi !== 'string') return diagnosi
  return diagnosi.replace(RIGHE_DI_CURL, '')
}

/**
 * Lo stato HTTP dell'ULTIMO tentativo di curl, cioè dell'ultima riga «curl: (»: è quello del curl
 * che ha fatto uscire lo script. Se nel testo non c'è nessuna riga di curl, lo stato che
 * `httpDallaDiagnosi` trova nel testo intero. `null` se non c'è uno stato, e per un testo che non
 * è un testo.
 */
function statoDellUltimoCurl(diagnosi: string): number | null {
  if (typeof diagnosi !== 'string') return null
  const righe = diagnosi.match(RIGHE_DI_CURL)
  if (righe !== null && righe.length > 0) return httpDallaDiagnosi(righe[righe.length - 1])
  return httpDallaDiagnosi(diagnosi)
}

/** Lo stderr mostra un errore di rete o un errore HTTP (di qualunque stato)? */
function mostraErroreDiRete(diagnosi: string): boolean {
  if (typeof diagnosi !== 'string') return false
  return (
    httpDallaDiagnosi(diagnosi) !== null || SEGNALI_DI_RETE.some((segnale) => segnale.test(diagnosi))
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE CLASSI
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La classe di un DOWNLOAD (o di una firma) che non è riuscito, dallo stato HTTP e dal
 * codice dello Storage.
 *
 *  · `NoSuchKey`, oppure uno stato 4xx → `infra-permanente`;
 *  · 5xx, `0` (il «000» che curl scrive quando non ha ricevuto nessuna risposta) e
 *    `null`/`undefined` (nessuno stato: timeout, DNS, connessione caduta) →
 *    `infra-transitoria`. Ciò che non si capisce si ritenta.
 *
 * `codiceStorage` è l'`error.code` di `StorageApiError` («NoSuchKey», «AccessDenied»…).
 *
 * È la regola della BUILD: la firma dei due `.gz` e l'uscita 21 dell'apparecchio. La
 * tabella della spec (§4.5) la stringe per altri punti: «404 permanente, altrimenti
 * transitoria» per gli URL firmati (uscite 24, 31 e 34: se ne occupano le funzioni
 * `classeDaUscita…`) e «404/400» per la firma dell'ORIGINALE (chi chiama passa a questa
 * funzione solo uno stato 400 o 404, altrimenti `null`).
 *
 * ⚠️ «Permanente» non vuol dire «non ritentare»: le due classi `infra-*` si ritentano, e
 * cambia solo il livello del log. Vale anche per un 408 o un 429: sono 4xx, e per la regola
 * della spec qui sono `infra-permanente`.
 */
export function classeDelDownload(
  http: number | null | undefined,
  codiceStorage?: string | null,
): ClasseGuasto {
  if (codiceStorage === 'NoSuchKey') return 'infra-permanente'
  if (typeof http === 'number' && Number.isInteger(http) && http >= 400 && http <= 499) {
    return 'infra-permanente'
  }
  return 'infra-transitoria'
}

/** Per un URL firmato (uscite 24, 31, 34): 404 è permanente, tutto il resto transitorio. */
function classeDiUnUrlFirmato(http: number | null): ClasseGuasto {
  return http === 404 ? 'infra-permanente' : 'infra-transitoria'
}

/**
 * La classe di un apparecchio finito male, dalla sua uscita e dal suo stderr. `null` solo
 * per lo zero, come in `codiceDaUscitaApparecchio`: un'uscita che non è un guasto non ha
 * una classe.
 *
 *   0  → `null`
 *   21 → scarico della build (BUILD_DOWNLOAD_FAILED): `classeDelDownload` sullo stato
 *        HTTP dell'ultima riga di curl — 4xx permanente; 5xx, timeout, DNS, connessione
 *        caduta transitoria;
 *   22 → impronta (BUILD_HASH_MISMATCH) e 23 → estrazione (BUILD_EXTRACT_FAILED):
 *        `infra-permanente`;
 *   24 → HEAD dell'originale (SOURCE_DOWNLOAD_FAILED): 404 `infra-permanente`, altrimenti
 *        `infra-transitoria`, sempre sull'ultima riga di curl;
 *   25 → ffprobe sull'URL (PROBE_COMMAND_FAILED): `infra-transitoria` SOLO se lo stderr, senza
 *        le righe di curl, mostra un errore di rete o HTTP, altrimenti `non-ritentabile` (D3:
 *        non si ritenta un file illeggibile);
 *   qualunque altra (1, 126, 127, 137, 255…) → `infra-transitoria`: si fallisce chiusi.
 *
 * ⚠️ Lo stderr è quello di TUTTO l'apparecchio — i due curl della build, sha256sum, la HEAD,
 * ffprobe — e curl scrive una riga «curl: (» per ogni tentativo fallito, anche quando quello
 * dopo riesce e l'uscita è 0 (misure in `RIGHE_DI_CURL`). Due regole:
 *
 *  · 21 e 24: decide il tentativo FINALE del curl che ha fatto uscire lo script, cioè l'ULTIMA
 *    riga «curl: (». Un 429 recuperato sul primo `.gz` non rende permanente l'esito del
 *    secondo, che è finito in timeout: per la spec (§4.5) un timeout è transitorio;
 *  · 25: le righe di curl non contano. I curl dell'apparecchio hanno già finito, e bene —
 *    altrimenti lo script sarebbe uscito con 21 o con 24, salvo l'eccezione della HEAD descritta
 *    in `RIGHE_DI_CURL` — quindi le loro righe sono tentativi recuperati e non la causa, e
 *    ffprobe non scrive mai righe «curl: (». Contano solo le righe degli altri comandi.
 */
export function classeDaUscitaApparecchio(uscita: number, diagnosi: string): ClasseGuasto | null {
  switch (uscita) {
    case 0:
      return null
    case USCITE_PREPARAZIONE.scarico:
      return classeDelDownload(statoDellUltimoCurl(diagnosi))
    case USCITE_PREPARAZIONE.impronta:
    case USCITE_PREPARAZIONE.estrazione:
      return 'infra-permanente'
    case USCITE_APPARECCHIO.dimensione:
      return classeDiUnUrlFirmato(statoDellUltimoCurl(diagnosi))
    case USCITE_APPARECCHIO.probe:
      return mostraErroreDiRete(senzaRigheDiCurl(diagnosi)) ? 'infra-transitoria' : 'non-ritentabile'
    default:
      return 'infra-transitoria'
  }
}

/**
 * La classe di una conversione finita male, dalla sua uscita e dalla sua diagnosi. `null`
 * solo per lo zero.
 *
 *   0  → `null`
 *   31 → scarico dell'originale (SOURCE_DOWNLOAD_FAILED) e 34 → caricamento dell'uscita
 *        (OUTPUT_UPLOAD_FAILED): 404 `infra-permanente`, altrimenti `infra-transitoria`;
 *   32 → FFmpeg (ENCODE_FAILED), 33 → ffprobe sull'uscita (PROBE_COMMAND_FAILED) e
 *        qualunque uscita che non conosciamo, compreso un 137: `non-ritentabile` (D3).
 *
 * Per 31 e 34 lo stato è quello dell'ultima riga «curl: (» del diario: il diario raccoglie
 * anche i curl di prima (l'originale, il watermark), e un tentativo recuperato lì non è l'esito
 * del curl che ha fatto uscire lo script (vedi `RIGHE_DI_CURL`).
 *
 * ⚠️ Qui l'uscita ignota NON è transitoria, al contrario di quella dell'apparecchio: non si
 * ritenta un file che FFmpeg non riesce a convertire.
 */
export function classeDaUscitaConversione(uscita: number, diagnosi: string): ClasseGuasto | null {
  switch (uscita) {
    case 0:
      return null
    case USCITE_CONVERSIONE.scarico:
    case USCITE_CONVERSIONE.caricamento:
      return classeDiUnUrlFirmato(statoDellUltimoCurl(diagnosi))
    default:
      return 'non-ritentabile'
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA DECISIONE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Che cosa fare di un job che ha appena fallito.
 *
 *  · `ritenta: true` — `attesaSecondi` e `tentativiMassimi` sono i due numeri da passare a
 *    `video_job_retry` (`p_attesa_secondi`, `p_tentativi_massimi`);
 *  · `ritenta: false` — `motivo` dice perché: `classe-non-ritentabile` (`file` o
 *    `non-ritentabile`), `tentativi-esauriti` (è l'unico caso in cui il fallimento porta
 *    `tentativi_esauriti: true` nel log) oppure `attempt-non-valido`.
 */
export type DecisioneRitentativo =
  | { ritenta: true; attesaSecondi: number; tentativiMassimi: number }
  | {
      ritenta: false
      motivo: 'classe-non-ritentabile' | 'tentativi-esauriti' | 'attempt-non-valido'
    }

/**
 * Si ritenta? E dopo quanto?
 *
 * `attempt` è quello del job che ha appena fallito, e conta da 1 (vedi la testata). Le due
 * classi `infra-*` si ritentano finché ne restano: al 1° fallimento si aspetta
 * `ATTESE_FRA_TENTATIVI_S[0]`, al 2° `[1]`, al 3° `[2]`, e al 4° (`attempt >=
 * TENTATIVI_MASSIMI_GUASTO_NOSTRO`) il job fallisce per sempre. `file` e `non-ritentabile`
 * non si ritentano mai, a qualunque `attempt`.
 *
 * Un `attempt` che non è un intero ≥ 1 non è un tentativo: si fallisce chiusi, senza
 * ritentare, e senza spacciarlo per «esauriti».
 */
export function decidiRitentativo(attempt: number, classe: ClasseGuasto): DecisioneRitentativo {
  if (classe !== 'infra-transitoria' && classe !== 'infra-permanente') {
    return { ritenta: false, motivo: 'classe-non-ritentabile' }
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    return { ritenta: false, motivo: 'attempt-non-valido' }
  }
  if (attempt >= TENTATIVI_MASSIMI_GUASTO_NOSTRO) {
    return { ritenta: false, motivo: 'tentativi-esauriti' }
  }
  return {
    ritenta: true,
    attesaSecondi: ATTESE_FRA_TENTATIVI_S[attempt - 1],
    tentativiMassimi: TENTATIVI_MASSIMI_GUASTO_NOSTRO,
  }
}
