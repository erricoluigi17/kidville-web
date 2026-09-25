import { describe, expect, it } from 'vitest'
import { compareVideoTimelines } from '@/lib/media/video/temporale'

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
    expect(compareVideoTimelines(source, output, 0, null, 25)).toMatchObject({ ok: true, sourceFrames: 150, outputFrames: 150 })
  })
  it.each([30, 60])('accetta MP4 a 30 fps con timebase 1/%i e PTS riscalati senza perdita', timescale => {
    const make = (scale: number) => ({
      streams: [{ index: 0, codec_type: 'video', time_base: `1/${scale}`, avg_frame_rate: '30/1' }],
      frames: Array.from({ length: 60 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i * scale / 30, duration: scale / 30 })),
    })
    expect(compareVideoTimelines(make(timescale), make(15360), 0, null, 30))
      .toMatchObject({ ok: true, sourceFrames: 60, outputFrames: 60 })
  })
  it.each([30, 60])('rifiuta 11 PTS spostati di tre quarti di frame dalla sorgente con timebase 1/%i', fps => {
    const make = (scale: number, origin: number) => ({
      streams: [{ index: 0, codec_type: 'video', time_base: `1/${scale}`, avg_frame_rate: `${fps}/1` }],
      frames: Array.from({ length: fps * 2 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: origin + i * scale / fps, duration: scale / fps })),
    })
    const source = make(fps, 7), output = make(15360, 3 * 15360)
    expect(compareVideoTimelines(source, output, 0, null, fps).ok).toBe(true)
    for (let i = 10; i <= 20; i++) output.frames[i].best_effort_timestamp += 15360 * 0.75 / fps
    expect(compareVideoTimelines(source, output, 0, null, fps))
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
    expect(compareVideoTimelines(source, output, 0, null, fps).ok).toBe(true)
    output.frames[10].best_effort_timestamp += 1
    expect(compareVideoTimelines(source, output, 0, null, fps))
      .toMatchObject({ ok: false, reason: 'TIMESTAMP_MISMATCH' })
  })
  it.each(['perdita', 'duplicato', 'deriva', 'coda', 'senza-pts', 'senza-timebase'])('rifiuta %s anche a media dichiarata invariata', tipo => {
    const { source, output } = fixture()
    output.streams[0].avg_frame_rate = '25/1'
    if (tipo === 'perdita') output.frames.splice(20, 1)
    if (tipo === 'duplicato') output.frames[20] = { ...output.frames[19] }
    if (tipo === 'deriva') output.frames[50].best_effort_timestamp += 100
    if (tipo === 'coda') output.frames.at(-1)!.duration = 15360
    if (tipo === 'senza-pts') output.frames[20].best_effort_timestamp = NaN
    if (tipo === 'senza-timebase') output.streams[0].time_base = '0/0'
    expect(compareVideoTimelines(source, output, 0, null, 25).ok).toBe(false)
  })
  it('confronta gli offset audio/video e non solo le durate delle due tracce', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...structuredClone(frames)] }
    expect(compareVideoTimelines(a, b, 0, 1, 25).ok).toBe(true)
    b.frames.filter(f => f.stream_index === 1).forEach(f => { f.best_effort_timestamp += 4800 })
    expect(compareVideoTimelines(a, b, 0, 1, 25).ok).toBe(false)
  })
  it('rifiuta un buco audio interno anche se primo e ultimo campione sono intatti', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...frames.filter((_, i) => i < 100 || i > 110)] }
    expect(compareVideoTimelines(a, b, 0, 1, 25).ok).toBe(false)
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
    expect(compareVideoTimelines(a, b, 0, 1, 25))
      .toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
  })
  it('tollera la quantizzazione di un tick audio senza confonderla con un buco AAC', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames] }
    const b = { streams: [...output.streams, audio], frames: [...output.frames, ...frames.map((f, i) => ({ ...f, best_effort_timestamp: f.best_effort_timestamp + (i >= 100 ? 1 : 0) }))] }
    expect(compareVideoTimelines(a, b, 0, 1, 25).ok).toBe(true)
  })
  it('conserva un buco audio preesistente nella stessa posizione, non spostato di un frame AAC', () => {
    const { source, output } = fixture()
    const audio = { index: 1, codec_type: 'audio', time_base: '1/48000', sample_rate: '48000' }
    const frames = Array.from({ length: 281 }, (_, i) => ({ stream_index: 1, best_effort_timestamp: i * 1024, duration: 1024 }))
    const a = { streams: [...source.streams, audio], frames: [...source.frames, ...frames.filter((_, i) => i !== 100)] }
    const makeOutput = (missing: number) => ({ streams: [...output.streams, audio], frames: [...output.frames, ...frames.filter((_, i) => i !== missing)] })
    expect(compareVideoTimelines(a, makeOutput(100), 0, 1, 25).ok).toBe(true)
    expect(compareVideoTimelines(a, makeOutput(101), 0, 1, 25))
      .toMatchObject({ ok: false, reason: 'AUDIO_TIMELINE_MISMATCH' })
  })
  it('la riduzione 120 → 60 ammette meno frame, ma richiede la griglia a 60 Hz', () => {
    const make = (fps: number) => ({
      streams: [{ index: 0, codec_type: 'video', time_base: '1/12000', avg_frame_rate: `${fps}/1` }],
      frames: Array.from({ length: fps * 2 }, (_, i) => ({ stream_index: 0, best_effort_timestamp: i * 12000 / fps, duration: 12000 / fps })),
    })
    const source = make(120), output = make(60)
    expect(compareVideoTimelines(source, output, 0, null, 120)).toMatchObject({ ok: true, mode: 'reduce60', sourceFrames: 240, outputFrames: 120 })
    output.frames[50].best_effort_timestamp += 100
    expect(compareVideoTimelines(source, output, 0, null, 120).ok).toBe(false)
  })
})
