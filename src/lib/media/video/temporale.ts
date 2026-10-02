import { MAX_VIDEO_DURATION_SECONDS } from './limiti'

/**
 * I motivi per cui la prova temporale può dire no. Elenco chiuso e a runtime, non solo un tipo:
 * la diagnosi (`verify.ts`) copia nel database SOLO i motivi che riconosce, e per farlo le serve
 * l'elenco vero, non il suo profilo.
 *
 * `TERMINAL_COVERAGE_MISMATCH` non c'è più (02/10/2026): confrontava la durata dell'ULTIMO campione,
 * che il muxer non conserva. Il tetto di durata, che viveva dentro quel confronto, ha il suo
 * motivo: `DURATION_LIMIT`.
 */
export const VIDEO_TEMPORAL_REASONS = [
  'INVALID_EVIDENCE',
  'FRAME_COUNT_MISMATCH',
  'TIMESTAMP_MISMATCH',
  'DURATION_LIMIT',
  'FPS_LIMIT',
  'AUDIO_TIMELINE_MISMATCH',
  'TEMPORAL_PROBE_FAILED',
] as const

export type VideoTemporalReason = (typeof VIDEO_TEMPORAL_REASONS)[number]

/**
 * Ciò che le due timeline hanno MISURATO, in secondi. Non è un verdetto: serve a due cose, e a
 * nient'altro. `verify.ts` ne ricava la tolleranza sulla durata (l'ultimo campione della sorgente), e
 * la diagnosi le scrive in `video_jobs.diagnosi_verifica` perché un rifiuto si legga coi numeri
 * invece che col solo codice. Sono numeri e basta: nessun frame, nessun PTS esce dalla Sandbox.
 *
 * Presente anche quando la prova dice no (dopo il calcolo delle due timeline), assente solo se le
 * timeline non si sono potute costruire.
 */
export interface VideoTemporalMeasures {
  /** Durata dell'ultimo campione video della SORGENTE. */
  sourceLastSample: number
  /** Durata dell'ultimo campione video dell'USCITA: il muxer la sceglie lui. */
  outputLastSample: number
  /** Dal primo PTS alla fine dell'ultimo campione, sorgente. */
  sourceCoverage: number
  /** Dal primo PTS alla fine dell'ultimo campione, uscita. */
  outputCoverage: number
  /** Tolleranza sui PTS: un tick di uscita più 1 ns. */
  epsilon: number
}

/** Solo l'attestazione esce dalla Sandbox; frame e PTS non si persistono né si loggano. */
export interface VideoTemporalEvidence {
  version: 1
  ok: boolean
  mode: 'preserve' | 'reduce60'
  sourceFrames: number
  outputFrames: number
  sourceFps: number
  outputFps: number
  reason?: VideoTemporalReason
  /** Assente nelle prove di prima del 02/10/2026: chi la legge deve saperne fare a meno. */
  measures?: VideoTemporalMeasures
}

/**
 * Confronta la timeline video (e quella audio) della sorgente con quella dell'uscita.
 *
 * `maxDurationSeconds` è il tetto di durata dell'ingresso (`MAX_VIDEO_DURATION_SECONDS`) e arriva da
 * FUORI, come parametro, apposta: la funzione viaggia serializzata dentro la Sandbox e non può
 * importare nulla. Da lì derivano i due tetti interni — i secondi coperti e, a 1.000 frame al
 * secondo, il numero di frame — che prima erano un 180 scritto qui dentro e rimasto indietro il giorno
 * in cui il limite è salito.
 *
 * ⚠️ COSA NON SI CONFRONTA PIÙ (falso scarto del 28/09/2026, misurato il 02/10).
 * Fino a oggi si confrontava anche la COPERTURA TERMINALE: dal primo PTS alla fine dell'ultimo
 * campione, compresa la durata di quell'ultimo campione. Ma quella durata il muxer non la conserva:
 * la sceglie lui. Un `.mov` vero (14 MB), 264 frame con i PTS IDENTICI fotogramma per fotogramma
 * (primo 0, ultimo 8,721025 s), arrivava con un ultimo campione di 3,035 ms e usciva con uno da
 * 33,333 ms — Δ 30,3 ms contro una tolleranza di 3,036 — ed era buttato come
 * `TERMINAL_COVERAGE_MISMATCH` pur essendo una conversione perfetta. Provato anche con un file
 * sintetico (ultimo campione accorciato a 3 ms): `preserve` e `reduce60` cadono allo stesso modo.
 * In `preserve` l'uguaglianza dei PTS frame per frame prova già l'intera timeline, ultimo frame
 * compreso; in `reduce60` resta il controllo d'ARCO (primo → ultimo PTS, che non dipende da nessuna
 * durata di campione). Il tetto di durata resta, ma da solo e col suo motivo.
 */
export function compareVideoTimelines(
  source: unknown,
  output: unknown,
  videoIndex: number,
  audioIndex: number | null,
  sourceFps: number,
  maxDurationSeconds: number,
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
  // Senza un tetto valido non c'è modo di sapere se il file è ostile: fail-closed.
  if (typeof maxDurationSeconds !== 'number' || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) return result
  const maxFrames = Math.ceil(maxDurationSeconds * 1000)
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
    // `maxDurationSeconds` × 1.000 frame/s: tetto tecnico, nessun array illimitato da un file ostile.
    if (selected.length === 0 || selected.length > maxFrames) return null
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
  const coveredIn = before.end - before.first, coveredOut = after.end - after.first
  // Le misure si fissano PRIMA di qualunque rifiuto: è quando la prova dice no che servono.
  result.measures = {
    sourceLastSample,
    outputLastSample: after.durations[after.durations.length - 1],
    sourceCoverage: coveredIn,
    outputCoverage: coveredOut,
    epsilon,
  }
  // Il tetto di durata: un file ostile non fa coprire alla sorgente più di quanto il limite consente.
  // Si guarda la SORGENTE e solo lei; la tolleranza è quella di sempre (un campione), e NON è più
  // un confronto fra le due coperture.
  const capTolerance = Math.min(sourceLastSample, 1 / Math.min(sourceFps, 60)) + epsilon
  if (coveredIn > maxDurationSeconds + capTolerance) {
    result.reason = 'DURATION_LIMIT'
    return result
  }
  if (result.mode === 'preserve') {
    // L'uguaglianza dei PTS fotogramma per fotogramma, ultimo compreso, prova la timeline.
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
    // L'ARCO (primo → ultimo PTS) è l'unico confronto di copertura che resta: non guarda la durata di
    // nessun campione, che il muxer sceglie da sé.
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

/* ────────────────────────────────────────────────────────────────────────────
 * La sonda dentro la Sandbox: timeout e buffer
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Le costanti della sonda temporale. PROVVISORIE: T16 le tara con le misure del Sandbox vero
 * (4K HLG 10 bit a 60 fps, 1080p di 300 s). Fino ad allora vale la regola con cui sono scelte, che
 * non cambia: **sbagliare in alto costa soltanto quando una sonda si pianta, sbagliare in basso scarta un
 * video buono** — cioè il difetto che questo modulo esiste per chiudere.
 */
export const SONDA_TEMPORALE = {
  /**
   * Mai sotto i 120 secondi, il timeout fisso di prima: per un Full HD di 180 s il valore non deve
   * scendere sotto quello di oggi. È un pavimento: un video piccolo non ne ricava un timeout più corto.
   */
  pavimentoMs: 120_000,
  /**
   * Il massimo per OGNI sonda (ce ne sono due per job). Dentro il tetto della MicroVM (30 minuti,
   * `TETTO_SANDBOX_MS`), che spegne tutto comunque: questo non lo sostituisce, evita solo di
   * aspettare un processo piantato più di quanto serva.
   */
  tettoMs: 900_000,
  /** Avvio del processo e lettura del contenitore: non dipendono dalla dimensione del video. */
  baseMs: 30_000,
  /**
   * Ogni megapixel decodificato (larghezza × altezza × frame ÷ 1.000.000) costa 20 ms nel
   * peggiore dei casi: 50 megapixel al secondo, cioè un 4K a 6 fps o un Full HD a 24 fps. Un
   * decoder software è di norma parecchie volte più veloce: quello è il margine, apposta largo, e
   * T16 lo misura invece di indovinarlo.
   */
  msPerMegapixelDecodificato: 20,
  /**
   * Un frame occupa ~130 byte nel JSON di `ffprobe -show_frames` (misurato il 02/10/2026 sull'output
   * reale). Il caso reale più pesante, 300 s a 60 fps con audio (~32.000 frame), ne scrive ~4 MB; il
   * tetto tecnico di 300.000 frame per traccia ne scriverebbe ~40, oltre i 32 MiB di prima: a quel
   * punto `spawnSync` risponde `ENOBUFS` e un file al limite diventerebbe un falso scarto.
   */
  maxBufferBytes: 64 * 1024 * 1024,
} as const

/** Ciò che serve sapere dell'INGRESSO per stimare quanto ci metterà la sonda a decodificarlo. */
export interface MisureIngressoSonda {
  durationSeconds?: number
  width?: number
  height?: number
  fps?: number
}

/**
 * Il timeout di UNA sonda temporale, proporzionale a quanto c'è da decodificare: durata, risoluzione
 * e frame rate dell'ingresso. Funzione pura.
 *
 * Una misura mancante o malformata NON dà il pavimento ma il TETTO: non sapere quanto è grande il file
 * è esattamente il caso in cui meno si può permettere di scartarlo per un timeout. (Finché
 * `esegui.ts` non passa durata e dimensioni, tutte le sonde partono col tetto.)
 */
export function timeoutSondaTemporaleMs(ingresso: MisureIngressoSonda): number {
  const { pavimentoMs, tettoMs, baseMs, msPerMegapixelDecodificato } = SONDA_TEMPORALE
  const positivo = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const { durationSeconds, width, height, fps } = ingresso
  if (!positivo(durationSeconds) || !positivo(width) || !positivo(height) || !positivo(fps)) return tettoMs
  const megapixelDecodificati = (width * height / 1_000_000) * fps * durationSeconds
  const stima = baseMs + megapixelDecodificati * msPerMegapixelDecodificato
  // `Math.min` con il tetto assorbe anche un `Infinity` (dimensioni da file ostile).
  return Math.round(Math.min(tettoMs, Math.max(pavimentoMs, stima)))
}

/** Le opzioni del programma. Tutto ciò che non è `videoIndex`, `audioIndex` e `sourceFps` è facoltativo. */
export interface VideoTemporalProgramOptions {
  videoIndex: number
  audioIndex: number | null
  sourceFps: number
  /** Tetto di durata dell'ingresso. Assente: `MAX_VIDEO_DURATION_SECONDS`, e così deve restare. */
  maxDurationSeconds?: number
  /** Durata, larghezza e altezza dell'ingresso (dal probe): tarano il timeout. Assenti: tetto. */
  durationSeconds?: number
  width?: number
  height?: number
  /** Solo per le prove: sostituisce il timeout calcolato. */
  timeoutSondaMs?: number
}

/**
 * Node è disponibile nella Sandbox node22. Le sonde complete restano qui.
 *
 * Quando la prova fallisce, UNA riga su stderr dice perché (`ETIMEDOUT`, `ENOBUFS`, `ENOENT`, `USCITA_1`,
 * `STDERR`, `JSON_NON_VALIDO`, o `ECCEZIONE_<nome>` per un difetto nostro): finisce nel diario della
 * conversione, e distingue un timeout da un video davvero storto. Mai il contenuto della sonda: solo il
 * nome della causa.
 *
 * Per provare il programma a mano si usa vitest (lo fa `__tests__/lib/video-temporale.test.ts`, con un
 * ffprobe finto) e non `tsx`: esbuild con `keepNames` riempie il testo della funzione di chiamate a
 * `__name`, che fuori dal suo bundle non esistono e fanno cadere ogni sonda in `TEMPORAL_PROBE_FAILED`.
 */
export function videoTemporalProgram(options: VideoTemporalProgramOptions): string {
  const programma = {
    videoIndex: options.videoIndex,
    audioIndex: options.audioIndex,
    sourceFps: options.sourceFps,
    maxDurationSeconds: options.maxDurationSeconds ?? MAX_VIDEO_DURATION_SECONDS,
    timeoutMs: options.timeoutSondaMs ?? timeoutSondaTemporaleMs({
      durationSeconds: options.durationSeconds,
      width: options.width,
      height: options.height,
      fps: options.sourceFps,
    }),
    maxBufferBytes: SONDA_TEMPORALE.maxBufferBytes,
  }
  return `
const { spawnSync } = require('node:child_process');
const compare = (${compareVideoTimelines.toString()});
const options = ${JSON.stringify(programma)};
const read = (file) => {
  const p = spawnSync(process.argv[2], ['-v', 'error', '-err_detect', 'explode',
    '-show_streams', '-show_frames', '-show_entries',
    'stream=index,codec_type,time_base,avg_frame_rate,r_frame_rate,sample_rate:stream_disposition=attached_pic:frame=stream_index,best_effort_timestamp,duration,pkt_duration',
    '-of', 'json', file], { encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxBufferBytes });
  const fallita = (causa) => {
    process.stderr.write('sonda temporale: ' + causa + '\\n');
    throw new Error('TEMPORAL_PROBE_FAILED');
  };
  if (p.error) fallita(String(p.error.code || 'ERRORE'));
  if (p.status !== 0) fallita('USCITA_' + p.status);
  if (p.stderr.trim()) fallita('STDERR');
  try {
    return JSON.parse(p.stdout);
  } catch {
    return fallita('JSON_NON_VALIDO');
  }
};
let result;
try {
  result = compare(read(process.argv[3]), read(process.argv[4]), options.videoIndex, options.audioIndex, options.sourceFps, options.maxDurationSeconds);
} catch (errore) {
  // fallita() ha già scritto la sua riga. Ogni altra eccezione è un difetto del confronto o dei
  // parametri, e si dice col solo NOME del tipo: il messaggio potrebbe portarsi dietro dati della sonda.
  if (!errore || errore.message !== 'TEMPORAL_PROBE_FAILED') {
    process.stderr.write('sonda temporale: ECCEZIONE_' + String((errore && errore.name) || 'SCONOSCIUTA') + '\\n');
  }
  // Fail-closed, nessun nome file o contenuto della sonda nel diagnostico.
  result = { version: 1, ok: false, mode: options.sourceFps > 60 ? 'reduce60' : 'preserve', sourceFrames: 0, outputFrames: 0, sourceFps: options.sourceFps, outputFps: 0, reason: 'TEMPORAL_PROBE_FAILED' };
}
process.stdout.write(JSON.stringify(result));
`
}
