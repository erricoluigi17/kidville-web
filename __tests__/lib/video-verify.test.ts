import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  binariVideo,
  eseguiFfmpeg,
  generaFixture,
  inCartellaTemporanea,
  provaDiDecodifica,
  sondaFfprobe,
  type BinariVideo,
} from '../fixtures/ffmpeg'
import { buildVideoEncodeArgs } from '@/lib/media/video/encode'
import { parseVideoProbe, type VideoProbe } from '@/lib/media/video/probe'
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

/* ════════════════════════════════════════════════════════════════════════════
 * I CASI SINTETICI RESTANO, e non per affetto.
 *
 * Coprono rami che un video vero non raggiunge: un probe malformato, un errore di
 * ffprobe, un'uscita da 2.000.000.001 byte, una durata che manca del tutto. Quello
 * che NON possono coprire — e per due settimane hanno finto di coprire — è se
 * ffmpeg produca davvero ciò che questo JSON descrive. Quella parte sta nel
 * secondo blocco, e il primo giro con file veri ha trovato due difetti che nessuno
 * di questi ventun casi poteva vedere.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('verifyVideoOutput — casi sintetici', () => {
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

  /* ──────────────────────────────────────────────────────────────────────────
   * IL RANGE ASSENTE NON È UN RANGE SBAGLIATO, e la differenza è tutta qui.
   *
   * Misurato il 2026-09-17 su ffmpeg 8.1.2, eseguendo la riga di comando vera:
   *   · contratto colore interamente ignoto → x264 non ha niente da segnalare, non
   *     scrive il VUI, e ffprobe NON riporta `color_range`: il campo manca.
   *   · stessa sorgente forzata a `full` → il VUI c'è, perché `full_range = 1` non
   *     è il default, e ffprobe riporta `color_range: 'pc'`.
   *
   * Sono due silenzi opposti: «assente» vuol dire limited (il default H.264 è
   * `video_full_range_flag = 0`), «pc» vuol dire full ed è un errore. Prima
   * finivano tutti e due in `null` e il primo veniva respinto insieme al secondo.
   * L'allentamento vale SOLO quando anche il contratto è interamente ignoto: dove
   * x264 un VUI lo scrive, pretenderlo resta giusto.
   * ────────────────────────────────────────────────────────────────────────── */
  it('accetta un color_range assente solo dove x264 non ha motivo di scrivere il VUI', () => {
    const senzaColore = {
      ...source,
      isHdr: false,
      pixelFormat: 'yuv420p',
      colorTransfer: null,
      colorPrimaries: null,
      colorSpace: null,
    }

    const senzaVui = outputProbe()
    senzaVui.streams[0].color_transfer = 'unknown'
    senzaVui.streams[0].color_primaries = 'unspecified'
    senzaVui.streams[0].color_space = 'N/A'
    delete (senzaVui.streams[0] as { color_range?: string }).color_range
    expect(verifyVideoOutput(senzaColore, senzaVui, 1, decoded)).toMatchObject({ ok: true })

    // Un'uscita che DICHIARA full range resta rifiutata: è l'unica cosa che
    // l'allentamento non deve portarsi dietro.
    const fullRange = structuredClone(senzaVui)
    fullRange.streams[0].color_range = 'pc'
    expect(verifyVideoOutput(senzaColore, fullRange, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_NOT_SDR',
    })

    // E dove il contratto NON è vuoto, il VUI x264 lo scrive: continuare a
    // pretenderlo è la strettezza che non va allentata.
    const bt709SenzaRange = outputProbe()
    delete (bt709SenzaRange.streams[0] as { color_range?: string }).color_range
    expect(verifyVideoOutput(source, bt709SenzaRange, 1, decoded)).toEqual({
      ok: false,
      code: 'OUTPUT_NOT_SDR',
    })
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * IL CASO NEGATIVO DEI SIDE DATA HDR, e serve proprio adesso.
   *
   * Dal 2026-09-17 `encode.ts` cancella i SEI di mastering display e content light
   * level, quindi il caso reale che li trovava è diventato verde. Senza questo
   * caso sintetico, `hasHdrSideData` potrebbe sparire da `verify.ts` senza che
   * niente diventi rosso: la rete resterebbe scritta nella storia e non nel codice.
   * ────────────────────────────────────────────────────────────────────────── */
  it.each(['Mastering display metadata', 'Content light level metadata', 'DOVI configuration record'])(
    'rifiuta un’uscita BT.709 che si porta dietro «%s»',
    (tipo) => {
      const conSideData = outputProbe()
      ;(conSideData.streams[0] as Record<string, unknown>).side_data_list = [
        { side_data_type: tipo },
      ]
      expect(verifyVideoOutput(source, conSideData, 1, decoded)).toEqual({
        ok: false,
        code: 'OUTPUT_NOT_SDR',
      })
    },
  )

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

/* ════════════════════════════════════════════════════════════════════════════
 * IL GIRO COMPLETO, CON FFMPEG VERO E FILE VERI.
 *
 * lavfi → ffmpeg (fixture) → ffprobe → `parseVideoProbe` → `buildVideoEncodeArgs`
 * → ffmpeg (conversione di produzione, argomenti non ritoccati) → ffprobe
 * → `verifyVideoOutput`. Nessun JSON scritto a mano in mezzo: ogni numero che le
 * asserzioni leggono l'ha prodotto un encoder.
 *
 * Perché serviva: i casi sintetici qui sopra descrivono un'uscita IDEALE, e per
 * due settimane hanno dichiarato verde una pipeline che su due classi di video
 * veri rifiuta la propria stessa conversione. Ci sono i due casi qui sotto a
 * dirlo, e sono rossi nel senso che conta — dicono `ok: false` su un video che
 * la conversione ha trattato correttamente.
 *
 * Le fixture si generano e si distruggono: il repository è PUBBLICO e un HEVC 4K
 * committato resta nella storia di git anche dopo il `rm`.
 * ════════════════════════════════════════════════════════════════════════════ */

/** `-color_*` DA SOLI non bastano a x265: senza `-x265-params` il VUI resta a metà. */
const COLORE_BT709_SORGENTE = [
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
]

function probeDiIngresso(binari: BinariVideo, percorso: string): VideoProbe {
  const esito = parseVideoProbe(sondaFfprobe(binari, percorso), statSync(percorso).size)
  if (!esito.ok) {
    throw new Error(`parseVideoProbe ha rifiutato la fixture ${percorso}: ${esito.code}`)
  }
  return esito.probe
}

function converti(
  binari: BinariVideo,
  probe: VideoProbe,
  ingresso: string,
  uscita: string,
  ritocco?: (argomenti: string[]) => void,
): void {
  const argomenti = buildVideoEncodeArgs(probe, {
    channel: 'news',
    inputPath: ingresso,
    outputPath: uscita,
  })
  ritocco?.(argomenti)
  eseguiFfmpeg(binari, argomenti, `conversione di ${ingresso}`)
}

function verifica(binari: BinariVideo, probe: VideoProbe, uscita: string) {
  return verifyVideoOutput(
    probe,
    sondaFfprobe(binari, uscita),
    statSync(uscita).size,
    provaDiDecodifica(binari, uscita),
  )
}

/** I soli campi della traccia video che serve guardare a mano, letti dal JSON vero. */
function tracciaVideo(sonda: unknown): Record<string, unknown> {
  const streams = (sonda as { streams?: Record<string, unknown>[] }).streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')
  if (!video) throw new Error('la sonda non contiene una traccia video')
  return video
}

function sideData(sonda: unknown): string[] {
  const lista = (tracciaVideo(sonda).side_data_list ?? []) as { side_data_type?: string }[]
  return lista.map((voce) => voce.side_data_type ?? '')
}

describe('verifyVideoOutput — giro completo con ffmpeg vero', () => {
  it('HEVC 4K SDR con audio: esce Full HD H.264/AAC e la verifica lo accetta', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-4k-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=1',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
          '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          ...COLORE_BT709_SORGENTE,
          '-x265-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
          '-c:a', 'aac', '-b:a', '128k', '-shortest', ingresso,
        ],
        'fixture HEVC 4K',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({ videoCodec: 'hevc', width: 3840, height: 2160, hasAudio: true })

      converti(binari, probe, ingresso, uscita)
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: {
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          pixelFormat: 'yuv420p',
          hasAudio: true,
          audioCodec: 'aac',
          fps: 30,
        },
      })
    })
  }, 60_000)

  it('HDR10 PQ/BT.2020: la tripletta esce BT.709 e l’uscita non porta side data HDR', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-hdr-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1',
          '-vf', 'format=yuv420p10le',
          '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
          '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
          '-x265-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
          '-an', ingresso,
        ],
        'fixture HDR10 PQ',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({
        isHdr: true,
        colorTransfer: 'smpte2084',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc',
      })

      converti(binari, probe, ingresso, uscita)
      const sonda = sondaFfprobe(binari, uscita)
      expect(tracciaVideo(sonda)).toMatchObject({
        color_primaries: 'bt709',
        color_transfer: 'bt709',
        color_space: 'bt709',
        color_range: 'tv',
      })
      expect(sideData(sonda)).toEqual([])
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709' },
      })
    })
  }, 60_000)

  /* ──────────────────────────────────────────────────────────────────────────
   * IL DIFETTO CHE QUESTA FIXTURE HA TROVATO IL 2026-09-17, e com'è stato chiuso.
   *
   * Un HDR10 vero (iPhone, Android di fascia alta, qualunque camera HDR) porta i SEI
   * di *mastering display* e *content light level*. La catena `hdrToSdrFilters()`
   * convertiva i PIXEL — l'uscita era BT.709 su tutte e tre le voci — ma quei due
   * SEI ATTRAVERSAVANO il transcode e si ritrovavano nell'H.264: `-map_metadata -1`
   * non li tocca, perché non sono metadati del contenitore ma side data dei frame, e
   * libx264 li rileggeva e li riscriveva. `hasHdrSideData(video)` rispondeva
   * `OUTPUT_NOT_SDR` su un video che ERA SDR: ogni video HDR girato col telefono
   * veniva convertito bene e poi buttato.
   *
   * LA CORREZIONE sta in `encode.ts`, in fondo a `videoFilters()`: due istanze di
   * `sidedata=mode=delete` — il filtro ne cancella un tipo per volta. NON è
   * `-bsf:v filter_units=remove_types=6`, che avrebbe buttato via TUTTI i SEI
   * dell'H.264 invece dei due dell'HDR. Misurato sullo stesso giro: dopo la
   * cancellazione il side data di stream dell'uscita è vuoto.
   *
   * QUESTO CASO RESTA, ribaltato: è l'unica cosa che si accorgerebbe se quei SEI
   * tornassero a passare. Il verso di lettura è cambiato — prima pinnava la realtà
   * rotta, adesso pretende quella giusta — ma la fixture è la stessa, con
   * `master-display` e `max-cll` veri dentro.
   * ────────────────────────────────────────────────────────────────────────── */
  it('HDR10 con mastering display: i SEI non sopravvivono all’H.264 e l’uscita passa', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-hdr-sei-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1',
          '-vf', 'format=yuv420p10le',
          '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
          '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
          '-x265-params',
          'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:' +
            'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):' +
            'max-cll=1000,400',
          '-an', ingresso,
        ],
        'fixture HDR10 con mastering display',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe.isHdr).toBe(true)

      converti(binari, probe, ingresso, uscita)
      const sonda = sondaFfprobe(binari, uscita)

      // I pixel SONO stati convertiti: la conversione colore ha funzionato.
      expect(tracciaVideo(sonda)).toMatchObject({
        color_primaries: 'bt709',
        color_transfer: 'bt709',
        color_space: 'bt709',
      })
      // E adesso i SEI dell'HDR non ci sono più. Non «nessuno dei due che
      // guardiamo»: proprio nessun side data, il che dice anche che la
      // cancellazione mirata non ha portato via nient'altro per sbaglio.
      expect(sideData(sonda)).toEqual([])
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709' },
      })
    })
  }, 60_000)

  it('verticale con rotazione 90 nel display matrix: nessun ingrandimento e rotazione 0 in uscita', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-rot-', (cartella) => {
      const orizzontale = join(cartella, 'orizzontale.mp4')
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          ...COLORE_BT709_SORGENTE,
          '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
          '-an', orizzontale,
        ],
        'fixture orizzontale da ruotare',
      )
      // La matrice di display si scrive così: `-metadata:s:v rotate=90` viene ignorato
      // dal muxer mov dalla 7 in poi, e il file uscirebbe senza rotazione — una fixture
      // che non contiene il caso che dice di contenere.
      generaFixture(
        binari,
        ['-display_rotation', '90', '-i', orizzontale, '-c', 'copy', ingresso],
        'fixture con display matrix a 90°',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({ rotation: 90, width: 360, height: 640 })

      converti(binari, probe, ingresso, uscita)
      const sonda = sondaFfprobe(binari, uscita)
      expect(tracciaVideo(sonda)).toMatchObject({ width: 360, height: 640 })
      expect(sideData(sonda)).toEqual([])
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { width: 360, height: 640 },
      })
    })
  }, 45_000)

  it('120 fps escono a 60, con la durata intatta', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-120-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=120:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          ...COLORE_BT709_SORGENTE,
          '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
          '-an', ingresso,
        ],
        'fixture a 120 fps',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe.fps).toBe(120)

      converti(binari, probe, ingresso, uscita)
      expect(tracciaVideo(sondaFfprobe(binari, uscita))).toMatchObject({ avg_frame_rate: '60/1' })
      expect(verifica(binari, probe, uscita)).toMatchObject({ ok: true, output: { fps: 60 } })
    })
  }, 45_000)

  it('senza traccia audio: gli argomenti portano -an e l’uscita non inventa audio', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-muto-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          ...COLORE_BT709_SORGENTE,
          '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
          '-an', ingresso,
        ],
        'fixture senza audio',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({ hasAudio: false, audioStreamIndex: null })
      const argomenti = buildVideoEncodeArgs(probe, {
        channel: 'news',
        inputPath: ingresso,
        outputPath: uscita,
      })
      expect(argomenti).toContain('-an')
      expect(argomenti).not.toContain('-c:a')

      eseguiFfmpeg(binari, argomenti, 'conversione muta')
      const streams = (sondaFfprobe(binari, uscita) as { streams: Record<string, unknown>[] }).streams
      expect(streams.filter((stream) => stream.codec_type === 'audio')).toEqual([])
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { hasAudio: false, audioCodec: null, audioStreamIndex: null },
      })
    })
  }, 45_000)

  it('ProRes 422: il decoder promesso da limiti.ts legge davvero, e l’uscita passa', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-prores-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mov')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=1',
          '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le',
          ...COLORE_BT709_SORGENTE,
          '-an', ingresso,
        ],
        'fixture ProRes 422',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({ videoCodec: 'prores', pixelFormat: 'yuv422p10le' })

      converti(binari, probe, ingresso, uscita)
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { width: 1280, height: 720, videoCodec: 'h264', pixelFormat: 'yuv420p' },
      })
    })
  }, 45_000)

  it('DNxHR: il decoder dnxhd copre anche DNxHR, e l’uscita passa', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-dnxhd-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mov')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=1',
          '-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p',
          ...COLORE_BT709_SORGENTE,
          '-an', ingresso,
        ],
        'fixture DNxHR',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe.videoCodec).toBe('dnxhd')

      converti(binari, probe, ingresso, uscita)
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { width: 1280, height: 720, videoCodec: 'h264' },
      })
    })
  }, 45_000)

  /* ──────────────────────────────────────────────────────────────────────────
   * IL CASO NEGATIVO, e senza di lui gli altri non dimostrano niente.
   *
   * Sei uscite accettate provano che ffmpeg funziona — non che `verifyVideoOutput`
   * sappia dire di NO, che è l'unica cosa per cui quel modulo esiste. Qui la STESSA
   * riga di comando produce due file: uno a 1920×1080 e uno identico in tutto tranne
   * il `scale`, a 1280×720. Il primo passa, il secondo no: la differenza è una sola,
   * quindi il rifiuto è attribuibile a quella.
   * ────────────────────────────────────────────────────────────────────────── */
  it('un’uscita ricodificata di proposito a 1280×720 viene RIFIUTATA, quella corretta passa', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-neg-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const corretta = join(cartella, 'corretta.mp4')
      const ridotta = join(cartella, 'ridotta.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          ...COLORE_BT709_SORGENTE,
          '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
          '-an', ingresso,
        ],
        'fixture Full HD',
      )

      const probe = probeDiIngresso(binari, ingresso)
      converti(binari, probe, ingresso, corretta)
      expect(verifica(binari, probe, corretta)).toMatchObject({
        ok: true,
        output: { width: 1920, height: 1080 },
      })

      converti(binari, probe, ingresso, ridotta, (argomenti) => {
        const indice = argomenti.indexOf('-filter_complex')
        expect(argomenti[indice + 1]).toContain('scale=1920:1080')
        argomenti[indice + 1] = argomenti[indice + 1].replace('scale=1920:1080', 'scale=1280:720')
      })
      expect(tracciaVideo(sondaFfprobe(binari, ridotta))).toMatchObject({ width: 1280, height: 720 })
      expect(verifica(binari, probe, ridotta)).toEqual({
        ok: false,
        code: 'OUTPUT_DIMENSIONS_INVALID',
      })
    })
  }, 45_000)

  /* ──────────────────────────────────────────────────────────────────────────
   * IL SECONDO DIFETTO TROVATO DALLE FIXTURE VERE IL 2026-09-17, e come s'è chiuso.
   *
   * Quando la sorgente non dichiara NESSUNO dei tre valori colore — succede sui
   * vecchi AVI, su certe registrazioni di schermo e su parecchi encoder Android —
   * `outputVideoColorMetadata()` restituisce `{null, null, null, colorRange: 'tv'}`
   * e la riga di comando passa `colorprim=undef:transfer=undef:colormatrix=undef`.
   * A quel punto x264 NON scrive il VUI: `video_full_range_flag = 0` è già il suo
   * default, quindi non c'è niente da segnalare. Risultato: ffprobe sull'uscita non
   * riporta `color_range` affatto — e il confronto con `'tv'` faceva cadere una
   * conversione perfettamente riuscita su un campo che l'encoder non ha motivo di
   * scrivere. I ventun casi sintetici non potevano vederlo: il loro JSON scrive
   * `color_range: 'tv'` sempre, anche dove ffmpeg non lo scriverebbe mai.
   *
   * LA CORREZIONE sta in `verify.ts`, non in `encode.ts`, e la scelta ha un motivo:
   * forzare il VUI avrebbe richiesto di dichiarare primarie o transfer che la
   * sorgente non dichiara — `-x264-params range=tv` da solo non basta, perché
   * limited È il default e x264 non scrive un VUI per ripetere un default. Sarebbe
   * stato dire al lettore un colore che nessuno ha misurato, contro il principio
   * scritto in `encode.ts` sopra `outputVideoColorMetadata`.
   *
   * L'allentamento è stretto: «assente» vale quanto `tv` SOLO dove il contratto è
   * interamente ignoto, e un'uscita che dichiara `pc` resta respinta — c'è un caso
   * sintetico qui sopra che lo prova su tutti e tre i versi. L'asserzione sul
   * `color_range` assente RESTA, perché è la misura del fatto: se un domani x264
   * cambiasse idea, va visto qui e non in produzione.
   * ────────────────────────────────────────────────────────────────────────── */
  it('sorgente senza metadati colore: x264 non scrive il VUI e l’uscita passa lo stesso', (contesto) => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-video-senza-colore-', (cartella) => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(
        binari,
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          '-an', ingresso,
        ],
        'fixture senza metadati colore',
      )

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({
        colorPrimaries: null,
        colorTransfer: null,
        colorSpace: null,
        isHdr: false,
      })

      converti(binari, probe, ingresso, uscita)
      const video = tracciaVideo(sondaFfprobe(binari, uscita))
      expect(video.color_range).toBeUndefined()
      expect(verifica(binari, probe, uscita)).toMatchObject({
        ok: true,
        output: { colorPrimaries: null, colorTransfer: null, colorSpace: null },
      })
    })
  }, 45_000)
})

/* ──────────────────────────────────────────────────────────────────────────────
 * 🔴 IL DIFETTO CHE HA TROVATO IL PRIMO VIDEO VERO, 2026-09-18.
 *
 * Un `.mov` girato con un iPhone, 256 MB, caricato in Galleria mezz'ora dopo il
 * rilascio. La MicroVM si è aperta, la build pinnata si è scaricata, `ffmpeg` ha
 * convertito per due minuti e cinquantaquattro secondi e ha chiuso con il suo
 * riepilogo — «video:134586KiB audio:3254KiB, muxing overhead 0,10%», cioè
 * RIUSCITO. Poi `verifyVideoOutput` ha risposto `OUTPUT_VIDEO_INVALID`.
 *
 * L'uscita, scaricata e sondata a mano, era perfetta: una traccia h264, una aac,
 * `attached_pic=0`, 1080×1920, yuv420p. Le mancava una cosa sola: il campo
 * `sample_aspect_ratio`, che il verificatore pretendeva uguale a `'1:1'`.
 *
 * NON È UN'ANOMALIA DEL FILE, È COME FUNZIONA MP4. Quando i pixel sono quadrati il
 * muxer non scrive l'atomo `pasp`, perché 1:1 è il valore predefinito e non c'è
 * niente da dichiarare; `ffprobe` quindi non riporta il campo affatto. Pretenderlo
 * significa pretendere che l'encoder scriva ciò che non ha motivo di scrivere —
 * ED È ESATTAMENTE IL GEMELLO del difetto sul `color_range` chiuso il giorno
 * prima. Ne abbiamo corretto uno e non abbiamo cercato l'altro.
 *
 * PERCHÉ NÉ I 21 CASI SINTETICI NÉ LE FIXTURE VERE L'HANNO VISTO. I sintetici
 * scrivono `sample_aspect_ratio: '1:1'` in ogni caso — è nel loro modello, riga 52.
 * E le fixture vere nascono da `testsrc2`, che il SAR lo DICHIARA: l'uscita lo
 * eredita e il confronto passa. Misurato il 2026-09-18 provando a costruire una
 * fixture che lo omettesse — `.ts`, `.mkv`, `.avi`, `setsar=0`, e perfino
 * `h264_metadata=sample_aspect_ratio=0/1` su `.mov`: la build locale lo scrive
 * SEMPRE. Un iPhone no.
 *
 * È la lezione che questi casi portano: una fixture generata resta una fixture.
 * Eseguire ffmpeg davvero ha chiuso il divario fra «il parser legge il JSON» e
 * «ffmpeg produce quel JSON», ma non quello fra la nostra sorgente sintetica e il
 * telefono di un genitore.
 * ────────────────────────────────────────────────────────────────────────────── */
describe('il SAR assente di un video vero', () => {
  it('accetta un\u2019uscita che NON dichiara `sample_aspect_ratio`: assente significa quadrato', () => {
    const uscita = outputProbe()
    delete (uscita.streams[0] as { sample_aspect_ratio?: string }).sample_aspect_ratio

    expect(
      verifyVideoOutput(source, uscita, 80_000_000, decoded),
    ).toMatchObject({ ok: true })
  })

  it('accetta anche le due forme con cui ffprobe dice \u00abnon saprei\u00bb', () => {
    for (const valore of ['0:1', 'N/A']) {
      const uscita = outputProbe()
      uscita.streams[0].sample_aspect_ratio = valore
      expect(
        verifyVideoOutput(source, uscita, 80_000_000, decoded),
        `${valore} non \u00e8 una dichiarazione di pixel non quadrati: \u00e8 l\u2019assenza di una dichiarazione`,
      ).toMatchObject({ ok: true })
    }
  })

  it('RESPINGE invece un SAR dichiarato e NON quadrato, che \u00e8 la cosa da respingere', () => {
    // L'allentamento dev'essere stretto: 4:3 su pixel rettangolari deforma
    // l'immagine, e un lettore che lo onora mostrerebbe un video schiacciato.
    const uscita = outputProbe()
    uscita.streams[0].sample_aspect_ratio = '4:3'
    expect(
      verifyVideoOutput(source, uscita, 80_000_000, decoded),
    ).toEqual({ ok: false, code: 'OUTPUT_VIDEO_INVALID' })
  })
})
