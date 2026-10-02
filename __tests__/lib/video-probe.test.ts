import { describe, expect, it } from 'vitest'

import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_INPUT_BYTES,
  SUPPORTED_VIDEO_CODECS,
  SUPPORTED_VIDEO_CONTAINERS,
  validateVideoInputSize,
} from '@/lib/media/video/limiti'
import { buildVideoEncodeArgs } from '@/lib/media/video/encode'
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

/** Un tag `DURATION` Matroska (`HH:MM:SS.nnnnnnnnn`) per un numero intero di secondi. */
function tagDurataOrologio(secondi: number): string {
  const ore = Math.floor(secondi / 3600)
  const minuti = Math.floor((secondi % 3600) / 60)
  const resto = secondi % 60
  const due = (n: number) => String(n).padStart(2, '0')
  return `${due(ore)}:${due(minuti)}:${due(resto)}.000000000`
}

type TracciaGrezza = Record<string, unknown>

/** Un probe con il solo video e le tracce audio che si dicono, nell'ordine in cui si dicono. */
function conTracceAudio(...tracce: TracciaGrezza[]): { streams: TracciaGrezza[]; format: Record<string, unknown> } {
  const raw = cloneProbe() as unknown as { streams: TracciaGrezza[]; format: Record<string, unknown> }
  raw.streams.push(...tracce)
  return raw
}

/** `codec: undefined` è il caso vero di ffprobe per un codec che non conosce: il campo manca. */
function tracciaAudio(index: number, codec: string | undefined, predefinita: 0 | 1, extra: TracciaGrezza = {}): TracciaGrezza {
  return {
    index,
    codec_type: 'audio',
    ...(codec === undefined ? {} : { codec_name: codec }),
    duration: '12.5',
    disposition: { default: predefinita },
    ...extra,
  }
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
        ignoredAudioTracks: 0,
      },
    })
  })

  it('accetta la durata massima inclusa e rifiuta anche un epsilon oltre', () => {
    const atLimit = cloneProbe()
    atLimit.streams[0].duration = String(MAX_VIDEO_DURATION_SECONDS)
    atLimit.format.duration = String(MAX_VIDEO_DURATION_SECONDS)
    expect(parseVideoProbe(atLimit, 1)).toMatchObject({ ok: true })

    const overLimit = cloneProbe()
    overLimit.streams[0].duration = String(MAX_VIDEO_DURATION_SECONDS + 0.000001)
    overLimit.format.duration = String(MAX_VIDEO_DURATION_SECONDS + 0.000001)
    expect(parseVideoProbe(overLimit, 1)).toEqual({
      ok: false,
      code: 'VIDEO_TOO_LONG',
    })
  })

  it('usa la durata massima tra container, video e audio per non accettare code nascoste', () => {
    const raw = cloneProbe()
    raw.streams[0].duration = String(MAX_VIDEO_DURATION_SECONDS - 0.5)
    raw.format.duration = String(MAX_VIDEO_DURATION_SECONDS - 0.25)
    raw.streams.push({
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
      duration: String(MAX_VIDEO_DURATION_SECONDS + 0.000001),
      disposition: { default: 1 },
    } as (typeof raw.streams)[number])

    expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'VIDEO_TOO_LONG' })
  })

  it('include i tag DURATION Matroska nel massimo delle durate', () => {
    const raw = cloneProbe()
    raw.format.format_name = 'matroska,webm'
    raw.streams[0].duration = 'N/A'
    raw.format.duration = String(MAX_VIDEO_DURATION_SECONDS - 1)
    ;(raw.streams[0] as Record<string, unknown>).tags = {
      DURATION: tagDurataOrologio(MAX_VIDEO_DURATION_SECONDS + 1),
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
        ignoredAudioTracks: 1,
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

/* ════════════════════════════════════════════════════════════════════════════
 * LA TRACCIA AUDIO DA CONVERTIRE (02/10/2026)
 *
 * Prima si prendeva la predefinita e basta, e se il suo codec era ignoto — `codec_name` assente nel JSON
 * di ffprobe — tutto il video finiva in `UNKNOWN_AUDIO_CODEC`, anche con una traccia AAC perfetta
 * accanto. Adesso si sceglie fra le tracce DECODIFICABILI (la predefinita, in mancanza la prima), le altre
 * non si convertono e si contano, e quel codice esce solo se nessuna traccia si sa decodificare.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('la traccia audio da convertire', () => {
  /**
   * Il JSON REALE di ffprobe 8.1.2 su un MOV con tre tracce: video H.264, un'audio dal FourCC inventato
   * (`xyzw`, predefinita) e un'audio AAC. Generato il 02/10/2026 con ffmpeg e `-strict unofficial
   * -tag:a xyzw`, tenuto ai soli campi che il parser legge più l'identità delle tracce. Il fatto che
   * conta: la traccia ignota NON ha `codec_name`.
   */
  const FFPROBE_MOV_AUDIO_IGNOTO = {
    streams: [
      {
        index: 0, codec_name: 'h264', codec_type: 'video', codec_tag_string: 'avc1',
        width: 320, height: 240, coded_width: 320, coded_height: 240, pix_fmt: 'yuv420p',
        avg_frame_rate: '30/1', r_frame_rate: '30/1', time_base: '1/15360', duration: '2.000000',
        disposition: { default: 1, attached_pic: 0 },
      },
      {
        index: 1, codec_type: 'audio', codec_tag_string: 'xyzw', sample_rate: '44100', channels: 1,
        time_base: '1/44100', duration: '2.000000', disposition: { default: 1, attached_pic: 0 },
      },
      {
        index: 2, codec_name: 'aac', codec_type: 'audio', codec_tag_string: 'mp4a', sample_rate: '44100', channels: 1,
        time_base: '1/44100', duration: '2.000000', disposition: { default: 0, attached_pic: 0 },
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000000', nb_streams: 3 },
  }

  it('la forma VERA di ffprobe: la predefinita ha il codec ignoto, l’AAC accanto viene scelta e l’altra si conta', () => {
    expect(FFPROBE_MOV_AUDIO_IGNOTO.streams[1]).not.toHaveProperty('codec_name')
    expect(parseVideoProbe(FFPROBE_MOV_AUDIO_IGNOTO, 1)).toMatchObject({
      ok: true,
      probe: { hasAudio: true, audioCodec: 'aac', audioStreamIndex: 2, ignoredAudioTracks: 1, videoStreamIndex: 0 },
    })
  })

  it('con il codec della predefinita sconosciuto sceglie la prima traccia decodificabile, in qualunque ordine', () => {
    const ignotaPrima = conTracceAudio(tracciaAudio(1, undefined, 1), tracciaAudio(2, 'aac', 0))
    expect(parseVideoProbe(ignotaPrima, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 2, audioCodec: 'aac', ignoredAudioTracks: 1 } })
    const ignotaDopo = conTracceAudio(tracciaAudio(1, 'aac', 0), tracciaAudio(2, undefined, 1))
    // La predefinita è quella ignota, ma non si sa decodificare: vale l'unica che si sa.
    expect(parseVideoProbe(ignotaDopo, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 1, audioCodec: 'aac', ignoredAudioTracks: 1 } })
  })

  it.each(['unknown', 'none', 'unknown_codec', 'N/A', '', '   ', 'UNKNOWN'])('il codec «%s» non è un codec: la traccia non è decodificabile', nome => {
    const sola = conTracceAudio(tracciaAudio(1, nome, 1))
    expect(parseVideoProbe(sola, 1)).toEqual({ ok: false, code: 'UNKNOWN_AUDIO_CODEC' })
    const conAac = conTracceAudio(tracciaAudio(1, nome, 1), tracciaAudio(2, 'aac', 0))
    expect(parseVideoProbe(conAac, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 2, ignoredAudioTracks: 1 } })
  })

  it('UNKNOWN_AUDIO_CODEC esce solo se NESSUNA traccia si sa decodificare, qualunque ne sia il numero', () => {
    expect(parseVideoProbe(conTracceAudio(tracciaAudio(1, undefined, 1)), 1)).toEqual({ ok: false, code: 'UNKNOWN_AUDIO_CODEC' })
    expect(parseVideoProbe(conTracceAudio(tracciaAudio(1, undefined, 1), tracciaAudio(2, 'N/A', 0), tracciaAudio(3, 'unknown', 0)), 1))
      .toEqual({ ok: false, code: 'UNKNOWN_AUDIO_CODEC' })
  })

  it('fra più tracce decodificabili vale la predefinita; senza predefinita, la prima', () => {
    const conPredefinita = conTracceAudio(tracciaAudio(1, 'mp3', 0), tracciaAudio(2, 'aac', 1), tracciaAudio(3, 'opus', 0))
    expect(parseVideoProbe(conPredefinita, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 2, audioCodec: 'aac', ignoredAudioTracks: 2 } })
    const senza = conTracceAudio(tracciaAudio(1, 'mp3', 0), tracciaAudio(2, 'aac', 0))
    expect(parseVideoProbe(senza, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 1, audioCodec: 'mp3', ignoredAudioTracks: 1 } })
  })

  it('un video senza audio resta valido: nessuna traccia scelta, nessuna ignorata', () => {
    expect(parseVideoProbe(cloneProbe(), 1)).toMatchObject({
      ok: true,
      probe: { hasAudio: false, audioCodec: null, audioStreamIndex: null, audioDurationSeconds: null, ignoredAudioTracks: 0 },
    })
  })

  it('una traccia ignorata non rovina la scelta, nemmeno con un indice malformato; la scelta malformata sì', () => {
    const ignoratamalformata = conTracceAudio(tracciaAudio(1, undefined, 1, { index: 'uno' }), tracciaAudio(2, 'aac', 0))
    expect(parseVideoProbe(ignoratamalformata, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 2 } })
    const sceltaMalformata = conTracceAudio(tracciaAudio(1, 'aac', 1, { index: 'uno' }))
    expect(parseVideoProbe(sceltaMalformata, 1)).toEqual({ ok: false, code: 'INVALID_PROBE' })
  })

  it('l’indice uguale a quello del video, sulla traccia scelta, resta DUPLICATE_STREAM_INDEX', () => {
    expect(parseVideoProbe(conTracceAudio(tracciaAudio(0, undefined, 1), tracciaAudio(0, 'aac', 0)), 1))
      .toEqual({ ok: false, code: 'DUPLICATE_STREAM_INDEX' })
  })

  it('la durata della traccia audio è quella della traccia SCELTA, non quella di una ignorata', () => {
    const raw = conTracceAudio(
      tracciaAudio(1, undefined, 1, { duration: '12.5' }),
      tracciaAudio(2, 'aac', 0, { duration: '11.25' }),
    )
    expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true, probe: { audioStreamIndex: 2, audioDurationSeconds: 11.25 } })
  })

  describe('la durata del filmato NON conta le tracce audio ignorate (secondario #13, PR 2)', () => {
    // La traccia ignorata non finisce nell'uscita: se una più lunga decidesse il massimo, una registrazione di 12 s con una seconda traccia
    // dal formato proprietario di 400 s sarebbe scartata come `VIDEO_TOO_LONG` — un video che si convertirebbe benissimo — e, sotto il
    // tetto, `video_job_ready` registrerebbe una durata che l'uscita non ha (l'uscita risulterebbe più corta del suo ingresso).
    const DURATA_VIDEO = 12.5125

    it('un audio ignorato di 400 s (oltre il tetto di 300) NON scarta il video: la durata è quella di contenitore, video e audio scelto', () => {
      const raw = conTracceAudio(
        tracciaAudio(1, undefined, 1, { duration: '400' }),
        tracciaAudio(2, 'aac', 0, { duration: '11.25' }),
      )
      const esito = parseVideoProbe(raw, 1)

      expect(esito).toMatchObject({ ok: true, probe: { durationSeconds: DURATA_VIDEO, audioStreamIndex: 2, ignoredAudioTracks: 1 } })
    })

    it('una traccia ignorata più lunga delle altre non allunga la durata, nemmeno SOTTO il tetto', () => {
      const raw = conTracceAudio(
        tracciaAudio(1, undefined, 1, { duration: '120' }),
        tracciaAudio(2, 'aac', 0, { duration: '11.25' }),
      )
      expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true, probe: { durationSeconds: DURATA_VIDEO } })
    })

    it('la traccia audio SCELTA conta eccome: se è più lunga del video, la durata è la sua', () => {
      const raw = conTracceAudio(
        tracciaAudio(1, undefined, 1, { duration: '400' }),
        tracciaAudio(2, 'aac', 0, { duration: '14.5' }),
      )
      expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true, probe: { durationSeconds: 14.5, audioDurationSeconds: 14.5 } })
    })

    it('anche il tag `DURATION` (Matroska) di una traccia ignorata resta fuori dal massimo', () => {
      const raw = conTracceAudio(
        tracciaAudio(1, undefined, 1, { duration: undefined, tags: { DURATION: tagDurataOrologio(400) } }),
        tracciaAudio(2, 'aac', 0, { duration: '11.25' }),
      )
      expect(parseVideoProbe(raw, 1)).toMatchObject({ ok: true, probe: { durationSeconds: DURATA_VIDEO } })
    })

    it('la stessa traccia, se NON è ignorata (è la sola, ed è decodificabile), conta e scarta il video oltre il tetto: la regola non cambia, cambia chi è ignorato', () => {
      const raw = conTracceAudio(tracciaAudio(1, 'aac', 1, { duration: '400' }))
      expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'VIDEO_TOO_LONG' })
    })

    it('il LIMITE dichiarato: il contenitore conta ancora. Se `format.duration` porta già i 400 s, il video è scartato lo stesso', () => {
      // `format.duration` per un MP4 o un MOV è il massimo di TUTTE le tracce, ignorate comprese: escluderle dalla lista delle tracce non
      // lo cambia. Togliere anche il contenitore sarebbe un'altra decisione (si perderebbe il tetto sui flussi che mentono).
      const raw = conTracceAudio(
        tracciaAudio(1, undefined, 1, { duration: '400' }),
        tracciaAudio(2, 'aac', 0, { duration: '11.25' }),
      )
      raw.format.duration = '400'
      expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'VIDEO_TOO_LONG' })
    })

    it('con più tracce ignorate, nessuna di loro conta', () => {
      const raw = conTracceAudio(
        tracciaAudio(1, undefined, 1, { duration: '999' }),
        tracciaAudio(2, 'mp3', 0, { duration: '600' }),
        tracciaAudio(3, 'aac', 0, { duration: '11.25' }),
      )
      // La predefinita è ignota (non decodificabile): fra le decodificabili vince la prima, `mp3` a 600 s — che quindi È la scelta e conta.
      expect(parseVideoProbe(raw, 1)).toEqual({ ok: false, code: 'VIDEO_TOO_LONG' })

      const conPredefinitaDecodificabile = conTracceAudio(
        tracciaAudio(1, 'aac', 1, { duration: '11.25' }),
        tracciaAudio(2, 'mp3', 0, { duration: '600' }),
        tracciaAudio(3, undefined, 0, { duration: '999' }),
      )
      expect(parseVideoProbe(conPredefinitaDecodificabile, 1)).toMatchObject({
        ok: true,
        probe: { durationSeconds: DURATA_VIDEO, audioStreamIndex: 1, ignoredAudioTracks: 2 },
      })
    })
  })

  it('encode.ts mappa UNA traccia, la scelta: l’uscita nasce con un solo audio e non con la predefinita ignota', () => {
    const esito = parseVideoProbe(FFPROBE_MOV_AUDIO_IGNOTO, 1)
    if (!esito.ok) throw new Error(`il probe doveva riuscire: ${esito.code}`)
    const argomenti = buildVideoEncodeArgs(esito.probe, { channel: 'news', inputPath: '/tmp/in.mov', outputPath: '/tmp/out.mp4' })
    const mappe = argomenti.flatMap((valore, i) => (argomenti[i - 1] === '-map' ? [valore] : []))
    expect(mappe).toEqual(['[vout]', '0:2'])
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
