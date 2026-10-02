import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { USCITE_PREPARAZIONE } from '@/lib/media/video/runner/preparazione'
import {
  ATTESE_FRA_TENTATIVI_S,
  CADENZA_CRON_RUNNER_S,
  FINESTRA_TENTATIVI_S,
  TENTATIVI_MASSIMI_GUASTO_NOSTRO,
  classeDaUscitaApparecchio,
  classeDaUscitaConversione,
  classeDelDownload,
  decidiRitentativo,
  httpDallaDiagnosi,
  type ClasseGuasto,
} from '@/lib/media/video/runner/ritentativi'
import { USCITE_APPARECCHIO, USCITE_CONVERSIONE } from '@/lib/media/video/runner/script'

/**
 * LE CLASSI DI GUASTO E I RITENTATIVI — la logica pura che decide se un video si riprova.
 *
 * Nessun doppio: sono funzioni su stringhe e numeri, e un test che passa una stringa e ne
 * guarda un'altra non può essere verde «con e senza la correzione». Ciò che conta è da dove
 * vengono le stringhe, e per questo ogni stderr dichiara la sua origine:
 *
 *  · VERI — catturati il 2026-10-02 in locale con le stesse opzioni degli script (curl 8.7.1,
 *    ffprobe 8.1.2 con `-v error`) contro un server su localhost che rispondeva 400, 403, 404,
 *    429, 500, 503, un corpo non-MP4, un corpo vuoto, un corpo troncato, una connessione chiusa
 *    senza risposta, un RST (subito e a metà corpo), un timeout di lettura, e contro una porta
 *    chiusa, un DNS che non risolve e un `https://` verso un server in chiaro. L'indirizzo è
 *    sostituito da un segnaposto riservato (`.invalid`). Dello stesso giorno, contro un server
 *    Python su 127.0.0.1, i tentativi che curl RECUPERA (un 503 o un 429 o un timeout al primo
 *    colpo e poi un 200: uscita 0, e la riga d'errore resta su stderr) e il timeout a metà corpo;
 *  · RICOSTRUITI — non catturati: l'inizio dell'output di dnf del 29/09 (nel log di allora era
 *    tagliato a 500 caratteri, ed è il motivo per cui la causa non si vedeva), le righe di
 *    sha256sum e i messaggi di glibc.
 *
 * I numeri d'uscita e le classi sono scritti LETTERALI, come nella tabella del §4.5 della spec:
 * sono l'oracolo indipendente dal codice, che invece le costanti le importa dagli script. Se
 * qualcuno rinumerasse un'uscita, è questo file a diventare rosso.
 */

const ORIGINALE = 'https://esempio.invalid/originale.mp4'

/* ── stderr di curl ──────────────────────────────────────────────────────────── */

/** VERO. Con `--retry 3 --retry-all-errors` curl ripete la stessa riga a ogni tentativo: quattro. */
const curlConStato = (stato: number): string =>
  Array.from({ length: 4 }, () => `curl: (22) The requested URL returned error: ${stato}`).join('\n')

/** UNA delle quattro righe di `curlConStato(404)`: un 404 che è UN tentativo, non l'esito finale. */
const CURL_404 = curlConStato(404).split('\n')[0]

/** VERI. */
const CURL_TIMEOUT = 'curl: (28) Operation timed out after 2011 milliseconds with 0 bytes received'
const CURL_TRONCATO = 'curl: (18) transfer closed with 99900 bytes remaining to read'
const CURL_PORTA_CHIUSA = "curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server"
const CURL_DNS = 'curl: (6) Could not resolve host: nome-che-non-esiste.invalid'
const CURL_RISPOSTA_VUOTA = 'curl: (52) Empty reply from server'
const CURL_RESET = 'curl: (56) Recv failure: Connection reset by peer'

/**
 * VERI — i tentativi che curl RECUPERA. Con `--retry 3 --retry-all-errors` curl scrive una riga
 * per OGNI tentativo fallito, anche quando quello dopo riesce: l'uscita è 0 e la riga resta su
 * stderr. Misurati il 2026-10-02 con curl 8.7.1 contro un server Python su 127.0.0.1 (nello
 * scratchpad, spento a fine misura), con le opzioni esatte dello script di preparazione:
 *
 *   curl -fsS --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60 -o /dev/null URL 2> err; echo $?
 *
 *  · un percorso che risponde 503 al primo colpo e 200 dopo → uscita 0, e `err` contiene
 *    «curl: (22) The requested URL returned error: 503»; con tre 503 e poi il 200 la riga c'è
 *    tre volte, sempre con uscita 0;
 *  · lo stesso con un 429 → uscita 0 e la riga col 429;
 *  · un percorso che al primo colpo dorme 2,5 secondi, con `--max-time 1` al posto di
 *    `--max-time 60` → uscita 0, e `err` contiene la riga del timeout coi millisecondi misurati;
 *  · la HEAD dell'apparecchio (`curl -fsSI --retry 3 --retry-all-errors`) col 503 al primo
 *    colpo → uscita 0 e la stessa riga.
 */
const CURL_503_RECUPERATO = 'curl: (22) The requested URL returned error: 503'
const CURL_503_TRE_VOLTE_RECUPERATO = [CURL_503_RECUPERATO, CURL_503_RECUPERATO, CURL_503_RECUPERATO].join('\n')
const CURL_429_RECUPERATO = 'curl: (22) The requested URL returned error: 429'
const CURL_TIMEOUT_RECUPERATO = 'curl: (28) Operation timed out after 1010 milliseconds with 0 bytes received'

/**
 * VERO — il timeout a METÀ corpo, che curl NON recupera: `--max-time 1 --retry 3
 * --retry-all-errors` contro un server che dichiara `Content-Length: 67191515`, manda 1000 byte
 * e poi tace. Uscita 28 e QUATTRO righe, una per tentativo, nel formato «with N out of M bytes
 * received» di un download che si ferma. I millisecondi sono quelli di `--max-time 1`: con
 * `--max-time 60`, come nello script, sarebbero circa 60 mila (NON misurato: la forma non cambia).
 */
const CURL_TIMEOUT_A_META_CORPO = [
  'curl: (28) Operation timed out after 1010 milliseconds with 1000 out of 67191515 bytes received',
  'curl: (28) Operation timed out after 1008 milliseconds with 1000 out of 67191515 bytes received',
  'curl: (28) Operation timed out after 1004 milliseconds with 1000 out of 67191515 bytes received',
  'curl: (28) Operation timed out after 1001 milliseconds with 1000 out of 67191515 bytes received',
].join('\n')

/**
 * VERO, ma è la vista del TERMINALE, con stdout e stderr mescolati, e NON lo stderr dell'apparecchio.
 * Misurato: `curl -fsSI URL > out 2> err` manda «HTTP/1.1 404 Not Found» e «Content-Length» su
 * STDOUT (nell'apparecchio vanno in `tr | awk`), e su stderr resta solo la prima riga. Il campione
 * resta perché la spec §4.5 vuole riconosciuta anche la riga di stato, e lo stato 404 è lo stesso.
 */
const CURL_HEAD_404 = [
  'curl: (22) The requested URL returned error: 404',
  'HTTP/1.1 404 Not Found',
  'Content-Length: 0',
].join('\n')

/** RICOSTRUITO dalla descrizione del guasto: l'inizio di dnf, poi il 404 di curl. */
const DNF_PRIMA_DEL_404 = [
  'Amazon Linux 2023 repository                    76 MB/s |  76 MB     00:01',
  'Amazon Linux 2023 Kernel Livepatch repository   18 kB/s |  16 kB     00:00',
  'Dependencies resolved.',
  '================================================================================',
  ' Package    Architecture  Version                    Repository          Size',
  '================================================================================',
  'Installing:',
  ' xz         x86_64        5.2.5-9.amzn2023.0.2       amazonlinux        308 k',
  '',
  'Transaction Summary',
  '================================================================================',
  'Install  1 Package',
  '',
  'Total download size: 308 k',
  'Installed size: 1.0 M',
  'Complete!',
].join('\n')

/* ── stderr di ffprobe ───────────────────────────────────────────────────────── */

/** VERI. */
const FFPROBE_400 = `${ORIGINALE}: Server returned 400 Bad Request`
const FFPROBE_403 = `${ORIGINALE}: Server returned 403 Forbidden (access denied)`
const FFPROBE_404 = `${ORIGINALE}: Server returned 404 Not Found`
const FFPROBE_429 = `${ORIGINALE}: Server returned 429 Too Many Requests`
/** VERO: per i 5xx ffprobe non scrive nessuna cifra. */
const FFPROBE_5XX = `${ORIGINALE}: Server returned 5XX Server Error reply`
/** VERI: lo stesso ffprobe col log di default (senza `-v error`) scrive anche la riga dello strato HTTP, con la cifra. */
const FFPROBE_LOG_DI_DEFAULT_404 = `[http @ 0x11f613720] HTTP error 404 Not Found\n${ORIGINALE}: Server returned 404 Not Found`
const FFPROBE_LOG_DI_DEFAULT_503 = `[http @ 0x135613720] HTTP error 503 Service Unavailable\n${ORIGINALE}: Server returned 5XX Server Error reply`
const FFPROBE_TRONCATO = `[http @ 0x13b6137a0] Stream ends prematurely at 100, should be 100000\n${ORIGINALE}: Input/output error`
const FFPROBE_PORTA_CHIUSA = `[tcp @ 0x12e8040e0] Connection to tcp://127.0.0.1:9 failed: Connection refused\n${ORIGINALE}: Connection refused`
const FFPROBE_DNS = `[tcp @ 0x12a7046b0] Failed to resolve hostname nome-che-non-esiste.invalid: nodename nor servname provided, or not known\n${ORIGINALE}: Input/output error`
const FFPROBE_CHIUSURA_SENZA_RISPOSTA = `[http @ 0x132004690] Error reading HTTP response: End of file\n${ORIGINALE}: End of file`
const FFPROBE_RESET_SUBITO = `[http @ 0x135e137a0] Error reading HTTP response: Connection reset by peer\n${ORIGINALE}: Connection reset by peer`
const FFPROBE_TIMEOUT_DI_LETTURA = `[http @ 0x129e137a0] Error reading HTTP response: Operation timed out\n${ORIGINALE}: Operation timed out`
const FFPROBE_TLS_VERSO_SERVER_IN_CHIARO = `[tls @ 0x159004370] error:0A00010B:SSL routines::wrong version number\n${ORIGINALE}: Input/output error`
/**
 * VERO, ed è il caso che giustifica le formule testuali: con un RST a METÀ corpo ffprobe NON
 * scrive nessuna riga firmata `[http @ …]`. C'è solo questa.
 */
const FFPROBE_RESET_NEL_CORPO = `${ORIGINALE}: Connection reset by peer`
/** VERI: il filmato è rotto (un corpo non-MP4) o vuoto. */
const FFPROBE_NON_UN_MP4 = `${ORIGINALE}: Invalid data found when processing input`

/** RICOSTRUITO: il messaggio classico di un MP4 senza la sua coda. */
const FFPROBE_SENZA_MOOV = `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d0c8a3e640] moov atom not found\n${ORIGINALE}: Invalid data found when processing input`
/** RICOSTRUITO: la stessa riga di DNS, con il testo di glibc invece di quello di macOS. */
const FFPROBE_DNS_GLIBC = `[tcp @ 0x55d0c8a3e640] Failed to resolve hostname x.invalid: Name or service not known\n${ORIGINALE}: Input/output error`
/** RICOSTRUITO: lo stderr dell'apparecchio porta anche le righe di `sha256sum -c`, che vanno su stderr. */
const SHA256_OK = [
  '/tmp/kv-ffmpeg/ffmpeg.gz: OK',
  '/tmp/kv-ffmpeg/ffprobe.gz: OK',
  '/tmp/kv-ffmpeg/ffmpeg: OK',
  '/tmp/kv-ffmpeg/ffprobe: OK',
].join('\n')

/* ────────────────────────────────────────────────────────────────────────────
 * I NUMERI
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · le costanti sono quelle decise dal titolare', () => {
  it('quattro tentativi in tutto: il primo e tre ritentativi', () => {
    expect(TENTATIVI_MASSIMI_GUASTO_NOSTRO).toBe(4)
    expect(TENTATIVI_MASSIMI_GUASTO_NOSTRO - 1).toBe(3)
  })

  it('attese di 5, 10 e 15 minuti', () => {
    expect([...ATTESE_FRA_TENTATIVI_S]).toEqual([300, 600, 900])
  })

  it('cadenza del cron di 5 minuti, finestra di un’ora', () => {
    expect(CADENZA_CRON_RUNNER_S).toBe(300)
    expect(FINESTRA_TENTATIVI_S).toBe(3600)
  })
})

describe('runner video · ritentativi · gli invarianti del bilancio dei tentativi', () => {
  const attese: number[] = [...ATTESE_FRA_TENTATIVI_S]
  const somma = attese.reduce((tot, attesa) => tot + attesa, 0)

  it('c’è un’attesa fra un tentativo e il successivo, e nessuna dopo l’ultimo', () => {
    expect(ATTESE_FRA_TENTATIVI_S.length).toBe(TENTATIVI_MASSIMI_GUASTO_NOSTRO - 1)
  })

  it('le attese crescono, una dopo l’altra', () => {
    expect(attese.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < attese.length; i++) {
      expect(attese[i], `l’attesa n. ${i + 1} non supera la precedente`).toBeGreaterThan(attese[i - 1])
    }
  })

  it('tutti i tentativi stanno nella finestra, anche slittando di una cadenza ciascuno', () => {
    const casoPeggiore = somma + TENTATIVI_MASSIMI_GUASTO_NOSTRO * CADENZA_CRON_RUNNER_S
    expect(casoPeggiore).toBeLessThanOrEqual(FINESTRA_TENTATIVI_S)
    // I numeri veri, scritti per esteso: 1800 + 4 × 300 = 3000, sotto i 3600 dell'ora.
    expect(somma).toBe(1800)
    expect(casoPeggiore).toBe(3000)
  })

  it('i numeri passano i controlli di `video_job_retry` (§4.7): massimo 1..10, attesa 1..86400', () => {
    expect(TENTATIVI_MASSIMI_GUASTO_NOSTRO).toBeGreaterThanOrEqual(1)
    expect(TENTATIVI_MASSIMI_GUASTO_NOSTRO).toBeLessThanOrEqual(10)
    for (const attesa of attese) {
      expect(Number.isInteger(attesa)).toBe(true)
      expect(attesa).toBeGreaterThanOrEqual(1)
      expect(attesa).toBeLessThanOrEqual(86_400)
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LA CADENZA, LETTA DAL CRON VERO
 *
 * Non si scrive `300` due volte e si spera che restino uguali: si legge lo schedule da
 * `20260918120000_video_runner_tick.sql`. E si legge la CHIAMATA `cron.schedule(…)`, non il
 * testo: la testata di quel file parla di cadenza a lungo, e un test che cercasse un numero
 * nel file lo troverebbe anche nei commenti.
 * ──────────────────────────────────────────────────────────────────────────── */

const MIGRAZIONE_TICK = join(process.cwd(), 'supabase/migrations/20260918120000_video_runner_tick.sql')

/** L'espressione cron di `video-runner-tick`, dalla chiamata `cron.schedule` (commenti SQL tolti). */
function scheduleDelTick(): string {
  const sql = readFileSync(MIGRAZIONE_TICK, 'utf8').replace(/--[^\n]*/g, '')
  const trovato = /cron\.schedule\(\s*'video-runner-tick'\s*,\s*'([^']+)'/.exec(sql)
  if (!trovato) {
    throw new Error('non trovo la chiamata cron.schedule di video-runner-tick: il test non può misurare la cadenza')
  }
  return trovato[1]
}

/** I minuti dell'ora in cui scatta il cron: un elenco `a,b,c` oppure un «ogni n minuti». Altro → errore. */
function minutiDelCampo(campo: string): number[] {
  if (/^\d+(?:,\d+)*$/.test(campo)) return campo.split(',').map(Number)
  const passo = /^\*\/(\d+)$/.exec(campo)
  if (passo) {
    const n = Number(passo[1])
    return Array.from({ length: Math.ceil(60 / n) }, (_, i) => i * n)
  }
  throw new Error(`campo dei minuti non riconosciuto: «${campo}». Il test lo legge solo come elenco o come passo.`)
}

describe('runner video · ritentativi · la cadenza è quella del cron vero', () => {
  const campi = scheduleDelTick().trim().split(/\s+/)

  it('lo schedule ha cinque campi e si ripete identico a ogni ora', () => {
    expect(campi).toHaveLength(5)
    // ora, giorno del mese, mese, giorno della settimana: tutti `*`, altrimenti la cadenza
    // non sarebbe la stessa a ogni ora e il conto sotto non varrebbe.
    expect(campi.slice(1)).toEqual(['*', '*', '*', '*'])
  })

  it('i giri del cron distano CADENZA_CRON_RUNNER_S, anche a cavallo dell’ora', () => {
    const minuti = minutiDelCampo(campi[0]).sort((a, b) => a - b)
    // Controllo positivo: la lettura ha trovato davvero qualcosa. Senza, «nessuna distanza
    // diversa da cinque minuti» sarebbe vero anche per un elenco vuoto.
    expect(minuti.length).toBeGreaterThanOrEqual(2)
    const distanze = minuti.map((minuto, i) =>
      i + 1 < minuti.length ? minuti[i + 1] - minuto : 60 - minuto + minuti[0],
    )
    expect([...new Set(distanze)].map((m) => m * 60)).toEqual([CADENZA_CRON_RUNNER_S])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LO STATO HTTP DENTRO LA DIAGNOSI
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · httpDallaDiagnosi', () => {
  it.each<[string, string, number | null]>([
    ['curl -f, 404 ripetuto a ogni tentativo', curlConStato(404), 404],
    ['curl -f, 403', curlConStato(403), 403],
    ['curl -f, 429', curlConStato(429), 429],
    ['curl -f, 503', curlConStato(503), 503],
    ['curl -I, vista del terminale: la riga d’errore e poi la riga di stato (su stdout, nell’apparecchio)', CURL_HEAD_404, 404],
    // RICOSTRUITO: i curl più vecchi scrivono anche il motivo dopo il numero.
    ['curl -f di una versione vecchia, col motivo dopo il numero', 'curl: (22) The requested URL returned error: 404 Not Found', 404],
    ['ffprobe, 400', FFPROBE_400, 400],
    ['ffprobe, 403', FFPROBE_403, 403],
    ['ffprobe, 404', FFPROBE_404, 404],
    ['ffprobe, 429', FFPROBE_429, 429],
    ['ffprobe col log di default, 404', FFPROBE_LOG_DI_DEFAULT_404, 404],
    ['ffprobe col log di default, 503: qui la cifra c’è, nella riga dello strato HTTP', FFPROBE_LOG_DI_DEFAULT_503, 503],
    ['una riga di stato HTTP/1.1', 'HTTP/1.1 503 Service Unavailable', 503],
    ['una riga di stato HTTP/2, senza il punto', 'HTTP/2 404', 404],
  ])('lo riconosce: %s', (_nome, diagnosi, atteso) => {
    expect(httpDallaDiagnosi(diagnosi)).toBe(atteso)
  })

  it('il 404 di curl non si perde dietro l’inizio di dnf (il guasto del 29/09)', () => {
    expect(httpDallaDiagnosi(`${DNF_PRIMA_DEL_404}\n${curlConStato(404)}`)).toBe(404)
  })

  it('i numeri che non sono uno stato HTTP non lo diventano', () => {
    // L'inizio di dnf è pieno di numeri («76 MB», «2023», «308 k»): nessuno è uno stato.
    expect(httpDallaDiagnosi(DNF_PRIMA_DEL_404)).toBeNull()
    expect(httpDallaDiagnosi('File di 404 byte, riga 503 del log, porta 500')).toBeNull()
    expect(httpDallaDiagnosi(SHA256_OK)).toBeNull()
  })

  it('un 5xx di ffprobe non ha cifre, e torna null: lo riconosce l’altra domanda, quella di rete', () => {
    expect(httpDallaDiagnosi(FFPROBE_5XX)).toBeNull()
  })

  it('i guasti che non portano uno stato HTTP tornano null', () => {
    for (const diagnosi of [
      CURL_TIMEOUT,
      CURL_TRONCATO,
      CURL_PORTA_CHIUSA,
      CURL_DNS,
      CURL_RISPOSTA_VUOTA,
      CURL_RESET,
      FFPROBE_TRONCATO,
      FFPROBE_DNS,
      FFPROBE_PORTA_CHIUSA,
      FFPROBE_CHIUSURA_SENZA_RISPOSTA,
      FFPROBE_RESET_SUBITO,
      FFPROBE_RESET_NEL_CORPO,
      FFPROBE_TIMEOUT_DI_LETTURA,
      FFPROBE_TLS_VERSO_SERVER_IN_CHIARO,
    ]) {
      expect(httpDallaDiagnosi(diagnosi), diagnosi).toBeNull()
    }
  })

  it('conta solo il 4xx e il 5xx: un 200 o un 302 non sono il guasto', () => {
    expect(httpDallaDiagnosi('HTTP/1.1 200 OK')).toBeNull()
    expect(httpDallaDiagnosi('HTTP/1.1 206 Partial Content')).toBeNull()
    expect(httpDallaDiagnosi('HTTP/1.1 302 Found')).toBeNull()
    expect(httpDallaDiagnosi(`HTTP/1.1 200 OK\n${curlConStato(404)}`)).toBe(404)
    // I confini della fascia: 399 e 600 sono fuori, 400 e 599 dentro.
    expect(httpDallaDiagnosi('curl: (22) The requested URL returned error: 399')).toBeNull()
    expect(httpDallaDiagnosi('curl: (22) The requested URL returned error: 400')).toBe(400)
    expect(httpDallaDiagnosi('curl: (22) The requested URL returned error: 599')).toBe(599)
    expect(httpDallaDiagnosi('curl: (22) The requested URL returned error: 600')).toBeNull()
  })

  it('se gli stati sono più d’uno vince l’ULTIMO nel testo, che è il verdetto finale', () => {
    expect(httpDallaDiagnosi(`${curlConStato(503)}\n${curlConStato(404)}`)).toBe(404)
    expect(httpDallaDiagnosi(`${curlConStato(404)}\n${curlConStato(503)}`)).toBe(503)
    // Anche fra forme diverse: la riga di stato che viene DOPO il «returned error» vince.
    expect(httpDallaDiagnosi('returned error: 404\nHTTP/1.1 503 Service Unavailable')).toBe(503)
  })

  it('un testo vuoto o che non è un testo non è uno stato', () => {
    expect(httpDallaDiagnosi('')).toBeNull()
    expect(httpDallaDiagnosi(undefined as unknown as string)).toBeNull()
    expect(httpDallaDiagnosi(null as unknown as string)).toBeNull()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LA CLASSE DI UN DOWNLOAD
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · classeDelDownload', () => {
  it.each<[number, ClasseGuasto]>([
    [400, 'infra-permanente'],
    [403, 'infra-permanente'],
    [404, 'infra-permanente'],
    [499, 'infra-permanente'],
    [500, 'infra-transitoria'],
    [503, 'infra-transitoria'],
    [599, 'infra-transitoria'],
    // «000» è ciò che curl scrive quando non ha ricevuto nessuna risposta.
    [0, 'infra-transitoria'],
    // I confini: 399 non è un 4xx.
    [399, 'infra-transitoria'],
  ])('lo stato HTTP %i → %s', (http, atteso) => {
    expect(classeDelDownload(http)).toBe(atteso)
  })

  it('nessuno stato (null o undefined: timeout, DNS, connessione caduta) è transitorio', () => {
    expect(classeDelDownload(null)).toBe('infra-transitoria')
    expect(classeDelDownload(undefined)).toBe('infra-transitoria')
  })

  it('uno stato che non è un intero non è un 4xx', () => {
    expect(classeDelDownload(404.5)).toBe('infra-transitoria')
    expect(classeDelDownload(Number.NaN)).toBe('infra-transitoria')
  })

  it('«NoSuchKey» dello Storage è permanente, anche senza uno stato HTTP', () => {
    expect(classeDelDownload(null, 'NoSuchKey')).toBe('infra-permanente')
    expect(classeDelDownload(undefined, 'NoSuchKey')).toBe('infra-permanente')
    expect(classeDelDownload(404, 'NoSuchKey')).toBe('infra-permanente')
  })

  it('un altro codice dello Storage, da solo, non rende permanente un guasto senza 4xx', () => {
    expect(classeDelDownload(500, 'InternalError')).toBe('infra-transitoria')
    expect(classeDelDownload(null, 'SlowDown')).toBe('infra-transitoria')
    expect(classeDelDownload(null, null)).toBe('infra-transitoria')
    expect(classeDelDownload(403, 'AccessDenied')).toBe('infra-permanente')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LE USCITE DELL'APPARECCHIO
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · i numeri d’uscita sono quelli degli script', () => {
  it('la tabella del §4.5 della spec parla delle stesse uscite che gli script producono', () => {
    expect(USCITE_PREPARAZIONE.scarico).toBe(21)
    expect(USCITE_PREPARAZIONE.impronta).toBe(22)
    expect(USCITE_PREPARAZIONE.estrazione).toBe(23)
    expect(USCITE_APPARECCHIO.dimensione).toBe(24)
    expect(USCITE_APPARECCHIO.probe).toBe(25)
    expect(USCITE_CONVERSIONE.scarico).toBe(31)
    expect(USCITE_CONVERSIONE.codifica).toBe(32)
    expect(USCITE_CONVERSIONE.probe).toBe(33)
    expect(USCITE_CONVERSIONE.caricamento).toBe(34)
  })
})

describe('runner video · ritentativi · classeDaUscitaApparecchio', () => {
  it('zero non è un guasto, e non ha una classe', () => {
    expect(classeDaUscitaApparecchio(0, '')).toBeNull()
  })

  it.each<[number]>([[1], [2], [126], [127], [137], [255]])(
    'l’uscita %i, che l’apparecchio non conosce, è transitoria: si fallisce chiusi',
    (uscita) => {
      expect(classeDaUscitaApparecchio(uscita, '')).toBe('infra-transitoria')
      // …qualunque cosa dica lo stderr: un 404 qui non rende permanente un'uscita che non
      // appartiene a nessun comando.
      expect(classeDaUscitaApparecchio(uscita, curlConStato(404))).toBe('infra-transitoria')
    },
  )

  it('le uscite della conversione (31-34), se arrivano all’apparecchio, sono «altre»: transitorie', () => {
    for (const uscita of [31, 32, 33, 34]) {
      expect(classeDaUscitaApparecchio(uscita, '')).toBe('infra-transitoria')
    }
  })

  it('22 (impronta) e 23 (estrazione) sono permanenti, e non dipendono dallo stderr', () => {
    for (const uscita of [22, 23]) {
      expect(classeDaUscitaApparecchio(uscita, '')).toBe('infra-permanente')
      expect(classeDaUscitaApparecchio(uscita, curlConStato(503))).toBe('infra-permanente')
    }
  })

  it('uno stderr che non è un testo non fa lanciare nulla: 21 e 24 sono transitorie, come con lo stderr vuoto', () => {
    for (const uscita of [21, 24]) {
      expect(classeDaUscitaApparecchio(uscita, undefined as unknown as string)).toBe('infra-transitoria')
      expect(classeDaUscitaApparecchio(uscita, null as unknown as string)).toBe('infra-transitoria')
    }
  })

  describe('21 — scarico della build (BUILD_DOWNLOAD_FAILED)', () => {
    it.each<[string, string, ClasseGuasto]>([
      ['404: la build non c’è più, come il 29/09', curlConStato(404), 'infra-permanente'],
      ['404 dietro l’inizio di dnf: il guasto vero del 29/09', `${DNF_PRIMA_DEL_404}\n${curlConStato(404)}`, 'infra-permanente'],
      ['403', curlConStato(403), 'infra-permanente'],
      ['400', curlConStato(400), 'infra-permanente'],
      ['429, che è un 4xx e quindi permanente per la regola della spec', curlConStato(429), 'infra-permanente'],
      ['500', curlConStato(500), 'infra-transitoria'],
      ['503', curlConStato(503), 'infra-transitoria'],
      ['timeout', CURL_TIMEOUT, 'infra-transitoria'],
      ['DNS che non risolve', CURL_DNS, 'infra-transitoria'],
      ['connessione rifiutata', CURL_PORTA_CHIUSA, 'infra-transitoria'],
      ['corpo interrotto a metà', CURL_TRONCATO, 'infra-transitoria'],
      ['risposta vuota del server', CURL_RISPOSTA_VUOTA, 'infra-transitoria'],
      ['connessione azzerata dal server', CURL_RESET, 'infra-transitoria'],
      ['stderr vuoto', '', 'infra-transitoria'],
      // I due curl della build condividono lo stderr: un tentativo RECUPERATO del primo .gz resta
      // scritto, e non è l'esito del secondo, che è quello che ha fatto uscire lo script con 21.
      [
        'un 429 recuperato sul primo .gz e quattro timeout sul secondo: decide il tentativo FINALE, e un timeout è transitorio',
        `${CURL_429_RECUPERATO}\n${CURL_TIMEOUT_A_META_CORPO}`,
        'infra-transitoria',
      ],
      [
        'un 503 recuperato sul primo .gz e il 404 definitivo sul secondo: decide il 404',
        `${CURL_503_RECUPERATO}\n${curlConStato(404)}`,
        'infra-permanente',
      ],
    ])('%s', (_nome, diagnosi, atteso) => {
      expect(classeDaUscitaApparecchio(21, diagnosi)).toBe(atteso)
    })
  })

  describe('24 — HEAD dell’originale (SOURCE_DOWNLOAD_FAILED): 404 permanente, il resto transitorio', () => {
    it.each<[string, string, ClasseGuasto]>([
      ['404, vista del terminale di -I (nell’apparecchio la riga di stato va su stdout)', CURL_HEAD_404, 'infra-permanente'],
      ['404 di curl -f', curlConStato(404), 'infra-permanente'],
      ['403: qui NON è permanente', curlConStato(403), 'infra-transitoria'],
      ['400', curlConStato(400), 'infra-transitoria'],
      ['503', curlConStato(503), 'infra-transitoria'],
      ['timeout', CURL_TIMEOUT, 'infra-transitoria'],
      ['connessione azzerata dal server', CURL_RESET, 'infra-transitoria'],
      ['stderr vuoto', '', 'infra-transitoria'],
      // Lo stderr dell'apparecchio porta anche le righe dei due curl della build: un 404 RECUPERATO
      // lì non è l'esito della HEAD, che è l'ultimo curl e quello che ha fatto uscire lo script.
      [
        'un 404 recuperato dal download della build e poi il timeout della HEAD: decide il tentativo FINALE',
        `${CURL_404}\n${SHA256_OK}\n${CURL_TIMEOUT}`,
        'infra-transitoria',
      ],
      [
        'un timeout recuperato dal download della build e poi il 404 definitivo della HEAD: decide il 404',
        `${CURL_TIMEOUT_RECUPERATO}\n${SHA256_OK}\n${curlConStato(404)}`,
        'infra-permanente',
      ],
    ])('%s', (_nome, diagnosi, atteso) => {
      expect(classeDaUscitaApparecchio(24, diagnosi)).toBe(atteso)
    })
  })

  describe('25 — ffprobe sull’URL (PROBE_COMMAND_FAILED): transitorio SOLO con un errore di rete o HTTP (D3)', () => {
    it.each<[string, string]>([
      ['404', FFPROBE_404],
      ['403', FFPROBE_403],
      ['400', FFPROBE_400],
      ['429', FFPROBE_429],
      ['un 5xx, che ffprobe scrive senza cifre', FFPROBE_5XX],
      ['il corpo che si interrompe', FFPROBE_TRONCATO],
      ['la connessione rifiutata', FFPROBE_PORTA_CHIUSA],
      ['la connessione chiusa senza risposta', FFPROBE_CHIUSURA_SENZA_RISPOSTA],
      ['la connessione azzerata subito', FFPROBE_RESET_SUBITO],
      ['il timeout di lettura', FFPROBE_TIMEOUT_DI_LETTURA],
      ['il TLS che fallisce', FFPROBE_TLS_VERSO_SERVER_IN_CHIARO],
      ['il DNS che non risolve (testo di macOS)', FFPROBE_DNS],
      ['il DNS che non risolve (testo di glibc)', FFPROBE_DNS_GLIBC],
      ['la rete, preceduta dalle righe di sha256sum che l’apparecchio porta su stderr', `${SHA256_OK}\n${FFPROBE_TRONCATO}`],
      ['la riga di stato HTTP', 'HTTP/1.1 503 Service Unavailable'],
    ])('con %s si ritenta', (_nome, diagnosi) => {
      expect(classeDaUscitaApparecchio(25, diagnosi)).toBe('infra-transitoria')
    })

    /**
     * La riga firmata `[tcp|tls|http|https @ …]` basta da sola: con `-v error` è già un errore, e
     * non dipende da come finisce il messaggio. Qui l'ultima riga è quella di un filmato rotto
     * («Invalid data found…»), e la firma di rete vince lo stesso. RICOSTRUITI, una riga per
     * strato: ognuno ha il suo caso, così togliere uno solo dei quattro rende rosso un test.
     */
    it.each<[string]>([['tcp'], ['tls'], ['http'], ['https']])(
      'una riga firmata dallo strato «%s» è un errore di rete anche se l’ultima riga parla d’altro',
      (strato) => {
        const diagnosi = `[${strato} @ 0x55d0c8a3e640] qualcosa è andato storto\n${FFPROBE_NON_UN_MP4}`
        expect(classeDaUscitaApparecchio(25, diagnosi)).toBe('infra-transitoria')
      },
    )

    /**
     * La riga firmata può mancare: con un RST a metà corpo ffprobe scrive solo l'ultima riga
     * (il primo caso, VERO). Per le altre formule il test prende l'ultima riga dei campioni
     * veri e la usa DA SOLA; quelle non misurate (errno di Linux, la 4XX generica) sono
     * RICOSTRUITE, e il nome lo dice.
     */
    const ultimaRiga = (testo: string): string => {
      const righe = testo.split('\n')
      return righe[righe.length - 1]
    }
    it.each<[string, string]>([
      ['Connection reset by peer (VERO: a metà corpo ffprobe non scrive altro)', FFPROBE_RESET_NEL_CORPO],
      ['Connection refused', ultimaRiga(FFPROBE_PORTA_CHIUSA)],
      ['Operation timed out', ultimaRiga(FFPROBE_TIMEOUT_DI_LETTURA)],
      ['Input/output error', ultimaRiga(FFPROBE_TRONCATO)],
      ['Connection timed out (l’errno di Linux: non misurato)', `${ORIGINALE}: Connection timed out`],
      ['Network is unreachable (non misurato)', `${ORIGINALE}: Network is unreachable`],
      ['No route to host (non misurato)', `${ORIGINALE}: No route to host`],
      ['Server returned 4XX generico (non misurato)', `${ORIGINALE}: Server returned 4XX Client Error, but not one of 40{0,1,3,4}`],
    ])('l’ultima riga da sola, senza la riga firmata, resta un errore di rete: %s', (_nome, diagnosi) => {
      expect(classeDaUscitaApparecchio(25, diagnosi)).toBe('infra-transitoria')
    })

    it.each<[string, string]>([
      ['un corpo che non è un MP4', FFPROBE_NON_UN_MP4],
      ['un MP4 senza la sua coda (moov atom not found)', FFPROBE_SENZA_MOOV],
      ['un MP4 rotto, preceduto dalle righe di sha256sum', `${SHA256_OK}\n${FFPROBE_SENZA_MOOV}`],
      ['uno stderr vuoto', ''],
      ['solo le righe di sha256sum', SHA256_OK],
    ])('con %s NON si ritenta: è un file illeggibile', (_nome, diagnosi) => {
      expect(classeDaUscitaApparecchio(25, diagnosi)).toBe('non-ritentabile')
    })

    /**
     * D3 e i curl RECUPERATI. All'uscita 25 i curl dell'apparecchio (i due .gz della build, la
     * HEAD) hanno già finito, e bene: se uno dei due della build fosse fallito lo script sarebbe
     * uscito con 21, e se fosse fallita la HEAD con 24 (salvo l'eccezione del caso a parte, qui
     * sotto). Le righe `curl: (` che restano nello stderr sono quindi tentativi RECUPERATI (VERO:
     * uscita 0 con la riga ancora lì) e non la causa; e ffprobe non scrive mai righe `curl: (`. Un
     * file illeggibile con un 503, un timeout o un reset recuperati alle spalle resta un file
     * illeggibile: non si ritenta, e all'insegnante non si dice «problema nostro» su un filmato rotto.
     */
    it.each<[string, string]>([
      ['un 503 recuperato prima, poi un corpo che non è un MP4', `${CURL_503_RECUPERATO}\n${SHA256_OK}\n${FFPROBE_NON_UN_MP4}`],
      ['un timeout recuperato prima, poi un MP4 senza la sua coda', `${CURL_TIMEOUT_RECUPERATO}\n${SHA256_OK}\n${FFPROBE_SENZA_MOOV}`],
      ['una connessione azzerata recuperata prima, poi un corpo che non è un MP4', `${CURL_RESET}\n${SHA256_OK}\n${FFPROBE_NON_UN_MP4}`],
      ['il 503 recuperato DOPO le righe di sha256sum (la HEAD), poi un corpo che non è un MP4', `${SHA256_OK}\n${CURL_503_RECUPERATO}\n${FFPROBE_NON_UN_MP4}`],
      ['un 429 recuperato prima, poi un corpo che non è un MP4', `${CURL_429_RECUPERATO}\n${SHA256_OK}\n${FFPROBE_NON_UN_MP4}`],
      [
        'tre 503 recuperati (il quarto tentativo è riuscito), poi un corpo che non è un MP4',
        `${CURL_503_TRE_VOLTE_RECUPERATO}\n${SHA256_OK}\n${FFPROBE_NON_UN_MP4}`,
      ],
      [
        // Nell'ordine dello script: i due .gz della build, le righe di sha256sum, la HEAD, ffprobe.
        'un 503 recuperato da ciascuno dei tre curl dell’apparecchio, poi un MP4 senza la sua coda',
        `${CURL_503_RECUPERATO}\n${CURL_503_RECUPERATO}\n${SHA256_OK}\n${CURL_503_RECUPERATO}\n${FFPROBE_SENZA_MOOV}`,
      ],
    ])('con %s NON si ritenta: le righe di curl sono tentativi recuperati', (_nome, diagnosi) => {
      expect(classeDaUscitaApparecchio(25, diagnosi)).toBe('non-ritentabile')
    })

    /**
     * Il contrario, perché togliere le righe di curl non diventi togliere tutto: se è ffprobe a
     * scrivere la riga di rete, la rete è caduta DOPO i curl e il guasto resta nostro.
     */
    it.each<[string, string]>([
      [
        'un 503 recuperato e poi un reset nel corpo, scritto da ffprobe',
        `${CURL_503_RECUPERATO}\n${SHA256_OK}\n${FFPROBE_RESET_NEL_CORPO}`,
      ],
      // MISURATO: con `curl -fsSI` un 404 che porta `Content-Length` scrive le intestazioni su stdout, e
      // la pipeline della HEAD (senza `pipefail`, in `script.ts`) esce 0 invece di 24, con le quattro
      // righe del 404 su stderr. Lo script prosegue e ffprobe scrive il suo 404: qui le righe di curl
      // sono la causa vera, ma tolte lo stesso, e la classe è giusta perché il segno lo porta ffprobe.
      [
        'una HEAD con un 404 che porta Content-Length (esce 0, non 24) e poi il 404 che scrive ffprobe',
        `${curlConStato(404)}\n${FFPROBE_404}`,
      ],
    ])('con %s si ritenta: la riga di rete è di ffprobe', (_nome, diagnosi) => {
      expect(classeDaUscitaApparecchio(25, diagnosi)).toBe('infra-transitoria')
    })

    it('un testo che non è un testo non è un errore di rete', () => {
      expect(classeDaUscitaApparecchio(25, undefined as unknown as string)).toBe('non-ritentabile')
    })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LE USCITE DELLA CONVERSIONE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · classeDaUscitaConversione', () => {
  it('zero non è un guasto, e non ha una classe', () => {
    expect(classeDaUscitaConversione(0, '')).toBeNull()
  })

  describe.each<[number, string]>([
    [31, 'scarico dell’originale (SOURCE_DOWNLOAD_FAILED)'],
    [34, 'caricamento dell’uscita (OUTPUT_UPLOAD_FAILED)'],
  ])('%i — %s: 404 permanente, il resto transitorio', (uscita) => {
    it.each<[string, string, ClasseGuasto]>([
      ['404', curlConStato(404), 'infra-permanente'],
      ['404 in coda al diario di una conversione', `${CURL_TIMEOUT}\n${curlConStato(404)}`, 'infra-permanente'],
      ['403: qui NON è permanente', curlConStato(403), 'infra-transitoria'],
      ['400', curlConStato(400), 'infra-transitoria'],
      ['503', curlConStato(503), 'infra-transitoria'],
      ['timeout', CURL_TIMEOUT, 'infra-transitoria'],
      ['connessione rifiutata', CURL_PORTA_CHIUSA, 'infra-transitoria'],
      ['risposta vuota del server', CURL_RISPOSTA_VUOTA, 'infra-transitoria'],
      ['diario vuoto', '', 'infra-transitoria'],
      // Il diario raccoglie anche i curl di prima (l'originale, il watermark): un 404 RECUPERATO
      // lì non è l'esito del curl che ha fatto uscire lo script, e decide l'ultima riga `curl: (`.
      [
        'un 404 recuperato e poi un timeout: decide il tentativo FINALE, e un timeout è transitorio',
        `${CURL_404}\n${CURL_TIMEOUT}`,
        'infra-transitoria',
      ],
    ])('%s', (_nome, diagnosi, atteso) => {
      expect(classeDaUscitaConversione(uscita, diagnosi)).toBe(atteso)
    })

    it('un diario che non è un testo non fa lanciare nulla: transitorio, come un diario vuoto', () => {
      expect(classeDaUscitaConversione(uscita, undefined as unknown as string)).toBe('infra-transitoria')
      expect(classeDaUscitaConversione(uscita, null as unknown as string)).toBe('infra-transitoria')
    })
  })

  it.each<[number, string]>([
    [32, 'FFmpeg uscito con errore (ENCODE_FAILED)'],
    [33, 'ffprobe sull’uscita (PROBE_COMMAND_FAILED)'],
  ])('%i — %s: non ritentabile (D3)', (uscita) => {
    expect(classeDaUscitaConversione(uscita, '')).toBe('non-ritentabile')
    // Neanche se il diario, che raccoglie anche i comandi di prima, parla di rete: il guasto è
    // di questo comando, e un 404 del download di prima non lo rende ritentabile.
    expect(classeDaUscitaConversione(uscita, `${curlConStato(404)}\n${FFPROBE_TRONCATO}`)).toBe('non-ritentabile')
  })

  it.each<[number]>([[1], [2], [126], [127], [137], [255]])(
    'l’uscita %i, che non conosciamo, è non ritentabile: al contrario dell’apparecchio, qui non si ritenta',
    (uscita) => {
      expect(classeDaUscitaConversione(uscita, '')).toBe('non-ritentabile')
      expect(classeDaUscitaConversione(uscita, curlConStato(503))).toBe('non-ritentabile')
    },
  )
})

/* ────────────────────────────────────────────────────────────────────────────
 * LA DECISIONE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · decidiRitentativo', () => {
  const INFRA: ClasseGuasto[] = ['infra-transitoria', 'infra-permanente']
  const NON_SI_RITENTA: ClasseGuasto[] = ['file', 'non-ritentabile']

  describe.each(INFRA)('la classe %s si ritenta', (classe) => {
    it.each<[number, number]>([
      [1, 300],
      [2, 600],
      [3, 900],
    ])('dopo il tentativo %i si aspettano %i secondi', (attempt, attesa) => {
      expect(decidiRitentativo(attempt, classe)).toEqual({
        ritenta: true,
        attesaSecondi: attesa,
        tentativiMassimi: 4,
      })
    })

    it.each<[number]>([[4], [5], [10], [1000]])(
      'dal tentativo %i in poi i tentativi sono esauriti',
      (attempt) => {
        expect(decidiRitentativo(attempt, classe)).toEqual({ ritenta: false, motivo: 'tentativi-esauriti' })
      },
    )

    it.each<[number]>([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
      'un attempt che non è un intero ≥ 1 (%s) non è un tentativo: non si ritenta, e non è «esauriti»',
      (attempt) => {
        expect(decidiRitentativo(attempt, classe)).toEqual({ ritenta: false, motivo: 'attempt-non-valido' })
      },
    )
  })

  describe.each(NON_SI_RITENTA)('la classe %s non si ritenta MAI', (classe) => {
    it.each<[number]>([[1], [2], [3], [4], [5], [10]])('nemmeno al tentativo %i', (attempt) => {
      expect(decidiRitentativo(attempt, classe)).toEqual({ ritenta: false, motivo: 'classe-non-ritentabile' })
    })

    it('nemmeno con un attempt senza senso: decide la classe, non il numero', () => {
      for (const attempt of [0, -1, 1.5, Number.NaN]) {
        expect(decidiRitentativo(attempt, classe)).toEqual({ ritenta: false, motivo: 'classe-non-ritentabile' })
      }
    })
  })

  it('una classe che non conosciamo non si ritenta (fallire chiusi)', () => {
    expect(decidiRitentativo(1, 'inventata' as unknown as ClasseGuasto)).toEqual({
      ritenta: false,
      motivo: 'classe-non-ritentabile',
    })
  })

  it('un guasto che non passa mai: quattro tentativi, le tre attese decise, poi basta', () => {
    for (const classe of INFRA) {
      const attese: number[] = []
      let tentativiFatti = 0
      let motivoFinale = ''
      for (let attempt = 1; attempt <= 20; attempt++) {
        tentativiFatti = attempt
        const decisione = decidiRitentativo(attempt, classe)
        if (!decisione.ritenta) {
          motivoFinale = decisione.motivo
          break
        }
        attese.push(decisione.attesaSecondi)
      }
      expect(tentativiFatti, classe).toBe(TENTATIVI_MASSIMI_GUASTO_NOSTRO)
      expect(attese, classe).toEqual([...ATTESE_FRA_TENTATIVI_S])
      expect(motivoFinale, classe).toBe('tentativi-esauriti')
    }
  })

  it('il guasto del 29/09 (la build non c’è più) oggi si ritenterebbe: 17 job su 17 non sarebbero morti al primo colpo', () => {
    const classe = classeDaUscitaApparecchio(21, `${DNF_PRIMA_DEL_404}\n${curlConStato(404)}`)
    expect(classe).toBe('infra-permanente')
    expect(decidiRitentativo(1, classe as ClasseGuasto)).toEqual({
      ritenta: true,
      attesaSecondi: 300,
      tentativiMassimi: 4,
    })
  })

  it('un file rotto, invece, non si ritenta: ffprobe che non legge il filmato resta un rifiuto', () => {
    const classe = classeDaUscitaApparecchio(25, FFPROBE_SENZA_MOOV)
    expect(classe).toBe('non-ritentabile')
    expect(decidiRitentativo(1, classe as ClasseGuasto)).toEqual({ ritenta: false, motivo: 'classe-non-ritentabile' })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * IL MODULO RESTA PURO
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · ritentativi · il modulo resta puro', () => {
  const SORGENTE = readFileSync(join(process.cwd(), 'src/lib/media/video/runner/ritentativi.ts'), 'utf8')

  /** Il codice, senza i commenti: la testata parla di rete e di log, e non deve far scattare i controlli. */
  const senzaCommenti = (sorgente: string): string =>
    sorgente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const importDi = (sorgente: string): string[] =>
    [...sorgente.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1])

  it('importa solo le costanti d’uscita dei due moduli del runner: niente SDK, niente log, niente Node', () => {
    const moduli = importDi(senzaCommenti(SORGENTE)).sort()
    // Controllo positivo: la lettura vede gli import. Senza, «nessun import vietato» sarebbe
    // vero anche se la regex non trovasse più niente.
    expect(moduli).toEqual(['./preparazione', './script'])
  })

  it('nel codice (commenti esclusi) non c’è né console, né logger, né SDK, né rete', () => {
    const codice = senzaCommenti(SORGENTE)
    // Controllo positivo: i commenti sono usciti davvero e il codice è rimasto.
    expect(codice).toContain('export function decidiRitentativo')
    expect(codice).not.toContain('LE QUATTRO CLASSI')
    for (const vietato of ['console', 'logEvento', 'logOk', 'logErrore', '@vercel/sandbox', '@supabase', 'fetch(', 'process.env']) {
      expect(codice.includes(vietato), `«${vietato}» non può comparire in un modulo puro`).toBe(false)
    }
  })

  it('la diagnosi viene letta e non esce mai: il risultato è sempre e solo una delle classi', () => {
    // Una diagnosi che porta qualcosa che non deve uscire (un indirizzo con un token, un
    // metadato di posizione): le funzioni ne ricavano una classe e nient'altro.
    const diagnosi = `${ORIGINALE}?token=NON-UN-VERO-TOKEN\ncom.apple.quicktime.location.ISO6709: +00.0000+000.0000/\n${curlConStato(404)}`
    const classi: (ClasseGuasto | null)[] = [
      classeDaUscitaApparecchio(21, diagnosi),
      classeDaUscitaApparecchio(24, diagnosi),
      classeDaUscitaApparecchio(25, diagnosi),
      classeDaUscitaConversione(31, diagnosi),
      classeDaUscitaConversione(34, diagnosi),
      classeDaUscitaConversione(32, diagnosi),
    ]
    for (const classe of classi) {
      expect(['file', 'non-ritentabile', 'infra-transitoria', 'infra-permanente']).toContain(classe)
      expect(JSON.stringify(classe)).not.toContain('TOKEN')
      expect(JSON.stringify(classe)).not.toContain('ISO6709')
    }
    expect(JSON.stringify(httpDallaDiagnosi(diagnosi))).toBe('404')
  })
})
