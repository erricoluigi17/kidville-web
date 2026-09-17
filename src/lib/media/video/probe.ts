import {
  MAX_VIDEO_DURATION_SECONDS,
  SUPPORTED_VIDEO_CODECS,
  SUPPORTED_VIDEO_CONTAINERS,
  validateVideoInputSize,
  type VideoInputSizeErrorCode,
} from './limiti'

export interface VideoProbe {
  durationSeconds: number
  /** Durata della traccia video selezionata; assente solo nelle fixture legacy. */
  videoDurationSeconds?: number | null
  /** Durata della traccia audio selezionata; assente solo nelle fixture legacy. */
  audioDurationSeconds?: number | null
  width: number
  height: number
  codedWidth: number
  codedHeight: number
  rotation: number
  fps: number
  hasAudio: boolean
  audioCodec: string | null
  videoCodec: string
  pixelFormat: string | null
  colorTransfer: string | null
  colorPrimaries: string | null
  colorSpace: string | null
  isHdr: boolean
  videoStreamIndex: number
  audioStreamIndex: number | null
}

export type VideoProbeErrorCode =
  | VideoInputSizeErrorCode
  | 'INVALID_PROBE'
  | 'UNKNOWN_DURATION'
  | 'VIDEO_TOO_LONG'
  | 'MISSING_VIDEO_STREAM'
  | 'ENCRYPTED_VIDEO'
  | 'UNSUPPORTED_CONTAINER'
  | 'UNSUPPORTED_VIDEO_CODEC'
  | 'UNKNOWN_AUDIO_CODEC'
  | 'DUPLICATE_STREAM_INDEX'
  | 'FFPROBE_ERROR'

export type VideoProbeResult =
  | { ok: true; probe: VideoProbe }
  | { ok: false; code: VideoProbeErrorCode }

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function finitePositive(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = finitePositive(value)
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function rational(value: unknown): number | null {
  if (typeof value !== 'string') return finitePositive(value)
  const match = value.trim().match(/^(\d+)(?:\/([1-9]\d*))?$/)
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2] ?? '1')
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null
  const parsed = numerator / denominator
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function sampleAspectRatio(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === 'N/A') return 1
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized === '0:1') return 1
  const match = normalized.match(/^(\d+)(?::|\/)([1-9]\d*)$/)
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator === 0) {
    return null
  }
  const ratio = numerator / denominator
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.trim().toUpperCase() !== 'N/A'
    ? value.trim().toLowerCase()
    : null
}

function isSupported(value: string, supported: readonly string[]): boolean {
  return supported.includes(value)
}

function dispositionFlag(stream: JsonObject, key: string): boolean {
  const disposition = asObject(stream.disposition)
  const value = disposition?.[key]
  return value === true || value === 1 || value === '1'
}

function preferredStream(streams: JsonObject[], type: 'video' | 'audio'): JsonObject | null {
  const candidates = streams.filter(
    (stream) => stream.codec_type === type && (type !== 'video' || !dispositionFlag(stream, 'attached_pic')),
  )
  return candidates.find((stream) => dispositionFlag(stream, 'default')) ?? candidates[0] ?? null
}

function rotationFrom(stream: JsonObject): number | null {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  const displayMatrix = sideData
    .map(asObject)
    .find((entry) => nullableString(entry?.side_data_type) === 'display matrix')
  const sideRotation = displayMatrix?.rotation
  const tags = asObject(stream.tags)
  const rawRotation = sideRotation ?? tags?.rotate
  if (rawRotation === undefined || rawRotation === null || rawRotation === '') return 0
  const parsed = typeof rawRotation === 'number' ? rawRotation : Number(rawRotation)
  if (!Number.isFinite(parsed)) return null
  return ((Math.round(parsed) % 360) + 360) % 360
}

function trueFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes'
}

function encryptedObject(value: unknown): boolean {
  const object = asObject(value)
  if (!object) return false
  if (trueFlag(object.is_encrypted) || trueFlag(object.encrypted)) return true

  const codecTag = nullableString(object.codec_tag_string)
  if (codecTag === 'encv' || codecTag === 'enca') return true

  const tags = asObject(object.tags)
  if (tags) {
    for (const [rawKey, tagValue] of Object.entries(tags)) {
      const key = rawKey.toLowerCase()
      if (
        (key === 'encryption_scheme' || key === 'encryption_key_id' || key === 'default_kid') &&
        tagValue !== undefined &&
        tagValue !== null &&
        tagValue !== ''
      ) {
        return true
      }
      if ((key === 'is_encrypted' || key === 'encrypted') && trueFlag(tagValue)) return true
    }
  }

  const sideData = Array.isArray(object.side_data_list) ? object.side_data_list : []
  return sideData.some((entry) => {
    const type = nullableString(asObject(entry)?.side_data_type)
    return type?.includes('encrypt') ?? false
  })
}

function hasHdrSideData(stream: JsonObject): boolean {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  return sideData.some((entry) => {
    const type = nullableString(asObject(entry)?.side_data_type)
    return (
      type?.includes('mastering display') === true ||
      type?.includes('content light level') === true ||
      type?.includes('dolby vision') === true
    )
  })
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function streamDuration(stream: JsonObject): number | null {
  const direct = finitePositive(stream.duration)
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

function taggedDurations(object: JsonObject): number[] {
  const tags = asObject(object.tags)
  if (!tags) return []

  return Object.entries(tags)
    .filter(([key]) => key.toUpperCase() === 'DURATION')
    .map(([, value]) => clockDurationTag(value))
    .filter((duration): duration is number => duration !== null)
}

function traceDuration(stream: JsonObject): number | null {
  const candidates = [streamDuration(stream), ...taggedDurations(stream)].filter(
    (duration): duration is number => duration !== null,
  )
  return candidates.length > 0 ? Math.max(...candidates) : null
}

/**
 * Valida e normalizza il JSON di ffprobe senza I/O e senza fidarsi dell'estensione.
 * Una durata illeggibile viene rifiutata: i byte del file non permettono di inferire il tempo.
 */
export function parseVideoProbe(raw: unknown, bytes: number): VideoProbeResult {
  const size = validateVideoInputSize(bytes)
  if (!size.ok) return size

  const root = asObject(parseRaw(raw))
  if (!root) return { ok: false, code: 'INVALID_PROBE' }
  if (Object.hasOwn(root, 'error') && root.error !== null && root.error !== undefined) {
    return { ok: false, code: 'FFPROBE_ERROR' }
  }
  if (!Array.isArray(root.streams)) return { ok: false, code: 'INVALID_PROBE' }
  const format = asObject(root.format)
  if (!format || typeof format.format_name !== 'string' || !format.format_name.trim()) {
    return { ok: false, code: 'INVALID_PROBE' }
  }
  const parsedStreams = root.streams.map(asObject)
  if (parsedStreams.some((stream) => stream === null)) return { ok: false, code: 'INVALID_PROBE' }
  const streams = parsedStreams as JsonObject[]
  if (encryptedObject(format) || streams.some(encryptedObject)) {
    return { ok: false, code: 'ENCRYPTED_VIDEO' }
  }
  const formatNames = nullableString(format.format_name)?.split(',').map((name) => name.trim()) ?? []
  if (!formatNames.some((name) => isSupported(name, SUPPORTED_VIDEO_CONTAINERS))) {
    return { ok: false, code: 'UNSUPPORTED_CONTAINER' }
  }

  const video = preferredStream(streams, 'video')
  if (!video) return { ok: false, code: 'MISSING_VIDEO_STREAM' }

  const videoCodec = nullableString(video.codec_name)
  if (!videoCodec) return { ok: false, code: 'INVALID_PROBE' }
  if (!isSupported(videoCodec, SUPPORTED_VIDEO_CODECS)) {
    return { ok: false, code: 'UNSUPPORTED_VIDEO_CODEC' }
  }

  const width = positiveInteger(video.width)
  const height = positiveInteger(video.height)
  const codedWidth = positiveInteger(video.coded_width) ?? width
  const codedHeight = positiveInteger(video.coded_height) ?? height
  const videoStreamIndex = nonNegativeInteger(video.index)
  const fps = rational(video.avg_frame_rate) ?? rational(video.r_frame_rate)
  if (
    width === null ||
    height === null ||
    codedWidth === null ||
    codedHeight === null ||
    videoStreamIndex === null ||
    fps === null
  ) {
    return { ok: false, code: 'INVALID_PROBE' }
  }

  const audio = preferredStream(streams, 'audio')
  const audioStreamIndex = audio ? nonNegativeInteger(audio.index) : null
  if (audio && audioStreamIndex === null) return { ok: false, code: 'INVALID_PROBE' }
  const audioCodec = audio ? nullableString(audio.codec_name) : null
  if (audio && !audioCodec) return { ok: false, code: 'UNKNOWN_AUDIO_CODEC' }
  if (audioStreamIndex !== null && audioStreamIndex === videoStreamIndex) {
    return { ok: false, code: 'DUPLICATE_STREAM_INDEX' }
  }

  // Non stimiamo mai la durata dalla dimensione. Il massimo delle fonti credibili
  // evita che una coda audio o una timeline container più lunga aggiri il tetto.
  const videoDurationSeconds = traceDuration(video)
  const audioDurationSeconds = audio ? traceDuration(audio) : null
  const durationCandidates = [
    finitePositive(format.duration),
    ...taggedDurations(format),
    ...streams
      .filter((stream) => stream.codec_type === 'video' || stream.codec_type === 'audio')
      .flatMap((stream) => [streamDuration(stream), ...taggedDurations(stream)]),
  ].filter((duration): duration is number => duration !== null)
  if (durationCandidates.length === 0) return { ok: false, code: 'UNKNOWN_DURATION' }
  const durationSeconds = durationCandidates.reduce(
    (maximum, duration) => Math.max(maximum, duration),
    0,
  )
  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    return { ok: false, code: 'VIDEO_TOO_LONG' }
  }

  const colorTransfer = nullableString(video.color_transfer)
  const colorPrimaries = nullableString(video.color_primaries)
  const colorSpace = nullableString(video.color_space)

  const pixelAspectRatio = sampleAspectRatio(video.sample_aspect_ratio)
  if (pixelAspectRatio === null) return { ok: false, code: 'INVALID_PROBE' }
  const displayWidth = Math.round(width * pixelAspectRatio)
  if (!Number.isSafeInteger(displayWidth) || displayWidth <= 0) {
    return { ok: false, code: 'INVALID_PROBE' }
  }
  const rotation = rotationFrom(video)
  if (rotation === null) return { ok: false, code: 'INVALID_PROBE' }
  const radians = (rotation * Math.PI) / 180
  const visualWidth = Math.round(
    Math.abs(displayWidth * Math.cos(radians)) + Math.abs(height * Math.sin(radians)),
  )
  const visualHeight = Math.round(
    Math.abs(displayWidth * Math.sin(radians)) + Math.abs(height * Math.cos(radians)),
  )
  if (
    !Number.isSafeInteger(visualWidth) ||
    visualWidth <= 0 ||
    !Number.isSafeInteger(visualHeight) ||
    visualHeight <= 0
  ) {
    return { ok: false, code: 'INVALID_PROBE' }
  }

  return {
    ok: true,
    probe: {
      durationSeconds,
      videoDurationSeconds,
      audioDurationSeconds,
      width: visualWidth,
      height: visualHeight,
      codedWidth,
      codedHeight,
      rotation,
      fps,
      hasAudio: audio !== null,
      audioCodec,
      videoCodec,
      pixelFormat: nullableString(video.pix_fmt),
      colorTransfer,
      colorPrimaries,
      colorSpace,
      isHdr:
        colorTransfer === 'smpte2084' ||
        colorTransfer === 'arib-std-b67' ||
        hasHdrSideData(video),
      videoStreamIndex,
      audioStreamIndex,
    },
  }
}
