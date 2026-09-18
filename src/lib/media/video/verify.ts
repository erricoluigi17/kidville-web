import { MAX_VIDEO_INPUT_BYTES } from './limiti'
import { outputVideoColorMetadata } from './encode'
import type { VideoProbe } from './probe'

const AAC_SAMPLES_PER_FRAME = 1024
const MAX_LANDSCAPE = { width: 1920, height: 1080 } as const
const MAX_PORTRAIT = { width: 1080, height: 1920 } as const

export interface VideoDecodeEvidence {
  exitCode: number
  decodedFrames: number
}

export interface VerifiedVideoOutput {
  durationSeconds: number
  videoDurationSeconds: number
  audioDurationSeconds: number | null
  width: number
  height: number
  fps: number
  hasAudio: boolean
  audioCodec: 'aac' | null
  videoCodec: 'h264'
  pixelFormat: 'yuv420p'
  colorTransfer: string | null
  colorPrimaries: string | null
  colorSpace: string | null
  videoStreamIndex: number
  audioStreamIndex: number | null
  bytes: number
  decodedFrames: number
}

export type VideoOutputVerificationErrorCode =
  | 'INVALID_OUTPUT_SIZE'
  | 'OUTPUT_TOO_LARGE'
  | 'INVALID_DECODE_EVIDENCE'
  | 'OUTPUT_DECODE_FAILED'
  | 'OUTPUT_NO_DECODED_FRAMES'
  | 'INVALID_OUTPUT_PROBE'
  | 'OUTPUT_FFPROBE_ERROR'
  | 'OUTPUT_CONTAINER_INVALID'
  | 'OUTPUT_VIDEO_INVALID'
  | 'OUTPUT_ROTATION_INVALID'
  | 'OUTPUT_DIMENSIONS_INVALID'
  | 'OUTPUT_FPS_INVALID'
  | 'OUTPUT_DURATION_UNKNOWN'
  | 'OUTPUT_DURATION_MISMATCH'
  | 'OUTPUT_AUDIO_MISSING'
  | 'OUTPUT_AUDIO_UNEXPECTED'
  | 'OUTPUT_AUDIO_INVALID'
  | 'OUTPUT_NOT_SDR'

export type VideoOutputVerificationResult =
  | { ok: true; output: VerifiedVideoOutput }
  | { ok: false; code: VideoOutputVerificationErrorCode }

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function parseRaw(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized && normalized !== 'n/a' ? normalized : null
}

function normalizedColorValue(value: unknown): string | null {
  const normalized = normalizedString(value)
  return normalized === 'unknown' || normalized === 'unspecified' ? null : normalized
}

/**
 * IL RANGE ASSENTE E IL RANGE SBAGLIATO SONO DUE COSE DIVERSE.
 *
 * Prima finivano tutti e due in `null`, e una conversione riuscita veniva respinta
 * insieme a una sbagliata. Misurato il 2026-09-17 eseguendo la riga di comando vera:
 *   · sorgente senza metadati colore → x264 non ha niente da segnalare, non scrive
 *     il VUI, e ffprobe NON riporta `color_range`. Il campo manca, e «manca» in
 *     H.264 significa `video_full_range_flag = 0`, cioè limited: è giusto così.
 *   · stessa sorgente forzata a full → il VUI c'è (full non è il default) e ffprobe
 *     riporta `color_range: 'pc'`. Questo va respinto, sempre.
 */
type RangeDiUscita = 'tv' | 'assente' | 'altro'

function outputColorRange(value: unknown): RangeDiUscita {
  const normalized = normalizedColorValue(value)
  if (normalized === null) return 'assente'
  return normalized === 'tv' || normalized === 'limited' ? 'tv' : 'altro'
}

function positiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function rational(value: unknown): number | null {
  if (typeof value !== 'string') return positiveNumber(value)
  const match = value.trim().match(/^(\d+)(?:\/([1-9]\d*))?$/)
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2] ?? '1')
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null
  const parsed = numerator / denominator
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function streamDuration(stream: JsonObject): number | null {
  const direct = positiveNumber(stream.duration)
  if (direct !== null) return direct
  const ticks = positiveInteger(stream.duration_ts)
  const timeBase = rational(stream.time_base)
  if (ticks === null || timeBase === null) return null
  const duration = ticks * timeBase
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

function clockDurationTag(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/)
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0
  if (!Number.isSafeInteger(hours) || !Number.isFinite(fraction)) return null

  const duration = hours * 3600 + minutes * 60 + seconds + fraction
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

function traceDuration(stream: JsonObject): number | null {
  const tags = asObject(stream.tags)
  const tagged = tags
    ? Object.entries(tags)
        .filter(([key]) => key.toUpperCase() === 'DURATION')
        .map(([, value]) => clockDurationTag(value))
        .filter((duration): duration is number => duration !== null)
    : []
  const candidates = [streamDuration(stream), ...tagged].filter(
    (duration): duration is number => duration !== null,
  )
  return candidates.length > 0 ? Math.max(...candidates) : null
}

function dispositionFlag(stream: JsonObject, key: string): boolean {
  const disposition = asObject(stream.disposition)
  const value = disposition?.[key]
  return value === true || value === 1 || value === '1'
}

function outputRotation(stream: JsonObject): number | null {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  const displayMatrix = sideData
    .map(asObject)
    .find((entry) => normalizedString(entry?.side_data_type) === 'display matrix')
  const tags = asObject(stream.tags)
  const raw = displayMatrix?.rotation ?? tags?.rotate
  if (raw === undefined || raw === null || raw === '') return 0
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return null
  return ((Math.round(parsed) % 360) + 360) % 360
}

/**
 * I side data che tradiscono un'uscita non davvero SDR.
 *
 * `dovi` non è un sinonimo ridondante di `dolby vision`: è l'UNICA forma che possa
 * comparire qui. Misurato il 2026-09-17 sui nomi dentro le librerie — «Dolby Vision
 * RPU Data» e «Dolby Vision Metadata» sono nomi di side data dei FRAME (libavutil),
 * che `ffprobe -show_streams` non stampa; il side data di stream, quello che questa
 * funzione legge, si chiama «DOVI configuration record» (libavcodec). Il ramo
 * `dolby vision` da solo era quindi cieco proprio dove doveva vedere.
 */
function hasHdrSideData(stream: JsonObject): boolean {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  return sideData.some((entry) => {
    const type = normalizedString(asObject(entry)?.side_data_type)
    return (
      type?.includes('mastering display') === true ||
      type?.includes('content light level') === true ||
      type?.includes('dolby vision') === true ||
      type?.includes('dovi') === true
    )
  })
}

function hasKnownZeroFrames(stream: JsonObject): boolean {
  return ['nb_frames', 'nb_read_frames', 'nb_read_packets'].some((key) => {
    if (!Object.hasOwn(stream, key)) return false
    return nonNegativeInteger(stream[key]) === 0
  })
}

function expectedDimensions(source: VideoProbe): { width: number; height: number } | null {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 2 ||
    source.height < 2
  ) {
    return null
  }
  const box = source.width >= source.height ? MAX_LANDSCAPE : MAX_PORTRAIT
  const ratio = Math.min(1, box.width / source.width, box.height / source.height)
  return { width: source.width * ratio, height: source.height * ratio }
}

function dimensionsMatch(source: VideoProbe, width: number, height: number): boolean {
  const expected = expectedDimensions(source)
  if (!expected || width % 2 !== 0 || height % 2 !== 0) return false

  // `scale` può arrotondare ciascun asse al pari inferiore due volte: una volta
  // per il box calcolato dall'app e una per mantenere esattamente le proporzioni.
  const widthLoss = expected.width - width
  const heightLoss = expected.height - height
  return widthLoss >= 0 && widthLoss < 4 && heightLoss >= 0 && heightLoss < 4
}

function fpsMatches(sourceFps: number, outputFps: number): boolean {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return false
  const expected = Math.min(sourceFps, 60)
  const tolerance = Math.max(0.01, expected * 0.001)
  return Math.abs(outputFps - expected) <= tolerance && outputFps <= 60 + tolerance
}

function durationMatches(
  sourceDuration: number,
  outputDuration: number,
  outputFps: number,
  audioSampleRate: number | null,
): boolean {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return false
  const oneFrame = 1 / outputFps
  const aacPadding = audioSampleRate === null ? 0 : AAC_SAMPLES_PER_FRAME / audioSampleRate
  // Limite aperto: perdere esattamente l'intera tolleranza non è considerato
  // una conversione completa. Lo stesso margine impedisce code spurie estese.
  return Math.abs(outputDuration - sourceDuration) < oneFrame + aacPadding
}

/**
 * Verifica i metadati dell'output e l'esito della decodifica completa eseguita
 * dal runner con `ffmpeg -xerror -err_detect explode`. Non usa il parser degli
 * input: l'output AAC può legittimamente superare di pochi millisecondi i 180 s.
 */
export function verifyVideoOutput(
  source: VideoProbe,
  rawOutputProbe: unknown,
  outputBytes: number,
  decodeEvidence: VideoDecodeEvidence,
): VideoOutputVerificationResult {
  if (!Number.isSafeInteger(outputBytes) || outputBytes <= 0) {
    return { ok: false, code: 'INVALID_OUTPUT_SIZE' }
  }
  if (outputBytes > MAX_VIDEO_INPUT_BYTES) {
    return { ok: false, code: 'OUTPUT_TOO_LARGE' }
  }
  if (
    !decodeEvidence ||
    !Number.isSafeInteger(decodeEvidence.exitCode) ||
    !Number.isSafeInteger(decodeEvidence.decodedFrames) ||
    decodeEvidence.decodedFrames < 0
  ) {
    return { ok: false, code: 'INVALID_DECODE_EVIDENCE' }
  }
  if (decodeEvidence.exitCode !== 0) return { ok: false, code: 'OUTPUT_DECODE_FAILED' }
  if (decodeEvidence.decodedFrames === 0) {
    return { ok: false, code: 'OUTPUT_NO_DECODED_FRAMES' }
  }

  const root = asObject(parseRaw(rawOutputProbe))
  if (!root) return { ok: false, code: 'INVALID_OUTPUT_PROBE' }
  if (Object.hasOwn(root, 'error') && root.error !== null && root.error !== undefined) {
    return { ok: false, code: 'OUTPUT_FFPROBE_ERROR' }
  }
  if (!Array.isArray(root.streams)) return { ok: false, code: 'INVALID_OUTPUT_PROBE' }
  const format = asObject(root.format)
  if (!format) return { ok: false, code: 'INVALID_OUTPUT_PROBE' }
  const formatNames = normalizedString(format.format_name)?.split(',').map((name) => name.trim())
  if (!formatNames?.includes('mp4')) return { ok: false, code: 'OUTPUT_CONTAINER_INVALID' }

  const parsedStreams = root.streams.map(asObject)
  if (parsedStreams.some((stream) => stream === null)) {
    return { ok: false, code: 'INVALID_OUTPUT_PROBE' }
  }
  const streams = parsedStreams as JsonObject[]
  const videos = streams.filter(
    (stream) => stream.codec_type === 'video' && !dispositionFlag(stream, 'attached_pic'),
  )
  if (videos.length !== 1) return { ok: false, code: 'OUTPUT_VIDEO_INVALID' }
  const video = videos[0]

  const videoStreamIndex = nonNegativeInteger(video.index)
  const width = positiveInteger(video.width)
  const height = positiveInteger(video.height)
  const fps = rational(video.avg_frame_rate) ?? rational(video.r_frame_rate)
  const videoDurationSeconds = traceDuration(video)
  if (videoDurationSeconds === null) {
    return { ok: false, code: 'OUTPUT_DURATION_UNKNOWN' }
  }
  if (
    videoStreamIndex === null ||
    width === null ||
    height === null ||
    fps === null ||
    normalizedString(video.codec_name) !== 'h264' ||
    normalizedString(video.pix_fmt) !== 'yuv420p' ||
    normalizedString(video.sample_aspect_ratio) !== '1:1'
  ) {
    return { ok: false, code: 'OUTPUT_VIDEO_INVALID' }
  }

  const rotation = outputRotation(video)
  if (rotation !== 0) return { ok: false, code: 'OUTPUT_ROTATION_INVALID' }
  if (!dimensionsMatch(source, width, height)) {
    return { ok: false, code: 'OUTPUT_DIMENSIONS_INVALID' }
  }
  if (!fpsMatches(source.fps, fps)) return { ok: false, code: 'OUTPUT_FPS_INVALID' }

  const colorTransfer = normalizedColorValue(video.color_transfer)
  const colorPrimaries = normalizedColorValue(video.color_primaries)
  const colorSpace = normalizedColorValue(video.color_space)
  const colorRange = outputColorRange(video.color_range)
  const expectedColor = outputVideoColorMetadata(source)
  // Quando il contratto non dichiara NIENTE — vecchi AVI, registrazioni di schermo,
  // parecchi encoder Android — x264 non ha motivo di scrivere il VUI e ffprobe non
  // riporta il range. Solo lì «assente» vale quanto `tv`: l'allentamento finisce
  // esattamente dove l'encoder tornerebbe a scrivere qualcosa, e un `pc` esplicito
  // resta respinto in ogni caso perché è `altro`, non `assente`.
  const contrattoInteramenteIgnoto =
    expectedColor.colorPrimaries === null &&
    expectedColor.colorTransfer === null &&
    expectedColor.colorSpace === null
  const rangeCoerente =
    colorRange === expectedColor.colorRange || (colorRange === 'assente' && contrattoInteramenteIgnoto)
  if (
    colorTransfer !== expectedColor.colorTransfer ||
    colorPrimaries !== expectedColor.colorPrimaries ||
    colorSpace !== expectedColor.colorSpace ||
    !rangeCoerente ||
    hasHdrSideData(video)
  ) {
    return { ok: false, code: 'OUTPUT_NOT_SDR' }
  }

  const audios = streams.filter((stream) => stream.codec_type === 'audio')
  if (source.hasAudio && audios.length === 0) {
    return { ok: false, code: 'OUTPUT_AUDIO_MISSING' }
  }
  if (!source.hasAudio && audios.length > 0) {
    return { ok: false, code: 'OUTPUT_AUDIO_UNEXPECTED' }
  }
  if (audios.length > 1) return { ok: false, code: 'OUTPUT_AUDIO_INVALID' }

  const audio = audios[0] ?? null
  const audioStreamIndex = audio ? nonNegativeInteger(audio.index) : null
  const audioDurationSeconds = audio ? traceDuration(audio) : null
  const audioSampleRate = audio ? positiveInteger(audio.sample_rate) : null
  if (
    audio &&
    (audioStreamIndex === null ||
      audioStreamIndex === videoStreamIndex ||
      normalizedString(audio.codec_name) !== 'aac' ||
      audioDurationSeconds === null ||
      audioSampleRate === null ||
      hasKnownZeroFrames(audio))
  ) {
    return { ok: false, code: 'OUTPUT_AUDIO_INVALID' }
  }

  // La traccia video resta il riferimento più prudente quando ffprobe non ne
  // espone la durata: in quel caso usiamo la timeline massima del contenitore.
  const sourceVideoDuration = source.videoDurationSeconds ?? source.durationSeconds
  const sourceAudioDuration = source.audioDurationSeconds
  if (
    !durationMatches(sourceVideoDuration, videoDurationSeconds, fps, audioSampleRate) ||
    (audioDurationSeconds !== null &&
      sourceAudioDuration !== undefined &&
      sourceAudioDuration !== null &&
      !durationMatches(sourceAudioDuration, audioDurationSeconds, fps, audioSampleRate))
  ) {
    return { ok: false, code: 'OUTPUT_DURATION_MISMATCH' }
  }

  const formatDuration = positiveNumber(format.duration)
  const durationSeconds = Math.max(
    videoDurationSeconds,
    audioDurationSeconds ?? 0,
    formatDuration ?? 0,
  )
  if (!durationMatches(source.durationSeconds, durationSeconds, fps, audioSampleRate)) {
    return { ok: false, code: 'OUTPUT_DURATION_MISMATCH' }
  }

  return {
    ok: true,
    output: {
      durationSeconds,
      videoDurationSeconds,
      audioDurationSeconds,
      width,
      height,
      fps,
      hasAudio: audio !== null,
      audioCodec: audio ? 'aac' : null,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      colorTransfer,
      colorPrimaries,
      colorSpace,
      videoStreamIndex,
      audioStreamIndex,
      bytes: outputBytes,
      decodedFrames: decodeEvidence.decodedFrames,
    },
  }
}
