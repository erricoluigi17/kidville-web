import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CARTELLA_BUILD, ENV_URL_FFMPEG, ENV_URL_FFPROBE } from '@/lib/media/video/runner/preparazione'
import { classeDaUscitaApparecchio, classeDaUscitaConversione } from '@/lib/media/video/runner/ritentativi'
import {
  CARTELLA_LAVORO,
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
function ambiente() {
  const dir = mkdtempSync(join(tmpdir(), 'kv-apparecchio-shell-'))
  cartelle.push(dir)
  const binDir = join(dir, 'bin')
  const build = join(dir, 'build')
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

  comando('sha256sum', `cat > /dev/null\nexit 0`)

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
      ['-c', script.replaceAll(CARTELLA_BUILD, build).replaceAll(CARTELLA_LAVORO, lavoro)],
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

  return {
    dir,
    lavoro,
    eventi,
    /** Gli eventi di un comando vietato: devono essere sempre zero. */
    vietati: () => eventi().filter((evento) => evento.startsWith('VIETATO-')),
    /** Lancia lo script dell'apparecchio. */
    apparecchio: (variabili: Record<string, string> = {}) => lanciaScript(scriptApparecchio(), variabili),
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
