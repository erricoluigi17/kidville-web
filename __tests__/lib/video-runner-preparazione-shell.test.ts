import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CARTELLA_BINARI_NELLO_SNAPSHOT,
  FFMPEG_GZ_SHA256,
  FFMPEG_SHA256,
  FFPROBE_GZ_SHA256,
  FFPROBE_SHA256,
} from '@/lib/media/video/build'
import {
  CARTELLA_BUILD,
  ENV_URL_FFMPEG,
  ENV_URL_FFPROBE,
  codiceDaUscitaPreparazione,
  scriptPreparazioneBuild,
  USCITE_PREPARAZIONE,
} from '@/lib/media/video/runner/preparazione'

/**
 * LO SCRIPT DI PREPARAZIONE, ESEGUITO DAVVERO DA `sh` — con i comandi di rete finti.
 *
 * Il test sulle stringhe (`video-runner-preparazione.test.ts`) prova com'è scritto lo
 * script; questo prova che cosa FA quando una shell lo interpreta: in che ordine
 * partono i comandi, quale uscita lascia ogni modo di fallire, che cosa NON parte
 * dopo un guasto. Sono due misure diverse, e la seconda è quella che manca a un test
 * che legge soltanto testo.
 *
 * I FINTI sono in una cartella che è l'intero `PATH`: `curl`, `sha256sum`, `gzip`,
 * `chmod` registrano ciò che gli viene chiesto in un file di eventi, e `sudo`, `dnf`,
 * `tar`, `xz`, `wget` — i comandi che lo script NON deve più chiamare — registrano un
 * evento «VIETATO» ed escono 97. Il `curl` finto scrive nel file la propria URL, e il
 * `gzip` finto la restituisce: così il contenuto del binario finale dice quale URL è
 * finito in quale file, e uno scambio fra i due download non può passare inosservato.
 *
 * Che cosa NON si prova qui, e resta al Sandbox vero: che `curl`, `sha256sum` e `gzip`
 * veri si comportino come i finti. Quella misura si fa con una MicroVM `node22`, prima
 * del merge (F1 del piano della PR 1).
 */

const URL_FFMPEG = 'https://esempio.invalid/video_build/ffmpeg.gz?token=segreto-uno'
const URL_FFPROBE = 'https://esempio.invalid/video_build/ffprobe.gz?token=segreto-due'

/**
 * La shell che interpreta lo script. `/bin/sh` è bash in modalità POSIX su macOS e dash su
 * Ubuntu (la CI): le due si comportano uguale su ciò che lo script usa, ma non sulle uscite
 * di `${VAR:?}` (1 con bash, 2 con dash), ed è esattamente la differenza che un test scritto
 * su un Mac non vede. Per provare l'altra: `KV_SHELL_DI_PROVA=/bin/dash npx vitest run …`.
 */
const SHELL = process.env.KV_SHELL_DI_PROVA ?? '/bin/sh'

interface Guasti {
  /** Il `curl` che scarica questo file esce con 56 (il `curl` vero esce 22 su un 404, 56 su un reset). */
  curl?: 'ffmpeg' | 'ffprobe'
  /** Il `sha256sum` di questa serie stampa `FAILED` ed esce con 1, come quello vero. */
  sha?: 'gz' | 'binari'
  /** Il `gzip` che decomprime questo file esce con 1. */
  gzip?: 'ffmpeg' | 'ffprobe'
  /** `chmod` esce con 1 (volume montato in sola lettura) o esce 0 senza fare niente (`noexec`). */
  chmod?: 'fallisce' | 'inefficace'
}

const cartelle: string[] = []
afterEach(() => {
  for (const dir of cartelle.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ambiente(guasti: Guasti = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-build-shell-'))
  cartelle.push(dir)
  const eventiFile = join(dir, 'eventi')
  const verificheFile = join(dir, 'verifiche')
  const build = join(dir, 'build')

  const comando = (nome: string, corpo: string) => {
    const file = join(dir, nome)
    writeFileSync(file, `#!${SHELL}\n${corpo}\n`)
    chmodSync(file, 0o755)
  }

  // Quelli veri: non c'è niente da fingere in `mkdir` e `rm`.
  for (const nome of ['mkdir', 'rm']) symlinkSync(`/bin/${nome}`, join(dir, nome))

  // `curl -fsS … -o <destinazione> <url>`: l'URL è l'ULTIMO argomento.
  comando(
    'curl',
    `destinazione=''
while [ $# -gt 1 ]; do
  [ "$1" = '-o' ] && destinazione="$2"
  shift
done
case "$destinazione" in
  *ffmpeg.gz) nome=ffmpeg ;;
  *ffprobe.gz) nome=ffprobe ;;
  *) nome=altro ;;
esac
echo "download-$nome" >> '${eventiFile}'
${guasti.curl ? `[ "$nome" = '${guasti.curl}' ] && exit 56` : ':'}
printf '%s' "$1" > "$destinazione"`,
  )

  // `sha256sum -c -` legge «impronta  percorso» da stdin. Il vero stampa `<file>: OK` su
  // stdout e, se qualcosa non torna, `FAILED` su stdout più un avviso su stderr.
  comando(
    'sha256sum',
    `entrata=$(/bin/cat)
printf '%s\\n' "$entrata" >> '${verificheFile}'
case "$entrata" in
  *ffmpeg.gz*) serie=gz ;;
  *) serie=binari ;;
esac
echo "verifica-$serie" >> '${eventiFile}'
printf '%s\\n' "$entrata" | while read -r impronta percorso; do
  [ -x "$percorso" ] && echo 'ESEGUIBILE-PRIMA-DELLA-VERIFICA' >> '${eventiFile}'
done
${
  guasti.sha
    ? `if [ "$serie" = '${guasti.sha}' ]; then
  echo 'file: FAILED'
  echo 'sha256sum: WARNING: 1 computed checksum did NOT match' >&2
  exit 1
fi`
    : ':'
}
echo 'file: OK'`,
  )

  // `gzip -dc <file>`: restituisce ciò che `curl` ha scritto, cioè l'URL.
  comando(
    'gzip',
    `[ "$1" = '-dc' ] || exit 64
case "$2" in
  *ffmpeg.gz) nome=ffmpeg ;;
  *ffprobe.gz) nome=ffprobe ;;
  *) nome=altro ;;
esac
echo "gunzip-$nome" >> '${eventiFile}'
${guasti.gzip ? `[ "$nome" = '${guasti.gzip}' ] && exit 1` : ':'}
/bin/cat "$2"`,
  )

  comando(
    'chmod',
    `echo chmod >> '${eventiFile}'
${guasti.chmod === 'fallisce' ? 'exit 1' : guasti.chmod === 'inefficace' ? 'exit 0' : '/bin/chmod "$@"'}`,
  )

  // I comandi che lo script NON deve più chiamare: se partono, lo si vede.
  for (const vietato of ['sudo', 'dnf', 'tar', 'xz', 'wget']) {
    comando(vietato, `echo 'VIETATO-${vietato}' >> '${eventiFile}'\nexit 97`)
  }

  const eventi = (): string[] =>
    existsSync(eventiFile) ? readFileSync(eventiFile, 'utf8').trim().split('\n') : []

  return {
    build,
    eventi,
    /** Gli eventi di un comando vietato: devono essere sempre zero. */
    vietati: () => eventi().filter((evento) => evento.startsWith('VIETATO-')),
    /** Le righe «impronta  percorso» che `sha256sum -c -` ha ricevuto, nell'ordine. */
    verifiche: (): string[] =>
      existsSync(verificheFile) ? readFileSync(verificheFile, 'utf8').trim().split('\n') : [],
    /**
     * Lancia lo script di provvista. `cartella` è quella che lo script nomina (il predefinito è `/tmp/kv-ffmpeg`, la PR 1; lo
     * snapshot la costruisce in `/opt/kv-ffmpeg`): in entrambi i casi si sostituisce con la cartella di prova, così il test non
     * scrive mai fuori dalla sua cartella temporanea.
     */
    esegui: (variabili: Record<string, string | undefined> = {}, cartella: string = CARTELLA_BUILD) => {
      const env: NodeJS.ProcessEnv = {
        PATH: dir,
        NODE_ENV: 'test',
        [ENV_URL_FFMPEG]: URL_FFMPEG,
        [ENV_URL_FFPROBE]: URL_FFPROBE,
      }
      for (const [nome, valore] of Object.entries(variabili)) {
        if (valore === undefined) delete env[nome]
        else env[nome] = valore
      }
      const esito = spawnSync(SHELL, ['-c', scriptPreparazioneBuild(cartella).replaceAll(cartella, build)], {
        env,
        encoding: 'utf8',
      })
      return { stato: esito.status, stdout: esito.stdout, stderr: esito.stderr }
    },
  }
}

const eseguibile = (percorso: string) => (statSync(percorso).mode & 0o111) !== 0

describe('runner · preparazione della build, eseguita da sh con i comandi di rete finti', () => {
  it('percorso felice: scarica, verifica i .gz, decomprime, verifica i binari, rende eseguibile — in quest’ordine', () => {
    const qa = ambiente()
    const esito = qa.esegui()

    expect(esito.stato).toBe(0)
    expect(qa.eventi()).toEqual([
      'download-ffmpeg',
      'download-ffprobe',
      'verifica-gz',
      'gunzip-ffmpeg',
      'gunzip-ffprobe',
      'verifica-binari',
      'chmod',
    ])
    // Nessun comando vietato, e nessun binario eseguibile prima della sua verifica.
    expect(qa.vietati()).toEqual([])
    expect(qa.eventi()).not.toContain('ESEGUIBILE-PRIMA-DELLA-VERIFICA')
    // I due `.gz` si buttano: restano i soli binari, eseguibili.
    expect(existsSync(join(qa.build, 'ffmpeg.gz'))).toBe(false)
    expect(existsSync(join(qa.build, 'ffprobe.gz'))).toBe(false)
    expect(eseguibile(join(qa.build, 'ffmpeg'))).toBe(true)
    expect(eseguibile(join(qa.build, 'ffprobe'))).toBe(true)
    // `>&2`: le righe «OK» di `sha256sum` non sporcano lo stdout, che è quello che si legge dopo.
    expect(esito.stdout).toBe('')
  })

  it('ogni URL finisce nel SUO file, e ogni impronta si confronta con il SUO file', () => {
    const qa = ambiente()
    expect(qa.esegui().stato).toBe(0)

    // Il `curl` finto scrive l'URL, il `gzip` finto lo restituisce: il binario finale dice da dove è venuto.
    expect(readFileSync(join(qa.build, 'ffmpeg'), 'utf8')).toBe(URL_FFMPEG)
    expect(readFileSync(join(qa.build, 'ffprobe'), 'utf8')).toBe(URL_FFPROBE)

    // Il formato è quello di `sha256sum -c`: impronta, DUE spazi, percorso.
    expect(qa.verifiche()).toEqual([
      `${FFMPEG_GZ_SHA256}  ${qa.build}/ffmpeg.gz`,
      `${FFPROBE_GZ_SHA256}  ${qa.build}/ffprobe.gz`,
      `${FFMPEG_SHA256}  ${qa.build}/ffmpeg`,
      `${FFPROBE_SHA256}  ${qa.build}/ffprobe`,
    ])
  })

  describe('uscita 21 — il download fallisce', () => {
    it.each([
      ['ffmpeg', ['download-ffmpeg']],
      ['ffprobe', ['download-ffmpeg', 'download-ffprobe']],
    ] as const)('%s: esce 21 e non verifica né decomprime niente', (quale, attesi) => {
      const qa = ambiente({ curl: quale })
      const esito = qa.esegui()

      expect(esito.stato).toBe(USCITE_PREPARAZIONE.scarico)
      expect(codiceDaUscitaPreparazione(esito.stato as number)).toBe('BUILD_DOWNLOAD_FAILED')
      expect(qa.eventi()).toEqual(attesi)
      expect(qa.vietati()).toEqual([])
    })
  })

  describe('uscita 22 — un’impronta non torna', () => {
    it('quella dei .gz: nessun gzip parte, e la riga FAILED arriva nella diagnosi', () => {
      const qa = ambiente({ sha: 'gz' })
      const esito = qa.esegui()

      expect(esito.stato).toBe(USCITE_PREPARAZIONE.impronta)
      expect(codiceDaUscitaPreparazione(esito.stato as number)).toBe('BUILD_HASH_MISMATCH')
      expect(qa.eventi()).toEqual(['download-ffmpeg', 'download-ffprobe', 'verifica-gz'])
      // `>&2`: il `FAILED` che `sha256sum` scrive sullo stdout deve finire dove si legge la diagnosi.
      expect(esito.stderr).toContain('FAILED')
      expect(esito.stdout).toBe('')
      expect(qa.vietati()).toEqual([])
    })

    it('quella dei binari: già decompressi, MA MAI ESEGUIBILI', () => {
      const qa = ambiente({ sha: 'binari' })
      const esito = qa.esegui()

      expect(esito.stato).toBe(USCITE_PREPARAZIONE.impronta)
      expect(qa.eventi()).toEqual([
        'download-ffmpeg',
        'download-ffprobe',
        'verifica-gz',
        'gunzip-ffmpeg',
        'gunzip-ffprobe',
        'verifica-binari',
      ])
      // Niente `chmod`: il binario che non ha superato la verifica non diventa eseguibile.
      expect(qa.eventi()).not.toContain('chmod')
      expect(eseguibile(join(qa.build, 'ffmpeg'))).toBe(false)
      expect(eseguibile(join(qa.build, 'ffprobe'))).toBe(false)
      expect(esito.stderr).toContain('FAILED')
    })
  })

  describe('uscita 23 — la decompressione o i permessi falliscono', () => {
    it.each([
      ['ffmpeg', ['download-ffmpeg', 'download-ffprobe', 'verifica-gz', 'gunzip-ffmpeg']],
      ['ffprobe', ['download-ffmpeg', 'download-ffprobe', 'verifica-gz', 'gunzip-ffmpeg', 'gunzip-ffprobe']],
    ] as const)('gzip su %s: esce 23 e non verifica i binari', (quale, attesi) => {
      const qa = ambiente({ gzip: quale })
      const esito = qa.esegui()

      expect(esito.stato).toBe(USCITE_PREPARAZIONE.estrazione)
      expect(codiceDaUscitaPreparazione(esito.stato as number)).toBe('BUILD_EXTRACT_FAILED')
      expect(qa.eventi()).toEqual(attesi)
      expect(qa.vietati()).toEqual([])
    })

    it.each(['fallisce', 'inefficace'] as const)(
      'chmod %s: esce 23, perché nessuno dei due lascia un binario eseguibile',
      (modo) => {
        // `inefficace` è il caso insidioso: `chmod` esce 0 e non cambia niente (volume
        // `noexec`). Lo ferma `test -x`, l'ultima riga dello script.
        const qa = ambiente({ chmod: modo })
        const esito = qa.esegui()

        expect(esito.stato).toBe(USCITE_PREPARAZIONE.estrazione)
        expect(codiceDaUscitaPreparazione(esito.stato as number)).toBe('BUILD_EXTRACT_FAILED')
        expect(qa.eventi()).toEqual([
          'download-ffmpeg',
          'download-ffprobe',
          'verifica-gz',
          'gunzip-ffmpeg',
          'gunzip-ffprobe',
          'verifica-binari',
          'chmod',
        ])
      },
    )
  })

  describe('una variabile d’ambiente mancante o vuota', () => {
    it.each([
      [ENV_URL_FFMPEG, undefined],
      [ENV_URL_FFPROBE, undefined],
      [ENV_URL_FFMPEG, ''],
      [ENV_URL_FFPROBE, ''],
    ])('%s = %j: lo script si ferma PRIMA del primo comando e dice quale', (nome, valore) => {
      const qa = ambiente()
      const esito = qa.esegui({ [nome]: valore })

      // Né 0 né le tre uscite dello script: `${VAR:?}` esce con 1 (bash) o 2 (dash). Va bene
      // qualunque numero, purché non sia «è andata bene» e il runner lo legga come guasto.
      expect(esito.stato).not.toBe(0)
      expect(Object.values(USCITE_PREPARAZIONE)).not.toContain(esito.stato)
      expect(codiceDaUscitaPreparazione(esito.stato as number)).toBe('BUILD_DOWNLOAD_FAILED')
      // Nessun comando è partito: né un download, né una verifica, né un gestore di pacchetti.
      expect(qa.eventi()).toEqual([])
      // E la diagnosi dice QUALE variabile manca.
      expect(esito.stderr).toContain(nome)
    })
  })

  describe('la STESSA provvista nella cartella dello snapshot (`/opt/kv-ffmpeg`), come la esegue `scripts/video-sandbox-ambiente.mjs`', () => {
    it('percorso felice: gli stessi sette passi nello stesso ordine, e i binari verificati sono eseguibili solo alla fine', () => {
      const qa = ambiente()
      const esito = qa.esegui({}, CARTELLA_BINARI_NELLO_SNAPSHOT)

      expect(esito.stato).toBe(0)
      expect(qa.eventi()).toEqual([
        'download-ffmpeg',
        'download-ffprobe',
        'verifica-gz',
        'gunzip-ffmpeg',
        'gunzip-ffprobe',
        'verifica-binari',
        'chmod',
      ])
      expect(qa.vietati()).toEqual([])
      expect(qa.eventi()).not.toContain('ESEGUIBILE-PRIMA-DELLA-VERIFICA')
      expect(eseguibile(join(qa.build, 'ffmpeg'))).toBe(true)
      expect(eseguibile(join(qa.build, 'ffprobe'))).toBe(true)
      expect(existsSync(join(qa.build, 'ffmpeg.gz'))).toBe(false)
    })

    it('le quattro impronte si verificano accanto ai file giusti (la cartella cambia, l’accoppiamento no)', () => {
      const qa = ambiente()
      qa.esegui({}, CARTELLA_BINARI_NELLO_SNAPSHOT)

      expect(qa.verifiche()).toEqual([
        `${FFMPEG_GZ_SHA256}  ${qa.build}/ffmpeg.gz`,
        `${FFPROBE_GZ_SHA256}  ${qa.build}/ffprobe.gz`,
        `${FFMPEG_SHA256}  ${qa.build}/ffmpeg`,
        `${FFPROBE_SHA256}  ${qa.build}/ffprobe`,
      ])
    })

    it('un’impronta dei binari che non torna: 22, e il binario NON diventa eseguibile — anche costruendo lo snapshot', () => {
      const qa = ambiente({ sha: 'binari' })
      const esito = qa.esegui({}, CARTELLA_BINARI_NELLO_SNAPSHOT)

      expect(esito.stato).toBe(USCITE_PREPARAZIONE.impronta)
      expect(qa.eventi()).not.toContain('chmod')
      expect(eseguibile(join(qa.build, 'ffmpeg'))).toBe(false)
      expect(eseguibile(join(qa.build, 'ffprobe'))).toBe(false)
    })
  })

  it('sudo e dnf non compaiono mai, in nessuno dei modi di finire', () => {
    const scenari: Guasti[] = [
      {},
      { curl: 'ffmpeg' },
      { curl: 'ffprobe' },
      { sha: 'gz' },
      { sha: 'binari' },
      { gzip: 'ffmpeg' },
      { gzip: 'ffprobe' },
      { chmod: 'fallisce' },
      { chmod: 'inefficace' },
    ]
    for (const guasti of scenari) {
      const qa = ambiente(guasti)
      qa.esegui()
      expect(qa.vietati(), `scenario ${JSON.stringify(guasti)}`).toEqual([])
    }
  })
})
