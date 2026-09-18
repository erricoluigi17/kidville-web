/**
 * LA BUILD DI FFMPEG CHE CONVERTE I VIDEO — numeri e stringhe, senza nessun import.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE QUESTO FILE, e perché non basta scrivere «ffmpeg» da qualche parte.
 *
 * La conversione gira dentro un Vercel Sandbox, su una build scaricata da Internet.
 * Se il collaudo in CI usa una build DIVERSA da quella del Sandbox, un test verde non
 * dice niente sul comportamento in produzione: dice che *una* certa FFmpeg fa *una*
 * certa cosa. Non è un'ipotesi — è la misura del 2026-09-17, e sta scritta qui perché
 * è il motivo per cui questo file esiste:
 *
 *   · `/opt/homebrew/bin/ffmpeg` 8.1.2, la build che un Mac ha addosso dopo
 *     `brew install ffmpeg`, NON ha il filtro `zscale`: Homebrew non compila libzimg.
 *   · `zscale` è il primo filtro di `hdrToSdrFilters()` (`./encode.ts`). Senza,
 *     OGNI video HDR fallisce con «No such filter», e i casi di collaudo sull'HDR non
 *     stanno misurando la nostra conversione: stanno misurando il pacchettizzatore.
 *
 * Perciò la build è **pinnata alla release datata**, non al tag mobile `latest`, e si
 * verifica con lo SHA-256 prima di essere eseguita. Lo stesso numero sta in tre posti
 * — qui, in `.github/workflows/ci.yml` e nella spec — e il lock
 * `__tests__/architecture/fixture-video-reali.test.ts` fallisce se divergono.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Provenienza e misura: `docs/superpowers/specs/2026-09-16-video-build-verificata.md`.
 */

/** FFmpeg n9.0.1-30-g9258bacca5, Linux x86_64 GPL, pacchetto BtbN del 2026-09-15. */
export const ARCHIVIO_FFMPEG_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-15-13-18/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz'

/**
 * SHA-256 pubblicato da BtbN e verificato due volte: sul download locale e dentro il
 * Sandbox. Si controlla PRIMA di estrarre: un archivio scaricato da una release
 * pubblica è codice che sta per girare con i nostri file dentro.
 */
export const ARCHIVIO_FFMPEG_SHA256 =
  'adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71'

/** La cartella radice dentro il tarball: i binari stanno sotto `<radice>/bin/`. */
export const RADICE_ARCHIVIO_FFMPEG = 'ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0'

export const FFMPEG_NELL_ARCHIVIO = `${RADICE_ARCHIVIO_FFMPEG}/bin/ffmpeg`
export const FFPROBE_NELL_ARCHIVIO = `${RADICE_ARCHIVIO_FFMPEG}/bin/ffprobe`

/**
 * I FILTRI CHE IL FILTERGRAPH DI PRODUZIONE NOMINA, uno per uno.
 *
 * Non è un elenco di buone intenzioni: è ciò che `buildVideoEncodeArgs` scrive nella
 * riga di comando. Una build che ne perde uno non fallisce all'installazione — fallisce
 * al primo video che imbocca quel ramo, cioè in produzione e su un file di un genitore.
 * Chi risolve un binario (il collaudo oggi, il runner domani) verifica questa lista e si
 * rifiuta di partire se manca qualcosa, invece di scoprirlo per via di uno stderr.
 *
 * NON SI TIENE ALLINEATO A MANO. Il lock `__tests__/architecture/fixture-video-reali.test.ts`
 * ricava i nomi dal filtergraph vero, su tutti i suoi rami, e cade se qui ne manca uno:
 * è così che il 2026-09-17, aggiungendo `sidedata`, è venuto fuori che l'elenco aveva già
 * perso `setsar` — nominato dal ramo Galleria da sempre, e mai dichiarato.
 */
export const FILTRI_RICHIESTI = [
  'zscale', // HDR→SDR e conversione SDR completa: senza libzimg non esiste
  'tonemap', // compressione della gamma dinamica, `tonemap=hable`
  'scale', // Full HD senza upscale, con `reset_sar`
  'overlay', // watermark della Galleria
  'setsar', // pixel quadrati sul watermark prima dell'overlay
  'fps', // riduzione a 60 fps sopra soglia
  'format', // `gbrpf32le` in mezzo alla catena, `yuv420p` alla fine
  'sidedata', // cancella i SEI di mastering display e content light level
] as const

/** I decoder degli originali che `./limiti.ts` promette di saper leggere. */
export const DECODER_RICHIESTI = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'prores', 'dnxhd'] as const

/** Gli encoder dell'uscita, più quelli che servono a fabbricare le fixture di collaudo. */
export const ENCODER_RICHIESTI = ['libx264', 'aac', 'libx265', 'prores_ks', 'dnxhd'] as const
