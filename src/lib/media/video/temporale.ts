/** Solo l'attestazione esce dalla Sandbox; frame e PTS non si persistono né si loggano. */
export interface VideoTemporalEvidence {
  version: 1
  ok: boolean
  mode: 'preserve' | 'reduce60'
  sourceFrames: number
  outputFrames: number
  sourceFps: number
  outputFps: number
  reason?: 'INVALID_EVIDENCE' | 'FRAME_COUNT_MISMATCH' | 'TIMESTAMP_MISMATCH' | 'TERMINAL_COVERAGE_MISMATCH' | 'FPS_LIMIT' | 'AUDIO_TIMELINE_MISMATCH' | 'TEMPORAL_PROBE_FAILED'
}

export function compareVideoTimelines(
  source: unknown,
  output: unknown,
  videoIndex: number,
  audioIndex: number | null,
  sourceFps: number,
): VideoTemporalEvidence {
  // Autonoma per costruzione: la stessa funzione viene serializzata nella Sandbox.
  // Nessuna dipendenza di modulo: il test dello script esegue anche questa proprietà.
  type Row = Record<string, unknown>
  const object = (x: unknown): Row | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Row : null
  const number = (x: unknown): number | null => {
    if (typeof x !== 'number' && (typeof x !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(x))) return null
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  const rational = (x: unknown): number | null => {
    if (typeof x !== 'string') return null
    const m = /^(\d+)\/([1-9]\d*)$/.exec(x)
    const n = m ? Number(m[1]) / Number(m[2]) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const result: VideoTemporalEvidence = {
    version: 1, ok: false, mode: sourceFps > 60 ? 'reduce60' : 'preserve',
    sourceFrames: 0, outputFrames: 0, sourceFps, outputFps: 0,
    reason: 'INVALID_EVIDENCE',
  }
  const a = object(source), b = object(output)
  if (!a || !b || !Array.isArray(a.streams) || !Array.isArray(b.streams) || !Array.isArray(a.frames) || !Array.isArray(b.frames)) return result
  const sourceStreams = a.streams.map(object), outputStreams = b.streams.map(object)
  const videoIn = sourceStreams.find(s => s?.index === videoIndex && s.codec_type === 'video')
  const videosOut = outputStreams.filter(s => s?.codec_type === 'video' && object(s.disposition)?.attached_pic !== 1)
  if (!videoIn || videosOut.length !== 1 || !videosOut[0] || !Number.isFinite(sourceFps) || sourceFps <= 0) return result
  const videoOut = videosOut[0]
  const fpsOut = rational(videoOut.avg_frame_rate) ?? rational(videoOut.r_frame_rate)
  if (!fpsOut) return result
  result.outputFps = fpsOut

  const timeline = (frames: unknown[], stream: Row) => {
    const tick = rational(stream.time_base)
    // La timebase è l'unità dei PTS, non il frame rate: un MP4 a 30 fps può
    // rappresentare esattamente ogni frame con un tick di 1/30 di secondo.
    if (!tick) return null
    const selected = frames.map(object).filter(f => f?.stream_index === stream.index)
    // 180 s × 1.000 frame/s: tetto tecnico, nessun array illimitato da un file ostile.
    if (selected.length === 0 || selected.length > 180_000) return null
    const pts: number[] = []
    const durations: number[] = []
    for (const frame of selected) {
      const timestamp = number(frame?.best_effort_timestamp)
      const duration = number(frame?.duration ?? frame?.pkt_duration)
      if (timestamp === null || !Number.isSafeInteger(timestamp) || duration === null || duration <= 0) return null
      const time = timestamp * tick
      if (pts.length && time <= pts[pts.length - 1]) return null
      pts.push(time)
      durations.push(duration * tick)
    }
    return { tick, pts, durations, first: pts[0], last: pts[pts.length - 1], end: pts[pts.length - 1] + durations[durations.length - 1] }
  }
  const before = timeline(a.frames, videoIn), after = timeline(b.frames, videoOut)
  if (!before || !after) return result
  result.sourceFrames = before.pts.length
  result.outputFrames = after.pts.length
  // I PTS sorgente sono valori già noti, anche quando la loro timebase è larga:
  // riscalarli non introduce un errore pari a un tick di ingresso. Solo i PTS
  // di uscita sono arrotondati; sottraendo il primo PTS, i due arrotondamenti
  // possono differire complessivamente di un tick di uscita. 1 ns assorbe
  // esclusivamente l'errore numerico dei calcoli in virgola mobile.
  const epsilon = after.tick + 1e-9
  const sourceLastSample = before.durations[before.durations.length - 1]
  // Il mux può assegnare diversamente UN campione terminale, mai una percentuale
  // dell'intero video. La durata complessiva continua a passare da verify.ts.
  const terminalTolerance = Math.min(sourceLastSample, 1 / Math.min(sourceFps, 60)) + epsilon
  const coveredIn = before.end - before.first, coveredOut = after.end - after.first
  if (coveredIn > 180 + terminalTolerance || Math.abs(coveredIn - coveredOut) > terminalTolerance) {
    result.reason = 'TERMINAL_COVERAGE_MISMATCH'
    return result
  }
  if (result.mode === 'preserve') {
    result.reason = 'FRAME_COUNT_MISMATCH'
    if (before.pts.length !== after.pts.length) return result
    result.reason = 'TIMESTAMP_MISMATCH'
    for (let i = 0; i < before.pts.length; i++) {
      if (Math.abs((before.pts[i] - before.first) - (after.pts[i] - after.first)) > epsilon) return result
    }
    // Il limite 60 si misura sulla timeline, non sul denominatore del mux.
    result.reason = 'FPS_LIMIT'
    if (after.pts.length > 1 && after.last - after.first + epsilon < (after.pts.length - 1) / 60) return result
  } else {
    // La riduzione intenzionale ha un contratto distinto: griglia a 60 Hz,
    // copertura della sorgente entro un campione di uscita, nessun confronto 1:1.
    result.reason = 'FPS_LIMIT'
    if (Math.abs(fpsOut - 60) > 0.01 || Math.abs((after.last - after.first) - (before.last - before.first)) > 1 / 60 + epsilon) return result
    for (let i = 0; i < after.pts.length; i++) {
      if (Math.abs(after.pts[i] - after.first - i / 60) > epsilon) return result
    }
  }
  const audiosOut = outputStreams.filter(s => s?.codec_type === 'audio')
  result.reason = 'AUDIO_TIMELINE_MISMATCH'
  if (audioIndex === null) {
    if (audiosOut.length) return result
  } else {
    const audioIn = sourceStreams.find(s => s?.index === audioIndex && s.codec_type === 'audio')
    if (!audioIn || audiosOut.length !== 1 || !audiosOut[0]) return result
    const audioOut = audiosOut[0]
    const inAudio = timeline(a.frames, audioIn), outAudio = timeline(b.frames, audioOut)
    const sampleRate = number(audioOut.sample_rate)
    if (!inAudio || !outAudio || !sampleRate || sampleRate <= 0) return result
    const audioQuantization = inAudio.tick + outAudio.tick + 1e-9
    // Il padding di un frame AAC riguarda soltanto i bordi della traccia.
    // Applicarlo ai buchi interni nasconderebbe proprio un frame audio perso.
    const audioEndpointTolerance = 1024 / sampleRate + audioQuantization + epsilon
    // Una traslazione globale del file è lecita; spostare solo l'audio no.
    if (Math.abs((inAudio.first - before.first) - (outAudio.first - after.first)) > audioEndpointTolerance ||
        Math.abs((inAudio.end - before.first) - (outAudio.end - after.first)) > audioEndpointTolerance) return result
    const gaps = (track: NonNullable<ReturnType<typeof timeline>>, origin: number) => {
      const holes: Array<[number, number]> = []
      for (let i = 1; i < track.pts.length; i++) {
        const end = track.pts[i - 1] + track.durations[i - 1]
        if (track.pts[i] - end > audioQuantization) holes.push([end - origin, track.pts[i] - origin])
        if (end - track.pts[i] > audioQuantization) return null
      }
      return holes
    }
    const holesIn = gaps(inAudio, before.first), holesOut = gaps(outAudio, after.first)
    if (!holesIn || !holesOut || holesIn.length !== holesOut.length) return result
    for (let i = 0; i < holesIn.length; i++) {
      if (Math.abs(holesIn[i][0] - holesOut[i][0]) > audioQuantization ||
          Math.abs(holesIn[i][1] - holesOut[i][1]) > audioQuantization) return result
    }
  }
  result.ok = true
  delete result.reason
  return result
}

/** Node è disponibile nella Sandbox node22. Le sonde complete restano qui. */
export function videoTemporalProgram(options: { videoIndex: number; audioIndex: number | null; sourceFps: number }): string {
  return `
const { spawnSync } = require('node:child_process');
const compare = (${compareVideoTimelines.toString()});
const options = ${JSON.stringify(options)};
const read = (file) => {
  const p = spawnSync(process.argv[2], ['-v', 'error', '-err_detect', 'explode',
    '-show_streams', '-show_frames', '-show_entries',
    'stream=index,codec_type,time_base,avg_frame_rate,r_frame_rate,sample_rate:stream_disposition=attached_pic:frame=stream_index,best_effort_timestamp,duration,pkt_duration',
    '-of', 'json', file], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (p.status !== 0 || p.error || p.stderr.trim()) throw new Error('TEMPORAL_PROBE_FAILED');
  return JSON.parse(p.stdout);
};
let result;
try {
  result = compare(read(process.argv[3]), read(process.argv[4]), options.videoIndex, options.audioIndex, options.sourceFps);
} catch {
  // Fail-closed, nessun nome file o contenuto della sonda nel diagnostico.
  result = { version: 1, ok: false, mode: options.sourceFps > 60 ? 'reduce60' : 'preserve', sourceFrames: 0, outputFrames: 0, sourceFps: options.sourceFps, outputFps: 0, reason: 'TEMPORAL_PROBE_FAILED' };
}
process.stdout.write(JSON.stringify(result));
`
}
