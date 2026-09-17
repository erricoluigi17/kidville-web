import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildVideoEncodeArgs,
  outputVideoColorMetadata,
  type VideoEncodeOptions,
} from '@/lib/media/video/encode'
import type { VideoProbe } from '@/lib/media/video/probe'

const ffmpegDisponibile = (() => {
  const risultato = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  return risultato.status === 0
})()

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

  it.runIf(ffmpegDisponibile)(
    'transcodifica un MJPEG AVI con sola matrice bt470bg senza invocare zscale',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'kidville-mjpeg-sdr-'))
      const inputPath = join(directory, 'input.avi')
      const outputPath = join(directory, 'output.mp4')

      try {
        const fixture = spawnSync('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-f', 'lavfi',
          '-i', 'testsrc2=size=160x120:rate=1:duration=1',
          '-an',
          '-c:v', 'mjpeg',
          '-pix_fmt', 'yuvj420p',
          '-color_primaries', 'unspecified',
          '-color_trc', 'unspecified',
          '-colorspace', 'bt470bg',
          '-y', inputPath,
        ], { encoding: 'utf8' })
        expect(fixture.status, fixture.stderr).toBe(0)

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
        const risultato = spawnSync('ffmpeg', args, { encoding: 'utf8' })
        expect(risultato.status, risultato.stderr).toBe(0)

        const verifica = spawnSync('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=color_space,color_transfer,color_primaries',
          '-of', 'json',
          outputPath,
        ], { encoding: 'utf8' })
        expect(verifica.status, verifica.stderr).toBe(0)
        expect(JSON.parse(verifica.stdout).streams[0]).toEqual({ color_space: 'bt709' })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    15_000,
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

  it.runIf(ffmpegDisponibile)('rende il watermark al 70% del video mantenendo il rapporto del logo', () => {
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
    const risultato = spawnSync('ffmpeg', [
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
    ], { encoding: 'utf8' })

    expect(risultato.status, risultato.stderr).toBe(0)
    const bbox = risultato.stderr.match(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/)
    expect(bbox?.slice(1).map(Number)).toEqual([96, 543, 252, 341, 448, 90])
  })

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
