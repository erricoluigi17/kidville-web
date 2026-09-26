import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from './limiti'
import type { VideoProbe } from './probe'

/**
 * Opzioni passate direttamente a `spawn`/`execFile`: ogni elemento restituito è
 * un argomento FFmpeg autonomo. I percorsi non vengono mai interpolati in una shell.
 */
export type VideoEncodeOptions =
  | {
      channel: 'gallery'
      inputPath: string
      outputPath: string
      watermarkPath: string
    }
  | {
      channel: 'news'
      inputPath: string
      outputPath: string
      watermarkPath?: never
    }

const MAX_LANDSCAPE = { width: 1920, height: 1080 } as const
const MAX_PORTRAIT = { width: 1080, height: 1920 } as const

function evenFloor(value: number): number {
  return Math.floor(value / 2) * 2
}

/**
 * Dimensioni di uscita a pixel quadrati, entro Full HD e mai maggiori delle
 * dimensioni di visualizzazione fornite dal probe. `VideoProbe.width/height`
 * includono già SAR e rotazione: `codedWidth/codedHeight` non vanno riapplicati.
 */
function outputDimensions(probe: VideoProbe): { width: number; height: number } {
  if (!Number.isFinite(probe.width) || !Number.isFinite(probe.height) || probe.width <= 0 || probe.height <= 0) {
    throw new TypeError('Dimensioni video non valide')
  }

  const box = probe.width >= probe.height ? MAX_LANDSCAPE : MAX_PORTRAIT
  const ratio = Math.min(1, box.width / probe.width, box.height / probe.height)
  const dimensions = {
    width: evenFloor(probe.width * ratio),
    height: evenFloor(probe.height * ratio),
  }
  // yuv420p richiede dimensioni pari. Un input sotto 2 px non può rispettare
  // insieme quel vincolo e «mai upscale», quindi viene respinto esplicitamente.
  if (dimensions.width < 2 || dimensions.height < 2) {
    throw new TypeError('Dimensioni video troppo piccole')
  }
  return dimensions
}

/**
 * HDR10/PQ e HLG diventano SDR BT.709 in virgola mobile.
 *
 * La sequenza segue i filtri ufficiali FFmpeg: `zscale` linearizza il segnale,
 * `tonemap` comprime la gamma dinamica e il secondo `zscale` assegna primarie,
 * transfer, matrice e range di destinazione. `npl=100` definisce il bianco SDR.
 */
function hdrToSdrFilters(): string[] {
  return [
    'zscale=transfer=linear:npl=100',
    'format=gbrpf32le',
    'zscale=primaries=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited',
  ]
}

/**
 * I SEI HDR VANNO CANCELLATI A MANO: `-map_metadata -1` non li vede.
 *
 * Misurato il 2026-09-17 (ffmpeg 8.1.2): una sorgente HEVC con `master-display` e
 * `max-cll` porta «Mastering display metadata» e «Content light level metadata»
 * come side data DEI FRAME, non come metadati del contenitore. Attraversano tutto
 * il filtergraph, libx264 li rilegge e li riscrive nell'H.264 — così l'uscita è
 * SDR nei pixel (`hdrToSdrFilters` ha fatto il suo lavoro) e HDR nei SEI, e
 * `verifyVideoOutput` la respinge con `OUTPUT_NOT_SDR`. Cioè: ogni video HDR
 * girato col telefono veniva convertito bene e poi buttato.
 *
 * `sidedata=mode=delete` toglie un tipo per volta, perciò servono due istanze.
 * La stessa prova con la cancellazione attiva lascia il side data di uscita vuoto,
 * conservando il SEI «User Data Unregistered» con cui x264 si firma.
 *
 * PERCHÉ NON `-bsf:v filter_units=remove_types=6`: quello butta via TUTTI i SEI
 * dell'H.264, non i due dell'HDR — firma dell'encoder, picture timing, closed
 * caption comprese. È un'amputazione dove serve una cancellazione mirata.
 *
 * PERCHÉ SOLO QUESTI DUE E NON I TIPI DOLBY VISION: ogni nome scritto qui è una
 * dipendenza dura dalla build. Misurato: un tipo che la build non conosce fa
 * fallire l'apertura del filtergraph («Unable to parse "type" option value»),
 * cioè romperebbe OGNI conversione, non solo quelle DV. E un RPU Dolby Vision non
 * può comunque finire in un H.264 di libx264, che non sa scriverlo. Il ramo
 * «dolby vision» di `hasHdrSideData` resta: se un domani ci arrivasse, deve dirlo
 * forte invece di passare.
 */
function cancellaSideDataHdr(): string[] {
  return [
    'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
    'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
  ]
}

function sdrToBt709Filters(): string[] {
  return [
    'zscale=transfer=linear:npl=100',
    'format=gbrpf32le',
    'zscale=primaries=bt709',
    'zscale=transfer=bt709:matrix=bt709:range=limited',
  ]
}

const COLOR_PRIMARIES = new Set([
  'bt709',
  'bt470m',
  'bt470bg',
  'smpte170m',
  'smpte240m',
  'film',
  'bt2020',
  'smpte428',
  'smpte431',
  'smpte432',
  'jedec-p22',
  'ebu3213',
])

const COLOR_TRANSFERS = new Set([
  'bt709',
  'gamma22',
  'bt470m',
  'gamma28',
  'bt470bg',
  'smpte170m',
  'smpte240m',
  'linear',
  'log100',
  'log316',
  'iec61966-2-4',
  'bt1361e',
  'iec61966-2-1',
  'bt2020-10',
  'bt2020-12',
  'smpte2084',
  'smpte428',
  'arib-std-b67',
])

const COLOR_SPACES = new Set([
  'rgb',
  'bt709',
  'fcc',
  'bt470bg',
  'smpte170m',
  'smpte240m',
  'ycgco',
  'bt2020nc',
  'bt2020c',
  'smpte2085',
  'chroma-derived-nc',
  'chroma-derived-c',
  'ictcp',
])

const SWSCALE_COLOR_SPACES = new Set([
  'bt709',
  'fcc',
  'bt470bg',
  'smpte170m',
  'smpte240m',
  'bt2020nc',
])

export interface OutputVideoColorMetadata {
  colorPrimaries: string | null
  colorTransfer: string | null
  colorSpace: string | null
  colorRange: 'tv'
}

function trustedColorValue(value: string | null, allowed: ReadonlySet<string>): string | null {
  return value !== null && allowed.has(value) ? value : null
}

function trustedInputColorMetadata(probe: VideoProbe): Omit<OutputVideoColorMetadata, 'colorRange'> {
  return {
    colorPrimaries: trustedColorValue(probe.colorPrimaries, COLOR_PRIMARIES),
    colorTransfer: trustedColorValue(probe.colorTransfer, COLOR_TRANSFERS),
    colorSpace: trustedColorValue(probe.colorSpace, COLOR_SPACES),
  }
}

function hasCompleteColorMetadata(metadata: Omit<OutputVideoColorMetadata, 'colorRange'>): boolean {
  return metadata.colorPrimaries !== null && metadata.colorTransfer !== null && metadata.colorSpace !== null
}

function needsCompleteSdrConversion(probe: VideoProbe): boolean {
  const metadata = trustedInputColorMetadata(probe)
  return hasCompleteColorMetadata(metadata) &&
    [metadata.colorPrimaries, metadata.colorTransfer, metadata.colorSpace].some((value) => value !== 'bt709')
}

/**
 * Contratto colore dell'output codificato. HDR e triplette SDR complete vengono
 * convertiti interamente a BT.709. Con metadati SDR parziali, ogni campo noto
 * resta invariato; la sola matrice può essere convertita a BT.709 da swscale.
 * Un valore assente, unspecified o non fidato resta `null` e viene segnalato
 * come unspecified nel VUI, senza inventare primarie o transfer.
 */
export function outputVideoColorMetadata(probe: VideoProbe): OutputVideoColorMetadata {
  const input = trustedInputColorMetadata(probe)
  if (probe.isHdr || needsCompleteSdrConversion(probe)) {
    return {
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
    }
  }

  return {
    ...input,
    colorSpace:
      input.colorSpace !== null && input.colorSpace !== 'bt709' && SWSCALE_COLOR_SPACES.has(input.colorSpace)
        ? 'bt709'
        : input.colorSpace,
    colorRange: 'tv',
  }
}

function videoFilters(probe: VideoProbe): string[] {
  const dimensions = outputDimensions(probe)
  const filters: string[] = []
  if (probe.isHdr) filters.push(...hdrToSdrFilters())
  else if (needsCompleteSdrConversion(probe)) filters.push(...sdrToBt709Filters())
  const inputColor = trustedInputColorMetadata(probe)
  const matrixConversion =
    !probe.isHdr &&
    !needsCompleteSdrConversion(probe) &&
    inputColor.colorSpace !== null &&
    inputColor.colorSpace !== 'bt709' &&
    SWSCALE_COLOR_SPACES.has(inputColor.colorSpace)
      ? `:in_color_matrix=${inputColor.colorSpace}:out_color_matrix=bt709`
      : ''
  filters.push(
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1${matrixConversion}`,
  )
  // Nessun filtro FPS sotto o alla soglia: i timestamp originali restano intatti.
  if (probe.fps > 60) filters.push('fps=60')
  filters.push('format=yuv420p')
  // In fondo, e incondizionata: `hasHdrSideData` guarda l'USCITA, non la sorgente,
  // e un file rimasterizzato da un HDR porta quei SEI pur dichiarandosi SDR. Su un
  // video che non li ha il filtro non fa niente. Sta prima dell'`overlay` della
  // Galleria, che ricopierebbe i side data del frame principale.
  filters.push(...cancellaSideDataHdr())
  return filters
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * IL TETTO VBV — «capped CRF», e il conto che lo produce.
 *
 * IL DIFETTO, misurato il 2026-09-17: `-crf 18` senza `-maxrate` non ha nessun
 * limite superiore. Un'uscita ha raggiunto 2.073.793.213 byte — sopra
 * `MAX_VIDEO_INPUT_BYTES` — e il rifiuto `OUTPUT_TOO_LARGE` è arrivato DOPO 709 s
 * di wall e 1.452 s di CPU: la conversione era già stata fatta, pagata e buttata.
 *
 * IL CONTO, con i numeri di oggi. Cambiarne uno muove gli altri, ed è il motivo
 * per cui sta scritto qui invece di finire in una costante nuda:
 *
 *   tetto           2.000.000.000 byte × 8            = 16.000.000.000 bit
 *   − audio         192.000 bit/s × 180 s             =     34.560.000 bit
 *                                                       ───────────────
 *                                                       15.965.440.000 bit
 *   − 1% contenitore (moov, tabelle, interleaving)    = 15.805.785.600 bit
 *   ÷ finestra VBV  180 s di durata + 2 s di buffer   =            182 s
 *                                                       ───────────────
 *   -maxrate:v                                          86.844.975 bit/s
 *   -bufsize:v      = 2 × maxrate                      173.689.950 bit
 *
 * Il VBV garantisce che in una finestra di T secondi i bit non superino
 * `maxrate × T + bufsize`: nel caso peggiore ammesso l'uscita pesa 1.980.043.181
 * byte, cioè 19,9 MB sotto il tetto. `OUTPUT_TOO_LARGE` resta in `verify.ts` come
 * rete: qui si evita che il caso patologico accada, là si continua a misurarlo.
 *
 * NON È UN DEGRADO DELLA QUALITÀ. Resta CRF 18 a decidere il bitrate: il tetto è
 * un tetto, non un target (`-b:v` non compare). A 86,8 Mbit/s morde solo su
 * sorgenti che a Full HD non esistono nella pratica — cioè esattamente il caso
 * patologico che ha prodotto quei 2,07 GB.
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** Lo stesso `192k` che finisce in `-b:a`: se cambia lì, cambia il conto qui. */
const BITRATE_AUDIO_BPS = 192_000
/** Secondi di buffer VBV: più largo lascia respirare il CRF, ma va contato nel tetto. */
const SECONDI_BUFFER_VBV = 2
/** Quota del tetto lasciata al contenitore MP4. Aritmetica intera, niente virgola. */
const PERCENTUALE_RISERVATA_AL_CONTENITORE = 1

const BIT_VIDEO_DISPONIBILI = Math.floor(
  ((MAX_VIDEO_INPUT_BYTES * 8 - BITRATE_AUDIO_BPS * MAX_VIDEO_DURATION_SECONDS) *
    (100 - PERCENTUALE_RISERVATA_AL_CONTENITORE)) /
    100,
)
const MAXRATE_VIDEO_BPS = Math.floor(
  BIT_VIDEO_DISPONIBILI / (MAX_VIDEO_DURATION_SECONDS + SECONDI_BUFFER_VBV),
)
const BUFSIZE_VIDEO_BIT = MAXRATE_VIDEO_BPS * SECONDI_BUFFER_VBV

function requirePath(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} non valido`)
  }
  return value
}

/**
 * Genera soltanto gli argomenti FFmpeg, senza eseguire processi e senza imporre
 * una durata. Il limite di 180 secondi appartiene al probe: qui non compare `-t`
 * e un video accettato viene codificato per intero.
 *
 * FFmpeg ha `-autorotate` attivo per default; lo rendiamo esplicito e non
 * aggiungiamo `transpose`/`rotate`. In questo modo la matrice di display viene
 * applicata una volta sola e il `scale` lavora sulle dimensioni display del probe.
 */
export function buildVideoEncodeArgs(probe: VideoProbe, options: VideoEncodeOptions): string[] {
  const inputPath = requirePath(options.inputPath, 'inputPath')
  const outputPath = requirePath(options.outputPath, 'outputPath')
  if (!Number.isInteger(probe.videoStreamIndex) || probe.videoStreamIndex < 0) {
    throw new TypeError('videoStreamIndex non valido')
  }
  const outputColor = outputVideoColorMetadata(probe)
  const x264ColorPrimaries = outputColor.colorPrimaries ?? 'undef'
  const x264ColorTransfer = outputColor.colorTransfer ?? 'undef'
  const x264ColorSpace = outputColor.colorSpace ?? 'undef'

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    // Opzione di input, perciò deve precedere il relativo `-i`.
    '-autorotate',
    '-i',
    inputPath,
  ]

  const filters = videoFilters(probe).join(',')
  let graph: string
  if (options.channel === 'gallery') {
    const watermarkPath = requirePath(options.watermarkPath, 'watermarkPath')
    args.push('-i', watermarkPath)
    // Geometria identica all'elaborazione browser storica: larghezza 70%, centro
    // orizzontale, margine inferiore 5%. L'arrotondamento pari mantiene yuv420p.
    const watermarkWidth = evenFloor(outputDimensions(probe).width * 0.7)
    graph = [
      `[0:${probe.videoStreamIndex}]${filters}[base]`,
      `[1:v:0]scale=${watermarkWidth}:-2:flags=lanczos,setsar=1[wm]`,
      `[base][wm]overlay=x='(main_w-overlay_w)/2':y='main_h-overlay_h-main_h*0.05'[vout]`,
    ].join(';')
  } else {
    graph = `[0:${probe.videoStreamIndex}]${filters}[vout]`
  }

  args.push('-filter_complex', graph, '-map', '[vout]')

  if (probe.hasAudio) {
    if (probe.audioStreamIndex === null || !Number.isInteger(probe.audioStreamIndex) || probe.audioStreamIndex < 0) {
      throw new TypeError('audioStreamIndex non valido')
    }
    // Il bitrate audio esce dalla stessa costante che il conto del tetto VBV
    // sottrae: scritto due volte, prima o poi i due numeri divergono in silenzio.
    args.push('-map', `0:${probe.audioStreamIndex}`, '-c:a', 'aac', '-b:a', `${BITRATE_AUDIO_BPS / 1000}k`)
  } else {
    args.push('-an')
  }

  args.push(
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    // Il default 1/framerate arrotonda i PTS VFR anche quando nessun frame
    // viene perso. Il filtro mantiene la timebase sorgente (o 1/60 dopo fps),
    // e passthrough evita un secondo ricampionamento deciso dal muxer.
    '-fps_mode:v',
    'passthrough',
    '-enc_time_base:v',
    'filter',
    // Capped CRF: il tetto vale sulla sola traccia video, l'audio ha già `-b:a`.
    '-maxrate:v',
    String(MAXRATE_VIDEO_BPS),
    '-bufsize:v',
    String(BUFSIZE_VIDEO_BIT),
    '-pix_fmt',
    'yuv420p',
    // libx264 scrive questi valori anche nel VUI H.264: le sole opzioni generiche
    // non sono conservate da tutte le build/container MP4.
    '-x264-params',
    `colorprim=${x264ColorPrimaries}:transfer=${x264ColorTransfer}:colormatrix=${x264ColorSpace}`,
    '-color_primaries',
    outputColor.colorPrimaries ?? 'unspecified',
    '-color_trc',
    outputColor.colorTransfer ?? 'unspecified',
    '-colorspace',
    outputColor.colorSpace ?? 'unspecified',
    '-color_range',
    outputColor.colorRange,
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    outputPath,
  )

  return args
}
