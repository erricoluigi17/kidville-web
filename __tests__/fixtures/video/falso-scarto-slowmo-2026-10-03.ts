import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TimelineFixture } from './falso-scarto-2026-09-28'

/* ════════════════════════════════════════════════════════════════════════════
 * IL FALSO SCARTO DELLO SLOW-MOTION — `m05` della matrice di collaudo E1, 03/10/2026
 *
 * `m05-slowmo-vfr.mov` è stato respinto due volte (da iOS e da Android) con `OUTPUT_FPS_INVALID`, motivo
 * `FPS_LIMIT`, dopo una conversione corretta: modo `reduce60`, 720 fotogrammi in ingresso, 602 in uscita,
 * copertura 10.029,167 ms contro 10.033,333 ms. È un file SINTETICO (`testsrc2` a 240 fps, nessun dato di
 * nessuno): HEVC 1080p di 10 s con un tratto a 240 fps (4-6 s, 480 fotogrammi) e due tratti a 30 fps
 * (0-4 s e 6-10 s, 120 fotogrammi l'uno), cioè un VFR come quello di un rallentatore, con
 * `avg_frame_rate` 72/1.
 *
 * Misurato il 03/10/2026, solo numeri:
 *
 *   · `falso-scarto-slowmo-2026-10-03-sorgente.json` — `ffprobe` con le opzioni della sonda temporale sul
 *     file della matrice: 720 fotogrammi video, ultimo PTS 153.536 tick (9,995833 s) e ultimo campione di
 *     512 tick (33,333 ms: la coda a 30 fps);
 *   · `falso-scarto-slowmo-2026-10-03-uscita.json` — la stessa sonda sull'uscita di una conversione vera
 *     fatta con gli ARGOMENTI DI PRODUZIONE (quelli che stampa `buildVideoEncodeArgs`: `fps=60`,
 *     `-fps_mode:v passthrough`, `-enc_time_base:v filter`), con ffmpeg 8.1.2: 602 fotogrammi sulla griglia a
 *     60 Hz che parte dal primo PTS (256 tick di 1/15360 s l'uno), ultimo PTS 153.856 tick (10,016667 s).
 *     Sono gli stessi 602 fotogrammi e la stessa copertura (10.033,333 ms) della diagnosi del job respinto.
 *
 * Contengono SOLO il video e SOLO la proiezione di ffprobe (streams{index, codec_type, time_base,
 * avg_frame_rate, r_frame_rate, disposition.attached_pic}, frames{stream_index, best_effort_timestamp,
 * duration}): nessun tag, nessun side data, nessun nome. L'audio manca di proposito — il difetto sta tutto nel
 * ramo video, e l'audio ha la fixture del 28/09 — e `violazioniDiPrivacy` (della fixture del 28/09)
 * lo verifica, perché il repository è pubblico.
 * ════════════════════════════════════════════════════════════════════════════ */

const CARTELLA = join(process.cwd(), '__tests__', 'fixtures', 'video')

/** Una copia fresca ogni volta: i test le alterano per costruire le controprove. */
export function leggiTimelineSlowmo(nome: 'sorgente' | 'uscita'): TimelineFixture {
  return JSON.parse(readFileSync(join(CARTELLA, `falso-scarto-slowmo-2026-10-03-${nome}.json`), 'utf8')) as TimelineFixture
}

/** L'indice del video: la sola traccia delle due timeline, sia in ingresso sia in uscita. */
export const SLOWMO = { video: 0 } as const

/** `avg_frame_rate` della sorgente (720 fotogrammi in 10 s): è il `fps` che il probe passa davvero al confronto. */
export const FPS_SLOWMO = 72

/** Il tick comune alle due timeline: 1/15360 s. Un fotogramma della griglia a 60 Hz ne occupa 256. */
export const TICK_SLOWMO = 1 / 15_360
