import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  FPS_MEDIO,
  FPS_NOMINALE,
  SORGENTE,
  USCITA,
  framesDi,
  leggiTimeline,
  violazioniDiPrivacy,
  type TimelineFixture,
} from '../fixtures/video/falso-scarto-2026-09-28'
import { MAX_VIDEO_DURATION_SECONDS } from '@/lib/media/video/limiti'
import {
  SONDA_TEMPORALE,
  VIDEO_TEMPORAL_REASONS,
  compareVideoTimelines,
  timeoutSondaTemporaleMs,
  videoTemporalProgram,
  type VideoTemporalEvidence,
} from '@/lib/media/video/temporale'

/** Il tetto di durata dell'ingresso: SEMPRE la costante, mai il numero (T1 l'ha portata da 180 a 300). */
const MAX = MAX_VIDEO_DURATION_SECONDS

/** `compareVideoTimelines` col tetto vero: l'unica cosa che questi test non vogliono ripetere cinquanta volte. */
const confronta = (source: unknown, output: unknown, videoIndex: number, audioIndex: number | null, sourceFps: number) =>
  compareVideoTimelines(source, output, videoIndex, audioIndex, sourceFps, MAX)

function fixture() {
  const pts = Array.from({ length: 180 }, (_, i) => i).filter(i => i < 90 || i % 3 !== 0)
  const source = {
    streams: [{ index: 0, codec_type: 'video', time_base: '1/15360', avg_frame_rate: '25/1' }],
    frames: pts.map((n, i) => ({ stream_index: 0, best_effort_timestamp: n * 512, duration: (pts[i + 1] ?? 180) * 512 - n * 512 })),
  }
  const output = structuredClone(source)
  output.streams[0].avg_frame_rate = '4500/179'
  output.frames.at(-1)!.duration = 1024
  return { source, output }
}

describe('timeline VFR: conta e confronta i frame realmente decodificati', () => {
  it('accetta tutti i PTS conservati con differenza di un campione terminale', () => {
    const { source, output } = fixture()
    expect(confronta(source, output, 0, null, 25)).toMatchObject({ ok: true, sourceFrames: 150, outputFrames: 150 })
  })
  it.each([30, 60])('accetta MP4 a 30 fps con timebase 1/%i e PTS riscalati senza perdita', timescale => {
    const make = (scale: number) => ({
      streams: [{ index: 0, codec_type: 'video', time_base: `1/${scale}`, avg_frame_rate: '30/1' }],
      frames: Array.from({ length: 60 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i * scale / 30, duration: scale / 30 })),
    })
    expect(confronta(make(timescale), make(15360), 0, null, 30))
      .toMatchObject({ ok: true, sourceFrames: 60, outputFrames: 60 })
  })
  it.each([30, 60])('rifiuta 11 PTS spostati di tre quarti di frame dalla sorgente con timebase 1/%i', fps => {
    const make = (scale: number, origin: number) => ({
      streams: [{ index: 0, codec_type: 'video', time_base: `1/${scale}`, avg_frame_rate: `${fps}/1` }],
      frames: Array.from({ length: fps * 2 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: origin + i * scale / fps, duration: scale / fps })),
    })
    const source = make(fps, 7), output = make(15360, 3 * 15360)
    expect(confronta(source, output, 0, null, fps).ok).toBe(true)
    for (let i = 10; i <= 20; i++) output.frames[i].best_effort_timestamp += 15360 * 0.75 / fps
    expect(confronta(source, output, 0, null, fps))
      .toMatchObject({ ok: false, reason: 'TIMESTAMP_MISMATCH', sourceFrames: fps * 2, outputFrames: fps * 2 })
  })
  it.each([30, 60])('tollera un tick di uscita, ma non due, con timebase sorgente 1/%i', fps => {
    const source = {
      streams: [{ index: 0, codec_type: 'video', time_base: `1/${fps}`, avg_frame_rate: `${fps}/1` }],
      frames: Array.from({ length: fps * 2 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i, duration: 1 })),
    }
    const output = {
      streams: [{ ...source.streams[0], time_base: '1/15360' }],
      frames: source.frames.map(f => ({ ...f, best_effort_timestamp: f.best_effort_timestamp * 15360 / fps, duration: 15360 / fps })),
    }
    output.frames[10].best_effort_timestamp += 1
    expect(confronta(source, output, 0, null, fps).ok).toBe(true)
    output.frames[10].best_effort_timestamp += 1
    expect(confronta(source, output, 0, null, fps))
      .toMatchObject({ ok: false, reason: 'TIMESTAMP_MISMATCH' })
  })
  it.each(['perdita', 'duplicato', 'deriva', 'senza-pts', 'senza-timebase'])('rifiuta %s anche a media dichiarata invariata', tipo => {
    const { source, output } = fixture()
    output.streams[0].avg_frame_rate = '25/1'
    if (tipo === 'perdita') output.frames.splice(20, 1)
    if (tipo === 'duplicato') output.frames[20] = { ...output.frames[19] }
    if (tipo === 'deriva') output.frames[50].best_effort_timestamp += 100
    if (tipo === 'senza-pts') output.frames[20].best_effort_timestamp = NaN
    if (tipo === 'senza-timebase') output.streams[0].time_base = '0/0'
    expect(confronta(source, output, 0, null, 25).ok).toBe(false)
  })
  it('una coda spuria in uscita NON è più affare della prova temporale: la durata dell’ultimo campione la sceglie il muxer', () => {
    // Prima questo caso era rosso qui («coda»: ultimo campione di un secondo contro 33 ms). Il confronto
    // sulla durata dell'ultimo campione è stato tolto il 02/10/2026, perché il muxer non la conserva:
    // la prova guarda i PTS, e quelli sono identici. Una coda lunga la rifiuta `verifyVideoOutput`,
    // con la tolleranza sulla durata — c'è il caso in `video-verify.test.ts`, e senza di lui questo
    // sarebbe un varco.
    const { source, output } = fixture()
    output.frames.at(-1)!.duration = 15360
    const prova = confronta(source, output, 0, null, 25)
    expect(prova.ok).toBe(true)
    expect(prova.measures!.outputLastSample).toBeCloseTo(1, 9)
    expect(prova.measures!.sourceLastSample).toBeCloseTo(512 / 15360, 9)
  })
  it('confronta gli offset audio/video e non solo le durate delle due tracce', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...structuredClone(frames)] }
    expect(confronta(a, b, 0, 1, 25).ok).toBe(true)
    b.frames.filter(f => f.stream_index === 1).forEach(f => { f.best_effort_timestamp += 4800 })
    expect(confronta(a, b, 0, 1, 25).ok).toBe(false)
  })
  it('rifiuta un buco audio interno anche se primo e ultimo campione sono intatti', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...frames.filter((_, i) => i < 100 || i > 110)] }
    expect(confronta(a, b, 0, 1, 25).ok).toBe(false)
  })
  it.each(['frame-mancante', 'sovrapposizione'])('rifiuta %s audio interno anche entro un frame AAC', difetto => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const modified = structuredClone(frames)
    if (difetto === 'frame-mancante') modified.splice(100, 1)
    else modified[100].best_effort_timestamp -= 512
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...modified] }
    expect(confronta(a, b, 0, 1, 25))
      .toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
  })
  it('tollera la quantizzazione di un tick audio senza confonderla con un buco AAC', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...frames.map((f, i) => ({ ...f, best_effort_timestamp: f.best_effort_timestamp + (i >= 100 ? 1 : 0) }))] }
    expect(confronta(a, b, 0, 1, 25).ok).toBe(true)
  })
  it('conserva un buco audio preesistente nella stessa posizione, non spostato di un frame AAC', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames.filter((_, i) => i !== 100)] }
    const makeOutput = (missing: number) => ({ streams: [...output.streams, audio], frames: [...output.frames, ...frames.filter((_, i) => i !== missing)] })
    expect(confronta(a, makeOutput(100), 0, 1, 25).ok).toBe(true)
    expect(confronta(a, makeOutput(101), 0, 1, 25))
      .toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
  })
  it('la riduzione 120 → 60 ammette meno frame, ma richiede la griglia a 60 Hz', () => {
    const make = (fps: number) => ({
      streams: [{ index: 0, codec_type: 'video', time_base: '1/12000', avg_frame_rate: `${fps}/1` }],
      frames: Array.from({ length: fps * 2 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i * 12000 / fps, duration: 12000 / fps })),
    })
    const source = make(120), output = make(60)
    expect(confronta(source, output, 0, null, 120)).toMatchObject({ ok: true, mode: 'reduce60', sourceFrames: 240, outputFrames: 120 })
    output.frames[50].best_effort_timestamp += 100
    expect(confronta(source, output, 0, null, 120).ok).toBe(false)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * IL FALSO SCARTO DEL 28/09/2026 — le due timeline VERE, misurate nel Sandbox
 *
 * Job `72fff674…`, scartato `OUTPUT_FPS_INVALID` / `TERMINAL_COVERAGE_MISMATCH` dopo una conversione
 * perfetta: 264 frame video con i PTS IDENTICI uno per uno (primo 0, ultimo 8,721025 s), e un solo
 * numero diverso — la durata dell'ULTIMO campione, 3,035 ms nella sorgente e 33,333 ms nell'uscita,
 * perché quella durata il muxer non la conserva. Copertura 8,724060 s contro 8,754358 s (Δ 30,3 ms),
 * tolleranza di allora 3,036 ms.
 *
 * Le due timeline stanno in `__tests__/fixtures/video/` (solo i campi della proiezione, nessun
 * tag, luogo o data: lo prova il primo caso qui sotto). Con il controllo di prima questo giro era ROSSO
 * — riprodotto il 02/10/2026 prima di toccare il codice, con `fps` sia medio sia nominale — e adesso è
 * verde. Le controprove sono costruite ALTERANDO le stesse timeline e restano rosse: un'accettazione
 * che non sa dire di no non è una correzione, è un varco.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('falso scarto del 28/09/2026: le due timeline misurate', () => {
  it('le fixture contengono SOLO la proiezione di ffprobe: nessun tag, luogo, data o nome (il repository è pubblico)', () => {
    expect(violazioniDiPrivacy(leggiTimeline('sorgente'))).toEqual([])
    expect(violazioniDiPrivacy(leggiTimeline('uscita'))).toEqual([])
    // Il controllo sa dire di no: stesse timeline, con le cose che NON devono esserci.
    const sporca = leggiTimeline('sorgente') as unknown as { streams: Array<Record<string, unknown>>; frames: Array<Record<string, unknown>> }
    sporca.streams[0].tags = { creation_time: '2026-09-28T10:00:00Z', location: '+00.0000+000.0000/' }
    sporca.frames[0].pkt_dts_time = '0.000000'
    sporca.frames[1].duration = '3035'
    expect(violazioniDiPrivacy(sporca)).toEqual(expect.arrayContaining(['stream.tags', 'frame.pkt_dts_time', 'frame.duration non numerico']))
  })

  it('le misure dichiarate dalla fixture sono quelle del 28/09 (264 frame, ultimo campione 3,035 ms contro 33,333 ms)', () => {
    const sorgente = leggiTimeline('sorgente'), uscita = leggiTimeline('uscita')
    expect(framesDi(sorgente, SORGENTE.video)).toHaveLength(264)
    expect(framesDi(uscita, USCITA.video)).toHaveLength(264)
    expect(framesDi(sorgente, SORGENTE.audio)).toHaveLength(377)
    expect(framesDi(uscita, USCITA.audio)).toHaveLength(377)
    expect(framesDi(sorgente, SORGENTE.video).at(-1)).toMatchObject({ best_effort_timestamp: 8_721_025, duration: 3_035 })
    expect(framesDi(uscita, USCITA.video).at(-1)).toMatchObject({ best_effort_timestamp: 8_721_025, duration: 33_333 })
  })

  it.each([['media', FPS_MEDIO], ['nominale', FPS_NOMINALE]])('adesso passa, con il frame rate %s della sorgente', (_nome, fps) => {
    const prova = confronta(leggiTimeline('sorgente'), leggiTimeline('uscita'), SORGENTE.video, SORGENTE.audio, fps)
    expect(prova).toMatchObject({ ok: true, mode: 'preserve', sourceFrames: 264, outputFrames: 264 })
    expect(prova.reason).toBeUndefined()
  })

  it('e la fixture ESERCITA il controllo che è stato tolto: con le misure della prova, il confronto di prima l’avrebbe scartata', () => {
    const prova = confronta(leggiTimeline('sorgente'), leggiTimeline('uscita'), SORGENTE.video, SORGENTE.audio, FPS_MEDIO)
    const misure = prova.measures!
    expect(misure.sourceLastSample).toBeCloseTo(0.003035, 6)
    expect(misure.outputLastSample).toBeCloseTo(0.033333, 6)
    expect(misure.sourceCoverage).toBeCloseTo(8.72406, 6)
    expect(misure.outputCoverage).toBeCloseTo(8.754358, 6)
    // La formula che c'era: `|coperturaIn − coperturaOut| > min(ultimoCampioneIn, 1/min(fps, 60)) + epsilon`.
    const tolleranzaDiPrima = Math.min(misure.sourceLastSample, 1 / Math.min(FPS_MEDIO, 60)) + misure.epsilon
    expect(tolleranzaDiPrima).toBeCloseTo(0.003036, 6)
    expect(Math.abs(misure.outputCoverage - misure.sourceCoverage)).toBeGreaterThan(tolleranzaDiPrima * 9)
  })

  describe('le controprove, sulle stesse timeline, restano ROSSE', () => {
    const rifiutata = (altera: (uscita: TimelineFixture) => void): VideoTemporalEvidence => {
      const uscita = leggiTimeline('uscita')
      altera(uscita)
      return confronta(leggiTimeline('sorgente'), uscita, SORGENTE.video, SORGENTE.audio, FPS_MEDIO)
    }

    it('un frame perso a metà video', () => {
      const prova = rifiutata(uscita => {
        const video = framesDi(uscita, USCITA.video)
        uscita.frames.splice(uscita.frames.indexOf(video[100]), 1)
      })
      expect(prova).toMatchObject({ ok: false, reason: 'FRAME_COUNT_MISMATCH', sourceFrames: 264, outputFrames: 263 })
    })

    it('il troncamento: gli ultimi frame mancano (anche uno solo, l’ultimo)', () => {
      for (const quanti of [1, 10]) {
        const prova = rifiutata(uscita => {
          for (const frame of framesDi(uscita, USCITA.video).slice(-quanti)) uscita.frames.splice(uscita.frames.indexOf(frame), 1)
        })
        expect(prova, `${quanti} frame tolti in coda`).toMatchObject({ ok: false, reason: 'FRAME_COUNT_MISMATCH', outputFrames: 264 - quanti })
      }
    })

    it('un solo PTS fuori posto, l’ultimo, di due millisecondi: l’uguaglianza è frame per frame', () => {
      // I due ultimi frame distano 3 ms: due ne bastano per un PTS che resta crescente e sbagliato.
      const prova = rifiutata(uscita => {
        framesDi(uscita, USCITA.video).at(-1)!.best_effort_timestamp -= 2_000
      })
      expect(prova).toMatchObject({ ok: false, reason: 'TIMESTAMP_MISMATCH', sourceFrames: 264, outputFrames: 264 })
    })

    it('l’accelerazione: tutti i PTS di uscita ridotti dell’1%', () => {
      const prova = rifiutata(uscita => {
        for (const frame of framesDi(uscita, USCITA.video)) {
          frame.best_effort_timestamp = Math.round(frame.best_effort_timestamp * 0.99)
          frame.duration *= 0.99
        }
      })
      expect(prova).toMatchObject({ ok: false, reason: 'TIMESTAMP_MISMATCH' })
    })

    it('l’audio spostato di cento millisecondi, con il video intatto', () => {
      const prova = rifiutata(uscita => {
        for (const frame of framesDi(uscita, USCITA.audio)) frame.best_effort_timestamp += 4_410
      })
      expect(prova).toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
    })

    it('l’audio troncato: gli ultimi venti frame mancano, o ne manca uno a metà', () => {
      const troncato = rifiutata(uscita => {
        for (const frame of framesDi(uscita, USCITA.audio).slice(-20)) uscita.frames.splice(uscita.frames.indexOf(frame), 1)
      })
      expect(troncato).toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
      const buco = rifiutata(uscita => {
        uscita.frames.splice(uscita.frames.indexOf(framesDi(uscita, USCITA.audio)[200]), 1)
      })
      expect(buco).toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
    })

    it('le misure restano nella prova anche quando dice no: è allora che servono alla diagnosi', () => {
      const prova = rifiutata(uscita => {
        uscita.frames.splice(uscita.frames.indexOf(framesDi(uscita, USCITA.video)[100]), 1)
      })
      expect(prova.ok).toBe(false)
      expect(prova.measures).toMatchObject({ sourceLastSample: expect.any(Number), outputLastSample: expect.any(Number) })
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * Il caso gemello: la riduzione oltre i 60 fps. Stessa causa (l'ultimo campione), stessa forma, e il
 * confronto tolto stava anche qui — riprodotto il 02/10/2026 con un file a 120 fps dall'ultimo
 * campione accorciato a 3 ms, convertito con gli argomenti di produzione: `TERMINAL_COVERAGE_MISMATCH`
 * anche in `reduce60`. In `reduce60` resta il controllo d'ARCO.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('reduce60: il controllo d’arco resta, la copertura terminale no', () => {
  /** 120 fps in ingresso con l'ultimo campione di 3,035 ms; 60 fps in uscita con l'ultimo di un campione intero. */
  function centoVenti() {
    const passo = 1_000_000 / 120
    const frames = Array.from({ length: 240 }, (_, i) => ({
      stream_index: 0,
      best_effort_timestamp: Math.round(i * passo),
      duration: i === 239 ? 3_035 : Math.round((i + 1) * passo) - Math.round(i * passo),
    }))
    const source = { streams: [{ index: 0, codec_type: 'video', time_base: '1/1000000', avg_frame_rate: '120/1' }], frames }
    const output = {
      streams: [{ index: 0, codec_type: 'video', time_base: '1/1000000', avg_frame_rate: '60/1' }],
      frames: Array.from({ length: 120 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: Math.round(i * 1_000_000 / 60), duration: 16_667 })),
    }
    return { source, output }
  }

  it('un ultimo campione corto in ingresso non fa scartare una riduzione corretta', () => {
    const { source, output } = centoVenti()
    const prova = confronta(source, output, 0, null, 120)
    expect(prova).toMatchObject({ ok: true, mode: 'reduce60', sourceFrames: 240, outputFrames: 120 })
    // Il confronto di prima l'avrebbe respinta: la premessa del caso sta nei numeri.
    const misure = prova.measures!
    const tolleranzaDiPrima = Math.min(misure.sourceLastSample, 1 / 60) + misure.epsilon
    expect(Math.abs(misure.outputCoverage - misure.sourceCoverage)).toBeGreaterThan(tolleranzaDiPrima)
  })

  it('il troncamento oltre un campione di uscita resta rosso (FPS_LIMIT, l’arco)', () => {
    const { source, output } = centoVenti()
    output.frames.splice(-3)
    expect(confronta(source, output, 0, null, 120)).toMatchObject({ ok: false, reason: 'FPS_LIMIT' })
  })

  it('e la griglia a 60 Hz resta obbligatoria', () => {
    const { source, output } = centoVenti()
    output.frames[50].best_effort_timestamp += 4_000
    expect(confronta(source, output, 0, null, 120)).toMatchObject({ ok: false, reason: 'FPS_LIMIT' })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * I TETTI INTERNI derivano dal parametro, non da un numero scritto qui dentro
 *
 * Erano 180 s e 180.000 frame, cablati. Il 02/10/2026 il tetto di durata è diventato 300 s
 * (`MAX_VIDEO_DURATION_SECONDS`) e un secondo «180» rimasto in un modulo avrebbe scartato i filmati fra
 * tre e cinque minuti — in silenzio, come INVALID_EVIDENCE o come copertura.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('i tetti interni vengono dal parametro', () => {
  /** Un video a `fps` costanti lungo `secondi`, con timebase 1/fps: un tick per frame. */
  function costante(secondi: number, fps = 30) {
    const frames = Array.from({ length: Math.round(secondi * fps) }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i, duration: 1 }))
    const flusso = { index: 0, codec_type: 'video', time_base: `1/${fps}`, avg_frame_rate: `${fps}/1` }
    return { source: { streams: [flusso], frames }, output: { streams: [flusso], frames: structuredClone(frames) }, fps }
  }

  it('un filmato lungo quanto il tetto passa, uno più lungo di un secondo no', () => {
    const entro = costante(MAX)
    expect(confronta(entro.source, entro.output, 0, null, entro.fps)).toMatchObject({ ok: true, sourceFrames: MAX * 30 })
    const oltre = costante(MAX + 1)
    expect(confronta(oltre.source, oltre.output, 0, null, oltre.fps)).toMatchObject({ ok: false, reason: 'DURATION_LIMIT' })
  })

  it('un filmato di dieci secondi sotto il tetto passa: non c’è nessun tetto più basso rimasto cablato', () => {
    const { source, output, fps } = costante(MAX - 10)
    expect(confronta(source, output, 0, null, fps).ok).toBe(true)
  })

  it('il tetto è quello PASSATO: lo stesso filmato passa con un tetto largo e cade con uno stretto', () => {
    const { source, output, fps } = costante(4)
    expect(compareVideoTimelines(source, output, 0, null, fps, 5).ok).toBe(true)
    expect(compareVideoTimelines(source, output, 0, null, fps, 3)).toMatchObject({ ok: false, reason: 'DURATION_LIMIT' })
    expect(compareVideoTimelines(source, output, 0, null, fps, MAX).ok).toBe(true)
  })

  it('anche il tetto sui frame deriva dal parametro: durata × 1.000 frame al secondo', () => {
    const lineare = (n: number) => {
      const flusso = { index: 0, codec_type: 'video', time_base: '1/1000', avg_frame_rate: '30/1' }
      const frames = Array.from({ length: n }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i, duration: 1 }))
      return { source: { streams: [flusso], frames }, output: { streams: [flusso], frames: structuredClone(frames) } }
    }
    // Tetto di 2 s ⇒ 2.000 frame. 2.000 lo superano (e cadono su un ALTRO controllo, il limite dei
    // 60 fps: 1.000 frame al secondo non sono un video); 2.001 non entrano nemmeno nella timeline.
    const dentro = lineare(2_000), fuori = lineare(2_001)
    expect(compareVideoTimelines(dentro.source, dentro.output, 0, null, 30, 2).reason).toBe('FPS_LIMIT')
    expect(compareVideoTimelines(fuori.source, fuori.output, 0, null, 30, 2).reason).toBe('INVALID_EVIDENCE')
    // E con un tetto più largo gli stessi 2.001 frame entrano.
    expect(compareVideoTimelines(fuori.source, fuori.output, 0, null, 30, 3).reason).toBe('FPS_LIMIT')
  })

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, '300'])('un tetto non valido (%s) è fail-closed', tetto => {
    const { source, output, fps } = costante(2)
    expect(compareVideoTimelines(source, output, 0, null, fps, tetto as unknown as number))
      .toMatchObject({ ok: false, reason: 'INVALID_EVIDENCE' })
  })

  it('i motivi possibili sono un elenco chiuso e senza il vecchio TERMINAL_COVERAGE_MISMATCH', () => {
    expect([...VIDEO_TEMPORAL_REASONS]).toEqual([
      'INVALID_EVIDENCE', 'FRAME_COUNT_MISMATCH', 'TIMESTAMP_MISMATCH', 'DURATION_LIMIT',
      'FPS_LIMIT', 'AUDIO_TIMELINE_MISMATCH', 'TEMPORAL_PROBE_FAILED',
    ])
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * Il timeout della sonda: proporzionale a durata e risoluzione, mai sotto i 120 s di prima
 * ════════════════════════════════════════════════════════════════════════════ */
describe('timeoutSondaTemporaleMs', () => {
  const FULL_HD_180S = { durationSeconds: 180, width: 1920, height: 1080, fps: 30 } // il caso di riferimento dei 120 s fissi di prima

  it('un Full HD di 180 s non scende sotto i 120 s di prima, e nemmeno uno piccolo o breve', () => {
    expect(timeoutSondaTemporaleMs(FULL_HD_180S)).toBeGreaterThanOrEqual(120_000)
    expect(timeoutSondaTemporaleMs({ durationSeconds: MAX, width: 1920, height: 1080, fps: 30 })).toBeGreaterThanOrEqual(120_000)
    expect(timeoutSondaTemporaleMs({ durationSeconds: 5, width: 320, height: 240, fps: 30 })).toBe(SONDA_TEMPORALE.pavimentoMs)
    expect(SONDA_TEMPORALE.pavimentoMs).toBe(120_000)
  })

  it('cresce con la durata, con la risoluzione e con il frame rate', () => {
    const base = { durationSeconds: 100, width: 1920, height: 1080, fps: 30 }
    const t = (cambio: Partial<typeof base>) => timeoutSondaTemporaleMs({ ...base, ...cambio })
    expect(t({ durationSeconds: 200 })).toBeGreaterThan(t({}))
    expect(t({ width: 3840, height: 2160 })).toBeGreaterThan(t({}))
    expect(t({ fps: 60 })).toBeGreaterThan(t({}))
  })

  it('è PROPORZIONALE: dove non lo limitano né il pavimento né il tetto, raddoppiare la durata raddoppia la parte variabile', () => {
    const { baseMs, pavimentoMs, tettoMs, msPerMegapixelDecodificato } = SONDA_TEMPORALE
    const t = (durationSeconds: number) => timeoutSondaTemporaleMs({ durationSeconds, width: 1920, height: 1080, fps: 30 })
    // Le durate si ricavano dalle costanti, così una taratura di T16 non sposta il test dalla regione lineare:
    // `corto` è la durata per cui la stima supera il pavimento della metà della sua parte variabile, `lungo` è il doppio.
    const msPerSecondoDiVideo = (1920 * 1080 / 1_000_000) * 30 * msPerMegapixelDecodificato
    const corto = ((pavimentoMs - baseMs) * 1.5) / msPerSecondoDiVideo
    const stimaCorta = t(corto), stimaLunga = t(corto * 2)
    expect(stimaCorta, 'la durata scelta deve stare sopra il pavimento: ritarare questo test se le costanti sono cambiate').toBeGreaterThan(pavimentoMs)
    expect(stimaLunga, 'e il doppio sotto il tetto').toBeLessThan(tettoMs)
    expect((stimaLunga - baseMs) / (stimaCorta - baseMs)).toBeCloseTo(2, 2)
  })

  it('non supera mai il tetto, nemmeno con un 8K a 240 fps o con misure da file ostile', () => {
    expect(timeoutSondaTemporaleMs({ durationSeconds: MAX, width: 7680, height: 4320, fps: 240 })).toBe(SONDA_TEMPORALE.tettoMs)
    expect(timeoutSondaTemporaleMs({ durationSeconds: 1e300, width: 1e300, height: 1e300, fps: 1e300 })).toBe(SONDA_TEMPORALE.tettoMs)
    expect(SONDA_TEMPORALE.tettoMs).toBeGreaterThan(SONDA_TEMPORALE.pavimentoMs)
  })

  it('una misura mancante o malformata dà il TETTO, non il pavimento: non sapere quanto è grande il file non è un motivo per scartarlo', () => {
    const buone = { durationSeconds: 60, width: 1920, height: 1080, fps: 30 }
    expect(timeoutSondaTemporaleMs(buone)).toBeLessThan(SONDA_TEMPORALE.tettoMs)
    for (const rotta of [
      {}, { ...buone, durationSeconds: undefined }, { ...buone, width: 0 }, { ...buone, height: -1080 },
      { ...buone, fps: Number.NaN }, { ...buone, durationSeconds: Number.POSITIVE_INFINITY },
      { ...buone, width: '1920' as unknown as number },
    ]) expect(timeoutSondaTemporaleMs(rotta)).toBe(SONDA_TEMPORALE.tettoMs)
  })

  it('è un intero di millisecondi', () => {
    expect(Number.isInteger(timeoutSondaTemporaleMs({ durationSeconds: 123.456, width: 1280, height: 720, fps: 29.97 }))).toBe(true)
  })

  it('il buffer della sonda è 64 MiB', () => {
    expect(SONDA_TEMPORALE.maxBufferBytes).toBe(64 * 1024 * 1024)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * Il PROGRAMMA che gira nella Sandbox, eseguito davvero (un processo `node`) con un ffprobe finto
 *
 * Il «finto» è uno script di tre righe che stampa il file che gli si passa come ultimo argomento: la
 * sonda vera è un'altra cosa, ma ciò che si prova qui è il programma — che la funzione serializzata
 * sia davvero autonoma (nessuna dipendenza di modulo), che il tetto e il timeout arrivino fin dentro
 * `spawnSync`, che il buffer basti, che un guasto dica perché. Gira ovunque: non serve FFmpeg.
 * ════════════════════════════════════════════════════════════════════════════ */
describe('il programma della Sandbox, eseguito con un ffprobe finto', () => {
  const OPZIONI_REALI = { videoIndex: SORGENTE.video, audioIndex: SORGENTE.audio, sourceFps: FPS_MEDIO }

  function inCartella<T>(corpo: (cartella: string, ffprobeFinto: string) => T): T {
    const cartella = mkdtempSync(join(tmpdir(), 'kidville-sonda-'))
    try {
      const finto = join(cartella, 'ffprobe-finto.sh')
      writeFileSync(finto, '#!/bin/sh\nfor ultimo; do :; done\ncat "$ultimo"\n')
      chmodSync(finto, 0o755)
      return corpo(cartella, finto)
    } finally {
      rmSync(cartella, { recursive: true, force: true })
    }
  }

  function esegui(programma: string, ffprobe: string, sorgente: string, uscita: string) {
    const p = spawnSync(process.execPath, ['-', ffprobe, sorgente, uscita], { input: programma, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    if (p.error) throw p.error
    return { stato: p.status, stderr: p.stderr, prova: JSON.parse(p.stdout) as VideoTemporalEvidence }
  }

  const scrivi = (cartella: string, nome: string, contenuto: unknown) => {
    const percorso = join(cartella, nome)
    writeFileSync(percorso, typeof contenuto === 'string' ? contenuto : JSON.stringify(contenuto))
    return percorso
  }

  it('sulle due timeline del 28/09 dice ok e porta le misure: la funzione serializzata è autonoma', () => {
    inCartella((cartella, finto) => {
      const { stato, prova } = esegui(
        videoTemporalProgram(OPZIONI_REALI), finto,
        scrivi(cartella, 'sorgente.json', leggiTimeline('sorgente')), scrivi(cartella, 'uscita.json', leggiTimeline('uscita')),
      )
      expect(stato).toBe(0)
      expect(prova).toMatchObject({ ok: true, mode: 'preserve', sourceFrames: 264, outputFrames: 264 })
      expect(prova.measures!.sourceLastSample).toBeCloseTo(0.003035, 6)
    })
  })

  it('il tetto di durata arriva fino a `compare`: con un tetto stretto la stessa coppia cade per DURATION_LIMIT', () => {
    inCartella((cartella, finto) => {
      const { prova } = esegui(
        videoTemporalProgram({ ...OPZIONI_REALI, maxDurationSeconds: 3 }), finto,
        scrivi(cartella, 'sorgente.json', leggiTimeline('sorgente')), scrivi(cartella, 'uscita.json', leggiTimeline('uscita')),
      )
      expect(prova).toMatchObject({ ok: false, reason: 'DURATION_LIMIT' })
    })
  })

  it('senza opzioni sul tetto vale MAX_VIDEO_DURATION_SECONDS, e il timeout calcolato sulle misure dell’ingresso', () => {
    const letteralmente = (programma: string) => {
      const riga = programma.split('\n').find(r => r.startsWith('const options = '))!
      return JSON.parse(riga.slice('const options = '.length).replace(/;$/, '')) as Record<string, unknown>
    }
    const misure = { durationSeconds: 90, width: 1920, height: 1080 }
    const opzioni = letteralmente(videoTemporalProgram({ ...OPZIONI_REALI, ...misure }))
    expect(opzioni).toMatchObject({
      maxDurationSeconds: MAX,
      timeoutMs: timeoutSondaTemporaleMs({ ...misure, fps: FPS_MEDIO }),
      maxBufferBytes: 64 * 1024 * 1024,
    })
    // Senza le misure dell'ingresso: il tetto, non il pavimento.
    expect(letteralmente(videoTemporalProgram(OPZIONI_REALI)).timeoutMs).toBe(SONDA_TEMPORALE.tettoMs)
    // E il timeout sostitutivo, solo per le prove.
    expect(letteralmente(videoTemporalProgram({ ...OPZIONI_REALI, timeoutSondaMs: 1234 })).timeoutMs).toBe(1234)
  })

  it('il buffer regge un output più grande dei 32 MiB di prima (e fino a 64)', () => {
    inCartella((cartella, finto) => {
      const grande = { ...leggiTimeline('sorgente'), imbottitura: 'x'.repeat(40 * 1024 * 1024) }
      const { stato, prova } = esegui(
        videoTemporalProgram(OPZIONI_REALI), finto,
        scrivi(cartella, 'sorgente.json', grande), scrivi(cartella, 'uscita.json', leggiTimeline('uscita')),
      )
      expect(stato).toBe(0)
      expect(prova.ok).toBe(true)
    })
  }, 60_000)

  it('il timeout arriva a `spawnSync`: una sonda che non finisce viene fermata, e la causa è ETIMEDOUT', () => {
    inCartella((cartella) => {
      const lenta = join(cartella, 'ffprobe-lento.sh')
      // `exec`: la shell diventa `sleep`, e il timeout uccide proprio lui (altrimenti resterebbe orfano).
      writeFileSync(lenta, '#!/bin/sh\nexec sleep 20\n')
      chmodSync(lenta, 0o755)
      const prima = Date.now()
      const { stato, stderr, prova } = esegui(
        videoTemporalProgram({ ...OPZIONI_REALI, timeoutSondaMs: 400 }), lenta,
        scrivi(cartella, 'sorgente.json', {}), scrivi(cartella, 'uscita.json', {}),
      )
      expect(Date.now() - prima).toBeLessThan(15_000)
      expect(stato).toBe(0)
      expect(prova).toMatchObject({ ok: false, reason: 'TEMPORAL_PROBE_FAILED' })
      expect(stderr).toContain('sonda temporale: ETIMEDOUT')
    })
  }, 30_000)

  it('un guasto della sonda dice perché, con il nome della causa e mai col contenuto', () => {
    inCartella((cartella) => {
      const sorgente = scrivi(cartella, 'sorgente.json', leggiTimeline('sorgente'))
      const uscita = scrivi(cartella, 'uscita.json', leggiTimeline('uscita'))
      const casi: Array<[string, string, string]> = [
        ['esce con un errore', '#!/bin/sh\nexit 3\n', 'sonda temporale: USCITA_3'],
        ['scrive su stderr', '#!/bin/sh\nfor ultimo; do :; done\necho "segreto del file" >&2\ncat "$ultimo"\n', 'sonda temporale: STDERR'],
        ['non produce JSON', '#!/bin/sh\necho "non è json"\n', 'sonda temporale: JSON_NON_VALIDO'],
      ]
      for (const [nome, script, attesa] of casi) {
        const percorso = join(cartella, 'ffprobe-guasto.sh')
        writeFileSync(percorso, script)
        chmodSync(percorso, 0o755)
        const { stato, stderr, prova } = esegui(videoTemporalProgram(OPZIONI_REALI), percorso, sorgente, uscita)
        expect(stato, nome).toBe(0)
        expect(prova, nome).toMatchObject({ ok: false, reason: 'TEMPORAL_PROBE_FAILED' })
        expect(stderr, nome).toContain(attesa)
        expect(stderr, nome).not.toContain('segreto del file')
      }
    })
  })

  it('un’eccezione inattesa del confronto dice il NOME del tipo e non il messaggio, che potrebbe portarsi dietro la sonda', () => {
    inCartella((cartella, finto) => {
      // `compare` è totale su ciò che ffprobe produce: per vedere il ramo lo si fa lanciare, dall'interno.
      const programma = videoTemporalProgram(OPZIONI_REALI)
        .replace('result = compare(', 'result = ((..._) => { throw new RangeError("dati della sonda: 1234") })(')
      expect(programma).toContain('throw new RangeError')
      const { stato, stderr, prova } = esegui(
        programma, finto,
        scrivi(cartella, 'sorgente.json', {}), scrivi(cartella, 'uscita.json', {}),
      )
      expect(stato).toBe(0)
      expect(prova).toMatchObject({ ok: false, reason: 'TEMPORAL_PROBE_FAILED' })
      expect(stderr).toContain('sonda temporale: ECCEZIONE_RangeError')
      expect(stderr).not.toContain('dati della sonda')
      // E una causa già detta da `fallita` non si ripete: una riga sola per guasto.
      expect(stderr.match(/sonda temporale:/g)).toHaveLength(1)
    })
  })

  it('un ffprobe che non esiste è un guasto detto per nome (ENOENT), non un’eccezione muta', () => {
    inCartella((cartella) => {
      const { stato, stderr, prova } = esegui(
        videoTemporalProgram(OPZIONI_REALI), join(cartella, 'non-esiste'),
        scrivi(cartella, 'sorgente.json', {}), scrivi(cartella, 'uscita.json', {}),
      )
      expect(stato).toBe(0)
      expect(prova).toMatchObject({ ok: false, reason: 'TEMPORAL_PROBE_FAILED' })
      expect(stderr).toContain('sonda temporale: ENOENT')
    })
  })
})
