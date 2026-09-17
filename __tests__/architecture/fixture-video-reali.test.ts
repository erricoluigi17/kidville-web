import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ARCHIVIO_FFMPEG_SHA256,
  ARCHIVIO_FFMPEG_URL,
  RADICE_ARCHIVIO_FFMPEG,
} from '@/lib/media/video/build'
import { VARIABILE_CARTELLA, VARIABILE_RINUNCIA, rinunciaDichiarata } from '../fixtures/ffmpeg'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · i collaudi video eseguono ffmpeg vero, e un'assenza non è mai un verde
//
// IL DIFETTO, misurato il 2026-09-17 su questo stesso branch.
//   · `__tests__/lib/video-encode.test.ts` calcolava `ffmpegDisponibile` con uno
//     `spawnSync('ffmpeg', ['-version'])` e appendeva i due casi che eseguono
//     davvero un encoder a un `it.runIf(...)`. Su una macchina senza FFmpeg quei
//     due sparivano e il file restava verde: undici casi su undici, nessuno dei
//     quali aveva toccato un encoder.
//   · `__tests__/lib/video-verify.test.ts` non eseguiva ffmpeg nemmeno una volta:
//     ventun casi su JSON scritto a mano. Dimostravano che `verifyVideoOutput`
//     legge ciò che gli si dà — non che ffmpeg produca quello. La spec
//     `docs/superpowers/specs/2026-09-16-video-build-verificata.md` lo dichiarava
//     apertamente ancora aperto, ed è stato il primo giro con file veri a trovare
//     due difetti che nessuno dei ventun casi poteva vedere.
//
// COSA PRETENDE QUESTO LOCK, e perché tre cose e non una.
//  (a) NIENTE SALTI STATICI nei file `__tests__/lib/video-*.test.ts`. Le forme
//      `runIf`/`skipIf`/`skip`/`todo` decidono a monte che un caso non esiste, e
//      lo fanno per DIFETTO: basta una macchina senza FFmpeg. L'unica rinuncia
//      ammessa è una variabile d'ambiente che qualcuno deve scrivere a mano, e
//      che in CI viene rifiutata.
//  (b) UN CONTROLLO POSITIVO. Il punto (a) da solo è soddisfatto anche da un file
//      VUOTO: un lock che ha smesso di trovare qualcosa deve CADERE, non passare.
//      Perciò qui si conta quanti casi reali chiedono i binari, e si esegue la
//      rinuncia per vedere che in CI lanci davvero — la sua descrizione a parole
//      non è una prova (2026-09-02: un riquadro di CLAUDE.md dichiarava armata una
//      protezione che non lo era).
//  (c) UN NUMERO, TRE POSTI. Lo sha256 della build pinnata sta in `build.ts`, in
//      `ci.yml` e nella spec. Se divergono, in CI gira una build diversa da quella
//      di produzione e un verde non dice più niente sul comportamento reale — che
//      è esattamente il difetto che tutto questo lavoro chiude.
//
// I file si leggono senza i commenti: un lock che cerca `runIf` come TESTO
// troverebbe anche questa riga, e sarebbe un lock che fallisce sulla propria
// spiegazione.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const CARTELLA_LIB = join(RADICE, '__tests__', 'lib')
const HELPER = join(RADICE, '__tests__', 'fixtures', 'ffmpeg.ts')
const BUILD = join(RADICE, 'src', 'lib', 'media', 'video', 'build.ts')
const WORKFLOW = join(RADICE, '.github', 'workflows', 'ci.yml')
const SPEC = join(
  RADICE,
  'docs',
  'superpowers',
  'specs',
  '2026-09-16-video-build-verificata.md',
)

/** Le forme che tolgono un caso dal conteggio prima ancora di eseguirlo. */
const SALTI_STATICI = /\b(?:it|test|describe)\.(runIf|skipIf|skip|todo)\b/g

function leggi(percorso: string): string {
  return readFileSync(percorso, 'utf8')
}

/** Via i commenti di blocco e le righe che iniziano con `//`, prima di cercare codice. */
function senzaCommenti(sorgente: string): string {
  return sorgente
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((riga) => !riga.trimStart().startsWith('//'))
    .join('\n')
}

/**
 * Via le righe di commento YAML.
 *
 * Non è pulizia: senza, l'asserzione «il workflow non fa `apt-get install ffmpeg`»
 * cadeva sul COMMENTO che spiega perché non lo fa. Un lock che legge un file come
 * testo legge anche le proprie spiegazioni.
 */
function senzaCommentiYaml(sorgente: string): string {
  return sorgente
    .split('\n')
    .filter((riga) => !riga.trimStart().startsWith('#'))
    .join('\n')
}

function fileVideoDiCollaudo(): string[] {
  return readdirSync(CARTELLA_LIB)
    .filter((nome) => /^video-.*\.test\.ts$/.test(nome))
    .sort()
}

/** Gli sha256 distinti che compaiono in un file: devono essere uno solo, e quello. */
function impronteIn(percorso: string): Set<string> {
  return new Set(leggi(percorso).match(/\b[0-9a-f]{64}\b/g) ?? [])
}

describe('fixture video reali', () => {
  it('i file di collaudo video esistono ancora, e sono quelli attesi', () => {
    // Se questa lista si svuota, tutto il resto del lock passerebbe a vuoto.
    expect(fileVideoDiCollaudo()).toEqual(
      expect.arrayContaining([
        'video-encode.test.ts',
        'video-probe.test.ts',
        'video-verify.test.ts',
      ]),
    )
  })

  it('nessun caso video si salta da sé: le forme statiche di salto sono vietate', () => {
    for (const nome of fileVideoDiCollaudo()) {
      const codice = senzaCommenti(leggi(join(CARTELLA_LIB, nome)))
      const trovati = [...codice.matchAll(SALTI_STATICI)].map((m) => m[0])
      expect(
        trovati,
        `${nome} salta dei casi a monte (${trovati.join(', ')}): su una macchina senza ` +
          `FFmpeg spariscono in silenzio. Usa binariVideo(contesto) di ` +
          `__tests__/fixtures/ffmpeg.ts, che fallisce invece di sparire.`,
      ).toEqual([])
    }
  })

  it('video-verify.test.ts esegue davvero il giro completo con ffmpeg', () => {
    const codice = senzaCommenti(leggi(join(CARTELLA_LIB, 'video-verify.test.ts')))

    expect(codice).toContain("from '../fixtures/ffmpeg'")
    // Il giro completo, nei suoi tre passaggi: probe dell'ingresso, argomenti di
    // produzione non ritoccati, verifica dell'uscita.
    expect(codice).toContain('parseVideoProbe(')
    expect(codice).toContain('buildVideoEncodeArgs(')
    expect(codice).toContain('verifyVideoOutput(')
    expect(codice).toContain('provaDiDecodifica(')

    const casiReali = [...codice.matchAll(/binariVideo\(contesto\)/g)].length
    expect(
      casiReali,
      'i casi che eseguono ffmpeg vero sono scesi: erano dieci il 2026-09-17 ' +
        '(4K HEVC, HDR10 puro, HDR10 con mastering display, rotazione, 120 fps, ' +
        'muto, ProRes, DNxHR, il caso negativo a 1280×720, sorgente senza colore).',
    ).toBeGreaterThanOrEqual(10)

    // Il caso NEGATIVO: senza, i nove positivi dimostrano che ffmpeg funziona, non
    // che `verifyVideoOutput` sappia dire di no — l'unica cosa per cui esiste.
    expect(codice).toContain('OUTPUT_DIMENSIONS_INVALID')
  })

  it('video-encode.test.ts esegue i suoi due casi reali passando dall’helper', () => {
    const codice = senzaCommenti(leggi(join(CARTELLA_LIB, 'video-encode.test.ts')))
    expect(codice).toContain("from '../fixtures/ffmpeg'")
    expect([...codice.matchAll(/binariVideo\(contesto\)/g)].length).toBeGreaterThanOrEqual(2)
  })

  it('l’helper verifica l’inventario della build, non solo che il file esista', () => {
    const codice = senzaCommenti(leggi(HELPER))
    // Una build che risponde `-version` con 0 e non ha `zscale` è inutile per la
    // catena HDR: `brew install ffmpeg` 8.1.2 è esattamente quella.
    expect(codice).toContain('FILTRI_RICHIESTI')
    expect(codice).toContain('DECODER_RICHIESTI')
    expect(codice).toContain('ENCODER_RICHIESTI')
    expect(codice).toContain(VARIABILE_CARTELLA)
  })

  it('la rinuncia esiste, ed eseguendola si vede che in CI non vale', () => {
    const ciPrima = process.env.CI
    const rinunciaPrima = process.env[VARIABILE_RINUNCIA]
    try {
      process.env[VARIABILE_RINUNCIA] = '1'

      delete process.env.CI
      expect(rinunciaDichiarata()).toContain(VARIABILE_RINUNCIA)

      process.env.CI = 'true'
      expect(() => rinunciaDichiarata()).toThrow(/CI=true/)

      delete process.env[VARIABILE_RINUNCIA]
      delete process.env.CI
      expect(rinunciaDichiarata()).toBeNull()
    } finally {
      if (ciPrima === undefined) delete process.env.CI
      else process.env.CI = ciPrima
      if (rinunciaPrima === undefined) delete process.env[VARIABILE_RINUNCIA]
      else process.env[VARIABILE_RINUNCIA] = rinunciaPrima
    }
  })

  it('lo sha256 della build pinnata è lo stesso numero in tre posti', () => {
    for (const percorso of [BUILD, WORKFLOW, SPEC]) {
      expect(
        impronteIn(percorso),
        `${percorso} non dichiara esattamente lo sha256 della build pinnata: ` +
          'una build diversa in CI rende il verde muto sul comportamento reale.',
      ).toEqual(new Set([ARCHIVIO_FFMPEG_SHA256]))
    }
  })

  it('anche l’archivio e la sua radice sono dichiarati una volta sola, uguali ovunque', () => {
    const workflow = leggi(WORKFLOW)
    const spec = leggi(SPEC)

    expect(workflow).toContain(ARCHIVIO_FFMPEG_URL)
    expect(spec).toContain(ARCHIVIO_FFMPEG_URL)
    // La radice serve al `tar --strip-components`: se cambia solo lì, l'estrazione
    // non trova niente e il passo fallisce con un messaggio che non dice il perché.
    expect(workflow).toContain(RADICE_ARCHIVIO_FFMPEG)
    // Il collegamento è alla release DATATA, non al tag mobile `latest`: quello
    // cambierebbe build sotto i piedi senza che nessun file del repo se ne accorga.
    expect(ARCHIVIO_FFMPEG_URL).not.toContain('/latest/')
  })

  it('il workflow prepara FFmpeg prima del gate, e lo passa alla suite', () => {
    const workflow = senzaCommentiYaml(leggi(WORKFLOW))
    expect(workflow).toContain(`${VARIABILE_CARTELLA}=`)
    expect(workflow).toContain('sha256sum -c -')
    expect(workflow.indexOf(`${VARIABILE_CARTELLA}=`)).toBeLessThan(
      workflow.indexOf('run: npm run gate'),
    )
    // `apt-get install ffmpeg` prenderebbe la build della distro, che non è quella
    // che converte i video in produzione: è la sostituzione silenziosa da impedire.
    expect(workflow).not.toContain('apt-get install ffmpeg')
  })
})
