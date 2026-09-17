import { describe, expect, it } from 'vitest'

import type { VideoProbe } from '@/lib/media/video/probe'
import { verifyVideoOutput } from '@/lib/media/video/verify'

const source: VideoProbe = {
  durationSeconds: 10,
  videoDurationSeconds: 10,
  audioDurationSeconds: 10,
  width: 3840,
  height: 2160,
  codedWidth: 3840,
  codedHeight: 2160,
  rotation: 0,
  fps: 30,
  hasAudio: true,
  audioCodec: 'pcm_s24le',
  videoCodec: 'hevc',
  pixelFormat: 'yuv420p10le',
  colorTransfer: 'smpte2084',
  colorPrimaries: 'bt2020',
  colorSpace: 'bt2020nc',
  isHdr: true,
  videoStreamIndex: 0,
  audioStreamIndex: 1,
}

function outputProbe() {
  return {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30/1',
        duration: '10.000000',
        sample_aspect_ratio: '1:1',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        color_range: 'tv',
        disposition: { default: 1, attached_pic: 0 },
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '48000',
        duration: '10.021333',
        disposition: { default: 1 },
      },
    ],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '10.021333',
    },
  }
}

const decoded = { exitCode: 0, decodedFrames: 300 }

describe('verifyVideoOutput', () => {
  it('accetta un MP4 H.264/AAC SDR decodificato per intero e restituisce metadati normalizzati', () => {
    expect(verifyVideoOutput(source, outputProbe(), 80_000_000, decoded)).toEqual({
      ok: true,
      output: {
        durationSeconds: 10.021333,
        videoDurationSeconds: 10,
        audioDurationSeconds: 10.021333,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        audioCodec: 'aac',
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709',
        colorSpace: 'bt709',
        videoStreamIndex: 0,
        audioStreamIndex: 1,
        bytes: 80_000_000,
        decodedFrames: 300,
      },
    })
  })

  it('non applica il vecchio limite di 50 MiB e accetta esattamente 2 GB', () => {
    expect(verifyVideoOutput(source, outputProbe(), 52_428_801, decoded)).toMatchObject({ ok: true })
    expect(verifyVideoOutput(source, outputProbe(), 2_000_000_000, decoded)).toMatchObject({ ok: true })
    expect(verifyVideoOutput(source, outputProbe(), 2_000_000_001, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_TOO_LARGE',
    })
  })

  it.each([0, -1, 1.5, Number.NaN])('rifiuta una dimensione output non valida: %s', (bytes) => {
    expect(verifyVideoOutput(source, outputProbe(), bytes, decoded)).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT_SIZE',
    })
  })

  it('richiede una decodifica completa conclusa con almeno un frame', () => {
    expect(verifyVideoOutput(source, outputProbe(), 1, { exitCode: 1, decodedFrames: 299 })).toEqual({
      ok: false,
      code: 'OUTPUT_DECODE_FAILED',
    })
    expect(verifyVideoOutput(source, outputProbe(), 1, { exitCode: 0, decodedFrames: 0 })).toEqual({
      ok: false,
      code: 'OUTPUT_NO_DECODED_FRAMES',
    })
    expect(
      verifyVideoOutput(source, outputProbe(), 1, { exitCode: 0.5, decodedFrames: 300 }),
    ).toEqual({ ok: false, code: 'INVALID_DECODE_EVIDENCE' })
  })

  it('rifiuta un video troncato anche quando audio e container nascondono la perdita', () => {
    const raw = outputProbe()
    raw.streams[0].duration = '9.940000'

    expect(verifyVideoOutput(source, raw, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_DURATION_MISMATCH',
    })
  })

  it('accetta una perdita strettamente inferiore a un frame più il padding AAC', () => {
    const raw = outputProbe()
    raw.streams[0].duration = '9.946000'

    expect(verifyVideoOutput(source, raw, 1, decoded)).toMatchObject({ ok: true })
  })

  it('confronta ogni traccia con la propria durata naturale', () => {
    const shortAudioSource = { ...source, audioDurationSeconds: 8 }
    const identical = outputProbe()
    identical.streams[1].duration = '8.000000'
    identical.format.duration = '10.000000'

    expect(verifyVideoOutput(shortAudioSource, identical, 1, decoded)).toMatchObject({ ok: true })

    const truncatedAudio = structuredClone(identical)
    truncatedAudio.streams[1].duration = '4.000000'
    expect(verifyVideoOutput(shortAudioSource, truncatedAudio, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_DURATION_MISMATCH',
    })
  })

  it('non inventa la durata audio dalla durata globale quando la sorgente non la espone', () => {
    const unknownAudioDuration = { ...source, audioDurationSeconds: null }
    const raw = outputProbe()
    raw.streams[1].duration = '8.000000'
    raw.format.duration = '10.000000'

    expect(verifyVideoOutput(unknownAudioDuration, raw, 1, decoded)).toMatchObject({ ok: true })
  })

  it('accetta i millisecondi oltre 180 secondi introdotti dal padding AAC', () => {
    const longSource = {
      ...source,
      durationSeconds: 180,
      videoDurationSeconds: 180,
      audioDurationSeconds: 180,
    }
    const raw = outputProbe()
    raw.streams[0].duration = '180.000000'
    raw.streams[1].duration = '180.021333'
    raw.format.duration = '180.021333'

    expect(verifyVideoOutput(longSource, raw, 1, { exitCode: 0, decodedFrames: 5_400 })).toMatchObject({
      ok: true,
      output: { durationSeconds: 180.021333 },
    })
  })

  it('rifiuta la perdita audio e non accetta audio inatteso', () => {
    const missing = outputProbe()
    missing.streams.pop()
    expect(verifyVideoOutput(source, missing, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_AUDIO_MISSING',
    })

    const unexpectedSource = { ...source, hasAudio: false, audioCodec: null, audioStreamIndex: null }
    expect(verifyVideoOutput(unexpectedSource, outputProbe(), 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_AUDIO_UNEXPECTED',
    })
  })

  it('richiede AAC con durata e sample rate positivi', () => {
    const wrongCodec = outputProbe()
    wrongCodec.streams[1].codec_name = 'mp3'
    expect(verifyVideoOutput(source, wrongCodec, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_AUDIO_INVALID',
    })

    const zeroDuration = outputProbe()
    zeroDuration.streams[1].duration = '0'
    expect(verifyVideoOutput(source, zeroDuration, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_AUDIO_INVALID',
    })

    const zeroFrames = outputProbe()
    ;(zeroFrames.streams[1] as Record<string, unknown>).nb_read_frames = '0'
    expect(verifyVideoOutput(source, zeroFrames, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_AUDIO_INVALID',
    })
  })

  it('accetta un output senza audio quando anche la sorgente ne è priva', () => {
    const silentSource = { ...source, hasAudio: false, audioCodec: null, audioStreamIndex: null }
    const silentOutput = outputProbe()
    silentOutput.streams.pop()
    silentOutput.format.duration = '10.000000'

    expect(verifyVideoOutput(silentSource, JSON.stringify(silentOutput), 1, decoded)).toMatchObject({
      ok: true,
      output: {
        hasAudio: false,
        audioCodec: null,
        audioDurationSeconds: null,
        audioStreamIndex: null,
      },
    })
  })

  it('conserva il frame rate medio VFR sotto 60 e riduce quelli superiori a 60', () => {
    const vfrSource = { ...source, fps: 24000 / 1001 }
    const vfr = outputProbe()
    vfr.streams[0].avg_frame_rate = '24000/1001'
    expect(verifyVideoOutput(vfrSource, vfr, 1, decoded)).toMatchObject({ ok: true })

    const highFpsSource = { ...source, fps: 120 }
    const sixty = outputProbe()
    sixty.streams[0].avg_frame_rate = '60/1'
    expect(verifyVideoOutput(highFpsSource, sixty, 1, decoded)).toMatchObject({ ok: true })

    const changed = outputProbe()
    changed.streams[0].avg_frame_rate = '25/1'
    expect(verifyVideoOutput(source, changed, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_FPS_INVALID',
    })
  })

  it('verifica Full HD verticale, rotazione applicata e nessun upscale', () => {
    const portraitSource = {
      ...source,
      width: 2160,
      height: 3840,
      codedWidth: 3840,
      codedHeight: 2160,
      rotation: 90,
    }
    const portrait = outputProbe()
    portrait.streams[0].width = 1080
    portrait.streams[0].height = 1920
    expect(verifyVideoOutput(portraitSource, portrait, 1, decoded)).toMatchObject({ ok: true })

    const rotatedOutput = outputProbe()
    ;(rotatedOutput.streams[0] as Record<string, unknown>).tags = { rotate: '90' }
    expect(verifyVideoOutput(source, rotatedOutput, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_ROTATION_INVALID',
    })

    const smallSource = { ...source, width: 720, height: 1280, codedWidth: 720, codedHeight: 1280 }
    const upscale = outputProbe()
    upscale.streams[0].width = 1080
    upscale.streams[0].height = 1920
    expect(verifyVideoOutput(smallSource, upscale, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_DIMENSIONS_INVALID',
    })
  })

  it('accetta l’arrotondamento pari ma rifiuta proporzioni o risoluzioni ridotte arbitrariamente', () => {
    const oddSource = { ...source, width: 1001, height: 1000, codedWidth: 1001, codedHeight: 1000 }
    const rounded = outputProbe()
    rounded.streams[0].width = 1000
    rounded.streams[0].height = 998
    expect(verifyVideoOutput(oddSource, rounded, 1, decoded)).toMatchObject({ ok: true })

    const distorted = outputProbe()
    distorted.streams[0].width = 1920
    distorted.streams[0].height = 1000
    expect(verifyVideoOutput(source, distorted, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_DIMENSIONS_INVALID',
    })
  })

  it('richiede MP4, H.264 yuv420p e segnalazione SDR BT.709', () => {
    const raw = outputProbe()
    raw.format.format_name = 'matroska,webm'
    expect(verifyVideoOutput(source, raw, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_CONTAINER_INVALID',
    })

    const wrongCodec = outputProbe()
    wrongCodec.streams[0].codec_name = 'hevc'
    expect(verifyVideoOutput(source, wrongCodec, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_VIDEO_INVALID',
    })

    const hdr = outputProbe()
    hdr.streams[0].color_transfer = 'smpte2084'
    hdr.streams[0].color_primaries = 'bt2020'
    hdr.streams[0].color_space = 'bt2020nc'
    expect(verifyVideoOutput(source, hdr, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_NOT_SDR',
    })
  })

  it('confronta i metadati colore effettivi con il contratto derivato dalla sorgente', () => {
    const legacySource = {
      ...source,
      isHdr: false,
      pixelFormat: 'yuv420p',
      colorTransfer: 'smpte170m',
      colorPrimaries: 'smpte170m',
      colorSpace: null,
    }
    const legacyOutput = outputProbe()
    legacyOutput.streams[0].color_transfer = 'smpte170m'
    legacyOutput.streams[0].color_primaries = 'smpte170m'
    legacyOutput.streams[0].color_space = 'unspecified'
    expect(verifyVideoOutput(legacySource, legacyOutput, 1, decoded)).toMatchObject({ ok: true })

    const unknownSource = {
      ...source,
      isHdr: false,
      pixelFormat: 'yuv420p',
      colorTransfer: null,
      colorPrimaries: null,
      colorSpace: null,
    }
    const coherentUnknown = outputProbe()
    coherentUnknown.streams[0].color_transfer = 'unknown'
    coherentUnknown.streams[0].color_primaries = 'unspecified'
    coherentUnknown.streams[0].color_space = 'N/A'
    expect(verifyVideoOutput(unknownSource, coherentUnknown, 1, decoded)).toMatchObject({ ok: true })

    expect(verifyVideoOutput(unknownSource, outputProbe(), 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_NOT_SDR',
    })
  })

  it('rifiuta probe malformati, errori ffprobe e durate video mancanti', () => {
    expect(verifyVideoOutput(source, null, 1, decoded)).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT_PROBE',
    })
    expect(verifyVideoOutput(source, { error: 'Invalid data found' }, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_FFPROBE_ERROR',
    })

    const missingDuration = outputProbe()
    delete (missingDuration.streams[0] as { duration?: string }).duration
    expect(verifyVideoOutput(source, missingDuration, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_DURATION_UNKNOWN',
    })
  })
})
