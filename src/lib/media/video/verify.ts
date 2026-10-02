import { MAX_VIDEO_INPUT_BYTES } from './limiti'
import { outputVideoColorMetadata } from './encode'
import type { VideoProbe } from './probe'
import { VIDEO_TEMPORAL_REASONS, type VideoTemporalEvidence } from './temporale'

const AAC_SAMPLES_PER_FRAME = 1024
const MAX_LANDSCAPE = { width: 1920, height: 1080 } as const
const MAX_PORTRAIT = { width: 1080, height: 1920 } as const

export interface VideoDecodeEvidence {
  exitCode: number
  decodedFrames: number
  temporal?: VideoTemporalEvidence | null
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
/**
 * I pixel dell'uscita sono quadrati — e «non dichiarato» CONTA COME QUADRATO.
 *
 * ⚠️ Fino al 2026-09-18 qui c'era `normalizedString(video.sample_aspect_ratio) !== '1:1'`,
 * e ha respinto il primo video vero della pipeline: un `.mov` da iPhone convertito
 * per due minuti e cinquantaquattro secondi, uscita h264/aac perfetta, rifiutata
 * con `OUTPUT_VIDEO_INVALID` perche' le mancava un campo.
 *
 * Non era un'anomalia del file, e' come funziona MP4: quando i pixel sono quadrati
 * il muxer NON scrive l'atomo `pasp`, perche' 1:1 e' il valore predefinito e non
 * c'e' niente da dichiarare — quindi `ffprobe` non riporta il campo affatto.
 * Pretenderlo significa pretendere che l'encoder scriva cio' che non ha motivo di
 * scrivere, ed e' il GEMELLO del difetto sul `color_range` chiuso il giorno prima:
 * ne abbiamo corretto uno e non abbiamo cercato l'altro.
 *
 * L'allentamento e' stretto, e la distinzione e' quella che conta: si accetta
 * l'ASSENZA di una dichiarazione (campo mancante, `0:1`, `N/A` — le tre forme con
 * cui ffprobe dice «non saprei»), si respinge una dichiarazione di pixel NON
 * quadrati, che deformerebbe l'immagine su ogni lettore che la onora.
 */
function pixelQuadrati(stream: JsonObject): boolean {
  const dichiarato = normalizedString(stream.sample_aspect_ratio)
  if (dichiarato === null || dichiarato === '' || dichiarato === 'n/a' || dichiarato === '0:1') {
    return true
  }
  return dichiarato === '1:1'
}

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

/**
 * La prova temporale è ben formata, dice `ok` e descrive proprio i frame che la decodifica ha contato.
 * Il resto (modo, frame rate, uguaglianza dei conteggi) lo decide chi la usa.
 */
function provaTemporaleValida(evidence: VideoDecodeEvidence): VideoTemporalEvidence | null {
  const temporal = evidence.temporal
  if (!temporal || temporal.version !== 1 || temporal.ok !== true ||
      !Number.isSafeInteger(temporal.sourceFrames) || temporal.sourceFrames <= 0 ||
      temporal.outputFrames !== evidence.decodedFrames) return null
  return temporal
}

function fpsMatches(sourceFps: number, outputFps: number, evidence: VideoDecodeEvidence): boolean {
  // Fail-closed: media o r_frame_rate, da soli, non dimostrano una conversione
  // temporale corretta. L'attestazione proviene dalla decodifica nella Sandbox.
  const temporal = provaTemporaleValida(evidence)
  if (!temporal || temporal.sourceFps !== sourceFps || temporal.outputFps !== outputFps) return false
  return sourceFps > 60
    ? temporal.mode === 'reduce60' && Math.abs(outputFps - 60) <= 0.01
    : temporal.mode === 'preserve' && temporal.sourceFrames === temporal.outputFrames
}

/**
 * Quanto dura l'ultimo campione video della sorgente, SE e solo se la conversione è 1:1 — cioè conteggio
 * dei frame e PTS coincidono, ed è la stessa prova che `fpsMatches` pretende dal ramo `preserve`.
 *
 * Perché serve. Il muxer non conserva la durata dell'ultimo campione: la sceglie lui (misurato il
 * 28/09/2026: 3,035 ms in ingresso, 33,333 ms in uscita, con i 264 PTS identici). Quando la sorgente ha un
 * ultimo campione più lungo di un frame — un'inquadratura ferma tenuta fino alla fine, una registrazione
 * di schermo — l'uscita risulta più CORTA di tutta la differenza, e un frame di tolleranza la scartava
 * come troncata. Con i PTS identici fotogramma per fotogramma quella differenza non può essere altro che
 * la durata dell'ultimo campione: è il solo grado di libertà che resta.
 *
 * Perché non apre un varco al troncamento: un frame mancante fa già fallire il conteggio (prima di
 * arrivare qui), e in `reduce60` — dove conteggio e PTS NON coincidono — la tolleranza resta quella di
 * sempre. Una misura assente, non positiva o più lunga della traccia stessa (incoerente: un campione
 * non dura più del video che lo contiene) non allarga niente.
 */
function ultimoCampioneConservato(evidence: VideoDecodeEvidence, durataTracciaSorgente: number): number | null {
  const temporal = provaTemporaleValida(evidence)
  if (!temporal || temporal.mode !== 'preserve' || temporal.sourceFrames !== temporal.outputFrames) return null
  const campione = temporal.measures?.sourceLastSample
  if (typeof campione !== 'number' || !Number.isFinite(campione) || campione <= 0) return null
  return campione <= durataTracciaSorgente ? campione : null
}

/**
 * Di quanto possono differire due durate: `max(1 frame, ultimo campione della sorgente)` più il padding
 * AAC. Senza un ultimo campione da far valere (`null`) è il frame di prima, né più né meno.
 *
 * L'unico punto che la calcola: la verifica e la diagnosi leggono lo stesso numero.
 */
function durationTolerance(
  outputFps: number,
  audioSampleRate: number | null,
  ultimoCampione: number | null,
): number {
  const oneFrame = 1 / outputFps
  const aacPadding = audioSampleRate === null ? 0 : AAC_SAMPLES_PER_FRAME / audioSampleRate
  return Math.max(oneFrame, ultimoCampione ?? 0) + aacPadding
}

function durationMatches(sourceDuration: number, outputDuration: number, tolerance: number): boolean {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return false
  // Limite aperto: perdere esattamente l'intera tolleranza non è considerato
  // una conversione completa. Lo stesso margine impedisce code spurie estese.
  return Math.abs(outputDuration - sourceDuration) < tolerance
}

/**
 * Verifica i metadati dell'output e l'esito della decodifica completa eseguita
 * dal runner con `ffmpeg -xerror -err_detect explode`. Non usa il parser degli
 * input: l'output AAC può legittimamente superare di pochi millisecondi il tetto
 * di durata dell'ingresso.
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
    !pixelQuadrati(video)
  ) {
    return { ok: false, code: 'OUTPUT_VIDEO_INVALID' }
  }

  const rotation = outputRotation(video)
  if (rotation !== 0) return { ok: false, code: 'OUTPUT_ROTATION_INVALID' }
  if (!dimensionsMatch(source, width, height)) {
    return { ok: false, code: 'OUTPUT_DIMENSIONS_INVALID' }
  }
  if (!fpsMatches(source.fps, fps, decodeEvidence)) return { ok: false, code: 'OUTPUT_FPS_INVALID' }

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
  // L'ultimo campione della sorgente allarga la tolleranza di tutto ciò che contiene la traccia
  // VIDEO (la sua durata e quella complessiva); la durata della traccia AUDIO non c'entra, e ha il
  // suo padding AAC e nient'altro.
  const toleranzaVideo = durationTolerance(
    fps,
    audioSampleRate,
    ultimoCampioneConservato(decodeEvidence, sourceVideoDuration),
  )
  const toleranzaAudio = durationTolerance(fps, audioSampleRate, null)
  if (
    !durationMatches(sourceVideoDuration, videoDurationSeconds, toleranzaVideo) ||
    (audioDurationSeconds !== null &&
      sourceAudioDuration !== undefined &&
      sourceAudioDuration !== null &&
      !durationMatches(sourceAudioDuration, audioDurationSeconds, toleranzaAudio))
  ) {
    return { ok: false, code: 'OUTPUT_DURATION_MISMATCH' }
  }

  const formatDuration = positiveNumber(format.duration)
  const durationSeconds = Math.max(
    videoDurationSeconds,
    audioDurationSeconds ?? 0,
    formatDuration ?? 0,
  )
  if (!durationMatches(source.durationSeconds, durationSeconds, toleranzaVideo)) {
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

/* ────────────────────────────────────────────────────────────────────────────
 * La diagnosi di una verifica: i numeri, non solo il codice
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I codici dell'esito, come elenco a runtime. Un `Record` e non un array: se
 * `VideoOutputVerificationErrorCode` cresce, il file smette di compilare finché non c'è anche qui, quindi
 * la lista bianca della diagnosi non può restare indietro in silenzio.
 */
const CODICI_ESITO_DIAGNOSI: Record<VideoOutputVerificationErrorCode, true> = {
  INVALID_OUTPUT_SIZE: true,
  OUTPUT_TOO_LARGE: true,
  INVALID_DECODE_EVIDENCE: true,
  OUTPUT_DECODE_FAILED: true,
  OUTPUT_NO_DECODED_FRAMES: true,
  INVALID_OUTPUT_PROBE: true,
  OUTPUT_FFPROBE_ERROR: true,
  OUTPUT_CONTAINER_INVALID: true,
  OUTPUT_VIDEO_INVALID: true,
  OUTPUT_ROTATION_INVALID: true,
  OUTPUT_DIMENSIONS_INVALID: true,
  OUTPUT_FPS_INVALID: true,
  OUTPUT_DURATION_UNKNOWN: true,
  OUTPUT_DURATION_MISMATCH: true,
  OUTPUT_AUDIO_MISSING: true,
  OUTPUT_AUDIO_UNEXPECTED: true,
  OUTPUT_AUDIO_INVALID: true,
  OUTPUT_NOT_SDR: true,
}

type ChiaveNumericaDiagnosi =
  | 'frame_sorgente'
  | 'frame_uscita'
  | 'frame_decodificati'
  | 'fps_sorgente'
  | 'fps_uscita'
  | 'copertura_sorgente_ms'
  | 'copertura_uscita_ms'
  | 'ultimo_campione_sorgente_ms'
  | 'ultimo_campione_uscita_ms'
  | 'durata_video_sorgente_ms'
  | 'durata_video_uscita_ms'
  | 'durata_audio_sorgente_ms'
  | 'durata_audio_uscita_ms'
  | 'tolleranza_durata_ms'
  | 'tolleranza_pts_ms'
  | 'tracce_audio_ignorate'

/**
 * Ciò che finisce in `video_jobs.diagnosi_verifica` (jsonb, ≤ 2048 byte): SOLO numeri ed enumerati.
 * Nessun nome, nessun percorso, nessuna stringa che arrivi dal file: le uniche stringhe sono `esito`,
 * `modo` e `motivo`, e ciascuna esce da un elenco chiuso. Tempi in millisecondi, frame come interi.
 */
export type DiagnosiVerifica = Partial<Record<ChiaveNumericaDiagnosi, number>> & {
  /** Versione dello schema, per chi legge la colonna fra sei mesi. */
  v: 1
  esito: VideoOutputVerificationErrorCode | 'ok' | 'SCONOSCIUTO'
  modo?: VideoTemporalEvidence['mode']
  motivo?: (typeof VIDEO_TEMPORAL_REASONS)[number] | 'SCONOSCIUTO'
}

/** Nessun numero della diagnosi esce da qui: undici giorni in millisecondi, o un miliardo di frame. */
const LIMITE_NUMERO_DIAGNOSI = 1e9

function numeroDiagnosi(value: unknown, decimali: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const limitato = Math.max(-LIMITE_NUMERO_DIAGNOSI, Math.min(LIMITE_NUMERO_DIAGNOSI, value))
  const fattore = 10 ** decimali
  return Math.round(limitato * fattore) / fattore
}

/** Secondi in millisecondi. Il controllo sul tipo viene PRIMA della moltiplicazione: `'12' * 1000` è 12000. */
function millisecondiDiagnosi(secondi: unknown): number | undefined {
  return typeof secondi === 'number' ? numeroDiagnosi(secondi * 1000, 3) : undefined
}

/**
 * Costruisce l'oggetto di `diagnosi_verifica`: i numeri con cui un rifiuto (o un'accettazione) si legge
 * dopo, invece del solo codice. Funzione pura e TOTALE: qualunque input malformato dà meno campi, mai
 * un'eccezione — gira sul percorso di un fallimento e non deve mascherarlo.
 *
 * I numeri della prova temporale (copertura, ultimo campione, tolleranza sui PTS) arrivano dalla
 * Sandbox, e quindi da un marcatore che questo modulo non controlla: ogni valore passa per
 * `numeroDiagnosi` (finito, limitato, arrotondato) e ogni stringa per un elenco chiuso. Il limite dei
 * 2048 byte vale PER COSTRUZIONE: venti chiavi in tutto, ciascuna con un numero di al più ~15 caratteri
 * (il caso peggiore, tutti i campi presenti e tutti i numeri al limite, misura 614 byte).
 *
 * La tolleranza sulla durata è calcolata da `durationTolerance`, la stessa funzione che decide: la
 * diagnosi non può raccontare un numero diverso da quello usato.
 *
 * Il cablaggio nel runner (scrivere questo oggetto con `video_job_diagnosi`) non sta qui.
 */
export function diagnosiVerifica(
  source: VideoProbe,
  rawOutputProbe: unknown,
  decodeEvidence: VideoDecodeEvidence | null | undefined,
  esito: VideoOutputVerificationErrorCode | 'ok',
): DiagnosiVerifica {
  const diagnosi: DiagnosiVerifica = {
    v: 1,
    esito: esito === 'ok' || Object.hasOwn(CODICI_ESITO_DIAGNOSI, esito) ? esito : 'SCONOSCIUTO',
  }

  const temporal = decodeEvidence?.temporal ?? null
  if (temporal?.mode === 'preserve' || temporal?.mode === 'reduce60') diagnosi.modo = temporal.mode
  if (typeof temporal?.reason === 'string') {
    diagnosi.motivo = (VIDEO_TEMPORAL_REASONS as readonly string[]).includes(temporal.reason)
      ? temporal.reason
      : 'SCONOSCIUTO'
  }
  const misure = temporal?.measures

  // L'uscita come l'ha vista ffprobe: lo stesso modo di leggerla di `verifyVideoOutput`.
  const root = asObject(parseRaw(rawOutputProbe))
  const streams = (Array.isArray(root?.streams) ? root.streams : [])
    .map(asObject)
    .filter((stream): stream is JsonObject => stream !== null)
  const videos = streams.filter(
    (stream) => stream.codec_type === 'video' && !dispositionFlag(stream, 'attached_pic'),
  )
  const audios = streams.filter((stream) => stream.codec_type === 'audio')
  const video = videos.length === 1 ? videos[0] : null
  const audio = audios.length === 1 ? audios[0] : null
  const fpsUscita = (video ? (rational(video.avg_frame_rate) ?? rational(video.r_frame_rate)) : null) ?? null
  const sampleRateUscita = audio ? positiveInteger(audio.sample_rate) : null

  const durataVideoSorgente = source?.videoDurationSeconds ?? source?.durationSeconds
  let tolleranzaDurata: number | undefined
  if (fpsUscita !== null && typeof durataVideoSorgente === 'number' && decodeEvidence) {
    tolleranzaDurata = durationTolerance(
      fpsUscita,
      sampleRateUscita,
      ultimoCampioneConservato(decodeEvidence, durataVideoSorgente),
    )
  }

  const numeri: Array<[ChiaveNumericaDiagnosi, number | undefined]> = [
    ['frame_sorgente', numeroDiagnosi(temporal?.sourceFrames, 0)],
    ['frame_uscita', numeroDiagnosi(temporal?.outputFrames, 0)],
    ['frame_decodificati', numeroDiagnosi(decodeEvidence?.decodedFrames, 0)],
    ['fps_sorgente', numeroDiagnosi(source?.fps, 4)],
    ['fps_uscita', numeroDiagnosi(fpsUscita ?? temporal?.outputFps, 4)],
    ['copertura_sorgente_ms', millisecondiDiagnosi(misure?.sourceCoverage)],
    ['copertura_uscita_ms', millisecondiDiagnosi(misure?.outputCoverage)],
    ['ultimo_campione_sorgente_ms', millisecondiDiagnosi(misure?.sourceLastSample)],
    ['ultimo_campione_uscita_ms', millisecondiDiagnosi(misure?.outputLastSample)],
    ['durata_video_sorgente_ms', millisecondiDiagnosi(durataVideoSorgente)],
    ['durata_video_uscita_ms', millisecondiDiagnosi(video ? traceDuration(video) : null)],
    ['durata_audio_sorgente_ms', millisecondiDiagnosi(source?.audioDurationSeconds)],
    ['durata_audio_uscita_ms', millisecondiDiagnosi(audio ? traceDuration(audio) : null)],
    ['tolleranza_durata_ms', millisecondiDiagnosi(tolleranzaDurata)],
    ['tolleranza_pts_ms', millisecondiDiagnosi(misure?.epsilon)],
    ['tracce_audio_ignorate', numeroDiagnosi(source?.ignoredAudioTracks, 0)],
  ]
  for (const [chiave, valore] of numeri) {
    if (valore !== undefined) diagnosi[chiave] = valore
  }
  return diagnosi
}
