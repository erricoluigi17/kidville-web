import { spawnSync } from 'node:child_process'
import {
  VIDEO_TEMPORAL_REASONS,
  compareVideoTimelines,
  videoTemporalProgram,
  type VideoTemporalEvidence,
} from '@/lib/media/video/temporale'
import {
  FPS_MEDIO,
  SORGENTE,
  USCITA,
  coperturaSecondi,
  framesDi,
  leggiTimeline,
  type TimelineFixture,
} from '../fixtures/video/falso-scarto-2026-09-28'
import { FPS_SLOWMO, SLOWMO, leggiTimelineSlowmo } from '../fixtures/video/falso-scarto-slowmo-2026-10-03'
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
import { MAX_VIDEO_DURATION_SECONDS } from '@/lib/media/video/limiti'
import { parseVideoProbe, type VideoProbe } from '@/lib/media/video/probe'
import { diagnosiVerifica, verifyVideoOutput } from '@/lib/media/video/verify'

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

const decoded = { exitCode: 0, decodedFrames: 300, temporal: { version: 1, ok: true, mode: 'preserve', sourceFrames: 300, outputFrames: 300, sourceFps: 30, outputFps: 30 } as const }

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

  it('accetta i millisecondi oltre il tetto di durata introdotti dal padding AAC', () => {
    // Il tetto è la COSTANTE (T1 l'ha portata da 180 a 300 s): la verifica dell'uscita non usa il parser
    // degli ingressi proprio perché l'AAC può superarlo di pochi millisecondi.
    const conPadding = (MAX_VIDEO_DURATION_SECONDS + 0.021333).toFixed(6)
    const frames = MAX_VIDEO_DURATION_SECONDS * 30
    const longSource = {
      ...source,
      durationSeconds: MAX_VIDEO_DURATION_SECONDS,
      videoDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
      audioDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
    }
    const raw = outputProbe()
    raw.streams[0].duration = `${MAX_VIDEO_DURATION_SECONDS}.000000`
    raw.streams[1].duration = conPadding
    raw.format.duration = conPadding

    expect(verifyVideoOutput(longSource, raw, 1, { exitCode: 0, decodedFrames: frames, temporal: { ...decoded.temporal, sourceFrames: frames, outputFrames: frames } })).toMatchObject({
      ok: true,
      output: { durationSeconds: Number(conPadding) },
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
    expect(verifyVideoOutput(vfrSource, vfr, 1, { ...decoded, temporal: { ...decoded.temporal, sourceFps: 24000 / 1001, outputFps: 24000 / 1001 } })).toMatchObject({ ok: true })

    const highFpsSource = { ...source, fps: 120 }
    const sixty = outputProbe()
    sixty.streams[0].avg_frame_rate = '60/1'
    expect(verifyVideoOutput(highFpsSource, sixty, 1, { ...decoded, temporal: { ...decoded.temporal, mode: 'reduce60', sourceFps: 120, outputFps: 60 } })).toMatchObject({ ok: true })

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

function provaTemporale(binari: BinariVideo, probe: VideoProbe, ingresso: string, uscita: string): VideoTemporalEvidence {
  const script = videoTemporalProgram({ videoIndex: probe.videoStreamIndex, audioIndex: probe.audioStreamIndex, sourceFps: probe.fps })
  const p = spawnSync(process.execPath, ['-', binari.ffprobe, ingresso, uscita], { input: script, encoding: 'utf8', timeout: 250_000 })
  if (p.status !== 0) throw new Error(`prova temporale: ${p.stderr}`)
  return JSON.parse(p.stdout) as VideoTemporalEvidence
}

function verifica(binari: BinariVideo, probe: VideoProbe, uscita: string, ingresso: string) {
  return verifyVideoOutput(
    probe,
    sondaFfprobe(binari, uscita),
    statSync(uscita).size,
    { ...provaDiDecodifica(binari, uscita), temporal: provaTemporale(binari, probe, ingresso, uscita) },
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
  it('preserva PTS irregolari MOV a timebase 1/600 senza quantizzarli al frame rate medio', contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-vfr-jitter-', cartella => {
      const ingresso = join(cartella, 'sorgente.mov')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(binari, [
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
        '-vf', "settb=1/600,setpts='N*20+mod(N,3)'", '-fps_mode', 'passthrough', '-enc_time_base', 'filter',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-video_track_timescale', '600', '-an', ingresso,
      ], 'fixture MOV con PTS irregolari')
      const probe = probeDiIngresso(binari, ingresso)
      eseguiFfmpeg(binari, buildVideoEncodeArgs(probe, {
        channel: 'gallery', inputPath: ingresso, outputPath: uscita,
        watermarkPath: join(process.cwd(), 'public/watermark.png'),
      }), 'conversione MOV con PTS irregolari')
      expect(provaTemporale(binari, probe, ingresso, uscita))
        .toMatchObject({ ok: true, sourceFrames: 60, outputFrames: 60 })
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({ ok: true })
    })
  }, 60_000)
  for (const timescale of [30, 60]) it(`MP4 reale con timebase 1/${timescale} conserva tutti i 60 frame`, contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-timescale-', cartella => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(binari, [
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-video_track_timescale', String(timescale), '-an', ingresso,
      ], 'fixture sintetica MP4 con timebase larga')
      expect(tracciaVideo(sondaFfprobe(binari, ingresso)).time_base).toBe(`1/${timescale}`)
      const probe = probeDiIngresso(binari, ingresso)
      converti(binari, probe, ingresso, uscita)
      expect(provaTemporale(binari, probe, ingresso, uscita))
        .toMatchObject({ ok: true, sourceFrames: 60, outputFrames: 60 })
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({ ok: true })
    })
  }, 60_000)

  for (const fps of [30, 60]) it(`MP4 reale con timebase 1/${fps}: rifiuta 11 PTS alterati pur conservando numero di frame e durata`, contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-pts-alterati-', cartella => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const corretta = join(cartella, 'corretta.mp4')
      const alterata = join(cartella, 'pts-alterati.mp4')
      generaFixture(binari, [
        '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${fps}:duration=2`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-video_track_timescale', String(fps), '-an', ingresso,
      ], 'fixture sintetica MP4 con PTS interni alterabili')
      const probe = probeDiIngresso(binari, ingresso)
      converti(binari, probe, ingresso, corretta)
      expect(verifica(binari, probe, corretta, ingresso)).toMatchObject({ ok: true })

      converti(binari, probe, ingresso, alterata, args => {
        const filter = args.indexOf('-filter_complex') + 1
        args[filter] = args[filter].replace('[vout]', `,settb=1/15360,setpts='PTS+if(between(N,10,20),${15360 * 0.75 / fps},0)'[vout]`)
        args.splice(args.length - 1, 0, '-fps_mode', 'passthrough', '-enc_time_base', '1:15360')
      })
      expect(tracciaVideo(sondaFfprobe(binari, alterata)).time_base).toBe('1/15360')
      expect(provaDiDecodifica(binari, alterata)).toMatchObject({ exitCode: 0, decodedFrames: fps * 2 })
      expect(provaTemporale(binari, probe, ingresso, alterata))
        .toMatchObject({ ok: false, reason: 'TIMESTAMP_MISMATCH', sourceFrames: fps * 2, outputFrames: fps * 2 })
      expect(verifica(binari, probe, alterata, ingresso)).toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
    })
  }, 60_000)

  for (const conAudio of [false, true]) it(`VFR reale con audio=${conAudio}: tutti i PTS preservati, senza dipendere dalla media del mux`, contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-vfr-', cartella => {
      const ingresso = join(cartella, 'sorgente.mp4')
      const uscita = join(cartella, 'uscita.mp4')
      generaFixture(binari, [
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=6',
        ...(conAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6'] : []),
        '-vf', "select='if(lt(t,3),1,mod(n,3))'", '-fps_mode', 'vfr',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        ...(conAudio ? ['-c:a', 'aac'] : ['-an']), ingresso,
      ], 'fixture sintetica VFR, nessun dato personale')
      const probe = probeDiIngresso(binari, ingresso)
      // Si usa anche il watermark: l'overlay fa parte della pipeline della Galleria.
      const args = buildVideoEncodeArgs(probe, {
        channel: 'gallery', inputPath: ingresso, outputPath: uscita,
        watermarkPath: join(process.cwd(), 'public/watermark.png'),
      })
      eseguiFfmpeg(binari, args, 'conversione VFR Galleria')
      expect(provaTemporale(binari, probe, ingresso, uscita)).toMatchObject({ ok: true, sourceFrames: 150, outputFrames: 150 })
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({ ok: true })

      // Mutazione reale dell'encoder: un frame perso non diventa lecito solo
      // perché durate e medie restano vicine. Questo deve restare rosso.
      const mutilata = join(cartella, 'frame-perso.mp4')
      const mutati = [...args]
      mutati[mutati.indexOf('-filter_complex') + 1] = mutati[mutati.indexOf('-filter_complex') + 1].replace('[vout]', ",select='not(eq(n,50))'[vout]")
      mutati[mutati.length - 1] = mutilata
      eseguiFfmpeg(binari, mutati, 'mutazione: un frame rimosso')
      expect(provaTemporale(binari, probe, ingresso, mutilata).ok).toBe(false)
      expect(verifica(binari, probe, mutilata, ingresso)).toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
    })
  }, 60_000)

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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({ ok: true, output: { fps: 60 } })
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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
      expect(verifica(binari, probe, corretta, ingresso)).toMatchObject({
        ok: true,
        output: { width: 1920, height: 1080 },
      })

      converti(binari, probe, ingresso, ridotta, (argomenti) => {
        const indice = argomenti.indexOf('-filter_complex')
        expect(argomenti[indice + 1]).toContain('scale=1920:1080')
        argomenti[indice + 1] = argomenti[indice + 1].replace('scale=1920:1080', 'scale=1280:720')
      })
      expect(tracciaVideo(sondaFfprobe(binari, ridotta))).toMatchObject({ width: 1280, height: 720 })
      expect(verifica(binari, probe, ridotta, ingresso)).toEqual({
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
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({
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


describe('regressione media VFR e attestazione della timeline', () => {
  const timeline = { ...decoded.temporal, outputFps: 3000 / 99 }
  it('accetta una media diversa solo con la prova temporale di tutti i frame', () => {
    const uscita = outputProbe()
    uscita.streams[0].avg_frame_rate = '3000/99'
    expect(verifyVideoOutput(source, uscita, 1234, { ...decoded, temporal: timeline })).toMatchObject({ ok: true })
  })
  it('rifiuta frame persi anche se la media FPS resta identica', () => {
    expect(verifyVideoOutput(source, outputProbe(), 1234, {
      ...decoded, temporal: { ...timeline, ok: false },
    })).toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * LA DURATA E L'ULTIMO CAMPIONE DELLA SORGENTE (02/10/2026)
 *
 * Il muxer non conserva la durata dell'ultimo campione video: la sceglie lui. Con i PTS identici
 * fotogramma per fotogramma — la prova che `compareVideoTimelines` già dà — quella durata è l'UNICO
 * grado di libertà rimasto, e quando la sorgente tiene l'ultimo campione più a lungo di un frame (una
 * schermata ferma fino alla fine) l'uscita risulta più corta di tutta la differenza. La tolleranza sulla
 * durata diventa `max(1 frame, ultimo campione della sorgente)` + padding AAC, e SOLO se conteggio
 * e PTS coincidono: un frame mancante fa già fallire il conteggio. In `reduce60` — dove non coincidono —
 * il difetto resta un frame e l'eccesso ha la sua regola: il blocco più sotto.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('verifyVideoOutput — l’ultimo campione della sorgente allarga la durata, e solo quella', () => {
  const misure = (sourceLastSample: number) => ({
    sourceLastSample, outputLastSample: 1 / 30, sourceCoverage: 10, outputCoverage: 10, epsilon: 1e-6,
  })
  /** L'evidenza di `decoded` più le misure della prova temporale (e, se serve, altri campi). */
  const conMisure = (sourceLastSample: number, extra: Record<string, unknown> = {}) => ({
    ...decoded,
    temporal: { ...decoded.temporal, measures: misure(sourceLastSample), ...extra } as VideoTemporalEvidence,
  })
  /** Una sorgente il cui VIDEO dura `video` secondi, ultimo campione compreso: audio e container restano a 10 s. */
  const sorgenteConVideo = (video: number): VideoProbe => ({
    ...source, videoDurationSeconds: video, durationSeconds: Math.max(video, 10),
  })
  /** Uscita con il video lungo `video` secondi (l'audio a 10,021333 come sempre). */
  const uscitaConVideo = (video: string) => {
    const raw = outputProbe()
    raw.streams[0].duration = video
    return raw
  }
  const MISMATCH = { ok: false, code: 'OUTPUT_DURATION_MISMATCH' } as const

  it('una sorgente con l’ultimo campione di 200 ms: l’uscita da 10 s non è un troncamento, ma senza la misura sì', () => {
    // Video sorgente 10,2 s, uscita 10,0 s: Δ 0,2 s. Un frame (33 ms) + AAC (21 ms) non bastano.
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, decoded)).toEqual(MISMATCH)
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, conMisure(0.2))).toMatchObject({ ok: true })
  })

  it('la tolleranza è esattamente max(1 frame, ultimo campione) + padding AAC: 0,2213 s, ai due lati', () => {
    // 0,2 + 1024/48000 = 0,221333. Δ 0,22 dentro, Δ 0,225 fuori.
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('9.980000'), 1, conMisure(0.2))).toMatchObject({ ok: true })
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('9.975000'), 1, conMisure(0.2))).toEqual(MISMATCH)
  })

  it('un ultimo campione più CORTO di un frame non stringe niente: il frame resta la tolleranza minima', () => {
    // Misura 3 ms, sorgente 10,0 s, uscita 9,946 s (Δ 54 ms < 33 + 21): passa come prima di questa correzione.
    expect(verifyVideoOutput(source, uscitaConVideo('9.946000'), 1, conMisure(0.003))).toMatchObject({ ok: true })
    // E il limite non scende: Δ 60 ms resta fuori.
    expect(verifyVideoOutput(source, uscitaConVideo('9.940000'), 1, conMisure(0.003))).toEqual(MISMATCH)
  })

  it('in reduce60 non allarga il DIFETTO: conteggio e PTS NON coincidono, un’uscita più corta resta a un frame d’uscita più l’AAC', () => {
    const sorgente120: VideoProbe = { ...sorgenteConVideo(10.2), fps: 120 }
    const sessanta = uscitaConVideo('10.000000')
    sessanta.streams[0].avg_frame_rate = '60/1'
    const riduzione = conMisure(0.2, { mode: 'reduce60', sourceFps: 120, outputFps: 60, sourceFrames: 1_224, outputFrames: 300 })
    expect(verifyVideoOutput(sorgente120, sessanta, 1, riduzione)).toEqual(MISMATCH)
    // Il termine di paragone: stessa differenza, conversione 1:1 a 30 fps, passa.
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, conMisure(0.2))).toMatchObject({ ok: true })
  })

  it('non vale per la durata della traccia AUDIO, che ha il suo padding AAC e nient’altro', () => {
    // Audio sorgente 10,3 s, uscita 10,021 s: Δ 0,279. Il video e il totale passerebbero con la
    // tolleranza allargata (10,0 ≈ 10,0 e 0,279 < 0,3 + 0,021): a farlo cadere è il solo confronto audio.
    const sorgenteAudioLungo: VideoProbe = { ...source, audioDurationSeconds: 10.3, durationSeconds: 10.3 }
    expect(verifyVideoOutput(sorgenteAudioLungo, outputProbe(), 1, conMisure(0.3))).toEqual(MISMATCH)
    // Con un audio sorgente coerente lo stesso scenario passa: l'unica differenza è quel confronto.
    expect(verifyVideoOutput({ ...source, durationSeconds: 10.3 }, outputProbe(), 1, conMisure(0.3))).toMatchObject({ ok: true })
  })

  it.each([
    ['assente', undefined],
    ['non finita', Number.NaN],
    ['infinita', Number.POSITIVE_INFINITY],
    ['negativa', -0.2],
    ['zero', 0],
    ['una stringa', '0.2'],
    ['nulla', null],
    ['più lunga della traccia stessa (incoerente)', 11],
  ])('una misura %s non allarga niente', (_nome, valore) => {
    const prova = conMisure(0.2)
    ;(prova.temporal.measures as unknown as Record<string, unknown>).sourceLastSample = valore
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, prova)).toEqual(MISMATCH)
  })

  it('la prova senza `measures` (un marcatore di prima del 02/10) si comporta come prima', () => {
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, decoded)).toEqual(MISMATCH)
    expect(verifyVideoOutput(source, outputProbe(), 1, decoded)).toMatchObject({ ok: true })
  })

  it('le controprove restano rosse: coda spuria, troncamento vero, frame persi, prova negativa', () => {
    // Una coda spuria: l'uscita dura un secondo PIÙ della sorgente, e la sorgente non aveva un ultimo
    // campione lungo. Prima era la copertura terminale a respingerla: ora è la durata.
    expect(verifyVideoOutput(source, uscitaConVideo('11.000000'), 1, conMisure(1 / 30))).toEqual(MISMATCH)
    // Un troncamento vero NON si nasconde dietro l'ultimo campione: Δ 0,5 s contro 0,2213 s.
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('9.700000'), 1, conMisure(0.2))).toEqual(MISMATCH)
    // Un frame in meno (conteggi diversi): fallisce PRIMA, sul frame rate, e la durata non è nemmeno guardata.
    const unoInMeno = conMisure(0.2, { sourceFrames: 301 })
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, unoInMeno))
      .toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
    // La prova che dice no non apre niente.
    const negativa = conMisure(0.2, { ok: false, reason: 'TIMESTAMP_MISMATCH' })
    expect(verifyVideoOutput(sorgenteConVideo(10.2), uscitaConVideo('10.000000'), 1, negativa))
      .toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * LA DURATA NELLA RIDUZIONE A 60 HZ: l'uscita copre l'ultimo campione della sorgente (Tfps2, 03/10/2026)
 *
 * `m05` SENZA audio (la sua traccia video con `-map 0:v -c copy -an`) cadeva su `OUTPUT_DURATION_MISMATCH`: la
 * pipeline vera dava 10,033333 s contro i 10,000 dichiarati dalla sorgente (+33,3 ms, esattamente L, l'ultimo
 * campione), senza audio e quindi senza il padding AAC che, con l'audio, la salva per 4,7 ms di margine. Il
 * filtro `fps=60` allunga l'uscita fino a coprire l'ultimo campione della sorgente, e la sorgente può non
 * contarlo nella durata che dichiara. In `reduce60` l'ECCESSO ammette `max(1/60, L)` più un tick, o quanto serve
 * per arrivare alla fine della copertura della sorgente sulla griglia; il DIFETTO resta un fotogramma, e il
 * `preserve` è com'era. Numeri VERI, misurati il 03/10/2026 con i moduli di produzione e ffmpeg 8.1.2.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('verifyVideoOutput — la riduzione a 60 Hz: l’uscita copre l’ultimo campione della sorgente, e la durata lo sa', () => {
  const MISMATCH = { ok: false, code: 'OUTPUT_DURATION_MISMATCH' } as const
  /** La prova temporale vera di m05 (720 → 602 fotogrammi, `reduce60`, ultimo campione di 33,333 ms). */
  const provaM05 = () => compareVideoTimelines(
    leggiTimelineSlowmo('sorgente'), leggiTimelineSlowmo('uscita'), SLOWMO.video, null, FPS_SLOWMO, MAX_VIDEO_DURATION_SECONDS,
  )
  const evidenza = (prova: VideoTemporalEvidence) => ({ exitCode: 0, decodedFrames: prova.outputFrames, temporal: prova })
  /** L'evidenza di m05 con una misura alterata (le misure arrivano dalla Sandbox, e non è detto che siano sane). */
  const conMisura = (campo: keyof NonNullable<VideoTemporalEvidence['measures']>, valore: unknown) => {
    const prova = provaM05()
    ;(prova.measures as unknown as Record<string, unknown>)[campo] = valore
    return evidenza(prova)
  }
  /** Il probe della sorgente di m05: HEVC SDR 1080p, 10 s dichiarati, VFR a 72 fps medi, senza audio. */
  const sorgenteM05: VideoProbe = {
    durationSeconds: 10, videoDurationSeconds: 10, audioDurationSeconds: null,
    width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1080, rotation: 0, fps: FPS_SLOWMO,
    hasAudio: false, audioCodec: null, videoCodec: 'hevc', pixelFormat: 'yuv420p',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', colorSpace: 'bt709', isHdr: false,
    videoStreamIndex: SLOWMO.video, audioStreamIndex: null,
  }
  /** L'uscita vera di m05: H.264 1920×1080 a 60 fps, 602 fotogrammi (`duration` 10.033333), contenitore uguale, niente audio. */
  const uscitaM05 = (durata = '10.033333') => {
    const raw = outputProbe()
    raw.streams.pop()
    raw.streams[0].avg_frame_rate = '60/1'
    raw.streams[0].duration = durata
    raw.format.duration = durata
    return raw
  }

  it('m05 SENZA audio: l’uscita di 10,0333 s contro i 10,000 dichiarati (+33,3 ms, un ultimo campione) passa — era OUTPUT_DURATION_MISMATCH', () => {
    const prova = provaM05()
    expect(prova).toMatchObject({ ok: true, mode: 'reduce60', sourceFrames: 720, outputFrames: 602 })
    // La PREMESSA, nei numeri: lo scarto di durata è due fotogrammi d'uscita, e senza audio nessun padding AAC lo copre.
    expect(10.033333 - 10).toBeGreaterThan(1 / 60 + 1e-3)
    expect(prova.measures!.sourceLastSample).toBeCloseTo(0.033333, 6)
    expect(verifyVideoOutput(sorgenteM05, uscitaM05(), 1234, evidenza(prova))).toMatchObject({
      ok: true, output: { hasAudio: false, videoDurationSeconds: 10.033333, durationSeconds: 10.033333, decodedFrames: 602 },
    })
  })

  /** Una sorgente con l'AAC e l'uscita con l'AAC (la traccia audio di `outputProbe()`, 10,021333 s): le durate audio coerenti, il video a piacere. */
  const conAudio = (sorgente: VideoProbe, durataVideoUscita: string) => {
    const raw = outputProbe()
    raw.streams[0].avg_frame_rate = '60/1'
    raw.streams[0].duration = durataVideoUscita
    raw.format.duration = durataVideoUscita
    return {
      sorgente: { ...sorgente, hasAudio: true, audioCodec: 'aac', audioStreamIndex: 1, audioDurationSeconds: sorgente.durationSeconds } satisfies VideoProbe,
      uscita: raw,
    }
  }

  it('il padding AAC si somma al limite L più un tick: con l’audio +50 ms passa, senza audio no', () => {
    // Dichiarata la copertura intera (10,029167 s): decide la regola del campione (33,4 ms), e con l'AAC (21,3) arriva a 54,7.
    const sorgenteIntera: VideoProbe = { ...sorgenteM05, durationSeconds: 10.029167, videoDurationSeconds: 10.029167 }
    const { sorgente, uscita } = conAudio(sorgenteIntera, '10.079167')
    expect(verifyVideoOutput(sorgente, uscita, 1234, evidenza(provaM05()))).toMatchObject({ ok: true })
    expect(verifyVideoOutput(sorgenteIntera, uscitaM05('10.079167'), 1234, evidenza(provaM05()))).toEqual(MISMATCH)
  })

  it('l’ECCESSO oltre l’ultimo campione resta respinto, e il limite è L più un tick: +33,39 ms passa, +33,42 e +40 no', () => {
    for (const [durata, passa] of [['10.033390', true], ['10.033420', false], ['10.040000', false], ['10.050000', false]] as const) {
      const esito = verifyVideoOutput(sorgenteM05, uscitaM05(durata), 1234, evidenza(provaM05()))
      expect(esito, `uscita di ${durata} s`).toEqual(passa ? expect.objectContaining({ ok: true }) : MISMATCH)
    }
  })

  it('il limite L più un tick vale anche quando la sorgente dichiara tutta la sua copertura: +33,37 ms passa (serve il tick), +33,48 no', () => {
    // Dichiarata 10,029167 s (la copertura di m05): la fine della copertura sulla griglia (10,0334 s) sta sotto il limite
    // `L + un tick`, che decide da solo — è la regola «max(1/60, L) più un tick», non la fine della copertura.
    const sorgenteIntera: VideoProbe = { ...sorgenteM05, durationSeconds: 10.029167, videoDurationSeconds: 10.029167 }
    expect(verifyVideoOutput(sorgenteIntera, uscitaM05('10.062537'), 1234, evidenza(provaM05()))).toMatchObject({ ok: true })
    expect(verifyVideoOutput(sorgenteIntera, uscitaM05('10.062650'), 1234, evidenza(provaM05()))).toEqual(MISMATCH)
  })

  it('il DIFETTO resta un fotogramma, anche con l’ultimo campione di 33 ms: −15 ms passa, −20 ms no', () => {
    expect(verifyVideoOutput(sorgenteM05, uscitaM05('9.985000'), 1234, evidenza(provaM05()))).toMatchObject({ ok: true })
    // Un limite allargato anche da questa parte (a `max(1/60, L)`) la lascerebbe passare: è una troncatura di 20 ms.
    expect(verifyVideoOutput(sorgenteM05, uscitaM05('9.980000'), 1234, evidenza(provaM05()))).toEqual(MISMATCH)
  })

  it('il padding AAC vale anche per il DIFETTO: con l’audio −30 ms passa (un fotogramma più 21,3 ms), senza audio no', () => {
    const { sorgente, uscita } = conAudio(sorgenteM05, '9.970000')
    expect(verifyVideoOutput(sorgente, uscita, 1234, evidenza(provaM05()))).toMatchObject({ ok: true })
    expect(verifyVideoOutput(sorgenteM05, uscitaM05('9.970000'), 1234, evidenza(provaM05()))).toEqual(MISMATCH)
  })

  it('con un ultimo campione corto l’eccesso non scende sotto un fotogramma: +10 ms passa con L = 3 ms, +20 ms no', () => {
    // Misure coerenti con una sorgente che dichiara tutta la sua copertura (10 s): L = 3 ms, nessuna fine della copertura che aiuti.
    const prova = provaM05()
    prova.measures = { ...prova.measures!, sourceLastSample: 0.003, sourceCoverage: 10 }
    const sorgenteCorta: VideoProbe = { ...sorgenteM05, durationSeconds: 10, videoDurationSeconds: 10 }
    expect(verifyVideoOutput(sorgenteCorta, uscitaM05('10.010000'), 1234, evidenza(prova))).toMatchObject({ ok: true })
    expect(verifyVideoOutput(sorgenteCorta, uscitaM05('10.020000'), 1234, evidenza(prova))).toEqual(MISMATCH)
  })

  describe('una coda VFR vera (la `r2` dello sweep di fase): la durata dichiarata sta sotto la copertura di quasi L', () => {
    // Numeri VERI: 330 → 241 fotogrammi, ultimo campione di 33,333 ms, copertura della sorgente 4,008333 s contro i
    // 3,979167 dichiarati, uscita di 4,016667 s: +37,5 ms, cioè L più un tick d'uscita di quarto di fotogramma a 240 fps.
    // `max(1/60, L)` da solo (33,4 ms) la scarterebbe: l'uscita sta invece esattamente sulla fine della copertura
    // portata alla griglia (241 fotogrammi), e un fotogramma in più no.
    const sorgente: VideoProbe = { ...sorgenteM05, durationSeconds: 3.979167, videoDurationSeconds: 3.979167, fps: 82.5 }
    const evidenzaR2 = (extra: Record<string, unknown> = {}) => ({
      exitCode: 0, decodedFrames: 241,
      temporal: {
        version: 1, ok: true, mode: 'reduce60', sourceFrames: 330, outputFrames: 241, sourceFps: 82.5, outputFps: 60,
        measures: { sourceLastSample: 1 / 30, outputLastSample: 1 / 60, sourceCoverage: 4.008333, outputCoverage: 4.016667, epsilon: 1 / 15_360 + 1e-9, ...extra },
      } as VideoTemporalEvidence,
    })
    const uscita = (durata: string) => uscitaM05(durata)

    it('l’uscita sulla fine della copertura passa', () => {
      expect(0.037501).toBeGreaterThan(1 / 30 + 1 / 15_360)
      expect(verifyVideoOutput(sorgente, uscita('4.016667'), 1234, evidenzaR2())).toMatchObject({ ok: true })
    })

    it('una copertura che è GIÀ un numero intero di fotogrammi non ne guadagna uno per il rumore dei decimali', () => {
      // 4,15 s sono 249 fotogrammi a 60 Hz, ma in virgola mobile 60 × 4,15 = 249,00000000000003: arrotondato per eccesso
      // senza cautela diventerebbe 250 e una coda spuria di un fotogramma passerebbe. La dichiarata (4,11 s) sta sotto di
      // quanto basta perché la regola del campione non decida: è la fine della copertura.
      const dichiarata: VideoProbe = { ...sorgente, durationSeconds: 4.11, videoDurationSeconds: 4.11 }
      expect(60 * 4.15).toBeGreaterThan(249)
      expect(verifyVideoOutput(dichiarata, uscita('4.150000'), 1234, evidenzaR2({ sourceCoverage: 4.15, outputCoverage: 4.15 }))).toMatchObject({ ok: true })
      expect(verifyVideoOutput(dichiarata, uscita('4.166667'), 1234, evidenzaR2({ sourceCoverage: 4.15, outputCoverage: 4.15 }))).toEqual(MISMATCH)
    })

    it('con l’audio il padding AAC si somma anche alla fine della copertura: +56,8 ms passa, senza audio no', () => {
      // Oltre `L` più l'AAC (54,7 ms): decide la fine della copertura sulla griglia (4,0167 s) più l'AAC (4,0380 s).
      const { sorgente: conAac, uscita: uscitaAac } = conAudio(sorgente, '4.036000')
      uscitaAac.streams[1].duration = '4.000000'
      expect(verifyVideoOutput(conAac, uscitaAac, 1234, evidenzaR2())).toMatchObject({ ok: true })
      expect(verifyVideoOutput(sorgente, uscita('4.036000'), 1234, evidenzaR2())).toEqual(MISMATCH)
    })

    it('un fotogramma d’uscita oltre la fine della copertura è una coda spuria, ed è respinta', () => {
      expect(verifyVideoOutput(sorgente, uscita('4.033333'), 1234, evidenzaR2())).toEqual(MISMATCH)
      expect(verifyVideoOutput(sorgente, uscita('4.025000'), 1234, evidenzaR2())).toEqual(MISMATCH)
    })

    it('la fine della copertura segue la copertura MISURATA: con una sorgente che copre un fotogramma in meno, la stessa uscita non passa più', () => {
      // Copertura 3,991667 s (239,5 fotogrammi → 240, 4,000 s): l'uscita da 4,016667 oltre `L` e oltre la fine.
      expect(verifyVideoOutput(sorgente, uscita('4.016667'), 1234, evidenzaR2({ sourceCoverage: 3.991667 }))).toEqual(MISMATCH)
    })
  })

  describe('le misure incoerenti non allargano niente: la stessa uscita di m05 torna a un fotogramma', () => {
    it.each([
      ['sourceCoverage', undefined], ['sourceCoverage', Number.NaN], ['sourceCoverage', Number.POSITIVE_INFINITY],
      ['sourceCoverage', -10.03], ['sourceCoverage', 0], ['sourceCoverage', '10.029167'], ['sourceCoverage', null],
      ['sourceCoverage', 0.01],   // più corta dell'ultimo campione che dovrebbe contenere
      ['sourceCoverage', 10.06],  // oltre la traccia di più di un campione e un fotogramma: la sorgente non è un riferimento
      ['epsilon', undefined], ['epsilon', 0], ['epsilon', -1e-4], ['epsilon', Number.NaN], ['epsilon', '0.0000651'],
      ['epsilon', 0.02],          // un tick d'uscita non è più di un fotogramma
      ['sourceLastSample', undefined], ['sourceLastSample', Number.NaN], ['sourceLastSample', -0.0333], ['sourceLastSample', 0],
      ['sourceLastSample', '0.0333'], ['sourceLastSample', 11],
      ['sourceLastSample', 10.02],  // più lungo della traccia dichiarata (10 s), ma non della copertura che lo contiene
    ] as const)('%s = %s', (campo, valore) => {
      expect(verifyVideoOutput(sorgenteM05, uscitaM05(), 1234, conMisura(campo, valore))).toEqual(MISMATCH)
    })

    it('e senza `measures` (un marcatore di prima del 02/10) la riduzione si comporta come prima', () => {
      const prova = provaM05()
      delete prova.measures
      expect(verifyVideoOutput(sorgenteM05, uscitaM05(), 1234, evidenza(prova))).toEqual(MISMATCH)
    })
  })

  describe('la diagnosi riporta la tolleranza del verso in cui le durate differiscono: quella che la verifica ha usato', () => {
    const numeri = (durata: string, esito: 'ok' | 'OUTPUT_DURATION_MISMATCH') =>
      diagnosiVerifica(sorgenteM05, uscitaM05(durata), evidenza(provaM05()), esito)

    it('in eccesso: L più un tick (33,398 ms), non il fotogramma di prima', () => {
      expect(numeri('10.033333', 'ok').tolleranza_durata_ms).toBeCloseTo(33.398, 2)
      expect(numeri('10.040000', 'OUTPUT_DURATION_MISMATCH').tolleranza_durata_ms).toBeCloseTo(33.398, 2)
    })

    it('in difetto: un fotogramma (16,667 ms)', () => {
      expect(numeri('9.980000', 'OUTPUT_DURATION_MISMATCH').tolleranza_durata_ms).toBeCloseTo(16.667, 2)
    })

    it('senza la durata d’uscita (traccia illeggibile) riporta quella in difetto, la più stretta', () => {
      const senzaDurata = uscitaM05()
      delete (senzaDurata.streams[0] as Record<string, unknown>).duration
      expect(diagnosiVerifica(sorgenteM05, senzaDurata, evidenza(provaM05()), 'OUTPUT_DURATION_UNKNOWN').tolleranza_durata_ms).toBeCloseTo(16.667, 2)
    })
  })
})

/**
 * I due probe (sorgente e uscita) coerenti con le timeline del 28/09: le durate dei flussi sono le loro
 * coperture, le dimensioni e il colore quelli di un Full HD SDR qualunque (la fixture porta solo le
 * timeline, e nient'altro che è del file vero).
 */
function probiCoerenti(sorgente: TimelineFixture, uscita: TimelineFixture) {
  const videoIn = coperturaSecondi(sorgente, SORGENTE.video), audioIn = coperturaSecondi(sorgente, SORGENTE.audio)
  const videoOut = coperturaSecondi(uscita, USCITA.video), audioOut = coperturaSecondi(uscita, USCITA.audio)
  const probeSorgente: VideoProbe = {
    ...source, fps: FPS_MEDIO,
    durationSeconds: Math.max(videoIn, audioIn), videoDurationSeconds: videoIn, audioDurationSeconds: audioIn,
    videoStreamIndex: SORGENTE.video, audioStreamIndex: SORGENTE.audio,
  }
  const sondaUscita = outputProbe()
  sondaUscita.streams[0].avg_frame_rate = '44000000/1456517'
  sondaUscita.streams[0].duration = videoOut.toFixed(6)
  sondaUscita.streams[1].sample_rate = '44100'
  sondaUscita.streams[1].duration = audioOut.toFixed(6)
  sondaUscita.format.duration = Math.max(videoOut, audioOut).toFixed(6)
  return { probeSorgente, sondaUscita }
}

/* ════════════════════════════════════════════════════════════════════════════
 * IL FALSO SCARTO DEL 28/09, dalle timeline vere alla verifica dell'uscita
 *
 * `compareVideoTimelines` sulle due timeline misurate (come farebbe la Sandbox) e `verifyVideoOutput` sul
 * suo verdetto. I probe di sorgente e uscita sono costruiti attorno alle timeline: le durate dei flussi
 * sono le loro coperture, le dimensioni e il colore quelli di un Full HD SDR qualunque (la fixture porta
 * solo le timeline). Col controllo di prima il primo caso era `OUTPUT_FPS_INVALID`.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('verifyVideoOutput — le timeline del 28/09/2026', () => {
  const BYTE_USCITA = 8_853_997

  const evidenzaDi = (sorgente: TimelineFixture, uscita: TimelineFixture) =>
    compareVideoTimelines(sorgente, uscita, SORGENTE.video, SORGENTE.audio, FPS_MEDIO, MAX_VIDEO_DURATION_SECONDS)

  function verificaFixture(sorgente: TimelineFixture, uscita: TimelineFixture, prova: VideoTemporalEvidence = evidenzaDi(sorgente, uscita)) {
    const { probeSorgente, sondaUscita } = probiCoerenti(sorgente, uscita)
    return verifyVideoOutput(probeSorgente, sondaUscita, BYTE_USCITA, { exitCode: 0, decodedFrames: prova.outputFrames, temporal: prova })
  }

  it('la conversione perfetta del 28/09 adesso passa: 264 frame, PTS identici, ultimo campione 3 ms contro 33 ms', () => {
    const sorgente = leggiTimeline('sorgente'), uscita = leggiTimeline('uscita')
    expect(evidenzaDi(sorgente, uscita)).toMatchObject({ ok: true, sourceFrames: 264, outputFrames: 264 })
    expect(verificaFixture(sorgente, uscita)).toMatchObject({ ok: true, output: { decodedFrames: 264, hasAudio: true } })
  })

  it('un frame perso, e il verdetto è lo stesso di sempre: OUTPUT_FPS_INVALID', () => {
    const sorgente = leggiTimeline('sorgente'), uscita = leggiTimeline('uscita')
    uscita.frames.splice(uscita.frames.indexOf(framesDi(uscita, USCITA.video)[100]), 1)
    expect(verificaFixture(sorgente, uscita)).toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
  })

  it('con un ultimo campione di 100 ms in ingresso passa SOLO perché la tolleranza sulla durata lo conosce', () => {
    const sorgente = leggiTimeline('sorgente'), uscita = leggiTimeline('uscita')
    framesDi(sorgente, SORGENTE.video).at(-1)!.duration = 100_000
    const prova = evidenzaDi(sorgente, uscita)
    expect(prova).toMatchObject({ ok: true })
    expect(prova.measures!.sourceLastSample).toBeCloseTo(0.1, 9)
    expect(verificaFixture(sorgente, uscita, prova)).toMatchObject({ ok: true })
    // Senza le misure: Δ 66,7 ms contro 33,1 + 23,2 = 56,3 ms.
    expect(verificaFixture(sorgente, uscita, { ...prova, measures: undefined })).toEqual({ ok: false, code: 'OUTPUT_DURATION_MISMATCH' })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * LA DIAGNOSI: i numeri di una verifica, non solo il codice
 * ════════════════════════════════════════════════════════════════════════════ */
describe('diagnosiVerifica', () => {
  const sorgenteFixture = () => leggiTimeline('sorgente')
  const uscitaConFramePerso = () => {
    const uscita = leggiTimeline('uscita')
    uscita.frames.splice(uscita.frames.indexOf(framesDi(uscita, USCITA.video)[100]), 1)
    return uscita
  }
  const caso = (sorgente: TimelineFixture, uscita: TimelineFixture) => {
    const prova = compareVideoTimelines(sorgente, uscita, SORGENTE.video, SORGENTE.audio, FPS_MEDIO, MAX_VIDEO_DURATION_SECONDS)
    const { probeSorgente, sondaUscita } = probiCoerenti(sorgente, uscita)
    const evidenza = { exitCode: 0, decodedFrames: prova.outputFrames, temporal: prova }
    return { probeSorgente: { ...probeSorgente, ignoredAudioTracks: 2 }, sondaUscita, evidenza }
  }

  it('un rifiuto per frame persi porta i numeri: frame, fps, coperture, ultimo campione, tolleranze', () => {
    const { probeSorgente, sondaUscita, evidenza } = caso(sorgenteFixture(), uscitaConFramePerso())
    const diagnosi = diagnosiVerifica(probeSorgente, sondaUscita, evidenza, 'OUTPUT_FPS_INVALID')
    expect(diagnosi).toMatchObject({
      v: 1, esito: 'OUTPUT_FPS_INVALID', modo: 'preserve', motivo: 'FRAME_COUNT_MISMATCH',
      frame_sorgente: 264, frame_uscita: 263, frame_decodificati: 263, tracce_audio_ignorate: 2,
    })
    expect(diagnosi.fps_sorgente).toBeCloseTo(30.2611, 3)
    expect(diagnosi.fps_uscita).toBeCloseTo(30.2091, 3)
    expect(diagnosi.copertura_sorgente_ms).toBeCloseTo(8724.06, 2)
    expect(diagnosi.copertura_uscita_ms).toBeCloseTo(8754.358, 2)
    expect(diagnosi.ultimo_campione_sorgente_ms).toBeCloseTo(3.035, 3)
    expect(diagnosi.ultimo_campione_uscita_ms).toBeCloseTo(33.333, 3)
    expect(diagnosi.durata_video_sorgente_ms).toBeCloseTo(8724.06, 2)
    expect(diagnosi.durata_video_uscita_ms).toBeCloseTo(8754.358, 2)
    expect(diagnosi.durata_audio_sorgente_ms).toBeCloseTo(8731.678, 2)
    expect(diagnosi.durata_audio_uscita_ms).toBeCloseTo(8731.678, 2)
    // Un frame (1/30,2091) + AAC (1024/44100): la prova non è 1:1, quindi nessun ultimo campione allarga.
    expect(diagnosi.tolleranza_durata_ms).toBeCloseTo(1000 / 30.2091 + (1024 / 44100) * 1000, 2)
    expect(diagnosi.tolleranza_pts_ms).toBeCloseTo(0.001, 3)
  })

  it('la tolleranza sulla durata riportata è quella che la verifica USA, ultimo campione compreso', () => {
    const sorgente = sorgenteFixture(), uscita = leggiTimeline('uscita')
    framesDi(sorgente, SORGENTE.video).at(-1)!.duration = 100_000
    const { probeSorgente, sondaUscita, evidenza } = caso(sorgente, uscita)
    expect(verifyVideoOutput(probeSorgente, sondaUscita, 1, evidenza)).toMatchObject({ ok: true })
    const diagnosi = diagnosiVerifica(probeSorgente, sondaUscita, evidenza, 'ok')
    expect(diagnosi.esito).toBe('ok')
    expect(diagnosi.motivo).toBeUndefined()
    expect(diagnosi.tolleranza_durata_ms).toBeCloseTo(100 + (1024 / 44100) * 1000, 2)
  })

  it('contiene SOLO numeri ed enumerati: nessuna stringa che arrivi dal file, né un nome, né un percorso', () => {
    const { probeSorgente, sondaUscita, evidenza } = caso(sorgenteFixture(), uscitaConFramePerso())
    // L'uscita del probe porta dei campi di testo che NON devono comparire: tag, nome file, percorsi.
    const sporca = structuredClone(sondaUscita) as Record<string, unknown>
    ;(sporca.format as Record<string, unknown>).filename = '/tmp/cartella-di-prova/nome-di-prova.mp4'
    ;(sporca.format as Record<string, unknown>).tags = { title: 'titolo-di-prova', location: '+00.0000+000.0000/' }
    const diagnosi = diagnosiVerifica(probeSorgente, sporca, evidenza, 'OUTPUT_FPS_INVALID')
    const testo = JSON.stringify(diagnosi)
    for (const vietata of ['cartella-di-prova', 'nome-di-prova', 'titolo-di-prova', '+00.0000', 'mp4', 'tmp']) expect(testo).not.toContain(vietata)
    const MOTIVI = [...VIDEO_TEMPORAL_REASONS, 'SCONOSCIUTO'] as string[]
    for (const [chiave, valore] of Object.entries(diagnosi)) {
      if (typeof valore === 'number') expect(Number.isFinite(valore), chiave).toBe(true)
      else if (chiave === 'esito') expect(valore).toBe('OUTPUT_FPS_INVALID')
      else if (chiave === 'modo') expect(['preserve', 'reduce60']).toContain(valore)
      else if (chiave === 'motivo') expect(MOTIVI).toContain(valore)
      else throw new Error(`campo non numerico e non enumerato: ${chiave}`)
    }
  })

  it('una stringa che non è nell’elenco chiuso non passa: diventa SCONOSCIUTO, e non si porta dietro il testo', () => {
    const { probeSorgente, sondaUscita, evidenza } = caso(sorgenteFixture(), uscitaConFramePerso())
    const inquinata = {
      ...evidenza,
      temporal: { ...evidenza.temporal, mode: 'inventato', reason: 'DROP TABLE video_jobs; '.repeat(200) } as unknown as VideoTemporalEvidence,
    }
    const diagnosi = diagnosiVerifica(probeSorgente, sondaUscita, inquinata, 'NON_UN_CODICE' as never)
    expect(diagnosi).toMatchObject({ esito: 'SCONOSCIUTO', motivo: 'SCONOSCIUTO' })
    expect(diagnosi.modo).toBeUndefined()
    expect(JSON.stringify(diagnosi)).not.toContain('DROP TABLE')
  })

  it('sta nei 2048 byte della colonna anche col caso peggiore: tutti i campi presenti, tutti i numeri enormi', () => {
    const enorme = 9e300
    const evidenza = {
      exitCode: 0, decodedFrames: enorme,
      temporal: {
        version: 1, ok: false, mode: 'reduce60', reason: 'AUDIO_TIMELINE_MISMATCH',
        sourceFrames: enorme, outputFrames: enorme, sourceFps: enorme, outputFps: enorme,
        measures: { sourceLastSample: enorme, outputLastSample: enorme, sourceCoverage: enorme, outputCoverage: enorme, epsilon: enorme },
      },
    } as unknown as Parameters<typeof diagnosiVerifica>[2]
    const probeEnorme = { ...source, fps: enorme, durationSeconds: enorme, videoDurationSeconds: enorme, audioDurationSeconds: enorme, ignoredAudioTracks: enorme }
    const sonda = outputProbe()
    sonda.streams[0].duration = '9'.repeat(40)
    sonda.streams[1].duration = '9'.repeat(40)
    const diagnosi = diagnosiVerifica(probeEnorme, sonda, evidenza, 'OUTPUT_AUDIO_UNEXPECTED')
    // Il caso peggiore è davvero «tutto presente»: v, esito, modo, motivo e i sedici numeri.
    expect(Object.keys(diagnosi)).toHaveLength(20)
    expect(JSON.stringify(diagnosi).length).toBeLessThanOrEqual(2048)
    for (const valore of Object.values(diagnosi)) if (typeof valore === 'number') expect(Math.abs(valore)).toBeLessThanOrEqual(1e9)
  })

  it('i valori negativi, non finiti o non numerici spariscono invece di sporcare la colonna', () => {
    const { probeSorgente, sondaUscita, evidenza } = caso(sorgenteFixture(), uscitaConFramePerso())
    const rotta = {
      ...evidenza,
      decodedFrames: Number.NaN,
      temporal: {
        ...evidenza.temporal,
        sourceFrames: '264', outputFrames: Number.POSITIVE_INFINITY,
        measures: { sourceLastSample: '0.003', outputLastSample: null, sourceCoverage: Number.NaN, outputCoverage: undefined, epsilon: { x: 1 } },
      },
    } as unknown as Parameters<typeof diagnosiVerifica>[2]
    const diagnosi = diagnosiVerifica({ ...probeSorgente, fps: Number.NaN }, sondaUscita, rotta, 'OUTPUT_FPS_INVALID')
    for (const chiave of ['frame_sorgente', 'frame_uscita', 'frame_decodificati', 'fps_sorgente', 'copertura_sorgente_ms',
      'copertura_uscita_ms', 'ultimo_campione_sorgente_ms', 'ultimo_campione_uscita_ms', 'tolleranza_pts_ms']) {
      expect(diagnosi, chiave).not.toHaveProperty(chiave)
    }
    expect(diagnosi).toMatchObject({ v: 1, esito: 'OUTPUT_FPS_INVALID' })
  })

  it('è TOTALE: probe nulli, JSON rotto, evidenza assente o sorgente senza campi — mai un’eccezione, solo meno campi', () => {
    expect(diagnosiVerifica(source, null, null, 'INVALID_OUTPUT_PROBE')).toMatchObject({ v: 1, esito: 'INVALID_OUTPUT_PROBE', fps_sorgente: 30 })
    expect(diagnosiVerifica(source, '{rotto', undefined, 'INVALID_OUTPUT_PROBE')).toMatchObject({ esito: 'INVALID_OUTPUT_PROBE' })
    expect(diagnosiVerifica(source, { streams: 'no', format: null }, null, 'OUTPUT_VIDEO_INVALID')).toMatchObject({ esito: 'OUTPUT_VIDEO_INVALID' })
    expect(diagnosiVerifica(source, { streams: [null, 3, 'x', []] }, { exitCode: 0, decodedFrames: 3 }, 'OUTPUT_VIDEO_INVALID')).toMatchObject({ frame_decodificati: 3 })
    expect(diagnosiVerifica({} as unknown as VideoProbe, outputProbe(), decoded, 'ok')).toMatchObject({ v: 1, esito: 'ok' })
    expect(diagnosiVerifica(null as unknown as VideoProbe, undefined, undefined, 'ok')).toEqual({ v: 1, esito: 'ok' })
  })

  it('l’uscita con più video o più audio non inventa una traccia: i numeri dell’uscita mancano, quelli della sorgente no', () => {
    const doppio = outputProbe()
    doppio.streams.push({ ...doppio.streams[1], index: 2 })
    const diagnosi = diagnosiVerifica(source, doppio, decoded, 'OUTPUT_AUDIO_INVALID')
    expect(diagnosi).not.toHaveProperty('durata_audio_uscita_ms')
    expect(diagnosi).toMatchObject({ durata_video_uscita_ms: 10000, durata_video_sorgente_ms: 10000 })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * ULTIMO CAMPIONE CORTO E TRACCE AUDIO, CON FFMPEG VERO
 *
 * Le due fixture del 28/09 sono timeline MISURATE, con attorno dei probe costruiti; queste famiglie di
 * caso fanno lavorare un encoder. Stesse regole di sempre: `binariVideo(contesto)` fallisce in CI se
 * manca la build pinnata, e fuori da CI si dichiara non disponibile — niente salti statici.
 *
 * ⚠️ LA FIXTURE RESTA UNA FIXTURE. La sorgente del 28/09 aveva l'ultimo campione video più corto di un
 * frame (3 ms); qui lo si accorcia a 3 ms rimuxando i pacchetti con `-bsf:v setts` (nessuna
 * ricodifica). Ciò che rende il caso un caso e non un decoro è la PREMESSA, che si asserisce: l'uscita
 * deve aver scritto un ultimo campione molto più lungo di quello della sorgente. Se la build pinnata un
 * giorno lo conservasse, il caso diventerebbe rosso e lo direbbe, invece di passare a vuoto.
 * Misurato il 02/10/2026 con ffmpeg 8.1.2 (Homebrew): i sei casi qui sotto passano, e col codice di
 * prima i due dell'ultimo campione cadono su `TERMINAL_COVERAGE_MISMATCH`. Sulla build pinnata girano
 * soltanto in CI.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Rimuxa `base` senza ricodificare, portando l'ultimo pacchetto video (il suo indice, da 0) alla durata
 * `secondi`. Misurato il 02/10/2026 con ffmpeg 8.1.2: l'ultimo campione della sorgente diventa
 * 3,035 ms e quello della conversione di produzione torna di un frame intero.
 */
function conUltimoCampioneCorto(binari: BinariVideo, base: string, uscita: string, ultimoPacchetto: number, secondi: number): void {
  generaFixture(binari, [
    '-i', base, '-c', 'copy',
    '-bsf:v', `setts=duration='if(eq(N\\,${ultimoPacchetto})\\,${secondi}/TB\\,DURATION)'`,
    uscita,
  ], 'fixture con l’ultimo campione video accorciato')
}

/** Video sintetico a `fps` e audio AAC, con la timebase del video a 1/1.000.000 come quella della sorgente del 28/09. */
function baseConAudio(binari: BinariVideo, percorso: string, fps: number): void {
  generaFixture(binari, [
    '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${fps}:duration=2`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2.05',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-video_track_timescale', '1000000', percorso,
  ], `base a ${fps} fps con audio`)
}

describe('verifyVideoOutput — ultimo campione corto e tracce audio, con ffmpeg vero', () => {
  for (const { nome, fps, modo } of [
    { nome: '30 fps, conversione 1:1', fps: 30, modo: 'preserve' },
    { nome: '120 fps, riduzione a 60', fps: 120, modo: 'reduce60' },
  ] as const) it(`ultimo campione video di 3 ms in ingresso (${nome}): l’uscita ne scrive uno intero e passa lo stesso`, contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-ultimo-campione-', cartella => {
      const base = join(cartella, 'base.mov')
      const ingresso = join(cartella, 'sorgente.mov')
      const uscita = join(cartella, 'uscita.mp4')
      baseConAudio(binari, base, fps)
      conUltimoCampioneCorto(binari, base, ingresso, fps * 2 - 1, 0.003035)
      const probe = probeDiIngresso(binari, ingresso)
      converti(binari, probe, ingresso, uscita)

      const prova = provaTemporale(binari, probe, ingresso, uscita)
      // La PREMESSA: se non regge, il caso non misura niente.
      expect(prova.measures?.sourceLastSample).toBeCloseTo(0.003035, 5)
      expect(prova.measures!.outputLastSample).toBeGreaterThan(prova.measures!.sourceLastSample * 4)
      expect(prova).toMatchObject({ ok: true, mode: modo, sourceFrames: fps * 2 })
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({ ok: true })
    })
  }, 60_000)

  it('un frame in meno resta rosso anche con l’ultimo campione corto: il troncamento non si nasconde dietro la correzione', contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-ultimo-campione-tronco-', cartella => {
      const base = join(cartella, 'base.mov')
      const ingresso = join(cartella, 'sorgente.mov')
      const mutilata = join(cartella, 'ultimo-frame-perso.mp4')
      baseConAudio(binari, base, 30)
      conUltimoCampioneCorto(binari, base, ingresso, 59, 0.003035)
      const probe = probeDiIngresso(binari, ingresso)
      const args = buildVideoEncodeArgs(probe, { channel: 'news', inputPath: ingresso, outputPath: mutilata })
      args[args.indexOf('-filter_complex') + 1] = args[args.indexOf('-filter_complex') + 1].replace('[vout]', ",select='not(eq(n,59))'[vout]")
      eseguiFfmpeg(binari, args, 'mutazione: l’ultimo frame rimosso')

      expect(provaTemporale(binari, probe, ingresso, mutilata)).toMatchObject({ ok: false, reason: 'FRAME_COUNT_MISMATCH', sourceFrames: 60, outputFrames: 59 })
      expect(verifica(binari, probe, mutilata, ingresso)).toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
    })
  }, 60_000)

  it('a 120 fps, tre frame in meno in coda restano rossi (l’arco della riduzione)', contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-riduzione-tronca-', cartella => {
      const base = join(cartella, 'base.mov')
      const ingresso = join(cartella, 'sorgente.mov')
      const mutilata = join(cartella, 'tre-frame-persi.mp4')
      baseConAudio(binari, base, 120)
      conUltimoCampioneCorto(binari, base, ingresso, 239, 0.003035)
      const probe = probeDiIngresso(binari, ingresso)
      const args = buildVideoEncodeArgs(probe, { channel: 'news', inputPath: ingresso, outputPath: mutilata })
      // L'uscita ha 120 frame (2 s a 60 fps): se ne tengono 117.
      args[args.indexOf('-filter_complex') + 1] = args[args.indexOf('-filter_complex') + 1].replace('[vout]', ",select='lt(n,117)'[vout]")
      eseguiFfmpeg(binari, args, 'mutazione: tre frame rimossi in coda')

      expect(provaTemporale(binari, probe, ingresso, mutilata)).toMatchObject({ ok: false, mode: 'reduce60', reason: 'FPS_LIMIT' })
      expect(verifica(binari, probe, mutilata, ingresso)).toEqual({ ok: false, code: 'OUTPUT_FPS_INVALID' })
    })
  }, 60_000)

  /**
   * Una traccia audio con un FourCC inventato (`xyzw`) PRIMA della AAC, e predefinita: ffprobe non le dà
   * il `codec_name`. Prima del 02/10/2026 tutto il video finiva in `UNKNOWN_AUDIO_CODEC`. L'FourCC si
   * scrive con `-strict unofficial` (altrimenti il muxer lo rifiuta) e su PCM, che non porta un
   * descrittore del codec dentro: con l'AAC l'`esds` rivelerebbe comunque il codec.
   */
  function conAudioIgnotoPrimaDellAac(binari: BinariVideo, percorso: string): void {
    generaFixture(binari, [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=2',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a:0', 'pcm_s16le', '-tag:a:0', 'xyzw', '-c:a:1', 'aac',
      '-disposition:a:0', 'default', '-disposition:a:1', '0',
      '-strict', 'unofficial', percorso,
    ], 'fixture MOV con una traccia audio dal codec ignoto prima dell’AAC')
  }

  it('la predefinita ha un codec ignoto e accanto c’è un’AAC: si converte l’AAC, l’uscita ha UNA traccia audio e passa', contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-audio-ignoto-', cartella => {
      const ingresso = join(cartella, 'sorgente.mov')
      const uscita = join(cartella, 'uscita.mp4')
      conAudioIgnotoPrimaDellAac(binari, ingresso)

      // La PREMESSA, sul JSON vero di ffprobe: la prima traccia audio non ha `codec_name`.
      const sonda = sondaFfprobe(binari, ingresso) as { streams: Array<Record<string, unknown>> }
      const audio = sonda.streams.filter(stream => stream.codec_type === 'audio')
      expect(audio).toHaveLength(2)
      expect(audio[0].codec_name).toBeUndefined()
      expect(audio[1].codec_name).toBe('aac')

      const probe = probeDiIngresso(binari, ingresso)
      expect(probe).toMatchObject({ hasAudio: true, audioCodec: 'aac', audioStreamIndex: audio[1].index, ignoredAudioTracks: 1 })
      converti(binari, probe, ingresso, uscita)
      const tracceAudioInUscita = (sondaFfprobe(binari, uscita) as { streams: Array<Record<string, unknown>> }).streams
        .filter(stream => stream.codec_type === 'audio')
      expect(tracceAudioInUscita).toHaveLength(1)
      expect(verifica(binari, probe, uscita, ingresso)).toMatchObject({ ok: true, output: { hasAudio: true, audioCodec: 'aac' } })
    })
  }, 60_000)

  it('se la SOLA traccia audio ha il codec ignoto il video resta respinto: UNKNOWN_AUDIO_CODEC non è sparito', contesto => {
    const binari = binariVideo(contesto)
    inCartellaTemporanea('kidville-solo-audio-ignoto-', cartella => {
      const ingresso = join(cartella, 'sorgente.mov')
      generaFixture(binari, [
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'pcm_s16le', '-tag:a', 'xyzw', '-strict', 'unofficial', ingresso,
      ], 'fixture MOV con la sola traccia audio dal codec ignoto')
      expect(parseVideoProbe(sondaFfprobe(binari, ingresso), statSync(ingresso).size)).toEqual({ ok: false, code: 'UNKNOWN_AUDIO_CODEC' })
    })
  }, 30_000)
})
