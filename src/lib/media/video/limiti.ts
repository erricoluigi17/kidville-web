export const MAX_VIDEO_INPUT_BYTES = 2_000_000_000

/**
 * La durata massima di un video accettato: CINQUE minuti.
 *
 * Era 180 secondi fino al 2026-10-02, quando il titolare ha portato il tetto a 5 minuti
 * (PR 2 «video: server e web», decisione del titolare: peso e uscita restano quelli di
 * prima). È il numero da cui DERIVA ogni tetto di durata del repository — il probe, la
 * dichiarazione del client (`schemaFileVideoDichiarato`), i controlli prima di caricare, il
 * tetto VBV di `encode.ts` — e nessun altro posto deve riscriverlo: un secondo «180» cablato
 * in un modulo diventa il tetto che rifiuta un filmato di quattro minuti con la sicurezza di
 * chi sta applicando la regola. Lo stesso vale per i testi dei cataloghi («5 minuti»), che il
 * lock `__tests__/lib/video-contratto.test.ts` confronta con questa costante.
 */
export const MAX_VIDEO_DURATION_SECONDS = 300

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
