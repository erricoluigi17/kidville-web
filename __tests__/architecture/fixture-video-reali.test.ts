import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ARCHIVIO_FFMPEG_SHA256,
  ARCHIVIO_FFMPEG_URL,
  CARTELLA_BINARI_NELLO_SNAPSHOT,
  FFMPEG_GZ_SHA256,
  FFMPEG_SHA256,
  FFPROBE_GZ_SHA256,
  FFPROBE_SHA256,
  FILTRI_RICHIESTI,
} from '@/lib/media/video/build'
import { buildVideoEncodeArgs } from '@/lib/media/video/encode'
import type { VideoProbe } from '@/lib/media/video/probe'
import { CARTELLA_BUILD, scriptPreparazioneBuild } from '@/lib/media/video/runner/preparazione'
import { scriptApparecchio, scriptVerificaBinari } from '@/lib/media/video/runner/script'
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
//  (c) LE IMPRONTE, TRE POSTI. Dal 2026-10-02 la build non si scarica più da
//      Internet: sta nel nostro bucket `video_build`, e la catena ha CINQUE
//      impronte — l'archivio BtbN da cui viene (provenienza), i due `.gz` che si
//      scaricano, i due binari che ne escono. Stanno in `build.ts` e nella spec
//      (tutte e cinque) e in `ci.yml` (le quattro che la CI verifica: l'archivio
//      non lo scarica più nessuno). Se divergono, in CI gira una build diversa da
//      quella di produzione e un verde non dice più niente sul comportamento
//      reale — che è esattamente il difetto che tutto questo lavoro chiude.
//
//      E nessuno dei due percorsi — lo script che gira nel Sandbox, il workflow —
//      può rimettere un indirizzo esterno: il 29/09/2026 la release BtbN è stata
//      cancellata e la conversione si è fermata (17 job su 17).
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

/** Un probe qualunque: i rami li scelgono le varianti in `ogniFiltroDiProduzione`. */
const PROBE: VideoProbe = {
  durationSeconds: 30,
  width: 3840,
  height: 2160,
  codedWidth: 3840,
  codedHeight: 2160,
  rotation: 0,
  fps: 30,
  hasAudio: true,
  audioCodec: 'aac',
  videoCodec: 'hevc',
  pixelFormat: 'yuv420p10le',
  colorTransfer: 'bt709',
  colorPrimaries: 'bt709',
  colorSpace: 'bt709',
  isHdr: false,
  videoStreamIndex: 0,
  audioStreamIndex: 1,
}

/**
 * I nomi dei filtri dentro un filtergraph: via le etichette `[x]`, poi il token
 * prima del primo `=`. `[base][wm]overlay=x='…'` dà `overlay`.
 */
function filtriNominati(graph: string): string[] {
  return graph
    .split(/[;,]/)
    .map((segmento) => segmento.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').trim())
    .map((segmento) => segmento.match(/^([a-z][a-z0-9_]*)/)?.[1])
    .filter((nome): nome is string => nome !== undefined)
}

/** Ogni filtro che `buildVideoEncodeArgs` può scrivere, su tutti i suoi rami. */
function ogniFiltroDiProduzione(): Set<string> {
  const varianti: { probe: VideoProbe; watermark: boolean }[] = [
    { probe: PROBE, watermark: false },
    // Il watermark della Galleria, che aggiunge `overlay` e `setsar`.
    { probe: PROBE, watermark: true },
    // HDR → SDR: `zscale` e `tonemap`.
    { probe: { ...PROBE, isHdr: true, colorTransfer: 'smpte2084' }, watermark: false },
    // SDR completo non BT.709: la catena `zscale` senza tonemap.
    {
      probe: { ...PROBE, colorTransfer: 'bt2020-10', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc' },
      watermark: false,
    },
    // Oltre i 60 fps: `fps`.
    { probe: { ...PROBE, fps: 120 }, watermark: false },
  ]

  const nomi = new Set<string>()
  for (const { probe, watermark } of varianti) {
    const args = watermark
      ? buildVideoEncodeArgs(probe, {
          channel: 'gallery',
          inputPath: '/tmp/in.mov',
          outputPath: '/tmp/out.mp4',
          watermarkPath: '/tmp/wm.png',
        })
      : buildVideoEncodeArgs(probe, {
          channel: 'news',
          inputPath: '/tmp/in.mov',
          outputPath: '/tmp/out.mp4',
        })
    for (const nome of filtriNominati(args[args.indexOf('-filter_complex') + 1])) nomi.add(nome)
  }
  return nomi
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

  /* ──────────────────────────────────────────────────────────────────────────
   * L'INVENTARIO SI RICAVA DAL FILTERGRAPH, non si ricopia a mano.
   *
   * `FILTRI_RICHIESTI` esiste perché una build che perde un filtro non fallisce
   * all'installazione: fallisce al primo video che imbocca quel ramo, cioè in
   * produzione e sul file di un genitore. Ma finché l'elenco era scritto a mano,
   * la sua tenuta dipendeva dal fatto che chi aggiunge un filtro si ricordasse
   * anche di questo file — e il 2026-09-17, aggiungendo `sidedata`, si è visto che
   * l'elenco aveva già perso `setsar`, che il ramo Galleria nomina da sempre.
   * Adesso i nomi li conta il filtergraph vero, su tutti i suoi rami.
   * ────────────────────────────────────────────────────────────────────────── */
  it('ogni filtro che il filtergraph di produzione nomina è dichiarato in FILTRI_RICHIESTI', () => {
    const nominati = [...ogniFiltroDiProduzione()].sort()
    // Controllo positivo: se l'estrattore smettesse di trovare i nomi, «nessun
    // filtro mancante» e «nessun filtro visto» avrebbero lo stesso colore.
    expect(nominati).toEqual(expect.arrayContaining(['scale', 'overlay', 'zscale', 'tonemap']))

    const nonDichiarati = nominati.filter((nome) => !FILTRI_RICHIESTI.includes(nome as never))
    expect(
      nonDichiarati,
      `questi filtri finiscono nella riga di comando ma non nell’inventario di ` +
        `src/lib/media/video/build.ts: la CI installerebbe una build che non sa eseguirli, ` +
        `e la scoperta arriverebbe da uno stderr in produzione.`,
    ).toEqual([])
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

  /* ──────────────────────────────────────────────────────────────────────────
   * LE IMPRONTE, TRE POSTI (dal 2026-10-02).
   *
   * La catena ha cinque impronte: l'archivio BtbN (provenienza), i due `.gz` che si
   * scaricano dal nostro bucket, i due binari che ne escono. `build.ts` e la spec le
   * hanno tutte; la CI verifica le quattro della catena, perché l'archivio non lo
   * scarica più nessuno.
   * ────────────────────────────────────────────────────────────────────────── */
  const IMPRONTE_DELLA_CATENA = [FFMPEG_GZ_SHA256, FFPROBE_GZ_SHA256, FFMPEG_SHA256, FFPROBE_SHA256]
  const TUTTE_LE_IMPRONTE = [ARCHIVIO_FFMPEG_SHA256, ...IMPRONTE_DELLA_CATENA]

  it('le cinque impronte sono sha256 veri e tutte diverse', () => {
    for (const impronta of TUTTE_LE_IMPRONTE) expect(impronta).toMatch(/^[0-9a-f]{64}$/)
    // Una impronta incollata due volte (il `.gz` al posto del binario) renderebbe le due
    // verifiche la stessa verifica.
    expect(new Set(TUTTE_LE_IMPRONTE).size).toBe(5)
  })

  it('le impronte della build sono le stesse in tre posti: build.ts e spec le cinque, la CI le quattro che verifica', () => {
    for (const percorso of [BUILD, SPEC]) {
      expect(
        impronteIn(percorso),
        `${percorso} non dichiara ESATTAMENTE le cinque impronte della build pinnata ` +
          '(archivio, due .gz, due binari): una build diversa in CI rende il verde muto ' +
          'sul comportamento reale.',
      ).toEqual(new Set(TUTTE_LE_IMPRONTE))
    }
    expect(
      impronteIn(WORKFLOW),
      `${WORKFLOW} non dichiara ESATTAMENTE le quattro impronte che la CI verifica ` +
        '(due .gz, due binari): niente archivio, che non scarica più.',
    ).toEqual(new Set(IMPRONTE_DELLA_CATENA))
  })

  it('l’archivio BtbN è la PROVENIENZA: la spec lo dichiara, e nessuno lo scarica più', () => {
    expect(leggi(SPEC)).toContain(ARCHIVIO_FFMPEG_URL)
    // Il collegamento è alla release DATATA, non al tag mobile `latest`: quello
    // cambierebbe build sotto i piedi senza che nessun file del repo se ne accorga.
    expect(ARCHIVIO_FFMPEG_URL).not.toContain('/latest/')

    // Il workflow, senza i commenti che raccontano la storia, non nomina più BtbN: la
    // release datata è stata cancellata il 29/09/2026 e la conversione si è fermata.
    const workflow = senzaCommentiYaml(leggi(WORKFLOW))
    expect(workflow).not.toContain('github.com/BtbN')
    expect(workflow).not.toContain(ARCHIVIO_FFMPEG_URL)
  })

  it('la CI prende i binari dal NOSTRO bucket: due segreti con gli URL firmati, dichiarati in un solo punto', () => {
    const workflow = senzaCommentiYaml(leggi(WORKFLOW))
    for (const segreto of ['CI_FFMPEG_GZ_URL', 'CI_FFPROBE_GZ_URL']) {
      expect(workflow, `il workflow non usa più il segreto ${segreto}`).toContain(segreto)
      // «Dichiarati solo nel passo che li usa»: un solo `secrets.X`, quello dell'`env` del passo.
      // A livello di job o di workflow finirebbero nell'ambiente di ogni passo, `npm ci` compreso.
      expect([...workflow.matchAll(new RegExp(`secrets\\.${segreto}\\b`, 'g'))]).toHaveLength(1)
    }
  })

  it('la cache dei binari ha per chiave le impronte dei due binari: cambiare build cambia chiave', () => {
    expect(senzaCommentiYaml(leggi(WORKFLOW))).toContain(
      `key: ffmpeg-bin-${FFMPEG_SHA256}-${FFPROBE_SHA256}`,
    )
  })

  it('nessun indirizzo esterno nello script del Sandbox: gli URL arrivano dall’ambiente', () => {
    const script = scriptPreparazioneBuild()
    expect(script).not.toMatch(/https?:\/\//)
    expect(script).not.toContain(ARCHIVIO_FFMPEG_URL)
    expect(script).not.toContain('github.com')
  })

  it.each([
    ['lo script di preparazione del runner', () => scriptPreparazioneBuild()],
    ['il passo FFmpeg della CI', () => senzaCommentiYaml(leggi(WORKFLOW))],
  ] as [string, () => string][])(
    '%s verifica DUE volte, e decomprime FRA le due verifiche',
    (_nome, testo) => {
      const codice = testo()
      const verifiche = [...codice.matchAll(/sha256sum -c -/g)].map((m) => m.index)
      const decompressioni = [...codice.matchAll(/gzip -dc/g)].map((m) => m.index)
      // Una verifica prima (i `.gz`, appena arrivati dalla rete) e una dopo (i binari, appena
      // usciti dal `.gz`): senza la prima si decomprime ciò che non si è verificato, senza la
      // seconda non si prova che il `.gz` contenga il binario collaudato.
      expect(verifiche.length).toBeGreaterThanOrEqual(2)
      expect(decompressioni.length).toBeGreaterThanOrEqual(1)
      const prima = verifiche[0] as number
      const ultima = verifiche[verifiche.length - 1] as number
      for (const posizione of decompressioni) {
        expect(posizione as number).toBeGreaterThan(prima)
        expect(posizione as number).toBeLessThan(ultima)
      }
    },
  )

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

/* ──────────────────────────────────────────────────────────────────────────────
 * LO SNAPSHOT DEL SANDBOX (PR 2, spec §10.1): le STESSE impronte, nessun posto nuovo.
 *
 * Dalla PR 2 i binari possono stare già dentro uno snapshot (`/opt/kv-ffmpeg`), e il runner li VERIFICA a ogni avvio
 * invece di scaricarli. La fiducia non cambia, ed è ciò che questo gruppo tiene fermo: la verifica dello snapshot usa le due
 * impronte dei BINARI di `build.ts` — le stesse della provvista e della CI — e quelle impronte restano in TRE posti (le
 * conta il lock qui sopra). Un valore copiato in uno script, in un `.mjs` o nella costante di un altro modulo sarebbe una
 * quarta fonte: la build dello snapshot potrebbe divergere da quella che il runner accetta, e il rifiuto arriverebbe a runtime,
 * su ogni video, con il ripiego a coprirlo — cioè in silenzio.
 * ────────────────────────────────────────────────────────────────────────────── */

describe('fixture video reali · lo snapshot usa le impronte di build.ts, e nessuna nuova', () => {
  const SNAPSHOT = CARTELLA_BINARI_NELLO_SNAPSHOT
  const SORGENTI_DELLO_SNAPSHOT = [
    'src/lib/media/video/runner/ambiente.ts',
    'src/lib/media/video/runner/preparazione.ts',
    'src/lib/media/video/runner/script.ts',
    'scripts/video-sandbox-ambiente.mjs',
  ]

  it('la verifica dello snapshot controlla le due impronte dei BINARI (non quelle dei `.gz`), ciascuna accanto al suo file', () => {
    const script = scriptVerificaBinari(SNAPSHOT)
    expect(script).toContain(`'${FFMPEG_SHA256}' ${SNAPSHOT}/ffmpeg '${FFPROBE_SHA256}' ${SNAPSHOT}/ffprobe`)
    expect(script.match(/sha256sum -c -/g)).toHaveLength(1)
    for (const gz of [FFMPEG_GZ_SHA256, FFPROBE_GZ_SHA256, ARCHIVIO_FFMPEG_SHA256]) expect(script).not.toContain(gz)
  })

  it('le uniche sequenze di 64 cifre in ogni script di shell sono quelle di build.ts', () => {
    const attese = new Set([ARCHIVIO_FFMPEG_SHA256, FFMPEG_GZ_SHA256, FFPROBE_GZ_SHA256, FFMPEG_SHA256, FFPROBE_SHA256])
    for (const [nome, script] of [
      ['la verifica dello snapshot', scriptVerificaBinari(SNAPSHOT)],
      ['la provvista nella cartella dello snapshot', scriptPreparazioneBuild(SNAPSHOT)],
      ['l’apparecchio dello snapshot', scriptApparecchio({ cartella: SNAPSHOT, binariGiaPresenti: true })],
      ['l’apparecchio del ripiego', scriptApparecchio()],
    ] as [string, string][]) {
      const trovate = script.match(/\b[0-9a-f]{64}\b/g) ?? []
      expect(trovate.length, `${nome} non verifica niente`).toBeGreaterThan(0)
      for (const impronta of trovate) expect(attese.has(impronta), `${nome}: ${impronta} non è di build.ts`).toBe(true)
    }
  })

  it('nessun sorgente dello snapshot porta un’impronta scritta a mano: stanno in build.ts, e basta', () => {
    for (const percorso of SORGENTI_DELLO_SNAPSHOT) {
      const codice = senzaCommenti(leggi(join(RADICE, percorso)))
      expect(codice.match(/\b[0-9a-f]{64}\b/g), `${percorso} ha una copia di un’impronta`).toBeNull()
    }
  })

  it('i sorgenti dello snapshot importano le impronte dei binari da `build.ts`, non le ridefiniscono', () => {
    const script = senzaCommenti(leggi(join(RADICE, 'src/lib/media/video/runner/script.ts')))
    expect(script).toMatch(/import\s*\{[^}]*FFMPEG_SHA256[^}]*\}\s*from\s*'\.\.\/build'/)
    expect(script).toMatch(/import\s*\{[^}]*FFPROBE_SHA256[^}]*\}\s*from\s*'\.\.\/build'/)
    // Nessuna costante di impronta ridefinita qui con un valore letterale (l'`FORMA_SHA256_DICHIARATO` di `script.ts` è
    // un'espressione regolare, non un'impronta: la forma di un valore, non il valore).
    expect(script).not.toMatch(/(?:const|let|var)\s+\w*SHA256\w*\s*=\s*['"`][0-9a-f]{64}/)
    const costruzione = senzaCommenti(leggi(join(RADICE, 'scripts/video-sandbox-ambiente.mjs')))
    expect(costruzione).toMatch(/FFMPEG_SHA256/)
    expect(costruzione).toMatch(/FFPROBE_SHA256/)
  })

  it('la verifica precede ogni esecuzione dei binari: nell’apparecchio dello snapshot `sha256sum` viene prima dell’inventario', () => {
    const script = scriptApparecchio({ cartella: SNAPSHOT, binariGiaPresenti: true })
    // L'inventario ESEGUE `ffmpeg`: un binario non verificato non deve mai arrivare lì.
    expect(script.indexOf('sha256sum -c -')).toBeGreaterThanOrEqual(0)
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf(`${SNAPSHOT}/ffmpeg -hide_banner`))
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf(`${SNAPSHOT}/ffprobe -v error`))
  })

  it('i binari dello snapshot stanno sotto `/opt`, e NON dove li mette la provvista (`/tmp`): due cartelle, due provenienze, mai confuse', () => {
    expect(SNAPSHOT.startsWith('/opt/')).toBe(true)
    expect(SNAPSHOT).not.toBe(CARTELLA_BUILD)
    expect(CARTELLA_BUILD.startsWith('/tmp/')).toBe(true)
  })

  it('nessun indirizzo esterno negli script dello snapshot, né l’archivio BtbN: la sola fonte è il nostro bucket, con URL firmati dall’ambiente', () => {
    for (const script of [scriptVerificaBinari(SNAPSHOT), scriptPreparazioneBuild(SNAPSHOT)]) {
      expect(script).not.toMatch(/https?:\/\//)
      expect(script).not.toContain('github.com')
    }
    const costruzione = senzaCommenti(leggi(join(RADICE, 'scripts/video-sandbox-ambiente.mjs')))
    expect(costruzione).not.toContain('github.com')
    expect(costruzione).not.toContain(ARCHIVIO_FFMPEG_URL)
    // L'unico indirizzo che lo script nomina è il progetto Supabase che è già nostro (per firmare gli URL di lettura).
    const indirizzi = costruzione.match(/https?:\/\/[^\s'"`)]+/g) ?? []
    for (const indirizzo of indirizzi) expect(indirizzo, indirizzo).toMatch(/supabase\.co|\$\{/)
  })
})
