export const MAX_VIDEO_INPUT_BYTES = 2_000_000_000
export const MAX_VIDEO_DURATION_SECONDS = 180

/** Nomi restituiti da `ffprobe format.format_name`, non estensioni del file. */
export const SUPPORTED_VIDEO_CONTAINERS = [
  'mov',
  'mp4',
  'm4v',
  '3gp',
  '3g2',
  'mj2',
  'webm',
  'matroska',
  'avi',
  'asf',
  'mpeg',
  'mpegvideo',
  'flv',
  'ogg',
  'mpegts',
  'mpegtsraw',
  'mxf', // Il demuxer `mxf` copre anche MXF D-10.
] as const

/**
 * Codec video che la pipeline FFmpeg può tentare di decodificare. Essere nella matrice
 * autorizza il tentativo: non promette che ogni profilo privato o non standard sia leggibile.
 */
export const SUPPORTED_VIDEO_CODECS = [
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
  'prores',
  'dnxhd', // Il decoder `dnxhd` copre sia DNxHD sia DNxHR.
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
] as const

export type VideoInputSizeErrorCode = 'INVALID_FILE_SIZE' | 'EMPTY_FILE' | 'FILE_TOO_LARGE'

export type VideoInputSizeResult =
  | { ok: true }
  | { ok: false; code: VideoInputSizeErrorCode }

export function validateVideoInputSize(bytes: number): VideoInputSizeResult {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { ok: false, code: 'INVALID_FILE_SIZE' }
  }
  if (bytes === 0) {
    return { ok: false, code: 'EMPTY_FILE' }
  }
  if (bytes > MAX_VIDEO_INPUT_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE' }
  }

  return { ok: true }
}
