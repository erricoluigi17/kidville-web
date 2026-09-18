import { describe, expect, it } from 'vitest'

import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_INPUT_BYTES,
  SUPPORTED_VIDEO_CODECS,
  SUPPORTED_VIDEO_CONTAINERS,
  validateVideoInputSize,
} from '@/lib/media/video/limiti'
import { parseVideoProbe } from '@/lib/media/video/probe'

const FFPROBE_H264 = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      codec_type: 'video',
      width: 1920,
      height: 1080,
      coded_width: 1920,
      coded_height: 1088,
      pix_fmt: 'yuv420p',
      avg_frame_rate: '30000/1001',
      r_frame_rate: '30000/1001',
      duration: '12.512500',
      sample_aspect_ratio: '1:1',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_space: 'bt709',
      disposition: { default: 1, attached_pic: 0 },
    },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.512500',
  },
}

function cloneProbe(): typeof FFPROBE_H264 {
  return structuredClone(FFPROBE_H264)
}

describe('validateVideoInputSize', () => {
  it('accetta esattamente 2.000.000.000 byte e rifiuta il byte successivo', () => {
    expect(validateVideoInputSize(MAX_VIDEO_INPUT_BYTES)).toEqual({ ok: true })
    expect(validateVideoInputSize(MAX_VIDEO_INPUT_BYTES + 1)).toEqual({
      ok: false,
      code: 'FILE_TOO_LARGE',
    })
  })

  it('rifiuta file vuoto con un codice distinto', () => {
    expect(validateVideoInputSize(0)).toEqual({ ok: false, code: 'EMPTY_FILE' })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rifiuta la dimensione malformata %s',
    (bytes) => {
      expect(validateVideoInputSize(bytes)).toEqual({
        ok: false,
        code: 'INVALID_FILE_SIZE',
      })
    },
  )
})

describe('parseVideoProbe', () => {
  it('estrae il probe reale di un MP4 H.264 senza dipendere dal nome file', () => {
    expect(parseVideoProbe(FFPROBE_H264, 20_000_000)).toEqual({
      ok: true,
      probe: {
        durationSeconds: 12.5125,
        videoDurationSeconds: 12.5125,
        audioDurationSeconds: null,
        width: 1920,
        height: 1080,
        codedWidth: 1920,
        codedHeight: 1088,
        rotation: 0,
        fps: 30000 / 1001,
        hasAudio: false,
        audioCodec: null,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709',
        colorSpace: 'bt709',
        isHdr: false,
        videoStreamIndex: 0,
        audioStreamIndex: null,
      },
    })
  })

  it('accetta 180 secondi inclusi e rifiuta anche un epsilon oltre', () => {
    const atLimit = cloneProbe()
    atLimit.streams[0].duration = String(MAX_VIDEO_DURATION_SECONDS)
    atLimit.format.duration = String(MAX_VIDEO_DURATION_SECONDS)
    expect(parseVideoProbe(atLimit, 1)).toMatchObject({ ok: true })

    const overLimit = cloneProbe()
    overLimit.streams[0].duration = '180.000001'
    overLimit.format.duration = '180.000001'
    expect(parseVideoProbe(overLimit, 1)).toEqual({
      ok: false,
      code: 'VIDEO_TOO_LONG',
    })
  })

  it('usa la durata massima tra container, video e audio per non accettare code nascoste', () => {
    const raw = cloneProbe()
    raw.streams[0].duration = '179.5'
    raw.format.duration = '179.75'
    raw.streams.push({
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
      duration: '180.000001',
      disposition: { default: 1 },
    } as (typeof raw.streams)[number])

    expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'VIDEO_TOO_LONG' })
  })

  it('include i tag DURATION Matroska nel massimo delle durate', () => {
    const raw = cloneProbe()
    raw.format.format_name = 'matroska,webm'
    raw.streams[0].duration = 'N/A'
    raw.format.duration = '179'
    ;(raw.streams[0] as Record<string, unknown>).tags = {
      DURATION: '00:03:01.000000000',
    }

    expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'VIDEO_TOO_LONG' })
  })

  it('usa un tag DURATION valido anche quando e la sola fonte di durata', () => {
    const raw = cloneProbe()
    raw.format.format_name = 'matroska,webm'
    raw.streams[0].duration = 'N/A'
    raw.format.duration = 'N/A'
    ;(raw.streams[0] as Record<string, unknown>).tags = {
      DURATION: '00:02:59.125000000',
    }

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { durationSeconds: 179.125 },
    })
  })

  it.each(['2:59', '00:61:00', '00:00:00', '179']) (
    'non interpreta per assunzione il tag DURATION malformato %s',
    (durationTag) => {
      const raw = cloneProbe()
      raw.streams[0].duration = 'N/A'
      raw.format.duration = 'N/A'
      ;(raw.streams[0] as Record<string, unknown>).tags = { DURATION: durationTag }

      expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'UNKNOWN_DURATION' })
    },
  )

  it('usa la durata valida disponibile senza stimarla dai byte', () => {
    const onlyContainerDuration = cloneProbe()
    onlyContainerDuration.streams[0].duration = 'N/A'
    onlyContainerDuration.format.duration = '42.25'
    expect(parseVideoProbe(onlyContainerDuration, 1)).toMatchObject({
      ok: true,
      probe: { durationSeconds: 42.25 },
    })

    const unknown = cloneProbe()
    unknown.streams[0].duration = 'N/A'
    unknown.format.duration = 'NaN'
    expect(parseVideoProbe(unknown, 900_000_000)).toEqual({
      ok: false,
      code: 'UNKNOWN_DURATION',
    })
  })

  it('ricava la durata dai timestamp ffprobe quando duration è N/A', () => {
    const raw = cloneProbe()
    raw.streams[0].duration = 'N/A'
    raw.format.duration = 'N/A'
    ;(raw.streams[0] as Record<string, unknown>).duration_ts = 270_000
    ;(raw.streams[0] as Record<string, unknown>).time_base = '1/90000'
    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { durationSeconds: 3 },
    })
  })

  it('espone separatamente le durate video e audio, usando anche duration_ts e tag DURATION', () => {
    const raw = cloneProbe()
    raw.streams[0].duration = 'N/A'
    ;(raw.streams[0] as Record<string, unknown>).duration_ts = 900_000
    ;(raw.streams[0] as Record<string, unknown>).time_base = '1/90000'
    raw.streams.push({
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
      duration: 'N/A',
      tags: { DURATION: '00:00:08.000000000' },
      disposition: { default: 1 },
    } as unknown as (typeof raw.streams)[number])

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: {
        durationSeconds: 12.5125,
        videoDurationSeconds: 10,
        audioDurationSeconds: 8,
      },
    })
  })

  it('espone null quando ffprobe non conosce la durata della singola traccia', () => {
    const raw = cloneProbe()
    raw.streams[0].duration = 'N/A'

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: {
        durationSeconds: 12.5125,
        videoDurationSeconds: null,
        audioDurationSeconds: null,
      },
    })
  })

  it('applica il SAR e poi la rotazione Display Matrix alle dimensioni visive', () => {
    const raw = cloneProbe()
    raw.streams[0].width = 720
    raw.streams[0].height = 576
    raw.streams[0].coded_width = 720
    raw.streams[0].coded_height = 576
    raw.streams[0].sample_aspect_ratio = '16:15'
    ;(raw.streams[0] as Record<string, unknown>).side_data_list = [
      { side_data_type: 'Display Matrix', rotation: -90 },
    ]

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: {
        width: 576,
        height: 768,
        codedWidth: 720,
        codedHeight: 576,
        rotation: 270,
      },
    })
  })

  it('normalizza il SAR 0:1 sconosciuto come pixel quadrati', () => {
    const raw = cloneProbe()
    raw.streams[0].sample_aspect_ratio = '0:1'

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { width: 1920, height: 1080 },
    })
  })

  it('per un VFR usa avg_frame_rate razionale, non il rate nominale', () => {
    const raw = cloneProbe()
    raw.streams[0].avg_frame_rate = '24000/1001'
    raw.streams[0].r_frame_rate = '60/1'
    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { fps: 24000 / 1001 },
    })
  })

  it('estrae HDR e audio dal flusso predefinito', () => {
    const raw = cloneProbe()
    raw.streams[0].pix_fmt = 'yuv420p10le'
    raw.streams[0].color_transfer = 'smpte2084'
    raw.streams[0].color_primaries = 'bt2020'
    raw.streams[0].color_space = 'bt2020nc'
    raw.streams.push(
      {
        index: 1,
        codec_name: 'mp3',
        codec_type: 'audio',
        duration: '12.5',
        disposition: { default: 0 },
      } as (typeof raw.streams)[number],
      {
        index: 2,
        codec_name: 'aac',
        codec_type: 'audio',
        duration: '12.5',
        disposition: { default: 1 },
      } as (typeof raw.streams)[number],
    )

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: {
        pixelFormat: 'yuv420p10le',
        colorTransfer: 'smpte2084',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc',
        isHdr: true,
        hasAudio: true,
        audioCodec: 'aac',
        audioStreamIndex: 2,
      },
    })
  })

  it('rifiuta un flusso audio con codec sconosciuto con codice stabile', () => {
    const raw = cloneProbe()
    raw.streams.push({
      index: 1,
      codec_name: 'N/A',
      codec_type: 'audio',
      duration: '12.5',
      disposition: { default: 1 },
    } as (typeof raw.streams)[number])

    expect(parseVideoProbe(raw, 1)).toEqual({
      ok: false,
      code: 'UNKNOWN_AUDIO_CODEC',
    })
  })

  it('rifiuta indici duplicati tra i flussi video e audio selezionati', () => {
    const raw = cloneProbe()
    raw.streams.push({
      index: 0,
      codec_name: 'aac',
      codec_type: 'audio',
      duration: '12.5',
      disposition: { default: 1 },
    } as (typeof raw.streams)[number])

    expect(parseVideoProbe(raw, 1)).toEqual({
      ok: false,
      code: 'DUPLICATE_STREAM_INDEX',
    })
  })

  it('ignora le copertine attached_pic e sceglie il flusso video predefinito', () => {
    const primary = cloneProbe().streams[0]
    primary.index = 3
    const secondary = { ...primary, index: 2, disposition: { default: 0, attached_pic: 0 } }
    const cover = {
      ...primary,
      index: 0,
      codec_name: 'mjpeg',
      disposition: { default: 1, attached_pic: 1 },
    }
    const raw = {
      ...cloneProbe(),
      streams: [cover, secondary, primary],
    }

    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { videoCodec: 'h264', videoStreamIndex: 3 },
    })
  })

  it('accetta anche il JSON testuale prodotto da ffprobe', () => {
    expect(parseVideoProbe(JSON.stringify(FFPROBE_H264), 1)).toMatchObject({
      ok: true,
      probe: { videoCodec: 'h264' },
    })
  })

  it('rifiuta un errore ffprobe esplicito anche se sono presenti metadati validi', () => {
    const raw = {
      ...cloneProbe(),
      error: {
        code: -1094995529,
        string: 'Invalid data found when processing input',
      },
    }

    expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'FFPROBE_ERROR' })
    expect(
      parseVideoProbe(
        { error: { code: -1094995529, string: 'Invalid data found when processing input' } },
        1,
      ),
    ).toEqual({ ok: false, code: 'FFPROBE_ERROR' })
  })

  it.each([
    [null, 'INVALID_PROBE'],
    ['{rotto', 'INVALID_PROBE'],
    [{ streams: [] }, 'INVALID_PROBE'],
    [{ streams: [null], format: FFPROBE_H264.format }, 'INVALID_PROBE'],
    [{ ...FFPROBE_H264, streams: [] }, 'MISSING_VIDEO_STREAM'],
  ] as const)('rifiuta un probe strutturalmente invalido con codice stabile', (raw, code) => {
    expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code })
  })

  it('propaga i codici della validazione dimensione prima di leggere il probe', () => {
    expect(parseVideoProbe(null, 0)).toEqual({ ok: false, code: 'EMPTY_FILE' })
    expect(parseVideoProbe(null, Number.NaN)).toEqual({
      ok: false,
      code: 'INVALID_FILE_SIZE',
    })
    expect(parseVideoProbe(null, MAX_VIDEO_INPUT_BYTES + 1)).toEqual({
      ok: false,
      code: 'FILE_TOO_LARGE',
    })
  })

  it('non usa filename o estensione per far passare un container sconosciuto', () => {
    const raw = cloneProbe()
    raw.format.format_name = 'image2'
    ;(raw.format as Record<string, unknown>).filename = 'sembra-un-video.mp4'
    expect(parseVideoProbe(raw, 1)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_CONTAINER',
    })
  })

  it('distingue codec video non supportato e assenza del flusso video', () => {
    const unsupported = cloneProbe()
    unsupported.streams[0].codec_name = 'mjpeg'
    expect(parseVideoProbe(unsupported, 1)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_VIDEO_CODEC',
    })

    const onlyAudio = cloneProbe()
    onlyAudio.streams = [
      {
        index: 0,
        codec_name: 'aac',
        codec_type: 'audio',
        duration: '2',
        disposition: { default: 1 },
      } as (typeof onlyAudio.streams)[number],
    ]
    expect(parseVideoProbe(onlyAudio, 1)).toEqual({
      ok: false,
      code: 'MISSING_VIDEO_STREAM',
    })
  })

  it.each([
    { field: 'is_encrypted', value: 1 },
    { field: 'codec_tag_string', value: 'encv' },
  ])('rifiuta stream cifrati rilevati da $field', ({ field, value }) => {
    const raw = cloneProbe()
    ;(raw.streams[0] as Record<string, unknown>)[field] = value
    expect(parseVideoProbe(raw, 1)).toEqual({
      ok: false,
      code: 'ENCRYPTED_VIDEO',
    })
  })

  it('rifiuta cifratura segnalata nei tag o nei side data', () => {
    const tagged = cloneProbe()
    ;(tagged.format as Record<string, unknown>).tags = { encryption_scheme: 'cenc' }
    expect(parseVideoProbe(tagged, 1)).toEqual({
      ok: false,
      code: 'ENCRYPTED_VIDEO',
    })

    const sideData = cloneProbe()
    ;(sideData.streams[0] as Record<string, unknown>).side_data_list = [
      { side_data_type: 'Encryption initialization data' },
    ]
    expect(parseVideoProbe(sideData, 1)).toEqual({
      ok: false,
      code: 'ENCRYPTED_VIDEO',
    })
  })

  it('non confonde un flag encrypted esplicitamente falso con un file cifrato', () => {
    const raw = cloneProbe()
    ;(raw.format as Record<string, unknown>).tags = { encrypted: 'false' }
    expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true })
  })

  it('rifiuta razionali, SAR, rotazione e dimensioni malformati o in overflow', () => {
    for (const mutate of [
      (raw: typeof FFPROBE_H264) => {
        raw.streams[0].avg_frame_rate = '9007199254740992/1'
        raw.streams[0].r_frame_rate = '0/0'
      },
      (raw: typeof FFPROBE_H264) => {
        raw.streams[0].sample_aspect_ratio = '999999999999999999999:1'
      },
      (raw: typeof FFPROBE_H264) => {
        ;(raw.streams[0] as Record<string, unknown>).side_data_list = [
          { side_data_type: 'Display Matrix', rotation: 'non-un-numero' },
        ]
      },
      (raw: typeof FFPROBE_H264) => {
        ;(raw.streams[0] as Record<string, unknown>).width = Number.POSITIVE_INFINITY
      },
    ]) {
      const raw = cloneProbe()
      mutate(raw)
      expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'INVALID_PROBE' })
    }
  })

  it('riconosce HDR anche dai metadati mastering quando il transfer manca', () => {
    const raw = cloneProbe()
    ;(raw.streams[0] as Record<string, unknown>).color_transfer = 'N/A'
    ;(raw.streams[0] as Record<string, unknown>).side_data_list = [
      { side_data_type: 'Mastering display metadata' },
    ]
    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { colorTransfer: null, isHdr: true },
    })
  })

  it('calcola il riquadro visivo anche per una rotazione non ortogonale', () => {
    const raw = cloneProbe()
    raw.streams[0].width = 100
    raw.streams[0].height = 50
    raw.streams[0].coded_width = 100
    raw.streams[0].coded_height = 50
    ;(raw.streams[0] as Record<string, unknown>).side_data_list = [
      { side_data_type: 'Display Matrix', rotation: 45 },
    ]
    expect(parseVideoProbe(raw, 1)).toMatchObject({
      ok: true,
      probe: { width: 106, height: 106, rotation: 45 },
    })
  })
})

describe('matrice input video', () => {
  it('dichiara tutti i container ffprobe richiesti', () => {
    expect(SUPPORTED_VIDEO_CONTAINERS).toEqual(
      expect.arrayContaining([
        'mp4',
        'mov',
        'm4v',
        'webm',
        'matroska',
        'avi',
        'asf',
        'mpeg',
        '3gp',
        'flv',
        'ogg',
        'mpegts',
        'mxf',
      ]),
    )
  })

  it('dichiara i nomi reali dei decoder richiesti, HEVC Main 10 compreso', () => {
    expect(SUPPORTED_VIDEO_CODECS).toEqual(
      expect.arrayContaining([
        'h264',
        'hevc',
        'vp8',
        'vp9',
        'av1',
        'prores',
        'dnxhd',
        'mpeg1video',
        'mpeg2video',
        'mpeg4',
        'h263',
        'theora',
        'wmv1',
        'wmv2',
        'wmv3',
        'vc1',
        'flv1',
      ]),
    )

    const hevcMain10 = cloneProbe()
    hevcMain10.streams[0].codec_name = 'hevc'
    ;(hevcMain10.streams[0] as Record<string, unknown>).profile = 'Main 10'
    expect(parseVideoProbe(hevcMain10, 1)).toMatchObject({
      ok: true,
      probe: { videoCodec: 'hevc' },
    })
  })

  it.each([
    'mov,mp4,m4a,3gp,3g2,mj2',
    'm4v',
    'matroska,webm',
    'avi',
    'asf',
    'mpeg',
    'flv',
    'ogg',
    'mpegts',
    'mxf',
  ])('accetta il format_name ffprobe %s', (formatName) => {
    const raw = cloneProbe()
    raw.format.format_name = formatName
    expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true })
  })

  it.each([
    'h264',
    'hevc',
    'vp8',
    'vp9',
    'av1',
    'prores',
    'dnxhd',
    'mpeg1video',
    'mpeg2video',
    'mpeg4',
    'h263',
    'theora',
    'wmv1',
    'wmv2',
    'wmv3',
    'vc1',
    'flv1',
  ])('accetta il codec_name ffprobe %s', (codecName) => {
    const raw = cloneProbe()
    raw.streams[0].codec_name = codecName
    expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true })
  })

  it('non dichiara alias assenti dagli inventari della build FFmpeg fissata', () => {
    expect(SUPPORTED_VIDEO_CODECS).not.toEqual(expect.arrayContaining(['dnxhr', 'wmv']))
    expect(SUPPORTED_VIDEO_CONTAINERS).not.toContain('mxf_d10')
  })
})
