import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SEDE_A } from '../fixtures/sedi'

import { MESSAGGIO_MAX, descriviErrore, sanificaMessaggio } from '@/lib/logging/serialize'
import { rigaEvento } from '@/lib/logging/logger'
import { BUCKET_BUILD_VIDEO, PERCORSO_FFMPEG_GZ, PERCORSO_FFPROBE_GZ } from '@/lib/media/video/build'
import { archivioSupabase, codaSupabase } from '@/lib/media/video/runner/adattatori'
import { TETTO_INVOCAZIONE_MS } from '@/lib/media/video/runner/battito'
import { codaDiagnostica } from '@/lib/media/video/runner/diagnosi'
import { SECONDI_FIRMA_BUILD, erroreDiagnostico, eseguiUnJobVideo } from '@/lib/media/video/runner/esegui'
import {
  ENV_URL_FFMPEG,
  ENV_URL_FFPROBE,
  SEPARATORE_INVENTARIO,
  nomeSandboxVideo,
  percorsoUscitaVideo,
} from '@/lib/media/video/runner/preparazione'
import type {
  ArchivioVideo,
  CodaVideo,
  ComandoSandbox,
  EsitoArchivio,
  EsitoComando,
  EsitoRpcVideo,
  JobVideo,
  MacchinaSandbox,
  SessioneSandbox,
} from '@/lib/media/video/runner/porte'
import {
  USCITE_APPARECCHIO,
  USCITE_CONVERSIONE,
  codiceDaUscitaApparecchio,
  codiceDaUscitaConversione,
  leggiApparecchio,
  leggiEsitoConversione,
  scriptApparecchio,
  scriptConversione,
  senzaUrl,
} from '@/lib/media/video/runner/script'

/**
 * L'ORCHESTRAZIONE — chi vince, che cosa si ferma, in che ordine, con quale codice.
 *
 * ⚠️ QUI I DOPPI SONO OVUNQUE, E QUINDI QUI SI SBAGLIA. Un doppio piatto — «la
 * sandbox risponde sempre bene, il database dice sempre sì» — resta verde anche se
 * l'orchestrazione sotto è al contrario. Perciò ogni caso qui sotto rompe UNA cosa
 * sola e pretende due fatti: il codice giusto sul database, e **che cosa NON è
 * successo** (nessun comando dopo il guasto, nessuna scrittura sul job che non è
 * più nostro, nessuna MicroVM lasciata accesa). La seconda metà è quella che i mock
 * piatti non hanno mai.
 *
 * I LOG SI GUARDANO DAVVERO. `logEvento` è sostituito da un registratore e tutto il resto di
 * `@/lib/logging/logger` resta vero: in particolare `rigaEvento`, la parte DECIDIBILE del
 * logging (messaggio, bersaglio, campi redatti). Ogni chiamata registrata si fa passare da lì,
 * così ciò che si asserisce è ciò che finirebbe in `app_log`, e non ciò che il codice crede di
 * aver scritto — è la differenza che avrebbe visto il 404 perso in coda ai 500 caratteri.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Il registratore dei log
 * ──────────────────────────────────────────────────────────────────────────── */

type ChiamataLog = [
  evento: string,
  livello: string,
  campi: Record<string, unknown>,
  err?: unknown,
  opzioni?: { distingui?: readonly string[] },
]

const h = vi.hoisted(() => ({ log: [] as unknown[][] }))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...argomenti: unknown[]) => {
    h.log.push(argomenti)
  },
}))

// L'SDK del Sandbox non serve a niente qui: gli adattatori che si provano sono quelli della coda e dello
// Storage, e `macchinaVercel` — l'unico che lo usa — non si esercita. Senza il finto, importare
// `adattatori.ts` caricherebbe l'SDK vero dentro un test che non apre nessuna MicroVM.
vi.mock('@vercel/sandbox', () => ({ Sandbox: {} }))

beforeEach(() => {
  h.log.length = 0
})

/** Le righe di log scritte finora, nell'ordine. */
const righeDiLog = (): ChiamataLog[] => h.log as unknown as ChiamataLog[]

/** Le righe il cui `esito` è questo. */
const conEsito = (esito: string): ChiamataLog[] => righeDiLog().filter((r) => r[2].esito === esito)

/** L'UNICA riga con questo `esito`: zero o due sono già un difetto. */
function riga(esito: string): ChiamataLog {
  const trovate = conEsito(esito)
  expect(trovate, `righe di log con esito «${esito}»`).toHaveLength(1)
  return trovate[0]
}

/** Ciò che finirebbe in `app_log` per quella chiamata: passa dal `rigaEvento` VERO. */
function comeInTabella(r: ChiamataLog) {
  const tabella = rigaEvento(r[0], r[1] as 'info' | 'warn' | 'error', r[2] as never, r[3], r[4])
  expect(tabella, 'rigaEvento deve produrre una riga').toBeDefined()
  return tabella as NonNullable<typeof tabella>
}

/* ────────────────────────────────────────────────────────────────────────────
 * Le fixture: un probe di ingresso vero e un'uscita che lo rispetta
 * ──────────────────────────────────────────────────────────────────────────── */

const JOB_ID = '3f2a61b4-1c7d-4e58-9a0b-2d4c6e8f0a12'
const OWNER = '9d0c1b2a-3e4f-4a5b-8c9d-0e1f2a3b4c5d'
const WORKER = '00000000-1111-4222-8333-444444444444'
// La sede viene da `__tests__/fixtures/sedi.ts`: un uuid di produzione dentro un
// test è innocuo ma NORMALIZZA l'errore — chi copia il test copia l'uuid, e da lì
// finisce in uno script che scrive sul database vero (lock
// `migrazioni-senza-sede-cablata`).
const SCUOLA = SEDE_A

function job(sovrascritture: Partial<JobVideo> = {}): JobVideo {
  return {
    id: JOB_ID,
    owner_id: OWNER,
    scuola_id: SCUOLA,
    channel: 'gallery',
    intent_id: OWNER,
    status: 'processing',
    original_bucket: 'video_originals',
    original_path: `${OWNER}/originale`,
    source_size: 20_000_000,
    source_mime: 'video/mp4',
    attempt: 1,
    fence_epoch: 5,
    ...sovrascritture,
  }
}

/** Durata a ridosso del tetto: serve al caso «il probe_json è la SORGENTE». */
const DURATA_SORGENTE = 179.9
const DURATA_USCITA = 179.92

function probeSorgente(durata = DURATA_SORGENTE): string {
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        width: 1920,
        height: 1080,
        coded_width: 1920,
        coded_height: 1088,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30000/1001',
        r_frame_rate: '30000/1001',
        duration: String(durata),
        sample_aspect_ratio: '1:1',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        disposition: { default: 1, attached_pic: 0 },
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: String(durata) },
  })
}

function probeUscita(durata = DURATA_USCITA): string {
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30000/1001',
        r_frame_rate: '30000/1001',
        duration: String(durata),
        sample_aspect_ratio: '1:1',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        color_range: 'tv',
        disposition: { default: 1, attached_pic: 0 },
      },
    ],
    format: { format_name: 'mov,mp4', duration: String(durata) },
  })
}

const INVENTARIO_COMPLETO = [
  ' .. zscale            V->V       Colorspace conversion.\n' +
    ' .S tonemap           V->V       Dynamic range.\n' +
    ' .. scale             V->V       Scale.\n' +
    ' TS overlay           VV->V      Overlay.\n' +
    ' .. setsar            V->V       Set SAR.\n' +
    ' .. fps               V->V       Force fps.\n' +
    ' .. format            V->V       Convert pixel format.\n' +
    ' T. sidedata          V->V       Side data.',
  ' V....D h264\n V....D hevc\n V....D vp8\n V....D vp9\n VFS..D av1\n VF...D prores\n VFS..D dnxhd',
  ' V....D libx264\n A....D aac\n V....D libx265\n VFS... prores_ks\n VFS..D dnxhd',
].join(`\n${SEPARATORE_INVENTARIO}\n`)

function uscitaApparecchio(probe = probeSorgente()): string {
  return [
    '===INVENTARIO===',
    INVENTARIO_COMPLETO,
    '===BYTE===',
    '20000000',
    '===PROBE===',
    probe,
  ].join('\n')
}

function marcatore(
  p: {
    uscita?: number
    byteSorgente?: number
    byteUscita?: number
    decodeExit?: number
    decodeFrames?: number
    probeIn?: string
    probeOut?: string
    diagnosi?: string
  } = {},
): string {
  return [
    `KV_ESITO_EXIT=${p.uscita ?? 0}`,
    `KV_BYTE_SORGENTE=${p.byteSorgente ?? 20_000_000}`,
    `KV_BYTE_USCITA=${p.byteUscita ?? 8_000_000}`,
    `KV_DECODE_EXIT=${p.decodeExit ?? 0}`,
    `KV_DECODE_FRAMES=${p.decodeFrames ?? 5391}`,
    `KV_TEMPORAL=${JSON.stringify({ version: 1, ok: true, mode: 'preserve', sourceFrames: p.decodeFrames ?? 5391, outputFrames: p.decodeFrames ?? 5391, sourceFps: 30000 / 1001, outputFps: 30000 / 1001 })}`,
    '===PROBE_SORGENTE===',
    p.probeIn ?? probeSorgente(),
    '===PROBE_USCITA===',
    p.probeOut ?? probeUscita(),
    '===DIAGNOSI===',
    p.diagnosi ?? 'frame= 5391 fps=120 q=-1.0',
  ].join('\n')
}

/* ────────────────────────────────────────────────────────────────────────────
 * I doppi
 * ──────────────────────────────────────────────────────────────────────────── */

const OK: EsitoComando = { exitCode: 0, stdout: '', stderr: '' }

interface Copione {
  /** Risposta a ciascun comando, scelta guardando che cosa è stato chiesto. */
  risposta?: (c: ComandoSandbox, n: number) => EsitoComando | Error
  nuova?: boolean
  apriFallisce?: boolean
}

function sandboxFinta(copione: Copione = {}) {
  const eseguiti: ComandoSandbox[] = []
  const avviati: ComandoSandbox[] = []
  const nomi: string[] = []
  let fermata = 0
  let marcatoriLetti = 0

  const sessione: SessioneSandbox = {
    nuova: copione.nuova ?? true,
    esegui: async (c) => {
      eseguiti.push(c)
      if (c.args.join(' ').includes('esito.txt')) marcatoriLetti += 1
      const r = copione.risposta?.(c, eseguiti.length)
      if (r instanceof Error) throw r
      return r ?? OK
    },
    avvia: async (c) => {
      avviati.push(c)
    },
    ferma: async () => {
      fermata += 1
    },
  }

  const macchina: MacchinaSandbox = {
    apri: async (p) => {
      nomi.push(p.nome)
      if (copione.apriFallisce) throw new Error('microvm non disponibile')
      return sessione
    },
  }

  return { macchina, eseguiti, avviati, nomi, fermate: () => fermata, marcatoriLetti: () => marcatoriLetti }
}

type ParametriRiprova = Parameters<CodaVideo['riprova']>[0]

interface CopioneCoda {
  prossimo?: EsitoRpcVideo
  miei?: JobVideo[]
  battito?: EsitoRpcVideo
  pronto?: EsitoRpcVideo
  fallito?: EsitoRpcVideo
  /**
   * La risposta di `video_job_retry`. Senza copione il database dice «ok» e il job è `queued`: la
   * risposta di un ritentativo andato a buon fine.
   */
  riprova?: EsitoRpcVideo | ((p: ParametriRiprova) => EsitoRpcVideo)
}

function codaFinta(copione: CopioneCoda = {}) {
  const pronti: unknown[] = []
  const falliti: { jobId: string; fenceEpoch: number; leaseOwner: string; codice: string; rifiutato: boolean }[] = []
  const ritentati: ParametriRiprova[] = []
  const riprese: string[] = []
  let battiti = 0

  const coda: CodaVideo = {
    miei: async () => ({ ok: true, jobs: copione.miei ?? [] }),
    prossimo: async () => copione.prossimo ?? { ok: false, code: 'EMPTY_QUEUE' },
    riprendi: async (jobId) => {
      riprese.push(jobId)
      return { ok: true, job: (copione.miei ?? [])[0] ?? job() }
    },
    battito: async () => {
      battiti += 1
      return copione.battito ?? { ok: true, job: job() }
    },
    pronto: async (p) => {
      pronti.push(p)
      return copione.pronto ?? { ok: true, job: job() }
    },
    fallito: async (p) => {
      falliti.push(p)
      return copione.fallito ?? { ok: true, job: job({ status: 'failed' }) }
    },
    riprova: async (p) => {
      ritentati.push(p)
      const risposta = copione.riprova
      if (typeof risposta === 'function') return risposta(p)
      return risposta ?? { ok: true, job: job({ status: 'queued' }) }
    },
  }

  return { coda, pronti, falliti, ritentati, riprese, battiti: () => battiti }
}

/** Una firma rifiutata: il motivo e, se c'è, ciò da cui si decide la classe (stato HTTP, codice dello Storage). */
type FirmaRifiutata = Omit<Extract<EsitoArchivio, { ok: false }>, 'ok'>

interface FirmaRichiesta {
  tipo: 'lettura' | 'scrittura'
  bucket: string
  percorso: string
  /** Solo per le letture: quanto dura l'indirizzo. */
  secondi?: number
}

/**
 * Lo Storage finto: registra OGNI firma richiesta (che cosa, da quale bucket, per quanti
 * secondi) e può rifiutarne alcune. Gli indirizzi portano un `token=` finto: ogni asserzione che
 * dice «questo indirizzo non deve stare lì» ha qualcosa da trovare.
 */
function archivioFinto(
  rifiuti: {
    lettura?: (bucket: string, percorso: string) => FirmaRifiutata | null
    scrittura?: (bucket: string, percorso: string) => FirmaRifiutata | null
  } = {},
) {
  const firme: FirmaRichiesta[] = []
  const archivio: ArchivioVideo = {
    urlLettura: async (bucket, percorso, secondi) => {
      firme.push({ tipo: 'lettura', bucket, percorso, secondi })
      const rifiuto = rifiuti.lettura?.(bucket, percorso)
      if (rifiuto) return { ok: false, ...rifiuto }
      return {
        ok: true,
        url: `https://esempio.invalid/storage/${bucket}/${percorso}?token=segreto-che-non-va-loggato`,
      }
    },
    urlScrittura: async (bucket, percorso) => {
      firme.push({ tipo: 'scrittura', bucket, percorso })
      const rifiuto = rifiuti.scrittura?.(bucket, percorso)
      if (rifiuto) return { ok: false, ...rifiuto }
      return {
        ok: true,
        url: `https://esempio.invalid/storage/upload/${bucket}/${percorso}?token=altro-segreto`,
      }
    },
  }
  return { archivio, firme }
}

/** Quello di sempre: tutte le firme riescono. */
const archivio: ArchivioVideo = archivioFinto().archivio

function orologioFinto() {
  let ora = 1_000_000
  return {
    adesso: () => ora,
    pausa: async (ms: number) => void (ora += ms),
    /** Fa passare del tempo «dentro» un comando finto, senza aspettare niente. */
    avanza: (ms: number) => void (ora += ms),
  }
}

function dipendenze(
  coda: CodaVideo,
  macchina: MacchinaSandbox,
  sovrascritture: Partial<Parameters<typeof eseguiUnJobVideo>[0]> = {},
) {
  return {
    coda,
    archivio,
    macchina,
    orologio: orologioFinto(),
    leaseOwner: WORKER,
    regione: 'dub1',
    vcpus: 4,
    urlWatermark: 'https://app.esempio.invalid/watermark.png',
    tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    ...sovrascritture,
  }
}

/** Il copione del percorso felice: apparecchio ok, args ok, marcatore pronto. */
function rispostaFelice(marca = marcatore()) {
  return (c: ComandoSandbox): EsitoComando => {
    const testo = c.args.join(' ')
    if (testo.includes('esito.txt')) return { exitCode: 0, stdout: marca, stderr: '' }
    if (testo.includes('===INVENTARIO===')) {
      return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
    }
    return OK
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. GLI SCRIPT E I LORO LETTORI — funzioni pure, nessun doppio
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · gli script e i loro lettori', () => {
  it('l’apparecchio distingue i propri modi di fallire da quelli della build', () => {
    expect(codiceDaUscitaApparecchio(0)).toBeNull()
    expect(codiceDaUscitaApparecchio(USCITE_APPARECCHIO.dimensione)).toBe('SOURCE_DOWNLOAD_FAILED')
    expect(codiceDaUscitaApparecchio(USCITE_APPARECCHIO.probe)).toBe('PROBE_COMMAND_FAILED')
    // Le tre uscite della provvista restano quelle, viste da qui.
    expect(codiceDaUscitaApparecchio(22)).toBe('BUILD_HASH_MISMATCH')
  })

  it('la conversione distingue scarico, codifica, probe e caricamento', () => {
    expect(codiceDaUscitaConversione(0)).toBeNull()
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.scarico)).toBe('SOURCE_DOWNLOAD_FAILED')
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.codifica)).toBe('ENCODE_FAILED')
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.probe)).toBe('PROBE_COMMAND_FAILED')
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.caricamento)).toBe('OUTPUT_UPLOAD_FAILED')
    // Fail-closed: un 137 (SIGKILL) non è «è andata bene».
    expect(codiceDaUscitaConversione(137)).toBe('ENCODE_FAILED')
  })

  it('il marcatore compare TUTTO INSIEME: si scrive a parte e si sposta', () => {
    const script = scriptConversione({ conWatermark: true, videoIndex: 0, audioIndex: null, sourceFps: 30 })
    expect(script).toContain('KV_TEMPORAL=')
    expect(script).toContain('node -')
    expect(script).toContain('-show_frames')
    expect(script).toContain('-fps_mode passthrough')
    // Senza questo `mv`, la sorveglianza potrebbe leggere un marcatore scritto a
    // metà — cioè un probe troncato — e dichiarare guasta una conversione riuscita.
    expect(script).toMatch(/mv\s+\S*parziale\S*\s+\S*esito\.txt/)
    // E il marcatore si scrive COMUNQUE, anche quando qualcosa esplode: senza la
    // trappola, un guasto lascerebbe la sorveglianza a girare fino al tetto.
    expect(script).toContain('trap')
  })

  it('l’apparecchio verifica la build prima di usarla, e legge il probe SENZA scaricare il video', () => {
    const script = scriptApparecchio()
    // La build non si scarica più da Internet né si estrae da un archivio: i due `.gz` del
    // nostro bucket si verificano PRIMA di essere decompressi. L'ordine completo (curl, sha dei
    // `.gz`, `gzip -dc`, sha dei binari, chmod) lo prova `video-runner-preparazione.test.ts`;
    // qui basta che la verifica ci sia e preceda la decompressione, anche dentro l'apparecchio.
    expect(script.indexOf('sha256sum')).toBeGreaterThanOrEqual(0)
    expect(script.indexOf('gzip -dc')).toBeGreaterThanOrEqual(0)
    expect(script.indexOf('sha256sum')).toBeLessThan(script.indexOf('gzip -dc'))
    expect(script).not.toContain('tar ')
    // ffprobe sull'URL firmato: legge le intestazioni con richieste di intervallo,
    // non i 2 GB. Se scaricasse, l'apparecchio non starebbe in un'invocazione.
    expect(script).toContain('$KV_URL_INGRESSO')
    expect(script).not.toContain('curl -fsSL --retry 3 --retry-all-errors -o /tmp/kv-video/ingresso')
  })

  it('il lettore dell’apparecchio separa inventario, dimensione e probe', () => {
    const letto = leggiApparecchio(uscitaApparecchio())
    expect(letto.byte).toBe(20_000_000)
    expect(letto.inventario.filtri.has('zscale')).toBe(true)
    expect(letto.inventario.encoder.has('libx264')).toBe(true)
    expect(JSON.parse(letto.probeGrezzo).format.format_name).toContain('mp4')
  })

  it('il lettore del marcatore ricava i numeri e i due probe', () => {
    const letto = leggiEsitoConversione(marcatore({ uscita: 0, decodeFrames: 12 }))
    expect(letto.uscita).toBe(0)
    expect(letto.byteSorgente).toBe(20_000_000)
    expect(letto.byteUscita).toBe(8_000_000)
    expect(letto.prova).toMatchObject({ exitCode: 0, decodedFrames: 12, temporal: { version: 1, ok: true, sourceFrames: 12, outputFrames: 12 } })
    expect(JSON.parse(letto.probeSorgente).format.duration).toBe(String(DURATA_SORGENTE))
    expect(JSON.parse(letto.probeUscita).format.duration).toBe(String(DURATA_USCITA))
  })

  it('un marcatore illeggibile non diventa «tutto a posto»', () => {
    const letto = leggiEsitoConversione('spazzatura')
    expect(letto.uscita).not.toBe(0)
    expect(letto.byteUscita).toBeNull()
    expect(letto.prova).toBeNull()
  })

  it('la diagnosi che finisce nei log non porta dentro un URL firmato', () => {
    const grezzo =
      "curl: (22) The requested URL returned error: 403 for https://x.invalid/o/v?token=eyJhbGciOi.SEGRETO"
    expect(senzaUrl(grezzo)).not.toContain('token=')
    expect(senzaUrl(grezzo)).not.toContain('eyJhbGciOi')
    // …ma il MOTIVO resta leggibile: è l'unica cosa che serve per capire.
    expect(senzaUrl(grezzo)).toContain('403')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. IL GIRO DEL WORKER
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · quando non c’è niente da fare', () => {
  it('coda vuota: non si apre nessuna MicroVM', async () => {
    const c = codaFinta({ prossimo: { ok: false, code: 'EMPTY_QUEUE' } })
    const s = sandboxFinta()
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'coda-vuota' })
    // Il conto di una MicroVM aperta per niente è piccolo; quello di 1.440 MicroVM
    // aperte per niente ogni giorno no.
    expect(s.nomi).toEqual([])
    expect(c.falliti).toEqual([])
  })

  it('presa rifiutata: nessuna MicroVM, e nessuna scrittura su un job che non è nostro', async () => {
    const c = codaFinta({ prossimo: { ok: false, code: 'LEASE_ACTIVE' } })
    const s = sandboxFinta()
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'presa-rifiutata', codice: 'LEASE_ACTIVE' })
    expect(s.nomi).toEqual([])
    // ⚠️ `video_job_fail` senza lease risponderebbe LEASE_MISMATCH: chiamarla
    // sarebbe rumore, e su un job di qualcun altro.
    expect(c.falliti).toEqual([])
  })
})

describe('runner video · il percorso felice', () => {
  it('converte, verifica e scrive l’esito — nell’ordine giusto', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // La MicroVM porta il fence del tentativo corrente.
    expect(s.nomi).toEqual([nomeSandboxVideo(JOB_ID, 5)])
    // Un solo avvio staccato: la conversione. Tutto il resto è sincrono e corto.
    expect(s.avviati).toHaveLength(1)
    // E si spegne: una MicroVM dimenticata accesa si paga a `GB × ore`.
    expect(s.fermate()).toBe(1)
    expect(c.falliti).toEqual([])
  })

  it('`video_job_ready` riceve il probe della SORGENTE, non quello dell’uscita', async () => {
    // ⚠️ Il trabocchetto, e costa una conversione intera. `video_jobs_probe_chk`
    // pretende `durationSeconds <= 180`, che è il limite dell'INGRESSO; l'uscita
    // AAC può legittimamente superarlo di qualche millisecondo (lo dice
    // `verifyVideoOutput`). Mandare l'uscita farebbe rispondere `BAD_INPUT` DOPO
    // aver pagato la codifica, e solo sui video lunghi — cioè in produzione.
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(c.pronti).toHaveLength(1)
    const scritto = c.pronti[0] as { probe: { durationSeconds: number }; percorsoUscita: string }
    expect(scritto.probe.durationSeconds).toBe(DURATA_SORGENTE)
    expect(scritto.probe.durationSeconds).toBeLessThanOrEqual(180)
    expect(scritto.percorsoUscita).toBe(
      percorsoUscitaVideo({ id: JOB_ID, owner_id: OWNER, fence_epoch: 5 }),
    )
  })

  it('nessun URL firmato finisce fra gli ARGOMENTI di un comando', async () => {
    // Un URL firmato porta un JWT: fra gli argomenti sarebbe leggibile con un `ps`
    // dentro la MicroVM e comparirebbe nella console di Vercel accanto al comando.
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    const tutti = [...s.eseguiti, ...s.avviati]
    expect(tutti.length).toBeGreaterThan(2)
    for (const comando of tutti) {
      expect(comando.args.join(' ')).not.toMatch(/token=/)
      expect(comando.args.join(' ')).not.toMatch(/https?:\/\/esempio\.invalid/)
    }
    // …e almeno un comando GLI URL CE LI HA, nell'ambiente: il controllo qui sopra
    // non sta passando perché non c'è niente da trovare.
    const conUrl = tutti.filter((comando) =>
      Object.values(comando.env ?? {}).some((v) => v.includes('token=')),
    )
    expect(conUrl.length).toBeGreaterThanOrEqual(2)
  })

  it('gli argomenti di FFmpeg viaggiano nell’array, mai in una riga di shell', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    // Il filtergraph della Galleria contiene già degli apici singoli: appiattirlo in
    // una stringa vorrebbe dire inventarsi un quoting, e un quoting inventato salta
    // sul caso strano, cioè in produzione.
    const scrittura = s.eseguiti.find((cmd) => cmd.args.some((a) => a.includes('-filter_complex')))
    expect(scrittura).toBeDefined()
    expect(scrittura?.args.some((a) => a.includes("overlay=x='(main_w-overlay_w)/2'"))).toBe(true)
  })
})

describe('runner video · i modi di fallire, uno per uno', () => {
  async function fallisciCon(risposta: Copione['risposta']) {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))
    return { esito, c, s }
  }

  it('lo SHA che non torna: si ferma lì, senza convertire — e il job si ritenta, riscaricando', async () => {
    const { esito, c, s } = await fallisciCon((cmd) =>
      cmd.args.join(' ').includes('===INVENTARIO===')
        ? { exitCode: 22, stdout: '', stderr: "sha256sum: WARNING: 1 computed checksum did NOT match" }
        : OK,
    )

    // Un'impronta che non torna è un guasto NOSTRO (la fonte è il nostro bucket): un trasferimento
    // troncato, non più una release pubblica cambiata sotto i piedi. Si ritenta — e il binario che
    // non ha superato le due verifiche non si esegue mai (lo prova `video-runner-preparazione-shell`).
    expect(esito).toEqual({
      esito: 'in-riprova',
      jobId: JOB_ID,
      codice: 'BUILD_HASH_MISMATCH',
      tentativo: 1,
      attesaS: 300,
    })
    // ⚠️ L'asserzione che vale il caso: NIENTE è stato avviato. Riprovare a eseguire
    // un binario che non è quello atteso è peggio che fermarsi.
    expect(s.avviati).toEqual([])
    expect(s.fermate()).toBe(1)
    expect(c.ritentati).toHaveLength(1)
    // Rimesso in coda, NON chiuso: `video_job_fail` renderebbe definitivo un guasto che passa.
    expect(c.falliti).toEqual([])
  })

  it('…ma al quarto tentativo i tentativi sono finiti: il job si chiude, e il codice è lo stesso', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ attempt: 4 }) } })
    const s = sandboxFinta({
      risposta: (cmd) =>
        cmd.args.join(' ').includes('===INVENTARIO===')
          ? { exitCode: 22, stdout: '', stderr: 'sha256sum: WARNING: 1 computed checksum did NOT match' }
          : OK,
    })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({
      esito: 'fallito',
      jobId: JOB_ID,
      codice: 'BUILD_HASH_MISMATCH',
      rifiutato: false,
    })
    expect(s.avviati).toEqual([])
    expect(c.ritentati).toEqual([])
    expect(c.falliti).toHaveLength(1)
  })

  it('una build a cui manca `zscale` non parte: il guasto si vedrebbe solo sul primo HDR', async () => {
    const senzaZscale = uscitaApparecchio().replace(/^ \.\. zscale.*$/m, '')
    const { esito, c, s } = await fallisciCon((cmd) => {
      const testo = cmd.args.join(' ')
      if (testo.includes('===INVENTARIO===')) {
        return { exitCode: 0, stdout: senzaZscale, stderr: '' }
      }
      return OK
    })

    // «Permanente» (una build che non sa fare ciò che serve non si ripara da sola) ma si ritenta
    // lo stesso, e il log lo grida: vedi «la classe di ogni punto» più sotto.
    expect(esito).toEqual({
      esito: 'in-riprova',
      jobId: JOB_ID,
      codice: 'BUILD_INCOMPLETE',
      tentativo: 1,
      attesaS: 300,
    })
    expect(s.avviati).toEqual([])
    expect(c.falliti).toEqual([])
  })

  it('un probe che non si lascia leggere è colpa del FILE: il job è respinto', async () => {
    const { esito } = await fallisciCon((cmd) =>
      cmd.args.join(' ').includes('===INVENTARIO===')
        ? {
            exitCode: 0,
            stdout: uscitaApparecchio(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })),
            stderr: '',
          }
        : OK,
    )

    expect(esito).toEqual({
      esito: 'fallito',
      jobId: JOB_ID,
      codice: 'MISSING_VIDEO_STREAM',
      // `rejected`: non è la nostra infrastruttura, è il video. Riprovare darebbe
      // lo stesso risultato, e la famiglia deve poterlo sapere.
      rifiutato: true,
    })
  })

  it('un’uscita che non passa la verifica non viene mai dichiarata pronta', async () => {
    const { esito, c } = await fallisciCon(
      rispostaFelice(
        // Un'uscita a 1280×720: `buildVideoEncodeArgs` non l'avrebbe mai prodotta a
        // partire da un 1920×1080, quindi qualcosa è andato storto in mezzo.
        marcatore({ probeOut: probeUscita().replace('"width":1920', '"width":1280') }),
      ),
    )

    expect(esito).toMatchObject({ esito: 'fallito', rifiutato: true })
    expect(c.pronti).toEqual([])
  })

  it('la MicroVM che non si apre è un guasto NOSTRO, e il job si rimette in coda', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ apriFallisce: true })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({
      esito: 'in-riprova',
      jobId: JOB_ID,
      codice: 'SANDBOX_UNAVAILABLE',
      tentativo: 1,
      attesaS: 300,
    })
    // Non si è aperto niente, quindi niente da spegnere.
    expect(s.fermate()).toBe(0)
    expect(c.ritentati).toHaveLength(1)
    expect(c.falliti).toEqual([])
  })

  it('la conversione uscita male porta il suo codice, non un generico', async () => {
    const { esito } = await fallisciCon(
      rispostaFelice(marcatore({ uscita: USCITE_CONVERSIONE.caricamento })),
    )
    // Il caricamento dell'uscita è un guasto di rete (34): si ritenta, e il codice resta il suo.
    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'OUTPUT_UPLOAD_FAILED' })
  })
})

describe('runner video · quando il job smette di essere nostro', () => {
  it('lease persa: non si scrive NIENTE sul job, e la MicroVM si spegne', async () => {
    const c = codaFinta({
      prossimo: { ok: true, job: job() },
      battito: { ok: false, code: 'FENCE_MISMATCH' },
    })
    // Un marcatore che non compare mai: la sorveglianza arriva al primo battito.
    const s = sandboxFinta({
      risposta: (cmd) => {
        const testo = cmd.args.join(' ')
        if (testo.includes('esito.txt')) return { exitCode: 1, stdout: '', stderr: '' }
        if (testo.includes('===INVENTARIO===')) {
          return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
        }
        return OK
      },
    })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'lease-persa', jobId: JOB_ID, codice: 'FENCE_MISMATCH' })
    // ⚠️ Il punto del fencing: un worker che ha perso la lease NON scrive l'esito.
    // `video_job_fail` risponderebbe comunque `FENCE_MISMATCH`, ma provarci
    // significherebbe non aver capito di chi è il job.
    expect(c.falliti).toEqual([])
    expect(c.pronti).toEqual([])
    expect(s.fermate()).toBe(1)
  })
})

describe('runner video · la conversione che dura più di un’invocazione', () => {
  it('finito il tempo, si lascia tutto acceso e si torna dopo', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({
      risposta: (cmd) => {
        const testo = cmd.args.join(' ')
        if (testo.includes('esito.txt')) return { exitCode: 1, stdout: '', stderr: '' }
        if (testo.includes('===INVENTARIO===')) {
          return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
        }
        return OK
      },
    })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'in-corso', jobId: JOB_ID })
    // ⚠️ La MicroVM NON si spegne: è lì che sta girando la conversione.
    expect(s.fermate()).toBe(0)
    expect(c.pronti).toEqual([])
    expect(c.falliti).toEqual([])
    // E la lease è stata tenuta viva fin qui, altrimenti il tick dopo non potrebbe
    // riprendere (`video_job_next` non restituisce un `processing` con lease valida).
    expect(c.battiti()).toBeGreaterThanOrEqual(3)
  })

  it('il tick successivo RIPRENDE lo stesso Sandbox invece di rifare tutto', async () => {
    const inCorso = job({ fence_epoch: 5 })
    const c = codaFinta({ miei: [inCorso] })
    const s = sandboxFinta({ nuova: false, risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // Stesso fence ⇒ stesso nome ⇒ `Sandbox.get` riaggancia la MicroVM che sta già
    // convertendo. È l'unica ragione per cui il fence sta nel nome.
    expect(s.nomi).toEqual([nomeSandboxVideo(JOB_ID, 5)])
    expect(c.riprese).toEqual([JOB_ID])
    // ⚠️ Non si riapparecchia e non si riavvia: la build c'è già e la conversione
    // sta girando. Rifare l'apparecchio significherebbe riscaricare FFmpeg sopra un
    // `ffmpeg` in esecuzione; riavviare, due codifiche sullo stesso file.
    expect(s.avviati).toEqual([])
    expect(s.eseguiti.every((cmd) => cmd.args.join(' ').includes('esito.txt'))).toBe(true)
  })

  it('se la MicroVM è morta nel frattempo, si riparte da capo invece di aspettare a vuoto', async () => {
    const inCorso = job({ fence_epoch: 5 })
    const c = codaFinta({ miei: [inCorso] })
    // `nuova: true` su una ripresa = il Sandbox non c'era più e ne è nato uno vuoto.
    const s = sandboxFinta({ nuova: true, risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // Apparecchio rifatto e conversione riavviata: altrimenti si sorveglierebbe un
    // marcatore che nessuno scriverà più, fino al tetto dell'invocazione, per sempre.
    expect(s.avviati).toHaveLength(1)
  })

  it('un job da riprendere ha la precedenza su uno nuovo', async () => {
    const c = codaFinta({ miei: [job({ fence_epoch: 5 })], prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ nuova: false, risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    // Prendere un job nuovo mentre uno è a metà vorrebbe dire due MicroVM aperte e
    // la prima conversione abbandonata a scadere.
    expect(c.riprese).toEqual([JOB_ID])
    expect(s.avviati).toEqual([])
  })
})

describe('runner video · la consegna a News', () => {
  /*
   * Perché questi quattro casi esistono: fino al 2026-09-18
   * `consegnaVideoInBozzaNews` non aveva NESSUN chiamante fuori dai test. L'editor
   * delle comunicazioni scrive nell'articolo un link deterministico a
   * `news_bozze/uploads/<proprietario>/<job>.mp4`, e senza la consegna quel link
   * punta a un file che non c'è. Il guasto non si ferma lì: `promuoviMediaBozza`
   * legge il «not found» dello Storage come «già promosso» e scrive nella riga
   * l'indirizzo pubblico di un oggetto inesistente — un video rotto per le
   * famiglie, scritto in silenzio.
   */

  it('per il canale `news` consegna l’uscita, DOPO che il database ha accettato il pronto', async () => {
    const ordine: string[] = []
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    const codaSpiata = {
      ...c.coda,
      pronto: async (...a: Parameters<typeof c.coda.pronto>) => {
        ordine.push('pronto')
        return c.coda.pronto(...a)
      },
    }
    const s = sandboxFinta({ risposta: rispostaFelice() })
    const consegnati: { jobId: string; bucket: string; percorso: string }[] = []

    const esito = await eseguiUnJobVideo(
      dipendenze(codaSpiata, s.macchina, {
        consegnaNews: async (j, percorso, bucket) => {
          ordine.push('consegna')
          consegnati.push({ jobId: j.id, bucket, percorso })
          return { ok: true }
        },
      }),
    )

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    // L'ORDINE è la cosa da provare: consegnare prima del `ready` lascerebbe
    // nell'area di sosta l'uscita di un job che il database non ha mai accettato.
    expect(ordine).toEqual(['pronto', 'consegna'])
    expect(consegnati).toHaveLength(1)
    expect(consegnati[0].bucket).toBe('video_processing')
  })

  it('per la Galleria NON consegna niente: quel canale copia per conto suo, dal finalizer', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'gallery' }) } })
    const s = sandboxFinta({ risposta: rispostaFelice() })
    let chiamate = 0

    await eseguiUnJobVideo(
      dipendenze(c.coda, s.macchina, {
        consegnaNews: async () => {
          chiamate += 1
          return { ok: true }
        },
      }),
    )

    expect(chiamate).toBe(0)
  })

  it('una consegna fallita NON annulla il pronto, ma si grida', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(
      dipendenze(c.coda, s.macchina, {
        consegnaNews: async () => ({ ok: false, codice: 'BUCKET_BOZZE_MANCANTE' }),
      }),
    )

    // La conversione è riuscita DAVVERO: dichiararla fallita vorrebbe dire rifarla da
    // capo — minuti di CPU pagati due volte — per un guasto di una copia.
    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
  })

  it('se la porta non è stata cablata lo dice a voce alta, invece di fingere', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    // `consegnaNews` assente: è la configurazione in cui il difetto è vissuto per due
    // giorni senza che nulla lo segnalasse.
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. LE FIRME DELLA BUILD
 * ════════════════════════════════════════════════════════════════════════════ */

/** Lancia un giro con un job preso dalla coda, e restituisce tutto ciò che serve a guardarlo. */
async function lancia(
  opzioni: {
    job?: Partial<JobVideo>
    archivio?: ArchivioVideo
    nuova?: boolean
    apriFallisce?: boolean
    risposta?: Copione['risposta']
    coda?: CopioneCoda
    orologio?: ReturnType<typeof orologioFinto>
  } = {},
) {
  const c = codaFinta({ prossimo: { ok: true, job: job(opzioni.job) }, ...opzioni.coda })
  const s = sandboxFinta({
    nuova: opzioni.nuova,
    apriFallisce: opzioni.apriFallisce,
    risposta: opzioni.risposta ?? rispostaFelice(),
  })
  const esito = await eseguiUnJobVideo(
    dipendenze(c.coda, s.macchina, {
      archivio: opzioni.archivio ?? archivio,
      ...(opzioni.orologio ? { orologio: opzioni.orologio } : {}),
    }),
  )
  return { esito, c, s }
}

/** Il comando dell'apparecchio: l'unico il cui script apre la sezione dell'inventario. */
const eApparecchio = (cmd: ComandoSandbox) => cmd.args.join(' ').includes('===INVENTARIO===')

describe('runner video · le firme dei due .gz della build', () => {
  it('con una MicroVM NUOVA si firmano quattro indirizzi; riagganciata, due', async () => {
    const nuova = archivioFinto()
    await lancia({ archivio: nuova.archivio })
    // L'originale, l'uscita, e i due `.gz`. Ci sono tutte e quattro perché la MicroVM è nuova.
    expect(nuova.firme).toHaveLength(4)
    expect(nuova.firme.filter((f) => f.tipo === 'lettura')).toHaveLength(3)
    expect(nuova.firme.filter((f) => f.tipo === 'scrittura')).toHaveLength(1)

    // Riagganciata: la conversione sta già girando, e la build non serve più a nessuno. Firmarla
    // a ogni tick metterebbe un punto di rottura nuovo sui riagganci delle conversioni lunghe.
    const riagganciata = archivioFinto()
    const c = codaFinta({ miei: [job()] })
    const s = sandboxFinta({ nuova: false, risposta: rispostaFelice() })
    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina, { archivio: riagganciata.archivio }))
    expect(riagganciata.firme).toHaveLength(2)
    expect(riagganciata.firme.some((f) => f.bucket === BUCKET_BUILD_VIDEO)).toBe(false)
  })

  it('i due .gz si firmano dal bucket `video_build`, coi percorsi della build e per 900 secondi', async () => {
    const { archivio: a, firme } = archivioFinto()
    await lancia({ archivio: a })

    expect(BUCKET_BUILD_VIDEO).toBe('video_build')
    expect(SECONDI_FIRMA_BUILD).toBe(900)
    // L'ordine non è un dettaglio: ffmpeg poi ffprobe, come l'apparecchio li consuma.
    expect(firme.filter((f) => f.bucket === BUCKET_BUILD_VIDEO)).toEqual([
      { tipo: 'lettura', bucket: 'video_build', percorso: PERCORSO_FFMPEG_GZ, secondi: 900 },
      { tipo: 'lettura', bucket: 'video_build', percorso: PERCORSO_FFPROBE_GZ, secondi: 900 },
    ])
    // L'originale, invece, vive quanto la conversione: due ore.
    expect(firme.find((f) => f.percorso === `${OWNER}/originale`)?.secondi).toBe(7200)
  })

  it('gli indirizzi della build entrano SOLO nell’env dell’apparecchio: mai in `avvia`, mai negli argomenti', async () => {
    const { s } = await lancia()

    const apparecchio = s.eseguiti.find(eApparecchio)
    expect(apparecchio).toBeDefined()
    // Ognuno nella SUA variabile: uno scambio fra i due scaricherebbe `ffprobe` come `ffmpeg`.
    expect(apparecchio?.env?.[ENV_URL_FFMPEG]).toContain(`/video_build/${PERCORSO_FFMPEG_GZ}?token=`)
    expect(apparecchio?.env?.[ENV_URL_FFPROBE]).toContain(`/video_build/${PERCORSO_FFPROBE_GZ}?token=`)

    // La conversione staccata ha i binari già pronti: un indirizzo in più sarebbe soltanto un
    // segreto in più da tenere lontano dai log.
    expect(s.avviati).toHaveLength(1)
    const env = s.avviati[0].env ?? {}
    expect(Object.keys(env)).not.toContain(ENV_URL_FFMPEG)
    expect(Object.keys(env)).not.toContain(ENV_URL_FFPROBE)
    for (const valore of Object.values(env)) expect(valore).not.toContain('video_build')

    // E nessun comando — eseguito o staccato — lo porta fra gli argomenti, dove un `ps` lo leggerebbe.
    for (const comando of [...s.eseguiti, ...s.avviati]) {
      expect(comando.args.join(' ')).not.toContain('video_build')
      expect(comando.args.join(' ')).not.toContain('token=')
      if (comando !== apparecchio) {
        expect(Object.keys(comando.env ?? {})).not.toContain(ENV_URL_FFMPEG)
      }
    }
  })

  it.each<[string, FirmaRifiutata, 'infra-permanente' | 'infra-transitoria']>([
    ['un oggetto che non c’è (NoSuchKey, anche con lo stato 400 dello Storage)', { motivo: 'Object not found', stato: 400, codiceStorage: 'NoSuchKey' }, 'infra-permanente'],
    ['un 4xx qualunque', { motivo: 'forbidden', stato: 403 }, 'infra-permanente'],
    ['un 5xx', { motivo: 'unavailable', stato: 503 }, 'infra-transitoria'],
    ['una rete caduta (nessuno stato)', { motivo: 'fetch failed' }, 'infra-transitoria'],
  ])('la firma di un .gz rifiutata — %s — non apre niente nella MicroVM', async (_nome, rifiuto, classe) => {
    const { archivio: a, firme } = archivioFinto({
      lettura: (bucket) => (bucket === BUCKET_BUILD_VIDEO ? rifiuto : null),
    })
    const { esito, c, s } = await lancia({ archivio: a })

    expect(esito).toEqual({ esito: 'in-riprova', jobId: JOB_ID, codice: 'BUILD_DOWNLOAD_FAILED', tentativo: 1, attesaS: 300 })
    // Nessun comando, nessuna conversione: la MicroVM si era aperta e si spegne subito.
    expect(s.eseguiti).toEqual([])
    expect(s.avviati).toEqual([])
    expect(s.fermate()).toBe(1)
    expect(c.ritentati).toHaveLength(1)
    expect(c.falliti).toEqual([])
    // La classe: un 4xx o un oggetto che manca non passano da soli (error), un 5xx o la rete sì (warn).
    const log = riga('conversione-da-riprovare')
    expect(log[1]).toBe(classe === 'infra-permanente' ? 'error' : 'warn')
    expect(log[2].tipo).toBe(classe)
    // Il rifiuto del primo `.gz` ferma lo scambio: il secondo non si firma nemmeno.
    expect(firme.filter((f) => f.bucket === BUCKET_BUILD_VIDEO)).toHaveLength(1)
  })

  it('anche il secondo .gz che non si firma ferma tutto, con la stessa classe', async () => {
    const { archivio: a } = archivioFinto({
      lettura: (_bucket, percorso) =>
        percorso === PERCORSO_FFPROBE_GZ ? { motivo: 'Object not found', stato: 404 } : null,
    })
    const { esito, s } = await lancia({ archivio: a })

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'BUILD_DOWNLOAD_FAILED' })
    expect(s.eseguiti).toEqual([])
    expect(riga('conversione-da-riprovare')[2].tipo).toBe('infra-permanente')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. LA CLASSE DI OGNI PUNTO IN CUI SI PUÒ FALLIRE (§4.5)
 * ════════════════════════════════════════════════════════════════════════════ */

const curlConStato = (stato: number): string =>
  Array.from({ length: 4 }, () => `curl: (22) The requested URL returned error: ${stato}`).join('\n')
const CURL_404 = 'curl: (22) The requested URL returned error: 404'
const CURL_TIMEOUT = 'curl: (28) Operation timed out after 60001 milliseconds with 0 bytes received'
const FFPROBE_RETE = '[tcp @ 0x55d1c0a3b2c0] Connection to tcp://esempio.invalid:443 failed: Connection refused'
const FFPROBE_FILE_ROTTO = 'moov atom not found'

/** Un apparecchio che esce con questo codice e questo stderr. */
const apparecchioCheEsce =
  (exitCode: number, stderr: string) =>
  (cmd: ComandoSandbox): EsitoComando =>
    eApparecchio(cmd) ? { exitCode, stdout: '', stderr } : OK

/** Un apparecchio riuscito che racconta un file con questo probe. */
const apparecchioConProbe =
  (probe: string) =>
  (cmd: ComandoSandbox): EsitoComando =>
    eApparecchio(cmd) ? { exitCode: 0, stdout: uscitaApparecchio(probe), stderr: '' } : OK

type ClasseAttesa = 'file' | 'non-ritentabile' | 'infra-transitoria' | 'infra-permanente'

interface Punto {
  nome: string
  opzioni: Parameters<typeof lancia>[0]
  codice?: string
  classe: ClasseAttesa
  /** Quante MicroVM si aprono (0 se il guasto è prima) e quante si spengono. */
  aperte: 0 | 1
  spente: 0 | 1
}

const ORIGINALE_RIFIUTATO = (r: FirmaRifiutata): Parameters<typeof lancia>[0] => ({
  archivio: archivioFinto({ lettura: (bucket) => (bucket !== BUCKET_BUILD_VIDEO ? r : null) }).archivio,
})
const BUILD_RIFIUTATA = (r: FirmaRifiutata): Parameters<typeof lancia>[0] => ({
  archivio: archivioFinto({ lettura: (bucket) => (bucket === BUCKET_BUILD_VIDEO ? r : null) }).archivio,
})
const CONVERSIONE_CON = (uscita: number, diagnosi: string): Parameters<typeof lancia>[0] => ({
  risposta: rispostaFelice(marcatore({ uscita, diagnosi })),
})

const PUNTI: Punto[] = [
  // ── Prima di aprire la MicroVM ──────────────────────────────────────────────
  { nome: 'firma dell’originale · 404', opzioni: ORIGINALE_RIFIUTATO({ motivo: 'Object not found', stato: 404 }), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 0, spente: 0 },
  { nome: 'firma dell’originale · 400 (come risponde lo Storage a un oggetto sparito)', opzioni: ORIGINALE_RIFIUTATO({ motivo: 'Object not found', stato: 400 }), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 0, spente: 0 },
  { nome: 'firma dell’originale · NoSuchKey', opzioni: ORIGINALE_RIFIUTATO({ motivo: 'gone', stato: 500, codiceStorage: 'NoSuchKey' }), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 0, spente: 0 },
  // La regola della BUILD (4xx permanente) NON vale per l'originale: un 403 o un 429 passano da soli.
  { nome: 'firma dell’originale · 403', opzioni: ORIGINALE_RIFIUTATO({ motivo: 'forbidden', stato: 403 }), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 0, spente: 0 },
  { nome: 'firma dell’originale · 429', opzioni: ORIGINALE_RIFIUTATO({ motivo: 'slow down', stato: 429 }), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 0, spente: 0 },
  { nome: 'firma dell’originale · nessuno stato (rete)', opzioni: ORIGINALE_RIFIUTATO({ motivo: 'fetch failed' }), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 0, spente: 0 },
  {
    nome: 'firma dell’uscita (anche con un 400)',
    opzioni: { archivio: archivioFinto({ scrittura: () => ({ motivo: 'boom', stato: 400 }) }).archivio },
    codice: 'OUTPUT_UPLOAD_FAILED',
    classe: 'infra-transitoria',
    aperte: 0,
    spente: 0,
  },
  { nome: 'apertura della MicroVM', opzioni: { apriFallisce: true }, codice: 'SANDBOX_UNAVAILABLE', classe: 'infra-transitoria', aperte: 1, spente: 0 },

  // ── La firma della build, con la MicroVM già aperta ─────────────────────────
  { nome: 'firma della build · NoSuchKey', opzioni: BUILD_RIFIUTATA({ motivo: 'Object not found', stato: 400, codiceStorage: 'NoSuchKey' }), codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'firma della build · 4xx', opzioni: BUILD_RIFIUTATA({ motivo: 'forbidden', stato: 403 }), codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'firma della build · 5xx', opzioni: BUILD_RIFIUTATA({ motivo: 'unavailable', stato: 503 }), codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'firma della build · rete', opzioni: BUILD_RIFIUTATA({ motivo: 'fetch failed' }), codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },

  // ── Le uscite dell'apparecchio ──────────────────────────────────────────────
  { nome: 'apparecchio 21 · il download della build dà 404', opzioni: { risposta: apparecchioCheEsce(21, curlConStato(404)) }, codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'apparecchio 21 · il download della build dà 503', opzioni: { risposta: apparecchioCheEsce(21, curlConStato(503)) }, codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'apparecchio 21 · il download della build va in timeout', opzioni: { risposta: apparecchioCheEsce(21, CURL_TIMEOUT) }, codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'apparecchio 22 · un’impronta non torna', opzioni: { risposta: apparecchioCheEsce(22, 'f.gz: FAILED') }, codice: 'BUILD_HASH_MISMATCH', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'apparecchio 23 · i binari non si estraggono', opzioni: { risposta: apparecchioCheEsce(23, '') }, codice: 'BUILD_EXTRACT_FAILED', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'apparecchio 24 · la HEAD dell’originale dà 404', opzioni: { risposta: apparecchioCheEsce(24, curlConStato(404)) }, codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'apparecchio 24 · la HEAD dell’originale dà 400', opzioni: { risposta: apparecchioCheEsce(24, curlConStato(400)) }, codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'apparecchio 25 · ffprobe sull’URL con un errore di rete', opzioni: { risposta: apparecchioCheEsce(25, FFPROBE_RETE) }, codice: 'PROBE_COMMAND_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'apparecchio 25 · ffprobe sull’URL su un file illeggibile (D3)', opzioni: { risposta: apparecchioCheEsce(25, FFPROBE_FILE_ROTTO) }, codice: 'PROBE_COMMAND_FAILED', classe: 'non-ritentabile', aperte: 1, spente: 1 },
  { nome: 'apparecchio 1 · uscita imprevista', opzioni: { risposta: apparecchioCheEsce(1, '') }, codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'apparecchio 127 · comando non trovato', opzioni: { risposta: apparecchioCheEsce(127, 'sh: curl: not found') }, codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'apparecchio 137 · ucciso (il tetto di tempo)', opzioni: { risposta: apparecchioCheEsce(137, '') }, codice: 'BUILD_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },

  // ── Dopo l'apparecchio ──────────────────────────────────────────────────────
  {
    nome: 'inventario · manca `zscale`',
    opzioni: {
      risposta: (cmd) =>
        eApparecchio(cmd)
          ? { exitCode: 0, stdout: uscitaApparecchio().replace(/^ \.\. zscale.*$/m, ''), stderr: '' }
          : OK,
    },
    codice: 'BUILD_INCOMPLETE',
    classe: 'infra-permanente',
    aperte: 1,
    spente: 1,
  },
  { nome: 'probe del file · nessuno stream video', opzioni: { risposta: apparecchioConProbe(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })) }, codice: 'MISSING_VIDEO_STREAM', classe: 'file', aperte: 1, spente: 1 },
  {
    nome: 'geometria impossibile (meno di 2 px una volta rientrati nel Full HD)',
    opzioni: {
      risposta: apparecchioConProbe(probeSorgente().replace('"width":1920', '"width":1').replace('"coded_width":1920', '"coded_width":1')),
    },
    codice: 'ENCODE_FAILED',
    classe: 'file',
    aperte: 1,
    spente: 1,
  },
  {
    nome: 'scrittura degli argomenti nella MicroVM',
    opzioni: {
      risposta: (cmd) => {
        if (cmd.args.includes('kv-argomenti')) return { exitCode: 1, stdout: '', stderr: 'sh: cannot create /tmp/kv-video/argomenti: No space left on device' }
        return rispostaFelice()(cmd)
      },
    },
    codice: 'ENCODE_FAILED',
    classe: 'infra-transitoria',
    aperte: 1,
    spente: 1,
  },

  // ── Le uscite della conversione, lette dal marcatore ────────────────────────
  { nome: 'conversione 31 · lo scarico dell’originale dà 404', opzioni: CONVERSIONE_CON(31, CURL_404), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-permanente', aperte: 1, spente: 1 },
  { nome: 'conversione 31 · lo scarico dell’originale dà 503', opzioni: CONVERSIONE_CON(31, curlConStato(503)), codice: 'SOURCE_DOWNLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  { nome: 'conversione 34 · il caricamento dell’uscita va in timeout', opzioni: CONVERSIONE_CON(34, CURL_TIMEOUT), codice: 'OUTPUT_UPLOAD_FAILED', classe: 'infra-transitoria', aperte: 1, spente: 1 },
  // D3: un file che FFmpeg non sa convertire non si converte al tentativo dopo.
  { nome: 'conversione 32 · FFmpeg esce con un errore', opzioni: CONVERSIONE_CON(32, 'Conversion failed!'), codice: 'ENCODE_FAILED', classe: 'non-ritentabile', aperte: 1, spente: 1 },
  { nome: 'conversione 33 · ffprobe sull’uscita', opzioni: CONVERSIONE_CON(33, 'moov atom not found'), codice: 'PROBE_COMMAND_FAILED', classe: 'non-ritentabile', aperte: 1, spente: 1 },
  { nome: 'conversione 137 · uscita che non conosciamo (un SIGKILL)', opzioni: CONVERSIONE_CON(137, ''), codice: 'ENCODE_FAILED', classe: 'non-ritentabile', aperte: 1, spente: 1 },
  {
    nome: 'conversione · il probe della sorgente nel marcatore non si legge',
    opzioni: { risposta: rispostaFelice(marcatore({ probeIn: JSON.stringify({ streams: [], format: { format_name: 'mp4' } }) })) },
    codice: 'MISSING_VIDEO_STREAM',
    classe: 'file',
    aperte: 1,
    spente: 1,
  },
  {
    nome: 'conversione · l’uscita non passa la verifica',
    opzioni: { risposta: rispostaFelice(marcatore({ probeOut: probeUscita().replace('"width":1920', '"width":1280') })) },
    classe: 'file',
    aperte: 1,
    spente: 1,
  },
]

describe('runner video · la classe di ogni punto in cui si può fallire', () => {
  it('la tabella copre ogni classe, e ogni punto del §4.5 ha la sua riga', () => {
    // Non è un controllo cosmetico: una classe che nessun punto esercita è una classe di cui non si
    // sa se il runner la tratta come promesso.
    expect(new Set(PUNTI.map((p) => p.classe))).toEqual(
      new Set<ClasseAttesa>(['file', 'non-ritentabile', 'infra-transitoria', 'infra-permanente']),
    )
    expect(PUNTI.length).toBeGreaterThanOrEqual(30)
  })

  it.each(PUNTI)('$nome → $classe', async (punto) => {
    const { esito, c, s } = await lancia(punto.opzioni)

    // La MicroVM: quante se ne aprono (il guasto è prima o dopo) e se si spengono.
    expect(s.nomi).toHaveLength(punto.aperte)
    expect(s.fermate()).toBe(punto.spente)

    if (punto.classe === 'file' || punto.classe === 'non-ritentabile') {
      // Si chiude subito, e mai si ritenta: `file` col job rifiutato, `non-ritentabile` no.
      const rifiutato = punto.classe === 'file'
      expect(esito).toMatchObject({
        esito: 'fallito',
        jobId: JOB_ID,
        ...(punto.codice ? { codice: punto.codice } : {}),
        rifiutato,
      })
      expect(c.falliti).toHaveLength(1)
      expect(c.falliti[0]).toMatchObject({
        jobId: JOB_ID,
        fenceEpoch: 5,
        leaseOwner: WORKER,
        ...(punto.codice ? { codice: punto.codice } : {}),
        rifiutato,
      })
      expect(c.ritentati).toEqual([])
      const log = riga('conversione-fallita')
      expect(log[1]).toBe('error')
      expect(log[2].tipo).toBe(punto.classe)
      expect(log[2].rifiutato).toBe(rifiutato)
      return
    }

    // Guasto NOSTRO: rimesso in coda con la prima attesa, mai chiuso.
    expect(esito).toEqual({
      esito: 'in-riprova',
      jobId: JOB_ID,
      codice: punto.codice,
      tentativo: 1,
      attesaS: 300,
    })
    expect(c.ritentati).toEqual([
      {
        jobId: JOB_ID,
        fenceEpoch: 5,
        leaseOwner: WORKER,
        codice: punto.codice,
        tentativiMassimi: 4,
        attesaSecondi: 300,
      },
    ])
    expect(c.falliti).toEqual([])
    // «Permanente» descrive la causa: si ritenta lo stesso, ma la riga grida (error) invece di avvisare (warn).
    const log = riga('conversione-da-riprovare')
    expect(log[1]).toBe(punto.classe === 'infra-permanente' ? 'error' : 'warn')
    expect(log[2].tipo).toBe(punto.classe)
    expect(log[2].error_code).toBe(punto.codice)
    // …e non c'è nessun fallimento definitivo da nessuna parte.
    expect(conEsito('conversione-fallita')).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 5. LA SCALA DEI RITENTATIVI
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · la scala dei ritentativi: 5, 10, 15 minuti, poi basta', () => {
  it.each([
    [1, 300],
    [2, 600],
    [3, 900],
  ])('al tentativo %i un guasto nostro si rimette in coda, e il prossimo parte fra %i secondi', async (attempt, attesa) => {
    const { esito, c } = await lancia({ job: { attempt }, apriFallisce: true })

    expect(esito).toEqual({
      esito: 'in-riprova',
      jobId: JOB_ID,
      codice: 'SANDBOX_UNAVAILABLE',
      tentativo: attempt,
      attesaS: attesa,
    })
    expect(c.ritentati).toHaveLength(1)
    expect(c.ritentati[0]).toMatchObject({ tentativiMassimi: 4, attesaSecondi: attesa })
    expect(c.falliti).toEqual([])
    // Quattro tentativi in tutto, e il database ne conosce il tetto: lo riceve ogni volta.
    expect(riga('conversione-da-riprovare')[2]).toMatchObject({ tentativi_massimi: 4, attesa_s: attesa })
  })

  it.each([4, 5, 12])('al tentativo %i i tentativi sono finiti: `video_job_fail`, mai un altro ritentativo', async (attempt) => {
    const { esito, c } = await lancia({ job: { attempt }, apriFallisce: true })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    expect(c.ritentati).toEqual([])
    expect(c.falliti).toHaveLength(1)
    expect(c.falliti[0]).toMatchObject({ codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    // Il log lo dice: è un fallimento DEFINITIVO per tentativi esauriti, di un guasto nostro.
    const log = riga('conversione-fallita')
    expect(log[1]).toBe('error')
    expect(log[2]).toMatchObject({ tipo: 'infra-transitoria', tentativi_esauriti: true, rifiutato: false })
    expect(conEsito('conversione-da-riprovare')).toEqual([])
  })

  it.each([0, -1, Number.NaN])('un `attempt` illeggibile (%s) fallisce chiuso, senza essere spacciato per «esauriti»', async (attempt) => {
    const { esito, c } = await lancia({ job: { attempt }, apriFallisce: true })

    expect(esito).toMatchObject({ esito: 'fallito', codice: 'SANDBOX_UNAVAILABLE' })
    expect(c.ritentati).toEqual([])
    expect(c.falliti).toHaveLength(1)
    expect(riga('conversione-fallita')[2]).not.toHaveProperty('tentativi_esauriti')
  })

  it('un guasto del file o non ritentabile non si ritenta a NESSUN tentativo', async () => {
    for (const attempt of [1, 2, 3]) {
      h.log.length = 0
      const file = await lancia({
        job: { attempt },
        risposta: apparecchioConProbe(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })),
      })
      expect(file.c.ritentati, `file, tentativo ${attempt}`).toEqual([])
      expect(file.c.falliti, `file, tentativo ${attempt}`).toHaveLength(1)

      const nonRitentabile = await lancia({ job: { attempt }, ...CONVERSIONE_CON(32, 'Conversion failed!') })
      expect(nonRitentabile.c.ritentati, `non ritentabile, tentativo ${attempt}`).toEqual([])
      expect(nonRitentabile.c.falliti, `non ritentabile, tentativo ${attempt}`).toHaveLength(1)
    }
  })

  it('un video che riesce dopo un ritentativo lo dice (`ritentato`), e non si somma ai riusciti al primo colpo', async () => {
    const primo = await lancia({ job: { attempt: 1 } })
    expect(primo.esito).toMatchObject({ esito: 'pronto' })
    const riuscitoAlPrimo = riga('video-convertito')
    expect(riuscitoAlPrimo[2].ritentato).toBe(false)

    h.log.length = 0
    const secondo = await lancia({ job: { attempt: 2 } })
    expect(secondo.esito).toMatchObject({ esito: 'pronto' })
    const riuscitoDopo = riga('video-convertito')
    expect(riuscitoDopo[2].ritentato).toBe(true)

    // Il campo entra nell'impronta: i due casi dello stesso giorno restano due righe in `app_log`.
    expect(riuscitoAlPrimo[4]?.distingui).toEqual(['ritentato'])
    expect(comeInTabella(riuscitoAlPrimo).bersaglio).toBe('ritentato=false')
    expect(comeInTabella(riuscitoDopo).bersaglio).toBe('ritentato=true')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 6. LA RISPOSTA DEL DATABASE A UN RITENTATIVO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · che cosa dice `video_job_retry`, e che cosa se ne fa', () => {
  const GUASTO = { apriFallisce: true } as const

  it('`ok` con il job in coda: è `in-riprova`, e non si scrive nessun fallimento', async () => {
    const { esito, c } = await lancia({ ...GUASTO })
    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SANDBOX_UNAVAILABLE' })
    expect(c.falliti).toEqual([])
  })

  it('`ok` ma il job è `failed`: il database ha già delegato al fallimento, e non si richiama `video_job_fail`', async () => {
    const { esito, c } = await lancia({
      ...GUASTO,
      coda: { riprova: { ok: true, job: job({ status: 'failed' }) } },
    })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    expect(c.ritentati).toHaveLength(1)
    // ⚠️ Il fallimento è GIÀ scritto: richiamare `video_job_fail` darebbe un doppio o un `ERROR_CONFLICT`.
    expect(c.falliti).toEqual([])
    // Si racconta come definitivo, perché lo è.
    const log = riga('conversione-fallita')
    expect(log[1]).toBe('error')
    expect(log[2]).toMatchObject({ tipo: 'infra-transitoria', tentativi_esauriti: true })
    expect(conEsito('conversione-da-riprovare')).toEqual([])
  })

  it('`RPC_ERROR` (la chiamata non è arrivata, o la migrazione non è applicata): ripiego su `video_job_fail`', async () => {
    const { esito, c } = await lancia({ ...GUASTO, coda: { riprova: { ok: false, code: 'RPC_ERROR' } } })

    // Senza il ripiego il job resterebbe `processing` e una MicroVM ripartirebbe ogni cinque minuti,
    // per giorni, su un guasto che nessuno ha scritto da nessuna parte.
    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    expect(c.ritentati).toHaveLength(1)
    expect(c.falliti).toHaveLength(1)
    expect(c.falliti[0]).toMatchObject({ codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    // Il ripiego si vede: prima «non ho potuto riprovare», poi il fallimento col suo motivo.
    expect(riga('riprova-non-scritta')[1]).toBe('error')
    expect(riga('riprova-non-scritta')[2].error_code).toBe('RPC_ERROR')
    expect(riga('conversione-fallita')[1]).toBe('error')
    expect(riga('conversione-fallita')[2]).not.toHaveProperty('tentativi_esauriti')
    expect(conEsito('conversione-da-riprovare')).toEqual([])
  })

  it.each(['FENCE_MISMATCH', 'LEASE_MISMATCH', 'LEASE_EXPIRED', 'INVALID_STATE', 'NOT_FOUND', 'INTENT_CHANGED_RETRY'])(
    'un VERDETTO del database (%s): il job non è più nostro, e non si scrive niente',
    async (code) => {
      const { esito, c } = await lancia({ ...GUASTO, coda: { riprova: { ok: false, code } } })

      expect(esito).toEqual({ esito: 'lease-persa', jobId: JOB_ID, codice: code })
      expect(c.ritentati).toHaveLength(1)
      // ⚠️ Come per un battito rifiutato: `video_job_fail` risponderebbe comunque il suo verdetto, ma
      // provarci vorrebbe dire non aver capito di chi è il job. Solo `RPC_ERROR` ripiega.
      expect(c.falliti).toEqual([])
      const log = riga('riprova-rifiutata')
      expect(log[1]).toBe('warn')
      expect(log[2].error_code).toBe(code)
      expect(conEsito('conversione-fallita')).toEqual([])
      expect(conEsito('riprova-non-scritta')).toEqual([])
    },
  )

  it('con un verdetto la diagnosi del tentativo NON si butta: resta nel log, in coda', async () => {
    const { c } = await lancia({
      risposta: apparecchioCheEsce(21, `${'riga di dnf\n'.repeat(80)}${CURL_404}`),
      coda: { riprova: { ok: false, code: 'FENCE_MISMATCH' } },
    })

    expect(c.falliti).toEqual([])
    expect(comeInTabella(riga('riprova-rifiutata')).messaggio.endsWith(CURL_404)).toBe(true)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 7. I LOG
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · i log di un ritentativo', () => {
  /** Lo stderr com'era nei 17 job del 29/09: tanto dnf, e il motivo vero — il 404 — in fondo. */
  const STDERR_DNF_E_404 = `INIZIO-DI-DNF\n${'Amazon Linux 2023 repository                     84 MB/s |  76 MB     00:00\n'.repeat(20)}${curlConStato(404)}`

  it('`conversione-da-riprovare` porta classe, tentativi, attesa, stato HTTP e la CODA dell’errore', async () => {
    await lancia({ risposta: apparecchioCheEsce(21, STDERR_DNF_E_404) })

    const log = riga('conversione-da-riprovare')
    const [evento, livello, campi, , opzioni] = log
    expect(evento).toBe('galleria')
    // Il 404 sul bucket nostro non passa da solo: error, non warn.
    expect(livello).toBe('error')
    expect(campi).toMatchObject({
      operazione: 'video-runner',
      esito: 'conversione-da-riprovare',
      error_code: 'BUILD_DOWNLOAD_FAILED',
      tipo: 'infra-permanente',
      tentativi_massimi: 4,
      attesa_s: 300,
      http: 404,
      job_id: JOB_ID,
      attempt: 1,
    })
    expect(opzioni?.distingui).toEqual(['job_id', 'attempt'])

    // ⚠️ Ciò che finisce in `app_log.messaggio`: la RIGA DEL 404, in fondo, dentro i 500 caratteri.
    // Fino al 2026-10-02 si salvava l'inizio e di queste righe ne restava soltanto l'output di dnf.
    const nellaTabella = comeInTabella(log)
    expect(nellaTabella.messaggio.length).toBeLessThanOrEqual(MESSAGGIO_MAX)
    expect(nellaTabella.messaggio.endsWith(CURL_404)).toBe(true)
    // L'INIZIO dello stderr — ciò che il vecchio `slice(0, 1000)` conservava — è ciò che si è tagliato.
    expect(nellaTabella.messaggio).not.toContain('INIZIO-DI-DNF')
    expect(nellaTabella.messaggio.startsWith('…')).toBe(true)
    expect(nellaTabella.codice).toBe('BUILD_DOWNLOAD_FAILED')
  })

  it('un guasto transitorio avvisa (`warn`) e lo stato HTTP è quello del 503', async () => {
    await lancia({ risposta: apparecchioCheEsce(21, curlConStato(503)) })

    const log = riga('conversione-da-riprovare')
    expect(log[1]).toBe('warn')
    expect(log[2]).toMatchObject({ tipo: 'infra-transitoria', http: 503 })
  })

  it('senza uno stato HTTP il campo `http` non c’è: un campo nullo non dice niente', async () => {
    await lancia({ apriFallisce: true })
    expect(riga('conversione-da-riprovare')[2]).not.toHaveProperty('http')
  })

  it('i tentativi dello stesso job restano righe DIVERSE in `app_log`, e due job pure', async () => {
    // `app_log` deduplica per (impronta, giorno) e somma i casi dopo il primo SENZA aggiornare il
    // contesto: dieci job caduti per la stessa causa lo stesso giorno sarebbero una riga sola,
    // col job del primo. `distingui` mette job e tentativo nell'impronta.
    await lancia({ job: { attempt: 1 }, apriFallisce: true })
    const primo = comeInTabella(riga('conversione-da-riprovare'))
    h.log.length = 0
    await lancia({ job: { attempt: 2 }, apriFallisce: true })
    const secondo = comeInTabella(riga('conversione-da-riprovare'))
    h.log.length = 0
    await lancia({ job: { attempt: 1, id: '7a1b2c3d-0e4f-4a5b-8c6d-9e0f1a2b3c4d' }, apriFallisce: true })
    const altroJob = comeInTabella(riga('conversione-da-riprovare'))

    expect(primo.bersaglio).toBe(`job_id=${JOB_ID};attempt=1`)
    expect(secondo.bersaglio).toBe(`job_id=${JOB_ID};attempt=2`)
    expect(altroJob.bersaglio).toBe('job_id=7a1b2c3d-0e4f-4a5b-8c6d-9e0f1a2b3c4d;attempt=1')
    // Stesso messaggio, stessa classe, stesso giorno: ciò che li separa è il bersaglio.
    expect(primo.messaggio).toBe(secondo.messaggio)
    expect(new Set([primo.bersaglio, secondo.bersaglio, altroJob.bersaglio]).size).toBe(3)
  })

  it('anche il fallimento definitivo distingue per tentativo', async () => {
    await lancia({ job: { attempt: 4 }, apriFallisce: true })
    expect(comeInTabella(riga('conversione-fallita')).bersaglio).toBe(`job_id=${JOB_ID};attempt=4`)
  })

  it('i campi nuovi escono IN CHIARO dalla lista bianca di `redact`, non redatti', async () => {
    await lancia({ risposta: apparecchioCheEsce(21, curlConStato(404)) })

    const campi = (comeInTabella(riga('conversione-da-riprovare')).contestoExtra as { campi: Record<string, unknown> }).campi
    expect(campi).toMatchObject({
      esito: 'conversione-da-riprovare',
      error_code: 'BUILD_DOWNLOAD_FAILED',
      tipo: 'infra-permanente',
      tentativi_massimi: 4,
      attesa_s: 300,
      http: 404,
    })
    // Nessun valore redatto fra quelli che il codice ha dichiarato.
    for (const [chiave, valore] of Object.entries(campi)) {
      expect(String(valore), `campo ${chiave}`).not.toMatch(/^\[redatto/)
    }
  })

  it('nei log non entra MAI un URL firmato né un token, neanche se lo stderr ne è pieno', async () => {
    const stderr = [
      'curl: (22) The requested URL returned error: 403 for https://esempio.invalid/storage/video_build/x.gz?token=segreto-che-non-va-loggato',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwcm92YSJ9.c2lnbmF0dXJhLWZpbnRh',
      'apikey=sb_secret_FINTA0123',
    ].join('\n')
    await lancia({ risposta: apparecchioCheEsce(21, stderr) })
    expect(righeDiLog().length).toBeGreaterThan(0)

    const tutto = righeDiLog()
      .map((r) => JSON.stringify([r[2], comeInTabella(r).messaggio]))
      .join('\n')
    for (const segreto of ['token=', 'esempio.invalid', 'eyJ', 'sb_secret', 'segreto-che-non-va-loggato']) {
      expect(tutto).not.toContain(segreto)
    }
    // …ma il MOTIVO resta leggibile.
    expect(tutto).toContain('returned error: 403')
  })

  it('una News ritentata scrive sotto `news`, la Galleria sotto `galleria`', async () => {
    await lancia({ job: { channel: 'news' }, apriFallisce: true })
    expect(riga('conversione-da-riprovare')[0]).toBe('news')

    h.log.length = 0
    await lancia({ job: { channel: 'gallery' }, apriFallisce: true })
    expect(riga('conversione-da-riprovare')[0]).toBe('galleria')
  })

  describe('`build-pronta`, il battito del percorso che si era rotto', () => {
    it('con una MicroVM nuova: una riga `info`, col tempo dell’apparecchio', async () => {
      const orologio = orologioFinto()
      await lancia({
        orologio,
        risposta: (cmd) => {
          // F1 ha misurato 8,3 secondi per l'apparecchio intero.
          if (eApparecchio(cmd)) orologio.avanza(8300)
          return rispostaFelice()(cmd)
        },
      })

      const log = riga('build-pronta')
      expect(log[1]).toBe('info')
      expect(log[2]).toMatchObject({ operazione: 'video-runner', ms: 8300, job_id: JOB_ID })
    })

    it('riagganciata: nessuna riga, perché la build non si è provvista', async () => {
      const c = codaFinta({ miei: [job()] })
      const s = sandboxFinta({ nuova: false, risposta: rispostaFelice() })
      await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))
      expect(conEsito('build-pronta')).toEqual([])
    })

    it('se la provvista fallisce non c’è: un battito che dice «la build arriva» solo quando arriva', async () => {
      await lancia({ risposta: apparecchioCheEsce(21, curlConStato(503)) })
      expect(conEsito('build-pronta')).toEqual([])
    })

    it('se la build è incompleta nemmeno: pronta vuol dire utilizzabile', async () => {
      await lancia({
        risposta: (cmd) =>
          eApparecchio(cmd)
            ? { exitCode: 0, stdout: uscitaApparecchio().replace(/^ \.\. zscale.*$/m, ''), stderr: '' }
            : OK,
      })
      expect(conEsito('build-pronta')).toEqual([])
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 8. LA CODA DELL'ERRORE CHE ARRIVA NEL LOG
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · la riga del 404 sopravvive a tutto ciò che sta fra lo stderr e `app_log.messaggio`', () => {
  /**
   * IL DIFETTO #9, riprodotto. `sanificaMessaggio` TAGLIA TENENDO L'INIZIO (oltre 500 battute butta
   * la fine) ma prima MASCHERA, e mascherare ALLUNGA: `[email]` è una battuta più di un'email di
   * sei, `"[valore]"` ne aggiunge sette a un valore di una. Una coda tagliata a 499 battute PRIMA di
   * sanificarla, con qualche email corta e qualche valore fra virgolette dentro, ne usciva di
   * 513 — e il taglio finale buttava la fine: la riga del 404, cioè proprio il motivo.
   *
   * La diagnosi qui sotto è lunga 496 battute (entra INTERA nella finestra di 499, nessun taglio
   * prima della sanificazione), ha tre email corte e due valori fra virgolette in testa, e finisce
   * col 404.
   */
  const FISSE = [
    'avviso a mario@x.co poi a luca@y.it e a sara@z.eu',
    'invalid input syntax for type uuid: "1"',
    'invalid input syntax for type uuid: "2"',
    CURL_404,
  ]
  const DIAGNOSI_LUNGA = (() => {
    const riempitivo = 'r'.repeat(496 - FISSE.join('\n').length - 1)
    return [FISSE[0], FISSE[1], FISSE[2], riempitivo, FISSE[3]].join('\n')
  })()

  it('la fixture riproduce il difetto: il percorso di prima (coda a 499 e POI sanificata) perdeva il 404', () => {
    expect(DIAGNOSI_LUNGA.length).toBe(496)
    // Entra intera: `codaDiagnostica` non ha tagliato niente, quindi le email stanno ancora lì.
    const coda = codaDiagnostica(DIAGNOSI_LUNGA, MESSAGGIO_MAX - 1)
    expect(coda).toBe(DIAGNOSI_LUNGA)

    const prima = sanificaMessaggio(coda)
    expect(prima.length).toBe(MESSAGGIO_MAX)
    expect(prima.endsWith('…')).toBe(true)
    expect(prima.endsWith(CURL_404)).toBe(false)
    // …e l'errore non era solo il 404 tagliato: erano le battute oltre il tetto.
    expect(prima.endsWith('returned error:…')).toBe(true)
  })

  it('con `erroreDiagnostico` il messaggio salvato (dal serializzatore VERO) finisce con la riga del 404', () => {
    const messaggio = descriviErrore(erroreDiagnostico('BUILD_DOWNLOAD_FAILED', DIAGNOSI_LUNGA)).messaggio

    expect(messaggio.endsWith(CURL_404)).toBe(true)
    expect(messaggio.length).toBeLessThanOrEqual(MESSAGGIO_MAX)
    // Le maschere ci sono ancora: niente email, e il valore fra virgolette è «[valore]».
    expect(messaggio).not.toContain('@')
    expect(messaggio).toContain('"[valore]"')
  })

  it('e lo stesso accade sul giro intero: dallo stderr dell’apparecchio alla riga di `app_log`', async () => {
    await lancia({ risposta: apparecchioCheEsce(21, DIAGNOSI_LUNGA) })

    const nellaTabella = comeInTabella(riga('conversione-da-riprovare'))
    expect(nellaTabella.messaggio.endsWith(CURL_404)).toBe(true)
    expect(nellaTabella.messaggio.length).toBeLessThanOrEqual(MESSAGGIO_MAX)
  })

  it('`erroreDiagnostico` ha il nome e il codice del guasto, e senza diagnosi il messaggio è il codice', () => {
    const err = erroreDiagnostico('SANDBOX_UNAVAILABLE', '')
    expect(err.name).toBe('VideoRunnerError')
    expect(err.message).toBe('SANDBOX_UNAVAILABLE')
    expect((err as Error & { code: string }).code).toBe('SANDBOX_UNAVAILABLE')
    expect(erroreDiagnostico('X', '   \n  ').message).toBe('X')
  })

  describe('la sanificazione prima e la coda dopo: ciò che la rende vera', () => {
    /**
     * Le forme che `sanificaMessaggio` maschera, una per una, e quelle che contengono già una
     * maschera (un testo sanificato passa dal logger una seconda volta). Il messaggio che
     * `erroreDiagnostico` consegna al logger deve uscirne IDENTICO: è questo che garantisce che il
     * taglio del logger — che tiene l'inizio — non abbia più niente da togliere.
     */
    const ATOMI = [
      'mario.rossi@example.com',
      'a@b.co',
      'x@y.it',
      'RSSMRA85T10A562S',
      'Key (email)=(mario@x.co) already exists.',
      'Key (a)=()',
      'invalid input syntax for type uuid: "abc"',
      'invalid input syntax for : ""',
      'invalid input value for enum ruolo: "x"',
      'date/time field value out of range: "2026-13-45"',
      'invalid value for domain cf: "zz"',
      CURL_404,
      'frame= 10 fps=0.0 q=-1.0',
      'Error while decoding stream #0:0',
      'testo senza niente da mascherare',
      '[email]',
      '[cf]',
      '"[valore]"',
      '…',
      'token=abc123',
      '+40.8518+014.2681/',
    ]

    /** Un generatore pseudo-casuale con seme fisso: lo stesso corpus a ogni giro, su ogni macchina. */
    function generatore(seme: number) {
      let stato = seme
      return () => {
        stato = (stato * 1103515245 + 12345) & 0x7fffffff
        return stato / 0x7fffffff
      }
    }

    it('un messaggio già sanificato esce identico da `sanificaMessaggio` (idempotenza), per ogni atomo e ogni coppia', () => {
      for (const atomo of ATOMI) {
        const messaggio = erroreDiagnostico('C', atomo).message
        expect(sanificaMessaggio(messaggio), `atomo ${atomo}`).toBe(messaggio)
      }
      for (const a of ATOMI) {
        for (const b of ATOMI) {
          const messaggio = erroreDiagnostico('C', `${a}\n${b}`).message
          expect(sanificaMessaggio(messaggio), `coppia ${a} + ${b}`).toBe(messaggio)
        }
      }
    })

    it('…e anche su 3.000 diagnosi composte a caso, comprese righe molto lunghe: mai più di 499 battute, mai un taglio', () => {
      const casuale = generatore(20261002)
      for (let i = 0; i < 3000; i += 1) {
        const righe: string[] = []
        const nRighe = 1 + Math.floor(casuale() * 12)
        for (let r = 0; r < nRighe; r += 1) {
          // Fino a 60 atomi per riga: alcune righe superano di molto `RIGA_MAX`.
          const parti: string[] = []
          const nParti = 1 + Math.floor(casuale() * (casuale() < 0.3 ? 60 : 6))
          for (let p = 0; p < nParti; p += 1) parti.push(ATOMI[Math.floor(casuale() * ATOMI.length)])
          righe.push(parti.join(casuale() < 0.5 ? ' ' : ''))
        }
        const diagnosi = righe.join('\n')
        const messaggio = erroreDiagnostico('C', diagnosi).message

        expect(messaggio.length, `diagnosi ${i}`).toBeLessThanOrEqual(MESSAGGIO_MAX - 1)
        expect(sanificaMessaggio(messaggio), `diagnosi ${i}`).toBe(messaggio)
      }
    })

    it('il caso peggiore di crescita sta sotto il tetto di una riga: `sanificaMessaggio` non ha mai niente da tagliare', () => {
      // I cinque atomi che fanno crescere di più il testo (vedi `RIGA_MAX` in `esegui.ts`): l'uno dopo
      // l'altro, in righe lunghe quanto basta a sforare il tetto. Se una maschera di `serialize.ts`
      // crescesse ancora, è qui che si vedrebbe — con la fine della riga mangiata dal taglio.
      const RIGA_MAX = Math.floor((MESSAGGIO_MAX * 7) / 9)
      for (const atomo of [
        'invalid input syntax for : ""',
        'a@b.co',
        'Key (a)=()',
        'date/time field value out of range:""',
        'invalid input value for enum :""',
      ]) {
        for (const separatore of ['', ' ', ' x ']) {
          const riga = (atomo + separatore).repeat(200)
          const diagnosi = `${riga}\n${CURL_404}`
          const messaggio = erroreDiagnostico('C', diagnosi).message

          // La riga lunga si accorcia a `RIGA_MAX` e si sanifica per intero: nessun taglio.
          const accorciata = codaDiagnostica(riga, RIGA_MAX)
          expect(sanificaMessaggio(accorciata).length, `${atomo} / «${separatore}»`).toBeLessThan(MESSAGGIO_MAX)
          expect(messaggio.endsWith(CURL_404), `${atomo} / «${separatore}»`).toBe(true)
        }
      }
    })

    it('una riga più lunga di 500 battute non perde la sua FINE nella sanificazione', () => {
      // 30 volte lo stesso pezzo, poi la riga che conta: la riga lunga viene accorciata TENENDO la fine,
      // perché `sanificaMessaggio` taglierebbe l'inizio del testo e butterebbe proprio il motivo.
      const lunga = `${'invalid input syntax for : "" '.repeat(30)}FINE-DELLA-RIGA-LUNGA`
      expect(lunga.length).toBeGreaterThan(MESSAGGIO_MAX)

      const messaggio = erroreDiagnostico('C', lunga).message
      expect(messaggio.endsWith('FINE-DELLA-RIGA-LUNGA')).toBe(true)
      expect(messaggio.startsWith('…')).toBe(true)
      expect(messaggio.length).toBeLessThanOrEqual(MESSAGGIO_MAX - 1)
    })

    it('le maschere non lasciano niente di ciò che mascherano', () => {
      const messaggio = erroreDiagnostico(
        'C',
        'da mario.rossi@example.com codice RSSMRA85T10A562S\nKey (email)=(luca@x.it) already exists.\n' + CURL_404,
      ).message

      expect(messaggio).not.toContain('@')
      expect(messaggio).not.toContain('RSSMRA85T10A562S')
      expect(messaggio).not.toContain('luca')
      expect(messaggio.endsWith(CURL_404)).toBe(true)
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 9. GLI ADATTATORI NUOVI: `video_job_retry` e i dettagli dello Storage
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * `adattatori.ts` dichiara in testa di NON essere collaudato: parla con un database e con uno Storage
 * che in locale non esistono. Qui si prova ciò che si può provare senza rete — con un client Supabase
 * finto che registra come lo si chiama — e che, sbagliato, farebbe un danno senza un errore:
 *
 *  · i NOMI degli argomenti di `video_job_retry`. Se uno non corrispondesse alla funzione, PostgREST
 *    risponderebbe «funzione non trovata» — cioè `RPC_ERROR`, che è esattamente il codice per cui il
 *    runner ripiega su `video_job_fail`: ogni guasto nostro diventerebbe definitivo al primo colpo,
 *    senza un test rosso e con i log che dicono soltanto «riprova non scritta». I nomi si leggono dalla
 *    migrazione, non da una copia;
 *  · che cosa diventa un errore dello Storage: lo stato e il codice sono ciò da cui si decide la classe.
 */
describe('runner video · gli adattatori nuovi', () => {
  const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

  /** I nomi degli argomenti di `video_job_retry`, come li dichiara la migrazione dei ritentativi. */
  function argomentiDellaFunzione(): string[] {
    const nome = readdirSync(MIGRAZIONI).find((n) => n.endsWith('_video_job_ritentativi.sql'))
    expect(nome, 'la migrazione dei ritentativi non si trova (si cerca per suffisso)').toBeDefined()
    const sql = readFileSync(join(MIGRAZIONI, nome as string), 'utf8')
    const inizio = sql.indexOf('CREATE OR REPLACE FUNCTION public.video_job_retry(')
    expect(inizio, 'la firma di video_job_retry non si trova nella migrazione').toBeGreaterThanOrEqual(0)
    const firma = sql.slice(inizio, sql.indexOf(')', inizio))
    return Array.from(firma.matchAll(/\bp_[a-z_]+/g), (m) => m[0]).sort()
  }

  /** Un client Supabase finto: registra le RPC e risponde con ciò che gli si dà. */
  function clienteFinto(risposta: { data: unknown; error: unknown }) {
    const chiamate: { nome: string; args: Record<string, unknown> }[] = []
    const client = {
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chiamate.push({ nome, args })
        return risposta
      },
    } as unknown as SupabaseClient
    return { client, chiamate }
  }

  /** Un client Supabase finto per lo Storage: le due firme rispondono col risultato dato. */
  function storageFinto(risultato: { data: unknown; error: unknown }) {
    return {
      storage: {
        from: () => ({
          createSignedUrl: async () => risultato,
          createSignedUploadUrl: async () => risultato,
        }),
      },
    } as unknown as SupabaseClient
  }

  const PARAMETRI: ParametriRiprova = {
    jobId: JOB_ID,
    fenceEpoch: 5,
    leaseOwner: WORKER,
    codice: 'BUILD_DOWNLOAD_FAILED',
    tentativiMassimi: 4,
    attesaSecondi: 300,
  }

  it('`riprova` chiama `video_job_retry` con ESATTAMENTE gli argomenti che la migrazione dichiara', async () => {
    const { client, chiamate } = clienteFinto({ data: { ok: true, job: job({ status: 'queued' }) }, error: null })
    await codaSupabase(client).riprova(PARAMETRI)

    expect(chiamate).toHaveLength(1)
    expect(chiamate[0].nome).toBe('video_job_retry')
    // Né uno in più né uno in meno, e con i nomi della funzione: non una copia scritta a mano.
    expect(Object.keys(chiamate[0].args).sort()).toEqual(argomentiDellaFunzione())
    expect(argomentiDellaFunzione()).toHaveLength(6)
    expect(chiamate[0].args).toEqual({
      p_job_id: JOB_ID,
      p_fence_epoch: 5,
      p_lease_owner: WORKER,
      p_error_code: 'BUILD_DOWNLOAD_FAILED',
      p_tentativi_massimi: 4,
      p_attesa_secondi: 300,
    })
  })

  describe('la risposta della RPC diventa l’esito che il runner legge', () => {
    it('`ok` col job: passa com’è, con il suo stato', async () => {
      const { client } = clienteFinto({ data: { ok: true, job: job({ status: 'queued' }) }, error: null })
      expect(await codaSupabase(client).riprova(PARAMETRI)).toEqual({ ok: true, job: job({ status: 'queued' }) })
    })

    it.each(['FENCE_MISMATCH', 'LEASE_EXPIRED', 'INVALID_STATE', 'BAD_INPUT'])('un verdetto (%s) mantiene il SUO codice', async (code) => {
      const { client } = clienteFinto({ data: { ok: false, code }, error: null })
      expect(await codaSupabase(client).riprova(PARAMETRI)).toEqual({ ok: false, code })
    })

    it('«funzione non trovata» (la migrazione non è applicata) è `RPC_ERROR`: il codice che fa ripiegare il runner', async () => {
      const { client } = clienteFinto({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.video_job_retry' },
      })
      expect(await codaSupabase(client).riprova(PARAMETRI)).toEqual({ ok: false, code: 'RPC_ERROR' })
      // E si vede: l'adattatore scrive la sua riga prima di restituire il codice.
      expect(righeDiLog().some((r) => r[2].esito === 'rpc-non-riuscita' && r[2].operazione === 'video-runner:retry')).toBe(true)
    })
  })

  describe('gli errori dello Storage portano lo stato e il codice da cui si decide la classe', () => {
    it('un errore dello Storage con stato e codice: `stato` e `codiceStorage`', async () => {
      const storage = storageFinto({
        data: null,
        error: { message: 'Object not found', status: 400, statusCode: '404', code: 'NoSuchKey' },
      })
      expect(await archivioSupabase(storage).urlLettura('video_build', 'x/ffmpeg.gz', 900)).toEqual({
        ok: false,
        motivo: 'Object not found',
        stato: 400,
        codiceStorage: 'NoSuchKey',
      })
      expect(await archivioSupabase(storage).urlScrittura('video_processing', 'x/1.mp4')).toEqual({
        ok: false,
        motivo: 'Object not found',
        stato: 400,
        codiceStorage: 'NoSuchKey',
      })
    })

    it('un errore di rete (nessuno stato, nessun codice): i due campi restano ASSENTI, non `undefined`', async () => {
      const storage = storageFinto({ data: null, error: { message: 'fetch failed' } })
      const esito = await archivioSupabase(storage).urlLettura('video_build', 'x/ffmpeg.gz', 900)

      expect(esito).toEqual({ ok: false, motivo: 'fetch failed' })
      // `toEqual` ignora le chiavi `undefined`: qui si vuole che non ci siano proprio.
      expect(Object.keys(esito)).toEqual(['ok', 'motivo'])
    })

    it('uno stato che non è un intero e un codice vuoto non si fingono validi', async () => {
      const storage = storageFinto({ data: null, error: { message: 'strano', status: '400', code: '' } })
      const esito = await archivioSupabase(storage).urlLettura('video_build', 'x/ffmpeg.gz', 900)

      expect(Object.keys(esito)).toEqual(['ok', 'motivo'])
    })

    it('una firma senza URL e senza errore ha il suo motivo, e nessun dettaglio inventato', async () => {
      const storage = storageFinto({ data: {}, error: null })
      const esito = await archivioSupabase(storage).urlLettura('video_build', 'x/ffmpeg.gz', 900)

      expect(esito).toEqual({ ok: false, motivo: 'firma-assente' })
    })

    it('la firma che riesce porta l’URL e basta', async () => {
      const storage = storageFinto({ data: { signedUrl: 'https://esempio.invalid/o?token=finto' }, error: null })
      expect(await archivioSupabase(storage).urlLettura('video_build', 'x/ffmpeg.gz', 900)).toEqual({
        ok: true,
        url: 'https://esempio.invalid/o?token=finto',
      })
    })
  })

  it('il runtime della MicroVM resta `node22` in questa PR (D7), e il commento dice dove cambia', () => {
    // L'SDK del Sandbox non si può esercitare qui, e un runtime cambiato per distrazione rompe ogni
    // job in produzione senza un test rosso. È una decisione dell'orchestratore con il suo motivo:
    // si cambia nella PR 2 (snapshot su `node:24`), non qui.
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/media/video/runner/adattatori.ts'), 'utf8')
    const posizione = sorgente.indexOf('Sandbox.create({')
    expect(posizione, '`Sandbox.create` non si trova più in adattatori.ts').toBeGreaterThan(0)

    expect(sorgente.slice(posizione, posizione + 120)).toContain("runtime: 'node22'")
    // Il commento sta subito sopra la chiamata e rimanda alla PR che cambia il runtime.
    const commento = sorgente.slice(Math.max(0, posizione - 900), posizione)
    expect(commento).toContain('PR 2')
    expect(commento).toContain('node:24')
    expect(commento).toContain('SANDBOX_UNAVAILABLE')
  })
})
