import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TimelineFixture } from './falso-scarto-2026-09-28'

/* ════════════════════════════════════════════════════════════════════════════
 * IL 240 FPS COSTANTE CHE PARTE FUORI DALLA GRIGLIA — il critico di Tfps, 03/10/2026
 *
 * Il rallentatore classico dell'iPhone, a fps COSTANTI: 482 fotogrammi a 240 fps, il video che parte 9 ms
 * dopo l'audio. La conversione è perfetta (120 fotogrammi sulla griglia a 60 Hz) e la prova temporale la
 * respingeva con `FPS_LIMIT`: l'arco d'uscita risultava più corto di quello di sorgente di 20,833 ms
 * contro un limite di 16,732 (con la partenza a 8 ms, 121 fotogrammi, passava). È un file SINTETICO
 * (`testsrc2` 320×240, H.264 + AAC, nessun dato di nessuno), generato con ffmpeg 8.1.2.
 *
 * Misurato il 03/10/2026, solo numeri:
 *
 *   · `falso-scarto-cfr240-2026-10-03-sorgente.json` — `ffprobe` con le opzioni della sonda temporale sul
 *     file: 482 fotogrammi video, primo PTS a 810 tick di 1/90000 s (9 ms), un fotogramma ogni 375 tick
 *     (4,167 ms) e l'ultimo campione di 375 tick;
 *   · `falso-scarto-cfr240-2026-10-03-uscita.json` — la stessa sonda sull'uscita di una conversione vera
 *     fatta con gli ARGOMENTI DI PRODUZIONE (`buildVideoEncodeArgs`, canale gallery, con la filigrana) e
 *     ffmpeg 8.1.2: 120 fotogrammi sulla griglia a 60 Hz (256 tick di 1/15360 s l'uno), il primo a 246 tick.
 *
 * Contengono SOLO il video e SOLO la proiezione di ffprobe (streams{index, codec_type, time_base,
 * avg_frame_rate, r_frame_rate, disposition.attached_pic}, frames{stream_index, best_effort_timestamp,
 * duration}): nessun tag, nessun side data, nessun nome. L'audio manca di proposito — il difetto sta tutto
 * nel ramo video, e l'audio ha la fixture del 28/09 — e `violazioniDiPrivacy` (della fixture del 28/09)
 * lo verifica, perché il repository è pubblico.
 * ════════════════════════════════════════════════════════════════════════════ */

const CARTELLA = join(process.cwd(), '__tests__', 'fixtures', 'video')

/** Una copia fresca ogni volta: i test le alterano per costruire le controprove. */
export function leggiTimelineCfr240(nome: 'sorgente' | 'uscita'): TimelineFixture {
  return JSON.parse(readFileSync(join(CARTELLA, `falso-scarto-cfr240-2026-10-03-${nome}.json`), 'utf8')) as TimelineFixture
}

/** L'indice del video: la sola traccia delle due timeline, sia in ingresso sia in uscita. */
export const CFR240 = { video: 0 } as const

/** `avg_frame_rate` della sorgente: a fps costanti è il frame rate vero, e il probe lo passa al confronto. */
export const FPS_CFR240 = 240

/** Il tick della sorgente (1/90000 s): un fotogramma a 240 fps ne occupa 375. */
export const TICK_SORGENTE_CFR240 = 1 / 90_000

/** Il tick dell'uscita (1/15360 s): un fotogramma della griglia a 60 Hz ne occupa 256. */
export const TICK_USCITA_CFR240 = 1 / 15_360
