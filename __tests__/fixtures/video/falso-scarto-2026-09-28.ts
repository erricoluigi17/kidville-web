import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ════════════════════════════════════════════════════════════════════════════
 * IL FALSO SCARTO DEL 28/09/2026 — le due timeline VERE, e come si leggono
 *
 * Job `72fff674…`: una conversione perfetta, scartata `OUTPUT_FPS_INVALID` (motivo
 * `TERMINAL_COVERAGE_MISMATCH`). 264 frame video con i PTS IDENTICI uno per uno, e un solo numero
 * diverso: la durata dell'ULTIMO campione, 3,035 ms nella sorgente e 33,333 ms nell'uscita. Misurato
 * il 02/10/2026 nel Sandbox con l'ffprobe pinnato, solo numeri:
 *
 *   · `falso-scarto-2026-09-28-sorgente.json` — audio all'indice 0 (377 frame), video all'indice 1;
 *   · `falso-scarto-2026-09-28-uscita.json`   — video all'indice 0, audio all'indice 1 (il muxer riordina).
 *
 * Contengono SOLO la proiezione di ffprobe — streams{index, codec_type, time_base, avg_frame_rate,
 * r_frame_rate, sample_rate, disposition.attached_pic}, frames{stream_index, best_effort_timestamp,
 * duration} — e niente altro: nessun tag, luogo, data o nome (il repository è pubblico).
 * `violazioniDiPrivacy` lo verifica, e un test la prova su una copia sporcata di proposito.
 * ════════════════════════════════════════════════════════════════════════════ */

export interface FrameFixture {
  stream_index: number
  best_effort_timestamp: number
  duration: number
}

export interface TimelineFixture {
  streams: Array<Record<string, unknown>>
  frames: FrameFixture[]
}

const CARTELLA = join(process.cwd(), '__tests__', 'fixtures', 'video')

/** Una copia fresca ogni volta: i test le alterano per costruire le controprove. */
export function leggiTimeline(nome: 'sorgente' | 'uscita'): TimelineFixture {
  return JSON.parse(readFileSync(join(CARTELLA, `falso-scarto-2026-09-28-${nome}.json`), 'utf8')) as TimelineFixture
}

/** Gli indici delle tracce: la sorgente ha l'audio per prima, l'uscita il video. */
export const SORGENTE = { video: 1, audio: 0 } as const
export const USCITA = { video: 0, audio: 1 } as const

/** `avg_frame_rate` della sorgente: è il `fps` che il probe passa davvero al confronto. */
export const FPS_MEDIO = 4_400_000 / 145_401
/** `r_frame_rate` della sorgente, l'altro modo in cui il confronto veniva riprodotto. */
export const FPS_NOMINALE = 1_000_000 / 33_333

export const framesDi = (timeline: TimelineFixture, indice: number): FrameFixture[] =>
  timeline.frames.filter(f => f.stream_index === indice)

/**
 * Quanto copre una traccia, in secondi: dal primo PTS alla fine dell'ultimo campione. È la stessa misura
 * che `compareVideoTimelines` chiama copertura, ricavata qui dai numeri della fixture: serve a costruire
 * i probe di durata coerenti con le timeline (la fixture non porta le durate dei flussi).
 */
export function coperturaSecondi(timeline: TimelineFixture, indice: number): number {
  const flusso = timeline.streams.find(s => s.index === indice)
  const denominatore = Number(String(flusso?.time_base).split('/')[1])
  const frames = framesDi(timeline, indice)
  const ultimo = frames[frames.length - 1]
  return (ultimo.best_effort_timestamp + ultimo.duration - frames[0].best_effort_timestamp) / denominatore
}

/** Tutto ciò che un file di questa fixture può contenere: i campi della proiezione di ffprobe e nient'altro. */
export function violazioniDiPrivacy(timeline: unknown): string[] {
  const trovate: string[] = []
  const radice = timeline as { streams?: unknown; frames?: unknown } & Record<string, unknown>
  if (JSON.stringify(Object.keys(radice).sort()) !== JSON.stringify(['frames', 'streams'])) trovate.push('chiavi di primo livello')
  const CHIAVI_STREAM = ['index', 'codec_type', 'time_base', 'avg_frame_rate', 'r_frame_rate', 'sample_rate', 'disposition']
  const CHIAVI_FRAME = ['stream_index', 'best_effort_timestamp', 'duration', 'pkt_duration']
  for (const stream of (Array.isArray(radice.streams) ? radice.streams : []) as Array<Record<string, unknown>>) {
    for (const [chiave, valore] of Object.entries(stream)) {
      if (!CHIAVI_STREAM.includes(chiave)) trovate.push(`stream.${chiave}`)
      if (chiave === 'codec_type' && valore !== 'video' && valore !== 'audio') trovate.push('stream.codec_type')
      if ((chiave === 'time_base' || chiave === 'avg_frame_rate' || chiave === 'r_frame_rate') && !/^\d+\/\d+$/.test(String(valore))) trovate.push(`stream.${chiave}`)
      if (chiave === 'sample_rate' && !/^\d+$/.test(String(valore))) trovate.push('stream.sample_rate')
      if (chiave === 'disposition' && JSON.stringify(Object.keys(valore as object)) !== JSON.stringify(['attached_pic'])) trovate.push('stream.disposition')
    }
  }
  for (const frame of (Array.isArray(radice.frames) ? radice.frames : []) as Array<Record<string, unknown>>) {
    for (const [chiave, valore] of Object.entries(frame)) {
      if (!CHIAVI_FRAME.includes(chiave)) trovate.push(`frame.${chiave}`)
      else if (typeof valore !== 'number') trovate.push(`frame.${chiave} non numerico`)
    }
  }
  return [...new Set(trovate)]
}
