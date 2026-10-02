import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CARTELLA_BINARI_NELLO_SNAPSHOT, FFMPEG_SHA256, FFPROBE_SHA256 } from '@/lib/media/video/build'
import { CARTELLA_BUILD, ENV_URL_FFMPEG, ENV_URL_FFPROBE } from '@/lib/media/video/runner/preparazione'
import { classeDaUscitaApparecchio, classeDaUscitaConversione } from '@/lib/media/video/runner/ritentativi'
import {
  CARTELLA_LAVORO,
  ENV_SHA256_ATTESO,
  ENV_URL_INGRESSO,
  ENV_URL_WATERMARK,
  USCITE_APPARECCHIO,
  USCITE_CONVERSIONE,
  codiceDaUscitaApparecchio,
  codiceDaUscitaConversione,
  leggiApparecchio,
  leggiEsitoConversione,
  scriptApparecchio,
  scriptConversione,
  scriptVerificaBinari,
} from '@/lib/media/video/runner/script'

/**
 * GLI SCRIPT DELL'APPARECCHIO E DELLA CONVERSIONE, ESEGUITI DAVVERO DA `sh` — con `curl` finto.
 *
 * I test sulle stringhe provano com'è scritto uno script; questi provano che cosa FA quando una
 * shell lo interpreta. Sono due misure diverse, e la seconda è l'unica che avrebbe visto i due
 * difetti qui sotto: nascono entrambi dal COMPORTAMENTO della shell, non dal testo.
 *
 *  1. **La HEAD dell'originale** (difetto #14). Senza `pipefail` la pipeline
 *     `curl -fsSI | tr | awk | tail | grep` esce con l'esito di `grep`, e un 4xx/5xx che porta un
 *     `Content-Length` — quello del CORPO D'ERRORE — passava per la dimensione del video. Misurato
 *     il 2026-10-02 sul Sandbox vero (F1, prova P7): per un URL firmato il cui oggetto non esiste
 *     più lo Storage risponde 400 con un corpo JSON di 88 byte; lo script prendeva 88, proseguiva
 *     verso ffprobe e usciva 25 (`PROBE_COMMAND_FAILED`, non ritentabile) invece di 24
 *     (`SOURCE_DOWNLOAD_FAILED`).
 *  2. **La coda del diario nel marcatore** (difetto #8b). `tail -c 2000` taglia dove cade il byte:
 *     la prima riga di ciò che restituisce è quasi sempre MEZZA, e di una coordinata GPS tagliata a
 *     metà le regole di `diagnosi.ts` non vedono più né il nome del tag né la forma intera.
 *
 * I FINTI stanno in una cartella che è l'intero `PATH`: `curl` (che si comporta come il vero nei
 * modi che qui servono — un 4xx con le intestazioni su stdout e le righe `curl: (22)` su stderr,
 * quattro volte come con `--retry 3`), `sha256sum`, `gzip` e i due «binari» di FFmpeg. I comandi di
 * sistema che gli script usano e che non c'è niente da fingere (`awk`, `tail`, `tr`, `grep`, `wc`…)
 * sono quelli VERI della macchina. `sudo`, `dnf`, `tar`, `xz` e `wget` — ciò che lo script non deve
 * più chiamare — registrano un evento «VIETATO» ed escono 97.
 *
 * Che cosa NON si prova qui, e resta al Sandbox vero (F1 del piano): che `curl`, `sha256sum` e
 * `gzip` veri facciano ciò che i finti fanno. Per provare l'altra shell:
 * `KV_SHELL_DI_PROVA=/bin/dash npx vitest run …` — la CI è su Ubuntu, dove `/bin/sh` è dash e non
 * ha `pipefail`: è esattamente il motivo per cui la correzione non lo usa.
 */

const SHELL = process.env.KV_SHELL_DI_PROVA ?? '/bin/sh'

const URL_FFMPEG = 'https://esempio.invalid/video_build/ffmpeg.gz?token=segreto-uno'
const URL_FFPROBE = 'https://esempio.invalid/video_build/ffprobe.gz?token=segreto-due'
const URL_ORIGINALE = 'https://esempio.invalid/video_originals/originale?token=segreto-tre'

/** La riga con cui curl dice di un 404, scritta quattro volte come con `--retry 3 --retry-all-errors`. */
const CURL_404 = 'curl: (22) The requested URL returned error: 404'

/** I comandi che gli script usano e che qui NON si fingono: si prendono quelli veri della macchina. */
const COMANDI_VERI = ['awk', 'cat', 'chmod', 'grep', 'mkdir', 'mv', 'rm', 'stat', 'tail', 'tr', 'wc']

function percorsoVero(nome: string): string {
  for (const cartella of ['/usr/bin', '/bin']) {
    const percorso = join(cartella, nome)
    if (existsSync(percorso)) return percorso
  }
  throw new Error(`il comando ${nome} non c'è su questa macchina: il test non può fingere l'ambiente`)
}

const cartelle: string[] = []
afterEach(() => {
  for (const dir of cartelle.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Un ambiente isolato: i finti nel suo `bin/`, la «MicroVM» in `build/` e `lavoro/`. I percorsi
 * assoluti degli script (`/tmp/kv-ffmpeg`, `/tmp/kv-video`) si sostituiscono con questi, così il
 * test non scrive mai in `/tmp` e due test non si pestano.
 */
function ambiente(opzioni: { shaVero?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-apparecchio-shell-'))
  cartelle.push(dir)
  const binDir = join(dir, 'bin')
  const build = join(dir, 'build')
  // La cartella dei binari DELLO SNAPSHOT: vuota finché un test non ci mette i suoi finti (`mettiBinariNelloSnapshot`).
  const snapshot = join(dir, 'snapshot')
  const lavoro = join(dir, 'lavoro')
  const eventiFile = join(dir, 'eventi')
  mkdirSync(binDir)

  for (const nome of COMANDI_VERI) symlinkSync(percorsoVero(nome), join(binDir, nome))

  const comando = (nome: string, corpo: string) => {
    const file = join(binDir, nome)
    writeFileSync(file, `#!${SHELL}\n${corpo}\n`)
    chmodSync(file, 0o755)
  }

  // I due «binari» che il `gzip` finto restituisce. `ffprobe` registra di essere stato lanciato:
  // «ffprobe NON parte» è l'asserzione che vale il caso della HEAD.
  const ffmpegFinto = join(dir, 'ffmpeg-finto')
  const ffprobeFinto = join(dir, 'ffprobe-finto')
  writeFileSync(
    ffmpegFinto,
    `#!${SHELL}\necho ' .. zscale            V->V       Colorspace conversion.'\nexit 0\n`,
  )
  writeFileSync(
    ffprobeFinto,
    `#!${SHELL}
echo ffprobe >> '${eventiFile}'
if [ -n "\${KV_FINTO_FFPROBE_ESCE:-}" ]; then
  echo 'moov atom not found' >&2
  exit "\${KV_FINTO_FFPROBE_ESCE}"
fi
echo '{"streams":[{"index":0}],"format":{"format_name":"mov,mp4"}}'
`,
  )

  // `curl -fsS … -o <destinazione> <url>` (i due `.gz`) oppure `curl -fsSI … <url>` (la HEAD).
  // L'URL è l'ULTIMO argomento. La HEAD si comporta secondo `KV_FINTO_HEAD`:
  //   ok               → 200 con `Content-Length: 20000000`;
  //   errore-<stato>   → intestazioni su STDOUT con un `Content-Length` di 88 byte (il corpo
  //                      d'errore dello Storage), quattro righe `curl: (22)` su stderr, uscita 22;
  //   senza-lunghezza  → 200 senza `Content-Length`;
  //   rete-giu         → una riga su stderr, niente su stdout, uscita 56.
  comando(
    'curl',
    `destinazione=''
testa=no
precedente=''
url=''
for a in "$@"; do
  [ "$precedente" = '-o' ] && destinazione="$a"
  [ "$a" = '-fsSI' ] && testa=si
  precedente="$a"
  url="$a"
done
if [ "$testa" = si ]; then
  echo head >> '${eventiFile}'
  case "\${KV_FINTO_HEAD:-ok}" in
    ok)
      printf 'HTTP/1.1 200 OK\\r\\nContent-Type: video/mp4\\r\\nContent-Length: 20000000\\r\\n\\r\\n'
      exit 0 ;;
    errore-*)
      stato="\${KV_FINTO_HEAD#errore-}"
      printf 'HTTP/1.1 %s Errore\\r\\nContent-Type: application/json\\r\\nContent-Length: 88\\r\\n\\r\\n' "$stato"
      for i in 1 2 3 4; do echo "curl: (22) The requested URL returned error: $stato" >&2; done
      exit 22 ;;
    senza-lunghezza)
      printf 'HTTP/1.1 200 OK\\r\\nContent-Type: video/mp4\\r\\n\\r\\n'
      exit 0 ;;
    rete-giu)
      echo 'curl: (56) Recv failure: Connection reset by peer' >&2
      exit 56 ;;
  esac
fi
if [ -n "\${KV_FINTO_STDERR_FILE:-}" ]; then
  cat "$KV_FINTO_STDERR_FILE" >&2
  exit 22
fi
echo "download" >> '${eventiFile}'
printf '%s' "$url" > "$destinazione"`,
  )

  if (opzioni.shaVero) {
    // Un `sha256sum -c -` che VERIFICA davvero (legge «impronta  percorso», calcola lo SHA-256 del file, risponde `OK`
    // o `FAILED` con l'uscita 1 come il vero). Serve a provare l'ACCOPPIAMENTO impronta/file e il confronto vero, che un finto
    // che dice sempre sì non vedrebbe mai. Scritto in Node (la macchina di sviluppo è un Mac, dove `sha256sum` non c'è) e
    // chiamato da un involucro `sh`, perché un percorso di Node con spazi romperebbe uno shebang.
    const verificatore = join(dir, 'sha256sum.cjs')
    writeFileSync(
      verificatore,
      `const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs');
let fallite = 0, valide = 0;
for (const riga of readFileSync(0, 'utf8').split('\\n')) {
  const m = /^([0-9a-f]{64})  (.+)$/.exec(riga); if (!m) continue;
  valide += 1;
  let torna = false;
  try { torna = createHash('sha256').update(readFileSync(m[2])).digest('hex') === m[1]; } catch { torna = false; }
  console.log(m[2] + ': ' + (torna ? 'OK' : 'FAILED'));
  if (!torna) fallite += 1;
}
// Come GNU sha256sum: nessuna riga ben formata NON è «tutto a posto», è un errore (uscita 1).
if (valide === 0) { console.error('sha256sum: -: no properly formatted SHA256 checksum lines found'); process.exit(1); }
if (fallite > 0) { console.error('sha256sum: WARNING: ' + fallite + ' computed checksum did NOT match'); process.exit(1); }
`,
    )
    comando('sha256sum', `echo verifica-sha >> '${eventiFile}'\nexec '${process.execPath}' '${verificatore}'`)
  } else {
    comando('sha256sum', `cat > /dev/null\nexit 0`)
  }

  // `xargs` finto: nell'ambiente di prova non c'è, e la conversione ci arriva solo dopo la verifica dello `sha256`.
  // Registra di essere stato chiamato (la codifica è PARTITA) e fa fallire la codifica: l'uscita è 32.
  comando('xargs', `echo codifica >> '${eventiFile}'\nexit 99`)

  comando(
    'gzip',
    `[ "$1" = '-dc' ] || exit 64
case "$2" in
  *ffprobe.gz) cat '${ffprobeFinto}' ;;
  *) cat '${ffmpegFinto}' ;;
esac`,
  )

  // I comandi che lo script NON deve più chiamare: se partono, lo si vede.
  for (const vietato of ['sudo', 'dnf', 'tar', 'xz', 'wget']) {
    comando(vietato, `echo 'VIETATO-${vietato}' >> '${eventiFile}'\nexit 97`)
  }

  const eventi = (): string[] =>
    existsSync(eventiFile) ? readFileSync(eventiFile, 'utf8').trim().split('\n') : []

  const lanciaScript = (script: string, variabili: Record<string, string>) => {
    const esito = spawnSync(
      SHELL,
      [
        '-c',
        script
          .replaceAll(CARTELLA_BUILD, build)
          .replaceAll(CARTELLA_BINARI_NELLO_SNAPSHOT, snapshot)
          .replaceAll(CARTELLA_LAVORO, lavoro),
      ],
      {
        env: {
          PATH: binDir,
          NODE_ENV: 'test',
          [ENV_URL_FFMPEG]: URL_FFMPEG,
          [ENV_URL_FFPROBE]: URL_FFPROBE,
          [ENV_URL_INGRESSO]: URL_ORIGINALE,
          [ENV_URL_WATERMARK]: 'https://esempio.invalid/watermark.png',
          ...variabili,
        },
        encoding: 'utf8',
      },
    )
    return { stato: esito.status, stdout: esito.stdout, stderr: esito.stderr }
  }

  /** I due «binari» dentro la cartella dello snapshot, eseguibili: ciò che lo snapshot porta già. */
  const mettiBinariNelloSnapshot = () => {
    mkdirSync(snapshot, { recursive: true })
    for (const [nome, sorgente] of [
      ['ffmpeg', ffmpegFinto],
      ['ffprobe', ffprobeFinto],
    ] as const) {
      writeFileSync(join(snapshot, nome), readFileSync(sorgente))
      chmodSync(join(snapshot, nome), 0o755)
    }
  }
  /** Lo SHA-256 VERO di un file dello snapshot: l'impronta con cui uno script di prova lo verifica. */
  const improntaNelloSnapshot = (nome: 'ffmpeg' | 'ffprobe') =>
    createHash('sha256').update(readFileSync(join(snapshot, nome))).digest('hex')

  return {
    dir,
    build,
    snapshot,
    mettiBinariNelloSnapshot,
    improntaNelloSnapshot,
    lavoro,
    eventi,
    /** Gli eventi di un comando vietato: devono essere sempre zero. */
    vietati: () => eventi().filter((evento) => evento.startsWith('VIETATO-')),
    /** Lancia lo script dell'apparecchio. */
    apparecchio: (variabili: Record<string, string> = {}) => lanciaScript(scriptApparecchio(), variabili),
    /**
     * Lancia l'apparecchio di una MicroVM nata dallo SNAPSHOT (`binariGiaPresenti`), con le impronte dei binari sostituite da quelle
     * dei finti (`impronte`): le costanti di `build.ts` sono quelle dei binari VERI, che qui non ci sono.
     */
    apparecchioSnapshot: (
      variabili: Record<string, string> = {},
      impronte: { ffmpeg: string; ffprobe: string } | null = null,
    ) => {
      let script = scriptApparecchio({ cartella: CARTELLA_BINARI_NELLO_SNAPSHOT, binariGiaPresenti: true })
      if (impronte) script = script.replaceAll(FFMPEG_SHA256, impronte.ffmpeg).replaceAll(FFPROBE_SHA256, impronte.ffprobe)
      return lanciaScript(script, variabili)
    },
    /** Lancia la sola verifica dei binari dello snapshot (come l'apparecchio la comincia). */
    verificaSnapshot: (impronte: { ffmpeg: string; ffprobe: string } | null = null) => {
      let script = scriptVerificaBinari(CARTELLA_BINARI_NELLO_SNAPSHOT)
      if (impronte) script = script.replaceAll(FFMPEG_SHA256, impronte.ffmpeg).replaceAll(FFPROBE_SHA256, impronte.ffprobe)
      return lanciaScript(script, {})
    },
    /** Lancia la conversione di un job con lo `sha256` dichiarato, con un curl che SCARICA (scrive l'URL nel file) e il `sha256sum` che verifica davvero. */
    conversioneConSha: (sha256Atteso: string, opzioni: { conWatermark?: boolean } = {}) => {
      const esito = lanciaScript(
        scriptConversione({
          conWatermark: opzioni.conWatermark ?? false,
          videoIndex: 0,
          audioIndex: null,
          sourceFps: 30,
          verificaSha256: true,
        }),
        { [ENV_SHA256_ATTESO]: sha256Atteso },
      )
      const marcatore = join(lavoro, 'esito.txt')
      return {
        stato: esito.stato,
        marcatoreScritto: existsSync(marcatore),
        letto: leggiEsitoConversione(existsSync(marcatore) ? readFileSync(marcatore, 'utf8') : ''),
      }
    },
    /**
     * Lancia lo script della conversione con un `curl` che FALLISCE subito (uscita 22 → lo script
     * esce 31) scrivendo su stderr `diario`: è ciò che finisce nel diario della MicroVM, e il
     * `trap … EXIT` scrive il marcatore comunque. Restituisce il marcatore già letto.
     */
    conversioneConDiario: (diario: string) => {
      const file = join(dir, 'stderr-di-curl')
      writeFileSync(file, diario)
      const esito = lanciaScript(
        scriptConversione({ conWatermark: false, videoIndex: 0, audioIndex: null, sourceFps: 30 }),
        { KV_FINTO_STDERR_FILE: file },
      )
      const marcatore = join(lavoro, 'esito.txt')
      return {
        stato: esito.stato,
        marcatoreScritto: existsSync(marcatore),
        letto: leggiEsitoConversione(existsSync(marcatore) ? readFileSync(marcatore, 'utf8') : ''),
      }
    },
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. LA HEAD DELL'ORIGINALE
 * ════════════════════════════════════════════════════════════════════════════ */

describe('apparecchio · la HEAD dell’originale, eseguita da sh con un curl finto', () => {
  it('percorso felice: legge la dimensione dalla HEAD, poi lancia ffprobe', () => {
    const qa = ambiente()
    const esito = qa.apparecchio()

    expect(esito.stato).toBe(0)
    const letto = leggiApparecchio(esito.stdout)
    expect(letto.byte).toBe(20_000_000)
    expect(JSON.parse(letto.probeGrezzo).format.format_name).toBe('mov,mp4')
    // La dimensione prima, ffprobe dopo: la HEAD non è saltata e ffprobe è partito.
    expect(qa.eventi().slice(-2)).toEqual(['head', 'ffprobe'])
    expect(qa.vietati()).toEqual([])
  })

  describe('un 4xx o un 5xx con un Content-Length (il difetto #14, prova P7)', () => {
    it('400 con 88 byte di corpo d’errore: esce 24, NON lancia ffprobe e non scambia 88 per la dimensione', () => {
      const qa = ambiente()
      const esito = qa.apparecchio({ KV_FINTO_HEAD: 'errore-400' })

      // ⚠️ L'asserzione che vale il caso. Senza la correzione la pipeline stampa `88`, esce 0 e lo
      // script prosegue: ffprobe parte, e l'uscita è quella di ffprobe (25, non ritentabile).
      expect(esito.stato).toBe(USCITE_APPARECCHIO.dimensione)
      expect(codiceDaUscitaApparecchio(esito.stato as number)).toBe('SOURCE_DOWNLOAD_FAILED')
      expect(qa.eventi()).not.toContain('ffprobe')
      // Né la sezione del probe, né il 88 nella sezione della dimensione: niente di ciò che segue la HEAD.
      expect(esito.stdout).not.toContain('===PROBE===')
      expect(leggiApparecchio(esito.stdout).byte).toBeNull()
      expect(esito.stdout).not.toMatch(/^88$/m)
      // Il motivo del guasto sta nello stderr, che è ciò che il log conserva.
      expect(esito.stderr).toContain('returned error: 400')
      expect(qa.vietati()).toEqual([])
    })

    it.each<[string, number, 'infra-permanente' | 'infra-transitoria']>([
      // La tabella del §4.5: 404 permanente, tutto il resto transitorio. Un oggetto sparito dopo
      // la firma risponde 400 (misurato) e dunque si ritenta: la firma del tentativo dopo lo dirà.
      ['400, come risponde lo Storage a un oggetto che non esiste più', 400, 'infra-transitoria'],
      ['404', 404, 'infra-permanente'],
      ['403', 403, 'infra-transitoria'],
      ['503', 503, 'infra-transitoria'],
    ])('%s: esce 24 e la sua classe è quella della tabella', (_nome, stato, classe) => {
      const qa = ambiente()
      const esito = qa.apparecchio({ KV_FINTO_HEAD: `errore-${stato}` })

      expect(esito.stato).toBe(24)
      expect(qa.eventi()).not.toContain('ffprobe')
      // La classe si ricava dallo stderr VERO che lo script ha prodotto, non da una stringa scritta a mano.
      expect(classeDaUscitaApparecchio(esito.stato as number, esito.stderr)).toBe(classe)
    })
  })

  it('curl che riesce ma una risposta senza Content-Length: esce 24, e ffprobe non parte', () => {
    const qa = ambiente()
    const esito = qa.apparecchio({ KV_FINTO_HEAD: 'senza-lunghezza' })

    // Una dimensione che non si conosce non si inventa: `parseVideoProbe` la usa per decidere se il
    // file è troppo grande, e «non lo so» non è «sta sotto il limite».
    expect(esito.stato).toBe(24)
    expect(qa.eventi()).not.toContain('ffprobe')
    expect(leggiApparecchio(esito.stdout).byte).toBeNull()
  })

  it('curl che esce con un errore di rete e non scrive niente su stdout: esce 24', () => {
    const qa = ambiente()
    const esito = qa.apparecchio({ KV_FINTO_HEAD: 'rete-giu' })

    expect(esito.stato).toBe(24)
    expect(qa.eventi()).not.toContain('ffprobe')
    expect(esito.stderr).toContain('Connection reset by peer')
    expect(classeDaUscitaApparecchio(24, esito.stderr)).toBe('infra-transitoria')
  })

  it('ffprobe che non legge il file: esce 25, con la dimensione già letta (la HEAD è andata bene)', () => {
    const qa = ambiente()
    const esito = qa.apparecchio({ KV_FINTO_FFPROBE_ESCE: '1' })

    // La correzione non sposta il confine fra i due modi di fallire: se la HEAD va bene e ffprobe no,
    // resta 25 (`PROBE_COMMAND_FAILED`), e senza segni di rete è un file illeggibile: non si ritenta.
    expect(esito.stato).toBe(USCITE_APPARECCHIO.probe)
    expect(codiceDaUscitaApparecchio(esito.stato as number)).toBe('PROBE_COMMAND_FAILED')
    expect(leggiApparecchio(esito.stdout).byte).toBe(20_000_000)
    expect(qa.eventi().slice(-2)).toEqual(['head', 'ffprobe'])
    expect(classeDaUscitaApparecchio(esito.stato as number, esito.stderr)).toBe('non-ritentabile')
  })

  it('sudo, dnf, tar, xz e wget non compaiono mai, in nessuno dei modi di finire', () => {
    const scenari: Record<string, string>[] = [
      {},
      { KV_FINTO_HEAD: 'errore-400' },
      { KV_FINTO_HEAD: 'senza-lunghezza' },
      { KV_FINTO_HEAD: 'rete-giu' },
      { KV_FINTO_FFPROBE_ESCE: '1' },
    ]
    for (const variabili of scenari) {
      const qa = ambiente()
      qa.apparecchio(variabili)
      expect(qa.vietati(), `scenario ${JSON.stringify(variabili)}`).toEqual([])
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. LA CODA DEL DIARIO NEL MARCATORE
 * ════════════════════════════════════════════════════════════════════════════ */

/** Una riga del diario lunga esattamente `byte` byte, fine riga compreso, con il numero in testa. */
function rigaDelDiario(numero: number, byte: number): string {
  return `riga-${String(numero).padStart(4, '0')}-`.padEnd(byte - 1, 'x')
}

/** Una riga intera, com'è scritta da `rigaDelDiario`, oppure la riga di curl. Una riga a metà non lo è. */
const RIGA_INTERA = /^(riga-\d{4}-x+|curl: \(22\) The requested URL returned error: 404)$/

describe('conversione · la coda del diario nel marcatore, scritta dal trap con una shell vera', () => {
  it('il marcatore compare comunque, e il guasto è quello dello scarico (31) con la sua classe', () => {
    const qa = ambiente()
    const { stato, marcatoreScritto, letto } = qa.conversioneConDiario(`${CURL_404}\n`)

    expect(stato).toBe(USCITE_CONVERSIONE.scarico)
    expect(marcatoreScritto).toBe(true)
    expect(letto.uscita).toBe(31)
    expect(codiceDaUscitaConversione(letto.uscita)).toBe('SOURCE_DOWNLOAD_FAILED')
    expect(letto.diagnosi).toBe(CURL_404)
    expect(classeDaUscitaConversione(letto.uscita, letto.diagnosi)).toBe('infra-permanente')
  })

  it('un diario di più di 2000 byte: la prima riga, che il taglio lascia a METÀ, si butta', () => {
    const qa = ambiente()
    // 60 righe da 60 byte e la riga di curl: 3649 byte. La finestra di 2000 byte comincia al byte
    // 1649, cioè 29 byte dentro la 28ª riga: la prima riga di `tail -c 2000` è un pezzo di riga.
    const diario = `${Array.from({ length: 60 }, (_, i) => rigaDelDiario(i + 1, 60)).join('\n')}\n${CURL_404}\n`
    expect(Buffer.byteLength(diario)).toBeGreaterThan(3600)

    const { letto } = qa.conversioneConDiario(diario)
    const righe = letto.diagnosi.split('\n')

    // Ogni riga che arriva è una riga INTERA: con un `tail -c 2000` nudo la prima sarebbe un
    // pezzo di `xxxxxxxx`, e di una coordinata GPS tagliata così resterebbe un frammento che nessuna
    // regola di `diagnosi.ts` sa più riconoscere.
    for (const riga of righe) expect(riga).toMatch(RIGA_INTERA)
    expect(righe[righe.length - 1]).toBe(CURL_404)
    // E non si butta più del necessario: la prima riga che resta è la prima intera dopo il taglio.
    expect(righe[0]).toBe(rigaDelDiario(29, 60))
    // Il diario intero NON arriva: sta entro 2000 byte.
    expect(Buffer.byteLength(letto.diagnosi)).toBeLessThanOrEqual(2000)
  })

  it('un diario corto arriva INTERO: la sua prima riga è una riga vera, e non si butta', () => {
    const qa = ambiente()
    const righe = [rigaDelDiario(1, 60), rigaDelDiario(2, 60), rigaDelDiario(3, 60), CURL_404]
    const { letto } = qa.conversioneConDiario(`${righe.join('\n')}\n`)

    // La prima riga di un diario che entra tutto è spesso la più informativa: buttarla sempre,
    // come farebbe un `tail -n +2` nudo, vorrebbe dire perdere il dato proprio quando c'è tutto.
    expect(letto.diagnosi.split('\n')).toEqual(righe)
  })

  describe('il confine dei 2000 byte', () => {
    // 40 righe da 50 byte = 2000 byte esatti: `tail -c 2000` non taglia niente.
    const righe2000 = Array.from({ length: 40 }, (_, i) => rigaDelDiario(i + 1, 50))

    it('2000 byte esatti: non c’è stato nessun taglio, la prima riga resta', () => {
      const qa = ambiente()
      const diario = `${righe2000.join('\n')}\n`
      expect(Buffer.byteLength(diario)).toBe(2000)

      const { letto } = qa.conversioneConDiario(diario)
      expect(letto.diagnosi.split('\n')).toEqual(righe2000)
    })

    it('2001 byte: il taglio c’è stato (un byte), e la prima riga — ormai monca — si butta', () => {
      const qa = ambiente()
      const piuUno = [`${righe2000[0]}y`, ...righe2000.slice(1)]
      const diario = `${piuUno.join('\n')}\n`
      expect(Buffer.byteLength(diario)).toBe(2001)

      const { letto } = qa.conversioneConDiario(diario)
      expect(letto.diagnosi.split('\n')).toEqual(righe2000.slice(1))
    })
  })

  it('un diario che è UN rigo solo, più lungo di 2000 byte: se ne tiene la fine, invece di non scrivere niente', () => {
    const qa = ambiente()
    const { letto } = qa.conversioneConDiario(`${'z'.repeat(3000)}\n`)

    // Buttare la «prima riga» qui vorrebbe dire buttare tutto. Di un errore illeggibile resta
    // almeno la fine, che è la parte che serve.
    expect(letto.diagnosi).toBe('z'.repeat(1999))
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. I BINARI DELLO SNAPSHOT: si VERIFICANO, non si scaricano (T8, spec §10.1)
 *
 * Con `sha256sum` che verifica DAVVERO (non uno che dice sempre sì) e le impronte dello script sostituite
 * da quelle dei finti: è l'unico modo di provare, con una shell vera, che ogni impronta è accoppiata al SUO file e che
 * un binario toccato dopo la costruzione dello snapshot non passa.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('snapshot · la verifica dei binari, eseguita da sh', () => {
  /** Lo scenario: i due finti dentro lo snapshot, e le loro impronte vere. */
  function conBinari() {
    const qa = ambiente({ shaVero: true })
    qa.mettiBinariNelloSnapshot()
    const impronte = { ffmpeg: qa.improntaNelloSnapshot('ffmpeg'), ffprobe: qa.improntaNelloSnapshot('ffprobe') }
    // I due finti sono contenuti DIVERSI: se non lo fossero, uno scambio fra le impronte passerebbe inosservato.
    expect(impronte.ffmpeg).not.toBe(impronte.ffprobe)
    return { qa, impronte }
  }

  it('i binari ci sono e le impronte tornano: uscita 0, e NESSUN comando di rete o di decompressione', () => {
    const { qa, impronte } = conBinari()
    const esito = qa.verificaSnapshot(impronte)

    expect(esito.stato).toBe(0)
    expect(qa.eventi()).toEqual(['verifica-sha'])
    expect(qa.vietati()).toEqual([])
    // `>&2`: le righe «OK» di `sha256sum` non sporcano lo stdout.
    expect(esito.stdout).toBe('')
  })

  it('un’impronta che NON torna: uscita 26, e la riga `FAILED` — con il file giusto — arriva nella diagnosi', () => {
    const { qa, impronte } = conBinari()
    // Si tocca il binario DOPO che le impronte sono state prese: è la sostituzione che la verifica esiste per vedere.
    writeFileSync(join(qa.snapshot, 'ffprobe'), '#!/bin/sh\necho binario-sostituito\n')
    chmodSync(join(qa.snapshot, 'ffprobe'), 0o755)

    const esito = qa.verificaSnapshot(impronte)

    expect(esito.stato).toBe(USCITE_APPARECCHIO.binari)
    expect(codiceDaUscitaApparecchio(esito.stato as number)).toBe('BUILD_HASH_MISMATCH')
    expect(esito.stderr).toContain(`${qa.snapshot}/ffprobe: FAILED`)
    // L'altro binario torna, e si legge anche questo: la diagnosi dice QUALE dei due non va.
    expect(esito.stderr).toContain(`${qa.snapshot}/ffmpeg: OK`)
  })

  it('le impronte sono accoppiate al file giusto: scambiarle fa fallire ENTRAMBI (non solo uno)', () => {
    const { qa, impronte } = conBinari()
    const esito = qa.verificaSnapshot({ ffmpeg: impronte.ffprobe, ffprobe: impronte.ffmpeg })

    expect(esito.stato).toBe(USCITE_APPARECCHIO.binari)
    expect(esito.stderr).toContain(`${qa.snapshot}/ffmpeg: FAILED`)
    expect(esito.stderr).toContain(`${qa.snapshot}/ffprobe: FAILED`)
  })

  it.each<['ffmpeg' | 'ffprobe']>([['ffmpeg'], ['ffprobe']])(
    'il file %s MANCA: uscita 26 SENZA nemmeno chiamare `sha256sum` (un’assenza dice «manca», non «No such file»)',
    (quale) => {
      const { qa, impronte } = conBinari()
      rmSync(join(qa.snapshot, quale))

      const esito = qa.verificaSnapshot(impronte)

      expect(esito.stato).toBe(USCITE_APPARECCHIO.binari)
      expect(qa.eventi(), 'sha256sum non deve partire').toEqual([])
    },
  )

  it('un binario che c’è ma NON è eseguibile (volume `noexec`, permessi persi): uscita 26', () => {
    const { qa, impronte } = conBinari()
    chmodSync(join(qa.snapshot, 'ffmpeg'), 0o644)

    expect(qa.verificaSnapshot(impronte).stato).toBe(USCITE_APPARECCHIO.binari)
  })

  it('la cartella dello snapshot non esiste: uscita 26 (lo snapshot non è quello che doveva essere)', () => {
    const qa = ambiente({ shaVero: true })
    expect(qa.verificaSnapshot().stato).toBe(USCITE_APPARECCHIO.binari)
  })
})

describe('snapshot · l’apparecchio completo con i binari già presenti, eseguito da sh', () => {
  function conBinari() {
    const qa = ambiente({ shaVero: true })
    qa.mettiBinariNelloSnapshot()
    return { qa, impronte: { ffmpeg: qa.improntaNelloSnapshot('ffmpeg'), ffprobe: qa.improntaNelloSnapshot('ffprobe') } }
  }

  it('percorso felice: verifica, inventario, HEAD, probe — e NESSUN download della build, nessuna decompressione', () => {
    const { qa, impronte } = conBinari()
    const esito = qa.apparecchioSnapshot({}, impronte)

    expect(esito.stato).toBe(0)
    // Gli eventi, nell'ordine: la verifica delle impronte, la HEAD, ffprobe. Niente `download`, niente `gunzip`, niente `chmod`.
    expect(qa.eventi()).toEqual(['verifica-sha', 'head', 'ffprobe'])
    expect(qa.vietati()).toEqual([])
    const letto = leggiApparecchio(esito.stdout)
    expect(letto.byte).toBe(20_000_000)
    expect(letto.inventario.filtri.has('zscale')).toBe(true)
    expect(JSON.parse(letto.probeGrezzo).format.format_name).toBe('mov,mp4')
  })

  it('non ha bisogno degli URL della build: senza `KV_URL_FFMPEG` e `KV_URL_FFPROBE` parte lo stesso (lo script della PR 1 si fermerebbe)', () => {
    const { qa, impronte } = conBinari()
    // Le due variabili tolte dall'ambiente: lo snapshot esiste perché a runtime il bucket non serva.
    const esito = qa.apparecchioSnapshot({ [ENV_URL_FFMPEG]: '', [ENV_URL_FFPROBE]: '' }, impronte)
    expect(esito.stato).toBe(0)

    // …mentre quello della PR 1, senza, si ferma PRIMA del primo comando (`${KV_URL_FFMPEG:?}`): è la differenza che si compra.
    const dellaPr1 = ambiente().apparecchio({ [ENV_URL_FFMPEG]: '', [ENV_URL_FFPROBE]: '' })
    expect(dellaPr1.stato).not.toBe(0)
  })

  it('un binario sostituito: esce 26 PRIMA della HEAD e del probe (nessun comando ha toccato né i binari né l’originale)', () => {
    const { qa, impronte } = conBinari()
    writeFileSync(join(qa.snapshot, 'ffmpeg'), '#!/bin/sh\necho altro\n')
    chmodSync(join(qa.snapshot, 'ffmpeg'), 0o755)

    const esito = qa.apparecchioSnapshot({}, impronte)

    expect(esito.stato).toBe(USCITE_APPARECCHIO.binari)
    expect(qa.eventi()).toEqual(['verifica-sha'])
    expect(esito.stdout).not.toContain('===INVENTARIO===')
    expect(esito.stderr).toContain('FAILED')
  })

  it('le uscite che seguono la verifica sono quelle di sempre: la HEAD che dà 404 esce 24, e ffprobe non parte', () => {
    const { qa, impronte } = conBinari()
    const esito = qa.apparecchioSnapshot({ KV_FINTO_HEAD: 'errore-404' }, impronte)

    expect(esito.stato).toBe(USCITE_APPARECCHIO.dimensione)
    expect(qa.eventi()).not.toContain('ffprobe')
    expect(classeDaUscitaApparecchio(esito.stato as number, esito.stderr)).toBe('infra-permanente')
  })

  it('i `curl` e i `gzip` dello script della PR 1 NON compaiono mai fra gli eventi, in nessun modo di finire', () => {
    const scenari: Record<string, string>[] = [{}, { KV_FINTO_HEAD: 'errore-400' }, { KV_FINTO_FFPROBE_ESCE: '1' }]
    for (const variabili of scenari) {
      const { qa, impronte } = conBinari()
      qa.apparecchioSnapshot(variabili, impronte)
      expect(qa.eventi().filter((e) => e === 'download' || e.startsWith('gunzip')), JSON.stringify(variabili)).toEqual([])
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. LO `sha256` DICHIARATO, DENTRO LA CONVERSIONE (T8, spec §10.4)
 *
 * `curl` finto SCARICA (scrive l'URL nel file `ingresso`) e `sha256sum` verifica davvero: l'impronta vera dell'originale è
 * quella di quella stringa. Con la corrispondente la conversione prosegue (fino alla codifica, che il finto fa fallire: uscita
 * 32); con una diversa esce 35 PRIMA di ogni altra cosa — e il marcatore si scrive comunque.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('conversione · lo `sha256` dichiarato si verifica dopo lo scarico e prima di convertire, con una shell vera', () => {
  /** Lo SHA-256 dell'«originale» che il `curl` finto scarica: l'URL, scritto nel file. */
  const IMPRONTA_DELL_ORIGINALE = createHash('sha256').update(URL_ORIGINALE).digest('hex')
  const IMPRONTA_DIVERSA = createHash('sha256').update('un altro contenuto').digest('hex')

  it('l’impronta TORNA: la conversione prosegue — la codifica PARTE (il finto la fa fallire con 32)', () => {
    const qa = ambiente({ shaVero: true })
    const { stato, marcatoreScritto, letto } = qa.conversioneConSha(IMPRONTA_DELL_ORIGINALE)

    expect(qa.eventi()).toEqual(['download', 'verifica-sha', 'codifica'])
    expect(stato).toBe(USCITE_CONVERSIONE.codifica)
    expect(marcatoreScritto).toBe(true)
    expect(letto.uscita).toBe(32)
    expect(codiceDaUscitaConversione(letto.uscita)).toBe('ENCODE_FAILED')
  })

  it('l’impronta NON torna: esce 35 DOPO lo scarico e PRIMA di tutto il resto — la codifica non parte', () => {
    const qa = ambiente({ shaVero: true })
    const { stato, marcatoreScritto, letto } = qa.conversioneConSha(IMPRONTA_DIVERSA)

    expect(stato).toBe(USCITE_CONVERSIONE.impronta)
    // Lo scarico c'è stato, la verifica pure, e NIENTE dopo: né la codifica né il resto.
    expect(qa.eventi()).toEqual(['download', 'verifica-sha'])
    expect(qa.eventi()).not.toContain('codifica')
    // Il marcatore si scrive comunque (`trap … EXIT`): senza, la sorveglianza girerebbe fino al tetto su un job già morto.
    expect(marcatoreScritto).toBe(true)
    expect(letto.uscita).toBe(35)
    expect(codiceDaUscitaConversione(letto.uscita)).toBe('ORIGINALE_DIVERSO')
    // `file`: rifiutato e mai ritentato. E il diario porta la riga `FAILED` di `sha256sum` (la prova del fatto).
    expect(classeDaUscitaConversione(letto.uscita, letto.diagnosi)).toBe('file')
    expect(letto.diagnosi).toContain('FAILED')
  })

  it('il diario NON porta l’impronta attesa né quella calcolata: `sha256sum -c` scrive solo `<file>: FAILED`', () => {
    const qa = ambiente({ shaVero: true })
    const { letto } = qa.conversioneConSha(IMPRONTA_DIVERSA)

    expect(letto.diagnosi).not.toContain(IMPRONTA_DIVERSA)
    expect(letto.diagnosi).not.toContain(IMPRONTA_DELL_ORIGINALE)
  })

  it('con il watermark la verifica sta comunque PRIMA: un originale diverso non scarica nemmeno il watermark', () => {
    const qa = ambiente({ shaVero: true })
    qa.conversioneConSha(IMPRONTA_DIVERSA, { conWatermark: true })

    // Un solo `download` (l'originale): il watermark non è stato richiesto.
    expect(qa.eventi().filter((e) => e === 'download')).toHaveLength(1)
    expect(qa.eventi()).not.toContain('codifica')
  })

  it.each([
    ['vuota', ''],
    ['non esadecimale', 'z'.repeat(64)],
    ['troppo corta', 'ab12'],
  ])('un valore atteso %s (un difetto nostro: il chiamante passa sempre 64 cifre) esce comunque 35 e non converte', (_nome, valore) => {
    // Fail-closed anche qui: `sha256sum -c` non trova una riga ben formata e fallisce, quindi lo script non prosegue.
    const qa = ambiente({ shaVero: true })
    const { stato } = qa.conversioneConSha(valore)

    expect(stato).toBe(USCITE_CONVERSIONE.impronta)
    expect(qa.eventi()).not.toContain('codifica')
  })

  it('senza `verificaSha256` il passo non c’è: nessun `sha256sum` e la codifica parte subito dopo lo scarico', () => {
    const qa = ambiente({ shaVero: true })
    const marcatore = join(qa.lavoro, 'esito.txt')
    const esito = qa.conversioneConDiario === undefined ? null : null
    expect(esito).toBeNull()
    // Si lancia la conversione di sempre con un `curl` che scarica: eventi `download`, `codifica` e nessuna `verifica-sha`.
    const lancia = (script: string) =>
      spawnSync(SHELL, ['-c', script.replaceAll(CARTELLA_BUILD, qa.build).replaceAll(CARTELLA_LAVORO, qa.lavoro)], {
        env: { PATH: join(qa.dir, 'bin'), NODE_ENV: 'test', [ENV_URL_INGRESSO]: URL_ORIGINALE },
        encoding: 'utf8',
      })
    lancia(scriptConversione({ conWatermark: false, videoIndex: 0, audioIndex: null, sourceFps: 30 }))

    expect(qa.eventi()).toEqual(['download', 'codifica'])
    expect(existsSync(marcatore)).toBe(true)
  })
})
