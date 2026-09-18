import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  binariVideo,
  eseguiFfmpeg,
  generaFixture,
  inCartellaTemporanea,
  sondaFfprobe,
} from '../fixtures/ffmpeg'
import {
  buildVideoEncodeArgs,
  outputVideoColorMetadata,
  type VideoEncodeOptions,
} from '@/lib/media/video/encode'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import type { VideoProbe } from '@/lib/media/video/probe'

/* ════════════════════════════════════════════════════════════════════════════
 * QUI C'ERA UN `ffmpegDisponibile` CALCOLATO CON UNO `spawnSync`, e i due casi che
 * eseguono ffmpeg davvero ci stavano appesi. Su una macchina senza FFmpeg quei due
 * sparivano e il file restava verde: undici casi su undici, e nessuno che avesse
 * toccato un encoder. Adesso la risoluzione dei binari sta in
 * `__tests__/fixtures/ffmpeg.ts`, fallisce rumorosamente quando FFmpeg manca o non
 * sa fare il lavoro, e l'unica uscita è una variabile d'ambiente esplicita che in
 * CI viene rifiutata.
 * ════════════════════════════════════════════════════════════════════════════ */

const probeBase: VideoProbe = {
  durationSeconds: 90,
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
  videoStreamIndex: 2,
  audioStreamIndex: 3,
}

function filterGraph(args: string[]): string {
  const index = args.indexOf('-filter_complex')
  expect(index).toBeGreaterThanOrEqual(0)
  return args[index + 1]
}

/** Il valore che segue un'opzione, con l'asserzione che l'opzione ci sia davvero. */
function valoreDi(args: string[], opzione: string): string {
  const indice = args.indexOf(opzione)
  expect(indice, `${opzione} non compare negli argomenti`).toBeGreaterThanOrEqual(0)
  return args[indice + 1]
}

describe('buildVideoEncodeArgs', () => {
  it('produce H.264 Full HD senza shell, preservando audio e FPS sotto 60', () => {
    const args = buildVideoEncodeArgs(probeBase, {
      channel: 'news',
      inputPath: '/tmp/input $(touch nope).mov',
      outputPath: '/tmp/output;nope.mp4',
    })

    expect(args).toContain('/tmp/input $(touch nope).mov')
    expect(args).toContain('/tmp/output;nope.mp4')
    expect(args.indexOf('-autorotate')).toBeLessThan(args.indexOf('-i'))
    expect(args).toEqual(expect.arrayContaining([
      '-map', '[vout]',
      '-map', '0:3',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-f', 'mp4',
    ]))
    expect(filterGraph(args)).toContain('scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1')
    expect(filterGraph(args)).not.toContain('fps=')
    expect(filterGraph(args)).not.toMatch(/transpose|rotate=/)
    expect(args).not.toContain('-t')
  })

  it('non ingrandisce e usa il box verticale per un video portrait', () => {
    const piccolo = buildVideoEncodeArgs(
      { ...probeBase, width: 720, height: 1280, codedWidth: 1280, codedHeight: 720, rotation: 90 },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )
    const grande = buildVideoEncodeArgs(
      { ...probeBase, width: 2160, height: 3840, codedWidth: 3840, codedHeight: 2160, rotation: 90 },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )

    expect(filterGraph(piccolo)).toContain('scale=720:1280:')
    expect(filterGraph(grande)).toContain('scale=1080:1920:')
    expect(filterGraph(grande)).not.toMatch(/transpose|rotate=/)
  })

  it('normalizza pixel anamorfici usando le dimensioni display del probe', () => {
    const args = buildVideoEncodeArgs(
      { ...probeBase, width: 1440, height: 1080, codedWidth: 720, codedHeight: 1080 },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )

    expect(filterGraph(args)).toContain('scale=1440:1080:')
    expect(filterGraph(args)).toContain('reset_sar=1')
  })

  it('riduce soltanto i frame rate superiori a 60', () => {
    const sessanta = buildVideoEncodeArgs(
      { ...probeBase, fps: 60 },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )
    const oltre = buildVideoEncodeArgs(
      { ...probeBase, fps: 120 },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )

    expect(filterGraph(sessanta)).not.toContain('fps=')
    expect(filterGraph(oltre)).toContain('fps=60')
  })

  it.each([
    ['smpte2084', 'PQ'],
    ['arib-std-b67', 'HLG'],
  ])('converte HDR %s (%s) in SDR BT.709', (colorTransfer) => {
    const args = buildVideoEncodeArgs(
      { ...probeBase, isHdr: true, colorTransfer },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )
    const graph = filterGraph(args)

    expect(graph).toContain('zscale=transfer=linear:npl=100')
    expect(graph).toContain('format=gbrpf32le')
    expect(graph).toContain('tonemap=tonemap=hable:desat=0')
    expect(graph).toContain('zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited')
    expect(args).toEqual(expect.arrayContaining([
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
      '-color_range', 'tv',
    ]))
  })

  it.each([
    {
      descrizione: 'BT.2020 SDR',
      colorTransfer: 'bt2020-10',
      colorPrimaries: 'bt2020',
      colorSpace: 'bt2020nc',
    },
    {
      descrizione: 'SMPTE 170M',
      colorTransfer: 'smpte170m',
      colorPrimaries: 'smpte170m',
      colorSpace: 'smpte170m',
    },
  ])('converte realmente $descrizione in SDR BT.709', ({ colorTransfer, colorPrimaries, colorSpace }) => {
    const args = buildVideoEncodeArgs(
      { ...probeBase, colorTransfer, colorPrimaries, colorSpace },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )

    expect(filterGraph(args)).toContain([
      'zscale=transfer=linear:npl=100',
      'format=gbrpf32le',
      'zscale=primaries=bt709',
      'zscale=transfer=bt709:matrix=bt709:range=limited',
    ].join(','))
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * I SEI HDR NON SONO METADATI DEL CONTENITORE, e `-map_metadata -1` non li vede.
   *
   * Misurato il 2026-09-17 su `/opt/homebrew/bin/ffmpeg` 8.1.2: una sorgente HEVC
   * con `master-display` e `max-cll` porta «Mastering display metadata» e «Content
   * light level metadata» come side data DEI FRAME. Attraversano il filtergraph,
   * libx264 li rilegge e li riscrive nell'H.264 — l'uscita è SDR nei pixel e HDR
   * nei SEI, e `verifyVideoOutput` la rifiuta con `OUTPUT_NOT_SDR`.
   *
   * La cancellazione è INCONDIZIONATA e non solo sul ramo HDR: `hasHdrSideData`
   * guarda l'uscita, non la sorgente, e un file rimasterizzato da un HDR può
   * portarsi dietro quei SEI pur dichiarandosi SDR. Su un video che non li ha, il
   * filtro non fa nulla.
   * ────────────────────────────────────────────────────────────────────────── */
  const CANCELLA_MASTERING = 'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA'
  const CANCELLA_CLL = 'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL'

  it.each([
    { descrizione: 'HDR', isHdr: true },
    { descrizione: 'SDR', isHdr: false },
  ])('cancella i SEI di mastering display e content light level anche da una sorgente $descrizione', ({ isHdr }) => {
    const graph = filterGraph(
      buildVideoEncodeArgs(
        { ...probeBase, isHdr },
        { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
      ),
    )

    expect(graph).toContain(CANCELLA_MASTERING)
    expect(graph).toContain(CANCELLA_CLL)
    // `filter_units=remove_types=6` avrebbe buttato via TUTTI i SEI, compresa la
    // firma dell'encoder: un'amputazione al posto di una cancellazione mirata.
    expect(graph).not.toContain('filter_units')
  })

  it('cancella i SEI HDR prima del watermark, così l’overlay non se li ricopia', () => {
    const graph = filterGraph(
      buildVideoEncodeArgs(
        { ...probeBase, isHdr: true },
        {
          channel: 'gallery',
          inputPath: '/tmp/in.mov',
          outputPath: '/tmp/out.mp4',
          watermarkPath: '/tmp/wm.png',
        },
      ),
    )

    // Prima che ci sia un ORDINE da controllare, i due pezzi devono esserci: un
    // `indexOf` che vale -1 è minore di qualunque posizione, e senza queste due
    // righe il caso passerebbe proprio quando la cancellazione manca del tutto.
    expect(graph).toContain(CANCELLA_CLL)
    expect(graph).toContain('overlay=')
    // `overlay` copia le proprietà del frame principale, side data compresi: se la
    // cancellazione stesse dopo, il ramo Galleria resterebbe scoperto.
    expect(graph.indexOf(CANCELLA_CLL)).toBeLessThan(graph.indexOf('overlay='))
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * IL TETTO VBV, e perché non è un numero scelto a occhio.
   *
   * Misura del 2026-09-17: `-crf 18` senza `-maxrate` ha prodotto un'uscita da
   * 2.073.793.213 byte — sopra `MAX_VIDEO_INPUT_BYTES` — e il rifiuto
   * `OUTPUT_TOO_LARGE` è arrivato DOPO 709 s di wall e 1.452 s di CPU. Il lavoro
   * era già stato fatto, pagato e buttato.
   *
   * Questo caso non ricopia il numero che `encode.ts` calcola — sarebbe una
   * tautologia. Rifà il CONTO al contrario partendo dagli argomenti emessi: nel
   * caso peggiore ammesso (durata massima, buffer pieno) i byte devono stare sotto
   * il tetto. Un `-maxrate 200M` scritto a mano lo farebbe cadere.
   * ────────────────────────────────────────────────────────────────────────── */
  it('impone un tetto VBV che tiene l’uscita sotto il limite anche nel caso peggiore', () => {
    const args = buildVideoEncodeArgs(probeBase, {
      channel: 'news',
      inputPath: '/tmp/in.mov',
      outputPath: '/tmp/out.mp4',
    })

    const maxrate = Number(valoreDi(args, '-maxrate:v'))
    const bufsize = Number(valoreDi(args, '-bufsize:v'))
    expect(Number.isSafeInteger(maxrate) && maxrate > 0).toBe(true)
    expect(Number.isSafeInteger(bufsize) && bufsize > 0).toBe(true)

    // Il VBV garantisce: in una finestra di T secondi i bit non superano
    // `maxrate × T + bufsize`. L'audio viaggia accanto, col suo bitrate — che il
    // caso LEGGE invece di bloccarlo: qui si misura la garanzia, non il numero.
    const bitrateAudio = valoreDi(args, '-b:a')
    expect(bitrateAudio).toMatch(/^\d+k$/)
    const bpsAudio = Number(bitrateAudio.slice(0, -1)) * 1000
    const bitPeggiori =
      maxrate * MAX_VIDEO_DURATION_SECONDS + bufsize + bpsAudio * MAX_VIDEO_DURATION_SECONDS
    expect(bitPeggiori / 8).toBeLessThanOrEqual(MAX_VIDEO_INPUT_BYTES)

    // …e nemmeno un tetto così basso da degradare ogni video per mettersi al
    // sicuro: resta capped CRF, con CRF 18 a guidare e il tetto che morde solo nei
    // casi patologici. Abbassare la soglia per far passare un rosso è la forma in
    // cui questo caso smetterebbe di misurare qualcosa.
    expect(bitPeggiori / 8).toBeGreaterThan(MAX_VIDEO_INPUT_BYTES * 0.95)

    // La qualità continua a decidere il bitrate: il tetto è un tetto, non un target.
    expect(args).toEqual(expect.arrayContaining(['-crf', '18']))
    expect(args).not.toContain('-b:v')
  })

  it('non interpola metadati colore non fidati nel filtergraph', () => {
    const valoreNonFidato = 'bt2020,drawtext=text=eseguito'
    const args = buildVideoEncodeArgs(
      { ...probeBase, colorPrimaries: valoreNonFidato },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )

    expect(filterGraph(args)).not.toContain(valoreNonFidato)
    expect(filterGraph(args)).not.toContain('drawtext')
  })

  it.each([null, 'unknown', 'unspecified', 'reserved'])(
    'mantiene unspecified i metadati colore incompleti (%s)',
    (valoreIgnoto) => {
      const args = buildVideoEncodeArgs(
        {
          ...probeBase,
          colorTransfer: valoreIgnoto,
          colorPrimaries: valoreIgnoto,
          colorSpace: valoreIgnoto,
        },
        { channel: 'news', inputPath: '/tmp/in.avi', outputPath: '/tmp/out.mp4' },
      )

      expect(filterGraph(args)).not.toContain('zscale=')
      expect(args).toEqual(expect.arrayContaining([
        '-x264-params', 'colorprim=undef:transfer=undef:colormatrix=undef',
        '-color_primaries', 'unspecified',
        '-color_trc', 'unspecified',
        '-colorspace', 'unspecified',
      ]))
      expect(outputVideoColorMetadata({
        ...probeBase,
        colorTransfer: valoreIgnoto,
        colorPrimaries: valoreIgnoto,
        colorSpace: valoreIgnoto,
      })).toEqual({
        colorPrimaries: null,
        colorTransfer: null,
        colorSpace: null,
        colorRange: 'tv',
      })
    },
  )

  it('converte con swscale una matrice SDR esplicita quando primarie e transfer sono ignote', () => {
    const args = buildVideoEncodeArgs(
      {
        ...probeBase,
        colorTransfer: null,
        colorPrimaries: null,
        colorSpace: 'bt470bg',
      },
      { channel: 'news', inputPath: '/tmp/in.avi', outputPath: '/tmp/out.mp4' },
    )
    const graph = filterGraph(args)

    expect(graph).not.toContain('zscale=')
    expect(graph).toContain('in_color_matrix=bt470bg:out_color_matrix=bt709')
    expect(args).toEqual(expect.arrayContaining([
      '-x264-params', 'colorprim=undef:transfer=undef:colormatrix=bt709',
      '-color_primaries', 'unspecified',
      '-color_trc', 'unspecified',
      '-colorspace', 'bt709',
    ]))
    expect(outputVideoColorMetadata({
      ...probeBase,
      colorTransfer: null,
      colorPrimaries: null,
      colorSpace: 'bt470bg',
    })).toEqual({
      colorPrimaries: null,
      colorTransfer: null,
      colorSpace: 'bt709',
      colorRange: 'tv',
    })
  })

  it.each([
    {
      descrizione: 'sole primarie',
      colorTransfer: null,
      colorPrimaries: 'bt2020',
      colorSpace: null,
      x264: 'colorprim=bt2020:transfer=undef:colormatrix=undef',
    },
    {
      descrizione: 'solo transfer',
      colorTransfer: 'smpte170m',
      colorPrimaries: null,
      colorSpace: null,
      x264: 'colorprim=undef:transfer=smpte170m:colormatrix=undef',
    },
  ])('non dichiara una conversione BT.709 con $descrizione', ({ colorTransfer, colorPrimaries, colorSpace, x264 }) => {
    const args = buildVideoEncodeArgs(
      { ...probeBase, colorTransfer, colorPrimaries, colorSpace },
      { channel: 'news', inputPath: '/tmp/in.avi', outputPath: '/tmp/out.mp4' },
    )

    expect(filterGraph(args)).not.toContain('zscale=')
    expect(filterGraph(args)).not.toContain('out_color_matrix=bt709')
    expect(args).toEqual(expect.arrayContaining(['-x264-params', x264]))
    expect(outputVideoColorMetadata({
      ...probeBase,
      colorTransfer,
      colorPrimaries,
      colorSpace,
    })).toEqual({ colorPrimaries, colorTransfer, colorSpace, colorRange: 'tv' })
  })

  it(
    'transcodifica un MJPEG AVI con sola matrice bt470bg senza invocare zscale',
    (contesto) => {
      const binari = binariVideo(contesto)
      inCartellaTemporanea('kidville-mjpeg-sdr-', (directory) => {
        const inputPath = join(directory, 'input.avi')
        const outputPath = join(directory, 'output.mp4')

        generaFixture(
          binari,
          [
            '-f', 'lavfi',
            '-i', 'testsrc2=size=160x120:rate=1:duration=1',
            '-an',
            '-c:v', 'mjpeg',
            '-pix_fmt', 'yuvj420p',
            '-color_primaries', 'unspecified',
            '-color_trc', 'unspecified',
            '-colorspace', 'bt470bg',
            inputPath,
          ],
          'fixture MJPEG AVI con matrice bt470bg',
        )

        const args = buildVideoEncodeArgs(
          {
            ...probeBase,
            width: 160,
            height: 120,
            codedWidth: 160,
            codedHeight: 120,
            hasAudio: false,
            audioCodec: null,
            videoCodec: 'mjpeg',
            pixelFormat: 'yuvj420p',
            colorTransfer: null,
            colorPrimaries: null,
            colorSpace: 'bt470bg',
            videoStreamIndex: 0,
            audioStreamIndex: null,
          },
          { channel: 'news', inputPath, outputPath },
        )

        expect(filterGraph(args)).not.toContain('zscale=')
        eseguiFfmpeg(binari, args, 'transcodifica MJPEG')

        const streams = (sondaFfprobe(binari, outputPath) as {
          streams: Record<string, unknown>[]
        }).streams
        const video = streams.find((stream) => stream.codec_type === 'video')
        // Solo la matrice viaggia: swscale la porta a BT.709 e x264 la scrive nel VUI.
        // Primarie e transfer restano taciute, perché la sorgente non le dichiarava e
        // inventarle significherebbe dire al lettore un colore che nessuno ha misurato.
        expect(video).toMatchObject({ color_space: 'bt709' })
        expect(video?.color_transfer).toBeUndefined()
        expect(video?.color_primaries).toBeUndefined()
      })
    },
    30_000,
  )

  it('applica il watermark soltanto alla Galleria con geometria invariata', () => {
    const gallery = buildVideoEncodeArgs(probeBase, {
      channel: 'gallery',
      inputPath: '/tmp/in.mov',
      outputPath: '/tmp/out.mp4',
      watermarkPath: '/app/public/watermark.png',
    })
    const news = buildVideoEncodeArgs(probeBase, {
      channel: 'news',
      inputPath: '/tmp/in.mov',
      outputPath: '/tmp/out.mp4',
    })

    expect(gallery).toEqual(expect.arrayContaining(['-i', '/app/public/watermark.png']))
    expect(filterGraph(gallery)).toContain('scale=1344:-2:flags=lanczos,setsar=1[wm]')
    expect(filterGraph(gallery)).not.toContain('scale2ref')
    expect(filterGraph(gallery)).toContain("overlay=x='(main_w-overlay_w)/2':y='main_h-overlay_h-main_h*0.05'")
    expect(news).not.toContain('/app/public/watermark.png')
    expect(filterGraph(news)).not.toContain('overlay=')
  })

  it('rende il watermark al 70% del video mantenendo il rapporto del logo', (contesto) => {
    const binari = binariVideo(contesto)
    const args = buildVideoEncodeArgs(
      {
        ...probeBase,
        width: 640,
        height: 360,
        codedWidth: 640,
        codedHeight: 360,
        hasAudio: false,
        audioCodec: null,
        videoStreamIndex: 0,
        audioStreamIndex: null,
      },
      {
        channel: 'gallery',
        inputPath: '/tmp/in.mp4',
        outputPath: '/tmp/out.mp4',
        watermarkPath: '/tmp/watermark.png',
      },
    )
    const graphConBbox = `${filterGraph(args).replace(/\[vout\]$/, '[composited]')};[composited]bbox=min_val=32[vout]`
    const stderr = eseguiFfmpeg(
      binari,
      [
        '-hide_banner',
        '-loglevel', 'info',
        '-f', 'lavfi',
        '-i', 'color=c=black:s=640x360:r=1:d=1',
        '-f', 'lavfi',
        '-i', 'color=c=white:s=100x20:r=1:d=1',
        '-filter_complex', graphConBbox,
        '-map', '[vout]',
        '-frames:v', '1',
        '-f', 'null',
        '-',
      ],
      'misura del watermark col filtro bbox',
    )

    const bbox = stderr.match(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/)
    expect(bbox?.slice(1).map(Number)).toEqual([96, 543, 252, 341, 448, 90])
  }, 30_000)

  it('rifiuta una Galleria senza watermark', () => {
    expect(() => buildVideoEncodeArgs(probeBase, {
      channel: 'gallery',
      inputPath: '/tmp/in.mov',
      outputPath: '/tmp/out.mp4',
    } as VideoEncodeOptions)).toThrow('watermarkPath')
  })

  it('disabilita audio quando il probe non ne trova uno', () => {
    const args = buildVideoEncodeArgs(
      { ...probeBase, hasAudio: false, audioCodec: null, audioStreamIndex: null },
      { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' },
    )

    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(args).not.toContain('0:3')
  })
})
