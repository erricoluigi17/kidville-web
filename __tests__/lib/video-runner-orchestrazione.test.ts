import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SEDE_A } from '../fixtures/sedi'

import { MESSAGGIO_MAX, descriviErrore, sanificaMessaggio } from '@/lib/logging/serialize'
import { rigaEvento } from '@/lib/logging/logger'
import {
  BUCKET_BUILD_VIDEO,
  CARTELLA_BINARI_NELLO_SNAPSHOT,
  FFMPEG_SHA256,
  FFPROBE_SHA256,
  PERCORSO_FFMPEG_GZ,
  PERCORSO_FFPROBE_GZ,
} from '@/lib/media/video/build'
import { MAX_VIDEO_DURATION_SECONDS } from '@/lib/media/video/limiti'
import { parseVideoProbe } from '@/lib/media/video/probe'
import { diagnosiVerifica } from '@/lib/media/video/verify'
import { archivioSupabase, codaSupabase } from '@/lib/media/video/runner/adattatori'
import {
  PERIODO_SONDA_MS,
  SECONDI_LEASE_PRESA,
  TETTO_INVOCAZIONE_MS,
} from '@/lib/media/video/runner/battito'
import { codaDiagnostica } from '@/lib/media/video/runner/diagnosi'
import {
  SECONDI_FIRMA_BUILD,
  SECONDI_SORVEGLIANZA,
  erroreDiagnostico,
  eseguiUnJobVideo,
  type ContestoPubblicazioni,
  type DipendenzeRunner,
  type EsitoRunnerVideo,
  type RichiestaRunner,
} from '@/lib/media/video/runner/esegui'
import {
  CARTELLA_BUILD,
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
  EsitoBattito,
  EsitoComando,
  EsitoConteggi,
  EsitoRpcVideo,
  JobVideo,
  MacchinaSandbox,
  SessioneSandbox,
} from '@/lib/media/video/runner/porte'
import { ATTESE_FRA_TENTATIVI_S, TENTATIVI_MASSIMI_GUASTO_NOSTRO } from '@/lib/media/video/runner/ritentativi'
import { SONDA_TEMPORALE, VIDEO_TEMPORAL_REASONS, timeoutSondaTemporaleMs } from '@/lib/media/video/temporale'
import {
  ENV_SHA256_ATTESO,
  INGRESSO,
  MODELLO_PROCESSI_DEI_BINARI,
  USCITE_APPARECCHIO,
  USCITE_CONVERSIONE,
  WATERMARK,
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

/**
 * Durata a ridosso del tetto: serve al caso «il probe_json è la SORGENTE». Il tetto NON è un numero
 * scritto qui (era 180, e il 2026-10-02 è diventato 300 senza che questa riga se ne accorgesse: secondario
 * #25): si legge da `MAX_VIDEO_DURATION_SECONDS`, e `a ridosso` vuol dire a un decimo di secondo.
 */
const DURATA_SORGENTE = MAX_VIDEO_DURATION_SECONDS - 0.1
const DURATA_USCITA = MAX_VIDEO_DURATION_SECONDS - 0.08

/** Le misure dell'ingresso che si vedono nel probe (e da cui la sonda temporale ricava il suo timeout). */
interface MisureProbe {
  larghezza?: number
  altezza?: number
  fps?: string
}

function probeSorgente(durata = DURATA_SORGENTE, misure: MisureProbe = {}): string {
  const larghezza = misure.larghezza ?? 1920
  const altezza = misure.altezza ?? 1080
  const fps = misure.fps ?? '30000/1001'
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        width: larghezza,
        height: altezza,
        coded_width: larghezza,
        coded_height: altezza === 1080 ? 1088 : altezza,
        pix_fmt: 'yuv420p',
        avg_frame_rate: fps,
        r_frame_rate: fps,
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
  /** Da dove è nata la MicroVM (T8): `snapshot` o `runtime`. Senza, la sessione non lo dichiara (= la PR 1). */
  origine?: 'snapshot' | 'runtime'
  apriFallisce?: boolean
  /** L'SDK che LANCIA su `avvia` (la conversione staccata): `esegui` lancia restituendo un `Error` da `risposta`. */
  avviaFallisce?: Error
  /** L'SDK che LANCIA su `ferma` (`sandbox.stop()`): la MicroVM che non si spegne (secondario #163). */
  fermaFallisce?: Error
}

function sandboxFinta(copione: Copione = {}) {
  const eseguiti: ComandoSandbox[] = []
  const avviati: ComandoSandbox[] = []
  const nomi: string[] = []
  let fermata = 0
  let marcatoriLetti = 0

  const sessione: SessioneSandbox = {
    nuova: copione.nuova ?? true,
    ...(copione.origine === undefined ? {} : { origine: copione.origine }),
    esegui: async (c) => {
      eseguiti.push(c)
      if (c.args.join(' ').includes('esito.txt')) marcatoriLetti += 1
      const r = copione.risposta?.(c, eseguiti.length)
      if (r instanceof Error) throw r
      return r ?? OK
    },
    avvia: async (c) => {
      avviati.push(c)
      if (copione.avviaFallisce) throw copione.avviaFallisce
    },
    ferma: async () => {
      fermata += 1
      if (copione.fermaFallisce) throw copione.fermaFallisce
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
type ParametriFallito = Parameters<CodaVideo['fallito']>[0]

/**
 * LA SORVEGLIANZA ESCLUSIVA com'è nel database (`video_job_sorveglianza_prendi` / `_rilascia`), in
 * memoria: un job ha al più una invocazione che lo sorveglia; chi non è quella la prende `GIA_SORVEGLIATO`;
 * chi la tiene la riprende (idempotente); un rilascio non proprio non fa niente. Condivisa fra più
 * `codaFinta`, è ciò che permette di provare DUE invocazioni sullo stesso job senza un database.
 *
 * ⚠️ Non modella la scadenza della lease: dentro un test nessuna dura abbastanza da scadere, e la
 * scadenza è provata dove vive — nel PGlite di `video-pubblicazione-automatica-rpc`.
 */
function sorveglianzaInMemoria() {
  const tenute = new Map<string, string>()
  return {
    prendi: (jobId: string, invocazione: string): EsitoBattito => {
      const chi = tenute.get(jobId)
      if (chi !== undefined && chi !== invocazione) return { ok: false, code: 'GIA_SORVEGLIATO' }
      tenute.set(jobId, invocazione)
      return { ok: true }
    },
    rilascia: (jobId: string, invocazione: string): EsitoBattito => {
      if (tenute.get(jobId) === invocazione) tenute.delete(jobId)
      return { ok: true }
    },
    /** Chi sorveglia che cosa, adesso. */
    tenute: () => new Map(tenute),
  }
}

/**
 * IL TETTO DELLE CONVERSIONI IN PARALLELO com'è nel database (`video_job_prendi` / `video_job_prossimo`),
 * in memoria: se i `processing` sono già `tetto`, `CAPACITA_PIENA`; un job che è già mio e vivo non occupa
 * un posto in più. Come la sorveglianza, è condiviso fra più `codaFinta`.
 */
function capacitaInMemoria() {
  const inLavorazione = new Set<string>()
  return {
    prendi: (jobId: string, tetto: number): EsitoRpcVideo => {
      if (!Number.isInteger(tetto) || tetto < 1) throw new Error(`il tetto non arriva: ${String(tetto)}`)
      if (!inLavorazione.has(jobId) && inLavorazione.size >= tetto) {
        return { ok: false, code: 'CAPACITA_PIENA' }
      }
      inLavorazione.add(jobId)
      return { ok: true, job: job({ id: jobId }) }
    },
    inLavorazione: () => new Set(inLavorazione),
  }
}

/**
 * Ciò che il database sa di UN job, per i campi che il runner scrive: gli stessi di `video_jobs`. Si può
 * passare a `codaFinta` per condividerlo fra più giri (i quattro tentativi dello stesso job).
 */
interface StatoDelJob {
  status: string
  errorCode: string | null
  /** `last_error_code`: lo scrive SOLO `video_job_retry`, mai `video_job_fail`. */
  lastErrorCode: string | null
}

function statoDelJob(): StatoDelJob {
  return { status: 'processing', errorCode: null, lastErrorCode: null }
}

interface CopioneCoda {
  prossimo?: EsitoRpcVideo
  miei?: JobVideo[]
  /**
   * La risposta di `video_job_prendi`. Senza copione il database prende il job che gli si chiede: il primo
   * dei `miei` (la ripresa), o un job qualunque.
   */
  prendi?: EsitoRpcVideo | ((jobId: string, tetto: number) => EsitoRpcVideo)
  /** La risposta di `video_job_sorveglianza_prendi`. Senza copione la sorveglianza si ottiene. */
  sorveglianzaPrendi?: EsitoBattito | ((jobId: string, invocazione: string) => EsitoBattito)
  sorveglianzaRilascia?: EsitoBattito | Error
  arriviRecupera?: EsitoConteggi | Error
  ventaglio?: EsitoConteggi | Error
  battito?: EsitoRpcVideo
  pronto?: EsitoRpcVideo | Error
  fallito?: EsitoRpcVideo | ((p: ParametriFallito) => EsitoRpcVideo)
  /** La risposta di `video_job_diagnosi` (T8). Senza copione la scrittura riesce; un `Error` fa LANCIARE l'adattatore. */
  diagnosi?: EsitoBattito | Error
  /**
   * La risposta di `video_job_retry`. Senza copione il database dice «ok» e il job è `queued`: la
   * risposta di un ritentativo andato a buon fine.
   */
  riprova?: EsitoRpcVideo | ((p: ParametriRiprova) => EsitoRpcVideo)
  /** Dove registrare l'ORDINE delle chiamate, se più doppi (o il punto d'aggancio) devono scriverci insieme. */
  ordine?: string[]
  /** La sorveglianza condivisa fra più invocazioni (al posto di quella che sempre riesce). */
  sorveglianza?: ReturnType<typeof sorveglianzaInMemoria>
  /** Lo stato del job lato database, se va condiviso fra più giri; altrimenti ne nasce uno per `codaFinta`. */
  stato?: StatoDelJob
}

function codaFinta(copione: CopioneCoda = {}) {
  const pronti: unknown[] = []
  /** Le diagnosi scritte con `video_job_diagnosi` (T8), tali e quali arrivano all'adattatore. */
  const diagnosi: Parameters<CodaVideo['diagnosi']>[0][] = []
  const falliti: ParametriFallito[] = []
  const ritentati: ParametriRiprova[] = []
  /** Gli id passati a `video_job_prendi`, e i parametri con cui sono stati passati. */
  const prese: string[] = []
  const richiestePrese: { jobId: string; leaseOwner: string; leaseSeconds: number; tetto: number }[] = []
  const richiesteProssimo: { leaseOwner: string; leaseSeconds: number; tetto: number }[] = []
  const sorveglianze: { jobId: string; invocazione: string; secondi: number }[] = []
  const rilasci: { jobId: string; invocazione: string }[] = []
  const arrivi: number[] = []
  const ventagli: { tetto: number; escludi: string | null }[] = []
  const ordine = copione.ordine ?? []
  const stato = copione.stato ?? statoDelJob()
  /** Il job che il database ha dato per ultimo: è da lui che `video_job_retry` sa a che tentativo è. */
  let corrente: JobVideo | null = null
  let battiti = 0

  /**
   * `video_job_retry` com'è scritta (PR 1; il suo test PGlite è `video-job-ritentativi`): annota SEMPRE
   * `last_error_code`, e se `attempt >= p_tentativi_massimi` delega a `video_job_fail`, che scrive
   * `error_code` e chiude. Il tentativo lo sa il database dal job; il doppio lo ricorda dall'ultima presa.
   */
  const comeVideoJobRetry = (p: ParametriRiprova): EsitoRpcVideo => {
    const attempt = corrente?.attempt ?? 1
    stato.lastErrorCode = p.codice
    if (attempt >= p.tentativiMassimi) {
      stato.status = 'failed'
      stato.errorCode = p.codice
      return { ok: true, job: job({ status: 'failed', attempt }) }
    }
    stato.status = 'queued'
    return { ok: true, job: job({ status: 'queued', attempt }) }
  }

  const coda: CodaVideo = {
    miei: async () => {
      ordine.push('miei')
      return { ok: true, jobs: copione.miei ?? [] }
    },
    prossimo: async (leaseOwner, leaseSeconds, tetto) => {
      ordine.push('prossimo')
      richiesteProssimo.push({ leaseOwner, leaseSeconds, tetto })
      const risposta: EsitoRpcVideo = copione.prossimo ?? { ok: false, code: 'EMPTY_QUEUE' }
      if (risposta.ok) corrente = risposta.job
      return risposta
    },
    prendi: async (jobId, leaseOwner, leaseSeconds, tetto) => {
      ordine.push(`prendi:${jobId}`)
      prese.push(jobId)
      richiestePrese.push({ jobId, leaseOwner, leaseSeconds, tetto })
      const copiata = copione.prendi
      const risposta: EsitoRpcVideo =
        typeof copiata === 'function'
          ? copiata(jobId, tetto)
          : (copiata ?? { ok: true, job: (copione.miei ?? []).find((j) => j.id === jobId) ?? (copione.miei ?? [])[0] ?? job({ id: jobId }) })
      if (risposta.ok) corrente = risposta.job
      return risposta
    },
    sorveglianzaPrendi: async (jobId, invocazione, secondi) => {
      ordine.push(`sorveglianzaPrendi:${jobId}`)
      sorveglianze.push({ jobId, invocazione, secondi })
      const risposta = copione.sorveglianzaPrendi
      if (typeof risposta === 'function') return risposta(jobId, invocazione)
      if (risposta) return risposta
      return copione.sorveglianza ? copione.sorveglianza.prendi(jobId, invocazione) : { ok: true }
    },
    sorveglianzaRilascia: async (jobId, invocazione) => {
      ordine.push(`sorveglianzaRilascia:${jobId}`)
      rilasci.push({ jobId, invocazione })
      if (copione.sorveglianzaRilascia instanceof Error) throw copione.sorveglianzaRilascia
      if (copione.sorveglianzaRilascia) return copione.sorveglianzaRilascia
      return copione.sorveglianza ? copione.sorveglianza.rilascia(jobId, invocazione) : { ok: true }
    },
    arriviRecupera: async (limite) => {
      ordine.push('arriviRecupera')
      arrivi.push(limite)
      if (copione.arriviRecupera instanceof Error) throw copione.arriviRecupera
      return copione.arriviRecupera ?? { ok: true, conteggi: { candidati: 0, arrivati: 0 } }
    },
    ventaglio: async (tetto, escludi) => {
      ordine.push(`ventaglio:${escludi ?? 'nessuno'}`)
      ventagli.push({ tetto, escludi })
      if (copione.ventaglio instanceof Error) throw copione.ventaglio
      return copione.ventaglio ?? { ok: true, conteggi: { candidati: 0, calciati: 0 } }
    },
    battito: async () => {
      battiti += 1
      return copione.battito ?? { ok: true, job: job() }
    },
    pronto: async (p) => {
      pronti.push(p)
      if (copione.pronto instanceof Error) throw copione.pronto
      return copione.pronto ?? { ok: true, job: job() }
    },
    diagnosi: async (p) => {
      ordine.push('diagnosi')
      diagnosi.push(p)
      if (copione.diagnosi instanceof Error) throw copione.diagnosi
      return copione.diagnosi ?? { ok: true }
    },
    fallito: async (p) => {
      ordine.push('fallito')
      falliti.push(p)
      const risposta = copione.fallito
      if (typeof risposta === 'function') return risposta(p)
      if (risposta) return risposta
      // `video_job_fail` scrive `error_code` e chiude, e NON tocca `last_error_code`: è il difetto #23.
      stato.status = p.rifiutato ? 'rejected' : 'failed'
      stato.errorCode = p.codice
      return { ok: true, job: job({ status: stato.status }) }
    },
    riprova: async (p) => {
      ritentati.push(p)
      const risposta = copione.riprova
      if (typeof risposta === 'function') return risposta(p)
      return risposta ?? comeVideoJobRetry(p)
    },
  }

  return {
    coda,
    pronti,
    diagnosi,
    falliti,
    ritentati,
    prese,
    richiestePrese,
    richiesteProssimo,
    sorveglianze,
    rilasci,
    arrivi,
    ventagli,
    ordine,
    stato,
    battiti: () => battiti,
  }
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

/** L'identità di QUESTA invocazione: nei test un uuid fisso, per poter dire chi ha preso e chi ha rilasciato. */
const INVOCAZIONE = '5a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b'
/** Il tetto delle conversioni in parallelo che i test passano al runner (il predefinito di `index.ts` è 3). */
const TETTO = 3

function dipendenze(
  coda: CodaVideo,
  macchina: MacchinaSandbox,
  sovrascritture: Partial<DipendenzeRunner> = {},
): DipendenzeRunner {
  return {
    coda,
    archivio,
    macchina,
    orologio: orologioFinto(),
    leaseOwner: WORKER,
    invocazione: INVOCAZIONE,
    tettoConversioni: TETTO,
    regione: 'dub1',
    vcpus: 4,
    urlWatermark: 'https://app.esempio.invalid/watermark.png',
    tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    ...sovrascritture,
  }
}

/** Il copione di una conversione che NON finisce mai: l'apparecchio riesce, il marcatore non compare. */
function rispostaSenzaMarcatore(cmd: ComandoSandbox): EsitoComando {
  const testo = cmd.args.join(' ')
  if (testo.includes('esito.txt')) return { exitCode: 1, stdout: '', stderr: '' }
  if (testo.includes('===INVENTARIO===')) return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
  return OK
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
    // pretende `durationSeconds <= MAX_VIDEO_DURATION_SECONDS`, che è il limite dell'INGRESSO; l'uscita
    // AAC può legittimamente superarlo di qualche millisecondo (lo dice
    // `verifyVideoOutput`). Mandare l'uscita farebbe rispondere `BAD_INPUT` DOPO
    // aver pagato la codifica, e solo sui video lunghi — cioè in produzione.
    //
    // Il tetto si legge dalla costante (secondario #25: era un `180` che il 2026-10-02 è diventato 300
    // senza che il test se ne accorgesse). E il caso è quello vero: la SORGENTE sta sotto il tetto di
    // un centesimo di secondo, l'USCITA lo supera di un centesimo — l'unica forma in cui «quale probe
    // si manda» cambia l'esito.
    const sorgenteSottoIlTetto = MAX_VIDEO_DURATION_SECONDS - 0.01
    const uscitaOltreIlTetto = MAX_VIDEO_DURATION_SECONDS + 0.01
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({
      risposta: rispostaFelice(
        marcatore({
          probeIn: probeSorgente(sorgenteSottoIlTetto),
          probeOut: probeUscita(uscitaOltreIlTetto),
        }),
      ),
    })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito.esito, 'la fixture deve arrivare a `pronto`: una tolleranza troppo stretta la farebbe fallire prima').toBe('pronto')
    expect(c.pronti).toHaveLength(1)
    const scritto = c.pronti[0] as { probe: { durationSeconds: number }; percorsoUscita: string }
    expect(scritto.probe.durationSeconds).toBe(sorgenteSottoIlTetto)
    expect(scritto.probe.durationSeconds).toBeLessThanOrEqual(MAX_VIDEO_DURATION_SECONDS)
    // …e l'uscita, se fosse stata mandata, il database l'avrebbe respinta.
    expect(uscitaOltreIlTetto).toBeGreaterThan(MAX_VIDEO_DURATION_SECONDS)
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
    // SECONDARIO #23: anche l'ULTIMO tentativo passa da `video_job_retry`, che è la RPC a riconoscere i
    // tentativi finiti, ad annotare `last_error_code` e a delegare a `video_job_fail`. Il runner NON chiama
    // `video_job_fail` da sé: la chiusura è già scritta, e richiamarla darebbe un doppio.
    expect(c.ritentati).toHaveLength(1)
    expect(c.ritentati[0]).toMatchObject({ codice: 'BUILD_HASH_MISMATCH', tentativiMassimi: 4 })
    expect(c.falliti).toEqual([])
    expect(c.stato).toMatchObject({
      status: 'failed',
      errorCode: 'BUILD_HASH_MISMATCH',
      lastErrorCode: 'BUILD_HASH_MISMATCH',
    })
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
    expect(c.prese).toEqual([JOB_ID])
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
    expect(c.prese).toEqual([JOB_ID])
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
    /** Da dove è nata la MicroVM (T8). */
    origine?: 'snapshot' | 'runtime'
    apriFallisce?: boolean
    avviaFallisce?: Error
    /** `stop()` che lancia (secondario #163). */
    fermaFallisce?: Error
    risposta?: Copione['risposta']
    coda?: CopioneCoda
    orologio?: ReturnType<typeof orologioFinto>
    /** Con un `jobId` è un CALCIO; senza è il giro del cron. */
    richiesta?: RichiestaRunner
    /** Altre dipendenze (il punto d'aggancio delle pubblicazioni, il tetto delle conversioni…). */
    dipendenze?: Partial<DipendenzeRunner>
  } = {},
) {
  const preso: EsitoRpcVideo = { ok: true, job: job(opzioni.job) }
  // Il job lo dà `prossimo` (il giro) o `prendi` (il calcio): lo stesso, quello che il test descrive.
  const c = codaFinta({ prossimo: preso, prendi: preso, ...opzioni.coda })
  const s = sandboxFinta({
    nuova: opzioni.nuova,
    origine: opzioni.origine,
    apriFallisce: opzioni.apriFallisce,
    avviaFallisce: opzioni.avviaFallisce,
    fermaFallisce: opzioni.fermaFallisce,
    risposta: opzioni.risposta ?? rispostaFelice(),
  })
  const esito = await eseguiUnJobVideo(
    dipendenze(c.coda, s.macchina, {
      archivio: opzioni.archivio ?? archivio,
      ...(opzioni.orologio ? { orologio: opzioni.orologio } : {}),
      ...opzioni.dipendenze,
    }),
    opzioni.richiesta,
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
  // T8: un `sha256` dichiarato che non è un'impronta non si può verificare, e un controllo richiesto e non eseguibile non passa
  // in silenzio. Si esce PRIMA di firmare e di aprire qualunque cosa (aperte 0).
  { nome: 'sha256 dichiarato illeggibile (non è un’impronta)', opzioni: { job: { sha256_dichiarato: '\\xnon-un-hash' } }, codice: 'ORIGINALE_DIVERSO', classe: 'file', aperte: 0, spente: 0 },
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
  // T8, §10.4: lo `sha256` dichiarato non è quello dell'originale scaricato. Il guasto è del FILE: rifiutato, mai ritentato.
  { nome: 'conversione 35 · lo sha256 dichiarato non coincide con l’originale', opzioni: CONVERSIONE_CON(35, '/tmp/kv-video/ingresso: FAILED'), codice: 'ORIGINALE_DIVERSO', classe: 'file', aperte: 1, spente: 1 },
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

  it.each([4, 5, 12])('al tentativo %i i tentativi sono finiti: `video_job_retry` chiude (e annota `last_error_code`), mai un altro ritentativo', async (attempt) => {
    const { esito, c } = await lancia({ job: { attempt }, apriFallisce: true })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    // L'ULTIMO tentativo passa da `riprova` (secondario #23): è la RPC a decidere che i tentativi sono finiti,
    // e a delegare a `video_job_fail` DOPO aver annotato `last_error_code`. Con un massimo di 4 e un `attempt`
    // già a 4 (o oltre) il database non rimette in coda niente.
    expect(c.ritentati).toHaveLength(1)
    expect(c.ritentati[0]).toMatchObject({
      codice: 'SANDBOX_UNAVAILABLE',
      tentativiMassimi: TENTATIVI_MASSIMI_GUASTO_NOSTRO,
      // L'attesa qui non serve a niente (la RPC non la legge), ma la RPC la VALIDA: un numero valido ci vuole.
      attesaSecondi: ATTESE_FRA_TENTATIVI_S[ATTESE_FRA_TENTATIVI_S.length - 1],
    })
    // …e il runner NON richiama `video_job_fail`: la chiusura è già scritta, e richiamarla darebbe un doppio.
    expect(c.falliti).toEqual([])
    expect(c.stato).toMatchObject({ status: 'failed', errorCode: 'SANDBOX_UNAVAILABLE', lastErrorCode: 'SANDBOX_UNAVAILABLE' })
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

  it('il ripiego resta `node22` come nella PR 1 (D7): il runtime sta in `ambiente.ts`, e il rischio è dichiarato', () => {
    // L'SDK del Sandbox non si può esercitare qui, e un runtime cambiato per distrazione rompe ogni job in
    // produzione senza un test rosso. Fino alla PR 1 questo test leggeva `adattatori.ts` e cercava
    // `Sandbox.create({ runtime: 'node22' … })`; dalla PR 2 la scelta (riaggancio, snapshot, ripiego) è di
    // `apriLaMicroVm`, in `ambiente.ts`, e `adattatori.ts` non nomina più nessun runtime. Il percorso che si
    // prova CHIAMANDO l'apertura con un SDK finto, parametro per parametro, è in `video-runner-ambiente.test.ts`;
    // qui resta il lock sul TESTO, perché il runtime cambia in un posto solo e quel posto ha il suo commento.
    const ambiente = readFileSync(join(process.cwd(), 'src/lib/media/video/runner/ambiente.ts'), 'utf8')
    expect(ambiente).toContain("export const RUNTIME_DI_RIPIEGO = 'node22'")
    // Il rischio che il ripiego lascia aperto (spec §10.2) sta scritto accanto alla costante e alla sua decisione.
    expect(ambiente).toContain('SANDBOX_UNAVAILABLE')
    expect(ambiente).toContain('node22')

    // Né un altro runtime scritto a mano da qualche parte: il ripiego ha UN nome. Si guarda il CODICE e non i
    // commenti, che il runtime lo nominano apposta (un lock che legge un file come testo legge anche le proprie spiegazioni).
    const senzaCommenti = (testo: string) =>
      testo
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .filter((riga) => !riga.trimStart().startsWith('//'))
        .join('\n')
    const adattatori = readFileSync(join(process.cwd(), 'src/lib/media/video/runner/adattatori.ts'), 'utf8')
    expect(senzaCommenti(adattatori)).not.toMatch(/runtime:\s*['"`]/)
    expect(senzaCommenti(ambiente).match(/runtime:\s*RUNTIME_DI_RIPIEGO/g) ?? []).toHaveLength(1)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 10. IL CALCIO: UN `job_id`, UNA INVOCAZIONE (PR 2, spec §9)
 * ════════════════════════════════════════════════════════════════════════════ */

const CALCIO: RichiestaRunner = { jobId: JOB_ID }
const INVOCAZIONE_B = '6b2c3d4e-5f60-4172-9b8c-0d1e2f3a4b5c'
const ALTRO_JOB = '7c3d4e5f-6071-4283-8c9d-1e2f3a4b5c6d'
const TERZO_JOB = '8d4e5f60-7182-4394-8dae-2f3a4b5c6d7e'
const QUARTO_JOB = '9e5f6071-8293-44a5-8ebf-3a4b5c6d7e8f'

/** Un'invocazione che NON lavora: la MicroVM non si apre e niente si scrive sul job. */
function nienteDaFare(s: ReturnType<typeof sandboxFinta>, c: ReturnType<typeof codaFinta>) {
  expect(s.nomi, 'nessuna MicroVM').toEqual([])
  expect(c.pronti, 'nessun `ready`').toEqual([])
  expect(c.falliti, 'nessun `fail`').toEqual([])
  expect(c.ritentati, 'nessun `retry`').toEqual([])
}

describe('runner video · il calcio con un job_id', () => {
  it('prende la sorveglianza, poi il job COL TETTO, lavora, rilascia — e NON fa il giro del cron', async () => {
    const ordine: string[] = []
    const { esito, c, s } = await lancia({ richiesta: CALCIO, coda: { ordine } })

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // L'ordine COMPLETO, e proprio perché è completo prova anche ciò che manca: un calcio non recupera
    // arrivi, non fa il ventaglio, non guarda i `miei` e non pesca dalla coda — quello è il giro del cron.
    expect(ordine).toEqual([
      `sorveglianzaPrendi:${JOB_ID}`,
      `prendi:${JOB_ID}`,
      `sorveglianzaRilascia:${JOB_ID}`,
    ])
    expect(c.sorveglianze).toEqual([
      { jobId: JOB_ID, invocazione: INVOCAZIONE, secondi: SECONDI_SORVEGLIANZA },
    ])
    expect(c.richiestePrese).toEqual([
      { jobId: JOB_ID, leaseOwner: WORKER, leaseSeconds: SECONDI_LEASE_PRESA, tetto: TETTO },
    ])
    // Chi rilascia è CHI HA PRESO: la stessa invocazione, per lo stesso job.
    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
    expect(s.nomi).toEqual([nomeSandboxVideo(JOB_ID, 5)])
    expect(s.fermate()).toBe(1)
  })

  it('un’altra invocazione lo sorveglia già: `gia-sorvegliato`, e non si tocca NIENTE — nemmeno la sua sorveglianza', async () => {
    const { esito, c, s } = await lancia({
      richiesta: CALCIO,
      coda: { sorveglianzaPrendi: { ok: false, code: 'GIA_SORVEGLIATO' } },
    })

    expect(esito).toEqual({ esito: 'gia-sorvegliato', jobId: JOB_ID })
    nienteDaFare(s, c)
    // Il job non è suo: né lo prende, né ne rilascia una sorveglianza che non ha (rilasciare quella di
    // un altro non farebbe niente, ma provarci vorrebbe dire non aver capito di chi è).
    expect(c.prese).toEqual([])
    expect(c.rilasci).toEqual([])
    // Esito TRANQUILLO: è il caso normale di due calci sullo stesso job, e un `error` qui sarebbe il falso
    // allarme (`OUTPUT_CONFLICT` su una conversione riuscita) che la sorveglianza esclusiva esiste per togliere.
    expect(righeDiLog().filter((r) => r[1] === 'error' || r[1] === 'warn')).toEqual([])
  })

  it('due calci sullo STESSO job insieme: una sola invocazione lo sorveglia, e UNA SOLA scrive l’esito', async () => {
    const sorveglianza = sorveglianzaInMemoria()
    const a = codaFinta({ sorveglianza })
    const b = codaFinta({ sorveglianza })
    const sa = sandboxFinta({ risposta: rispostaFelice() })
    const sb = sandboxFinta({ risposta: rispostaFelice() })

    const [esitoA, esitoB] = await Promise.all([
      eseguiUnJobVideo(dipendenze(a.coda, sa.macchina), CALCIO),
      eseguiUnJobVideo(dipendenze(b.coda, sb.macchina, { invocazione: INVOCAZIONE_B }), CALCIO),
    ])

    // Chi arriva per prima vince; l'altra se ne va con un esito tranquillo.
    expect(esitoA).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    expect(esitoB).toEqual({ esito: 'gia-sorvegliato', jobId: JOB_ID })
    // ⚠️ I due numeri che contano. Senza la sorveglianza ESCLUSIVA entrambe riagganciavano lo stesso
    // Sandbox, entrambe leggevano il marcatore e ENTRAMBE chiamavano `video_job_ready`: la seconda
    // prendeva un `OUTPUT_CONFLICT` su una conversione riuscita.
    expect(a.pronti.length + b.pronti.length, 'un solo `video_job_ready`').toBe(1)
    expect(sa.nomi.length + sb.nomi.length, 'una sola MicroVM').toBe(1)
    expect(b.prese, 'chi ha perso non ha nemmeno preso il job').toEqual([])
    // E al termine nessuno sorveglia più niente: il rilascio ha liberato il job.
    expect(sorveglianza.tenute().size).toBe(0)
  })

  it('chi ha finito rilascia: il calcio dopo, sullo stesso job, trova la sorveglianza libera', async () => {
    const sorveglianza = sorveglianzaInMemoria()
    const prima = codaFinta({ sorveglianza })
    await eseguiUnJobVideo(
      dipendenze(prima.coda, sandboxFinta({ risposta: rispostaSenzaMarcatore }).macchina),
      CALCIO,
    )

    const seconda = codaFinta({ sorveglianza })
    const esito = await eseguiUnJobVideo(
      dipendenze(seconda.coda, sandboxFinta({ risposta: rispostaFelice() }).macchina, {
        invocazione: INVOCAZIONE_B,
      }),
      CALCIO,
    )

    // La prima è uscita con `in-corso` (la conversione continua), ma ha RILASCIATO: chi riaggancia dopo di
    // lei non aspetta che scada la lease di sorveglianza.
    expect(esito).toMatchObject({ esito: 'pronto' })
  })

  it.each<[string, Parameters<typeof lancia>[0], EsitoRunnerVideo['esito']]>([
    ['la conversione riesce', {}, 'pronto'],
    [
      'il file è rifiutato',
      { risposta: apparecchioConProbe(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })) },
      'fallito',
    ],
    ['un guasto nostro: si ritenta', { apriFallisce: true }, 'in-riprova'],
    ['la conversione continua oltre l’invocazione', { risposta: rispostaSenzaMarcatore }, 'in-corso'],
    [
      'la lease è persa',
      { risposta: rispostaSenzaMarcatore, coda: { battito: { ok: false, code: 'FENCE_MISMATCH' } } },
      'lease-persa',
    ],
    ['l’esito non si scrive', { coda: { pronto: { ok: false, code: 'OUTPUT_CONFLICT' } } }, 'esito-non-scritto'],
  ])('comunque vada (%s) la sorveglianza si rilascia, e UNA volta sola', async (_nome, opzioni, atteso) => {
    const { esito, c } = await lancia({ ...opzioni, richiesta: CALCIO })

    expect(esito.esito).toBe(atteso)
    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
  })

  it('se il lavoro LANCIA (un’eccezione che non è dell’SDK), la sorveglianza si rilascia lo stesso e l’eccezione non si perde', async () => {
    const c = codaFinta({ pronto: new Error('database non raggiungibile') })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await expect(eseguiUnJobVideo(dipendenze(c.coda, s.macchina), CALCIO)).rejects.toThrow(
      'database non raggiungibile',
    )

    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
    // Non è un guasto dell'SDK: non si trasforma in un ritentativo (un job già `ready` non si riprova).
    expect(c.ritentati).toEqual([])
  })

  it('`CAPACITA_PIENA`: `capacita-piena` col job, la MicroVM non si apre, la sorveglianza (che si aveva) si rilascia', async () => {
    const { esito, c, s } = await lancia({
      richiesta: CALCIO,
      coda: { prendi: { ok: false, code: 'CAPACITA_PIENA' } },
    })

    expect(esito).toEqual({ esito: 'capacita-piena', jobId: JOB_ID })
    nienteDaFare(s, c)
    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
    // Il tetto che regge non è un guasto: nessuna riga `error` o `warn`, e nessun testimone (non c'è
    // una conversione che continua).
    expect(righeDiLog().filter((r) => r[1] === 'error' || r[1] === 'warn')).toEqual([])
    expect(c.ventagli).toEqual([])
  })

  it.each(['INVALID_STATE', 'INTENT_INACTIVE'])(
    'un job già finito o ritirato (%s) non è un guasto: non c’è niente da fare',
    async (code) => {
      const { esito, c, s } = await lancia({ richiesta: CALCIO, coda: { prendi: { ok: false, code } } })

      expect(esito).toEqual({ esito: 'coda-vuota' })
      nienteDaFare(s, c)
      expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
      expect(righeDiLog().filter((r) => r[1] === 'error')).toEqual([])
    },
  )

  it('`RETRY_NOT_DUE` — il calcio su un job che aspetta il prossimo tentativo — è «niente da fare ADESSO», NON un `error` (secondario #101)', async () => {
    // `video_job_claim`, delegato da `video_job_prendi`, risponde `RETRY_NOT_DUE` a un job che un guasto nostro ha
    // rimesso in coda con la sua attesa (5, 10, 15 minuti). Il calcio c'è stato (il `PATCH caricato`, il ventaglio)
    // e il job non è ancora dovuto: a riprenderlo ci pensa il giro del cron a scadenza. Prima di T8 questo dava una
    // `presa-rifiutata` con una riga `error`, cioè un allarme per un funzionamento normale — e un allarme che suona
    // per niente si impara a ignorare.
    const { esito, c, s } = await lancia({ richiesta: CALCIO, coda: { prendi: { ok: false, code: 'RETRY_NOT_DUE' } } })

    expect(esito).toEqual({ esito: 'coda-vuota' })
    nienteDaFare(s, c)
    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
    expect(conEsito('presa-rifiutata')).toEqual([])
    expect(righeDiLog().filter((r) => r[1] === 'error' || r[1] === 'warn')).toEqual([])
  })

  it.each(['LEASE_ACTIVE', 'NOT_FOUND', 'RPC_ERROR'])(
    'ogni altro rifiuto della presa (%s) resta una `presa-rifiutata`, a livello `error`, col job',
    async (code) => {
      const { esito, c, s } = await lancia({ richiesta: CALCIO, coda: { prendi: { ok: false, code } } })

      expect(esito).toEqual({ esito: 'presa-rifiutata', codice: code })
      nienteDaFare(s, c)
      expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
      const log = riga('presa-rifiutata')
      expect(log[1]).toBe('error')
      expect(log[2]).toMatchObject({ error_code: code, job_id: JOB_ID })
    },
  )

  it('la sorveglianza su un job che non è né in coda né in lavorazione (`INVALID_STATE`): niente da fare, niente da rilasciare', async () => {
    const { esito, c, s } = await lancia({
      richiesta: CALCIO,
      coda: { sorveglianzaPrendi: { ok: false, code: 'INVALID_STATE' } },
    })

    expect(esito).toEqual({ esito: 'coda-vuota' })
    nienteDaFare(s, c)
    expect(c.prese).toEqual([])
    expect(c.rilasci).toEqual([])
  })

  it.each(['NOT_FOUND', 'BAD_INPUT', 'RPC_ERROR'])(
    'la sorveglianza rifiutata per un motivo vero (%s) è una `presa-rifiutata` a `error`, e non si va avanti',
    async (code) => {
      const { esito, c, s } = await lancia({
        richiesta: CALCIO,
        coda: { sorveglianzaPrendi: { ok: false, code } },
      })

      expect(esito).toEqual({ esito: 'presa-rifiutata', codice: code })
      nienteDaFare(s, c)
      // Senza la sorveglianza non si prende il job: sarebbe lo stato che la sorveglianza esclusiva vieta.
      expect(c.prese).toEqual([])
      expect(c.rilasci).toEqual([])
      const log = riga('sorveglianza-rifiutata')
      expect(log[1]).toBe('error')
      expect(log[2]).toMatchObject({ error_code: code, job_id: JOB_ID })
    },
  )

  it('un rilascio che non riesce NON cambia l’esito, e si vede (`warn`): la lease scade da sé', async () => {
    for (const rilascio of [
      { ok: false, code: 'NOT_FOUND' } as EsitoBattito,
      new Error('rete giù'),
    ]) {
      h.log.length = 0
      const { esito } = await lancia({ richiesta: CALCIO, coda: { sorveglianzaRilascia: rilascio } })

      // Il video è pronto lo stesso: una sorveglianza non rilasciata è un ritardo per chi viene dopo, non
      // un guasto di questa conversione.
      expect(esito.esito).toBe('pronto')
      const log = riga('sorveglianza-non-rilasciata')
      expect(log[1]).toBe('warn')
      expect(log[2]).toMatchObject({ job_id: JOB_ID })
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 11. IL TETTO DELLE CONVERSIONI IN PARALLELO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · il tetto delle conversioni in parallelo', () => {
  /** Un calcio per un job, con un Sandbox la cui conversione non finisce mai: il posto resta occupato. */
  async function calcia(capacita: ReturnType<typeof capacitaInMemoria>, jobId: string, tetto: number) {
    const c = codaFinta({ prendi: (id, t) => capacita.prendi(id, t) })
    const s = sandboxFinta({ risposta: rispostaSenzaMarcatore })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina, { tettoConversioni: tetto }), { jobId })
    return { esito, c, s }
  }

  it('con tetto 3, il quarto job in parallelo trova `capacita-piena`: niente MicroVM, il job resta dov’è', async () => {
    const capacita = capacitaInMemoria()
    const esiti: EsitoRunnerVideo[] = []
    const sandbox: ReturnType<typeof sandboxFinta>[] = []

    for (const id of [JOB_ID, ALTRO_JOB, TERZO_JOB, QUARTO_JOB]) {
      const r = await calcia(capacita, id, 3)
      esiti.push(r.esito)
      sandbox.push(r.s)
    }

    expect(esiti.map((e) => e.esito)).toEqual(['in-corso', 'in-corso', 'in-corso', 'capacita-piena'])
    expect(esiti[3]).toEqual({ esito: 'capacita-piena', jobId: QUARTO_JOB })
    // Tre MicroVM aperte e una no: il tetto è rispettato a livello di PROCESSI veri, non di contatori.
    expect(sandbox.map((s) => s.nomi.length)).toEqual([1, 1, 1, 0])
    expect(capacita.inLavorazione().size).toBe(3)
  })

  it('un job GIÀ mio e vivo (il riaggancio di una conversione lunga) non occupa un posto in più', async () => {
    const capacita = capacitaInMemoria()
    for (const id of [JOB_ID, ALTRO_JOB, TERZO_JOB]) await calcia(capacita, id, 3)

    // I tre posti sono occupati; il primo job viene riagganciato dal testimone/dal tick dopo.
    const { esito } = await calcia(capacita, JOB_ID, 3)

    expect(esito.esito).toBe('in-corso')
  })

  it('il tetto che si passa è QUELLO delle dipendenze, a ogni presa — del calcio e del giro', async () => {
    const calcio = await lancia({ richiesta: CALCIO, dipendenze: { tettoConversioni: 2 } })
    expect(calcio.c.richiestePrese.map((r) => r.tetto)).toEqual([2])

    h.log.length = 0
    const giro = await lancia({ dipendenze: { tettoConversioni: 7 } })
    expect(giro.c.richiesteProssimo.map((r) => r.tetto)).toEqual([7])
    // …e lo stesso numero va al ventaglio, che calcia fino ai posti liberi.
    expect(giro.c.ventagli.map((v) => v.tetto)).toEqual([7])

    // Anche la RIPRESA di un job mio, dentro il giro, passa da `video_job_prendi` e porta il tetto: è la terza
    // delle quattro prese (calcio, giro che pesca, giro che riprende, ventaglio) e la sola che nessun'altra
    // asserzione guardava — con un numero fisso lì, un tetto diverso da 3 varrebbe per tutte le altre e non per lei.
    h.log.length = 0
    const ripresa = await lancia({
      nuova: false,
      risposta: rispostaSenzaMarcatore,
      coda: { miei: [job()] },
      dipendenze: { tettoConversioni: 5 },
    })
    expect(ripresa.c.prese, 'il giro doveva RIPRENDERE il suo job, non pescarne uno').toEqual([JOB_ID])
    expect(ripresa.c.richiestePrese.map((r) => r.tetto)).toEqual([5])
    expect(ripresa.c.richiesteProssimo).toEqual([])
  })

  it('nel giro, `CAPACITA_PIENA` da `prossimo` è `capacita-piena` (senza job) e non una presa rifiutata', async () => {
    const { esito, c, s } = await lancia({ coda: { prossimo: { ok: false, code: 'CAPACITA_PIENA' } } })

    expect(esito).toEqual({ esito: 'capacita-piena' })
    // Senza la chiave `jobId`: la route la scrive nel battito solo se c'è.
    expect(Object.keys(esito)).toEqual(['esito'])
    nienteDaFare(s, c)
    expect(righeDiLog().filter((r) => r[1] === 'error' || r[1] === 'warn')).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 12. IL GIRO DEL CRON (senza `job_id`)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · il giro del cron', () => {
  /** Un punto d'aggancio che scrive il proprio momento nello stesso registro delle chiamate alla coda. */
  const aggancioCheRegistra =
    (ordine: string[]) =>
    async ({ quando }: ContestoPubblicazioni) => {
      ordine.push(`pubblicazioni:${quando}`)
    }

  it('un job nuovo: arrivi → `miei` → ventaglio → pubblicazioni → presa → sorveglianza → rilascio → pubblicazioni', async () => {
    const ordine: string[] = []
    const { esito, c } = await lancia({
      coda: { ordine },
      dipendenze: { pubblicazioni: aggancioCheRegistra(ordine) },
    })

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    expect(ordine).toEqual([
      'arriviRecupera',
      'miei',
      'ventaglio:nessuno',
      'pubblicazioni:giro',
      'prossimo',
      `sorveglianzaPrendi:${JOB_ID}`,
      `sorveglianzaRilascia:${JOB_ID}`,
      'pubblicazioni:dopo-esito',
    ])
    // I numeri: gli arrivi si recuperano a cinquanta alla volta, la presa porta il tetto, la sorveglianza dura 270 s.
    expect(c.arrivi).toEqual([50])
    expect(c.richiesteProssimo).toEqual([{ leaseOwner: WORKER, leaseSeconds: SECONDI_LEASE_PRESA, tetto: TETTO }])
    expect(c.sorveglianze).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE, secondi: SECONDI_SORVEGLIANZA }])
    // Il job di un giro è PRESO prima di essere sorvegliato (solo la presa dice qual è): la presa non
    // passa da `prendi`, che è del calcio e della ripresa.
    expect(c.prese).toEqual([])
  })

  it('un job mio che nessuno sorveglia: se ne prende la sorveglianza PRIMA del ventaglio, che lo ESCLUDE (un JOB, non un’invocazione)', async () => {
    const ordine: string[] = []
    const { esito, c, s } = await lancia({
      nuova: false,
      coda: { ordine, miei: [job({ fence_epoch: 5 })] },
      dipendenze: { pubblicazioni: aggancioCheRegistra(ordine) },
    })

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    expect(ordine).toEqual([
      'arriviRecupera',
      'miei',
      `sorveglianzaPrendi:${JOB_ID}`,
      `ventaglio:${JOB_ID}`,
      'pubblicazioni:giro',
      `prendi:${JOB_ID}`,
      `sorveglianzaRilascia:${JOB_ID}`,
      'pubblicazioni:dopo-esito',
    ])
    // SECONDARIO #39: `p_escludi` è un JOB. Passare l'id dell'invocazione non avrebbe escluso niente.
    expect(c.ventagli).toEqual([{ tetto: TETTO, escludi: JOB_ID }])
    expect(c.ventagli[0].escludi).not.toBe(INVOCAZIONE)
    // Riprende lo STESSO Sandbox (stesso fence), senza riapparecchiare né riavviare.
    expect(s.nomi).toEqual([nomeSandboxVideo(JOB_ID, 5)])
    expect(s.avviati).toEqual([])
    // Un job mio ha la precedenza: non se ne pesca uno nuovo.
    expect(c.richiesteProssimo).toEqual([])
  })

  it('di più job miei: salta quelli che un’altra invocazione sorveglia già e prende il primo libero', async () => {
    const primo = job({ id: JOB_ID })
    const secondo = job({ id: ALTRO_JOB })
    const { c } = await lancia({
      nuova: false,
      coda: {
        miei: [primo, secondo],
        sorveglianzaPrendi: (jobId) =>
          jobId === JOB_ID ? { ok: false, code: 'GIA_SORVEGLIATO' } : { ok: true },
        prendi: (jobId) => ({ ok: true, job: job({ id: jobId }) }),
      },
    })

    expect(c.sorveglianze.map((x) => x.jobId)).toEqual([JOB_ID, ALTRO_JOB])
    expect(c.prese).toEqual([ALTRO_JOB])
    expect(c.ventagli[0].escludi).toBe(ALTRO_JOB)
    // Rilascia solo la sua.
    expect(c.rilasci.map((x) => x.jobId)).toEqual([ALTRO_JOB])
  })

  it('se TUTTI i miei sono già sorvegliati da altri, il giro pesca un job nuovo (e il ventaglio non esclude niente)', async () => {
    const { esito, c } = await lancia({
      coda: {
        miei: [job({ id: JOB_ID })],
        prossimo: { ok: true, job: job({ id: ALTRO_JOB }) },
        sorveglianzaPrendi: (jobId) =>
          jobId === JOB_ID ? { ok: false, code: 'GIA_SORVEGLIATO' } : { ok: true },
      },
    })

    expect(esito).toMatchObject({ esito: 'pronto', jobId: ALTRO_JOB })
    expect(c.ventagli).toEqual([{ tetto: TETTO, escludi: null }])
    expect(c.prese).toEqual([])
    expect(c.richiesteProssimo).toHaveLength(1)
  })

  it('la sorveglianza di un job mio che non si prende per un motivo VERO (non «già sorvegliato») si vede, e si prosegue', async () => {
    const { esito } = await lancia({
      coda: {
        miei: [job({ id: JOB_ID })],
        prossimo: { ok: true, job: job({ id: ALTRO_JOB }) },
        sorveglianzaPrendi: (jobId) =>
          jobId === JOB_ID ? { ok: false, code: 'RPC_ERROR' } : { ok: true },
      },
    })

    expect(esito).toMatchObject({ esito: 'pronto', jobId: ALTRO_JOB })
    const log = riga('sorveglianza-non-presa')
    expect(log[1]).toBe('warn')
    expect(log[2]).toMatchObject({ error_code: 'RPC_ERROR', job_id: JOB_ID })
  })

  it('`GIA_SORVEGLIATO` e `INVALID_STATE` di un job mio sono il caso normale: nessuna riga', async () => {
    await lancia({
      coda: {
        miei: [job({ id: ALTRO_JOB }), job({ id: TERZO_JOB })],
        sorveglianzaPrendi: (jobId) =>
          jobId === ALTRO_JOB ? { ok: false, code: 'GIA_SORVEGLIATO' } : { ok: false, code: 'INVALID_STATE' },
      },
    })

    expect(conEsito('sorveglianza-non-presa')).toEqual([])
  })

  it('`miei` che non si legge: si grida (`error`), perché ogni conversione lunga si rifarebbe da capo, e si pesca un job nuovo', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })
    const ricerca = c.coda.miei
    c.coda.miei = async (...a) => {
      await ricerca(...a)
      return { ok: false, motivo: 'SELECT_ERROR' }
    }

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toMatchObject({ esito: 'pronto' })
    const log = riga('ripresa-non-interrogabile')
    expect(log[1]).toBe('error')
    expect(log[2]).toMatchObject({ error_code: 'SELECT_ERROR' })
  })

  it('una ripresa rifiutata (la lease è scaduta fra la lettura e la presa): `warn`, la sorveglianza si rilascia e si pesca un job nuovo', async () => {
    const { esito, c } = await lancia({
      coda: {
        miei: [job({ id: JOB_ID })],
        prendi: { ok: false, code: 'LEASE_ACTIVE' },
        prossimo: { ok: true, job: job({ id: ALTRO_JOB }) },
      },
    })

    expect(esito).toMatchObject({ esito: 'pronto', jobId: ALTRO_JOB })
    const log = riga('ripresa-rifiutata')
    expect(log[1]).toBe('warn')
    expect(log[2]).toMatchObject({ error_code: 'LEASE_ACTIVE', job_id: JOB_ID })
    // Ha rilasciato la sorveglianza del primo PRIMA di prendere l'altro: un giro ne tiene una per volta.
    expect(c.rilasci.map((x) => x.jobId)).toEqual([JOB_ID, ALTRO_JOB])
  })

  it('un job mio che la capacità non lascia riprendere: `capacita-piena` col job, e la sorveglianza si rilascia', async () => {
    const { esito, c, s } = await lancia({
      coda: { miei: [job({ id: JOB_ID })], prendi: { ok: false, code: 'CAPACITA_PIENA' } },
    })

    expect(esito).toEqual({ esito: 'capacita-piena', jobId: JOB_ID })
    nienteDaFare(s, c)
    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
    // Non si pesca un job nuovo: il tetto è pieno anche per lui.
    expect(c.richiesteProssimo).toEqual([])
  })

  it('un job nuovo che un calcio ha già in sorveglianza: `gia-sorvegliato` col job, e non si lavora né si rilascia', async () => {
    const { esito, c, s } = await lancia({
      coda: { sorveglianzaPrendi: { ok: false, code: 'GIA_SORVEGLIATO' } },
    })

    expect(esito).toEqual({ esito: 'gia-sorvegliato', jobId: JOB_ID })
    nienteDaFare(s, c)
    expect(c.rilasci).toEqual([])
  })

  it.each([
    ['`EMPTY_QUEUE` è `coda-vuota`', { ok: false, code: 'EMPTY_QUEUE' } as EsitoRpcVideo, { esito: 'coda-vuota' }],
    [
      'un altro rifiuto è `presa-rifiutata`',
      { ok: false, code: 'LEASE_ACTIVE' } as EsitoRpcVideo,
      { esito: 'presa-rifiutata', codice: 'LEASE_ACTIVE' },
    ],
  ])('la coda: %s, e le pubblicazioni NON si richiamano dopo (non c’è nessun esito definitivo)', async (_nome, prossimo, atteso) => {
    const chiamate: string[] = []
    const { esito } = await lancia({
      coda: { prossimo },
      dipendenze: { pubblicazioni: async ({ quando }) => void chiamate.push(quando) },
    })

    expect(esito).toEqual(atteso)
    expect(chiamate).toEqual(['giro'])
  })

  describe('la rete e il ventaglio non fermano mai il giro', () => {
    it.each([
      ['arrivi: la chiamata non arriva (`RPC_ERROR`)', { arriviRecupera: { ok: false, code: 'RPC_ERROR' } as EsitoConteggi }, null],
      ['arrivi: un verdetto (`BAD_INPUT`)', { arriviRecupera: { ok: false, code: 'BAD_INPUT' } as EsitoConteggi }, 'arrivi-recupera-rifiutata'],
      ['arrivi: l’adattatore LANCIA', { arriviRecupera: new Error('rete giù') }, 'arrivi-recupera-eccezione'],
      ['ventaglio: la chiamata non arriva (`RPC_ERROR`)', { ventaglio: { ok: false, code: 'RPC_ERROR' } as EsitoConteggi }, null],
      ['ventaglio: un verdetto (`BAD_INPUT`)', { ventaglio: { ok: false, code: 'BAD_INPUT' } as EsitoConteggi }, 'ventaglio-rifiutato'],
      ['ventaglio: l’adattatore LANCIA', { ventaglio: new Error('rete giù') }, 'ventaglio-eccezione'],
    ])('%s: il job si converte lo stesso', async (_nome, coda, evento) => {
      const { esito } = await lancia({ coda })

      expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
      if (evento === null) {
        // Il trasporto che cade lo scrive già l'adattatore (`rpc-non-riuscita`): qui non si raddoppia.
        expect(righeDiLog().filter((r) => r[1] === 'error' || r[1] === 'warn')).toEqual([])
      } else {
        expect(conEsito(evento)).toHaveLength(1)
        expect(riga(evento)[1]).toBe(evento.endsWith('-eccezione') ? 'error' : 'warn')
      }
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 13. IL PUNTO D'AGGANCIO DELLE PUBBLICAZIONI (T7) E IL TESTIMONE
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · il punto d’aggancio delle pubblicazioni (di T7: qui solo QUANDO si chiama)', () => {
  /** Lancia con un aggancio che registra ogni chiamata. */
  async function conAggancio(opzioni: Parameters<typeof lancia>[0] = {}) {
    const chiamate: ContestoPubblicazioni[] = []
    const r = await lancia({
      ...opzioni,
      dipendenze: {
        ...opzioni.dipendenze,
        pubblicazioni: async (contesto) => void chiamate.push(contesto),
      },
    })
    return { ...r, chiamate }
  }

  it('nel giro si chiama UNA volta PRIMA di sorvegliare, col tempo che resta (`240 s` se non ne è passato)', async () => {
    const { chiamate } = await conAggancio({ risposta: rispostaSenzaMarcatore })

    // `in-corso`: nessun esito definitivo, quindi solo la chiamata del giro.
    expect(chiamate).toEqual([{ quando: 'giro', restanteMs: TETTO_INVOCAZIONE_MS }])
  })

  it.each<[string, Parameters<typeof lancia>[0], EsitoRunnerVideo['esito']]>([
    ['un job pronto', {}, 'pronto'],
    [
      'un job fallito in modo definitivo',
      { risposta: apparecchioConProbe(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })) },
      'fallito',
    ],
  ])('dopo ogni esito DEFINITIVO si richiama, subito: %s (il calcio e il giro)', async (_nome, opzioni, atteso) => {
    const calcio = await conAggancio({ ...opzioni, richiesta: CALCIO })
    expect(calcio.esito.esito).toBe(atteso)
    // Il calcio non fa il giro: l'unica chiamata è quella dopo l'esito.
    expect(calcio.chiamate.map((c) => c.quando)).toEqual(['dopo-esito'])

    h.log.length = 0
    const giro = await conAggancio(opzioni)
    expect(giro.esito.esito).toBe(atteso)
    expect(giro.chiamate.map((c) => c.quando)).toEqual(['giro', 'dopo-esito'])
  })

  it.each<[string, Parameters<typeof lancia>[0], EsitoRunnerVideo['esito']]>([
    ['la conversione continua', { risposta: rispostaSenzaMarcatore }, 'in-corso'],
    ['un guasto nostro: si ritenta', { apriFallisce: true }, 'in-riprova'],
    [
      'la lease è persa',
      { risposta: rispostaSenzaMarcatore, coda: { battito: { ok: false, code: 'FENCE_MISMATCH' } } },
      'lease-persa',
    ],
    ['l’esito non si scrive', { coda: { pronto: { ok: false, code: 'OUTPUT_CONFLICT' } } }, 'esito-non-scritto'],
    ['capacità piena', { coda: { prendi: { ok: false, code: 'CAPACITA_PIENA' } } }, 'capacita-piena'],
    ['già sorvegliato', { coda: { sorveglianzaPrendi: { ok: false, code: 'GIA_SORVEGLIATO' } } }, 'gia-sorvegliato'],
  ])('NON si richiama dopo un esito che non è definitivo: %s', async (_nome, opzioni, atteso) => {
    const { esito, chiamate } = await conAggancio({ ...opzioni, richiesta: CALCIO })

    expect(esito.esito).toBe(atteso)
    expect(chiamate).toEqual([])
  })

  it('l’aggancio che LANCIA non ferma il runner e non cambia l’esito: si logga (`error`) e si prosegue', async () => {
    for (const quando of ['giro', 'dopo-esito'] as const) {
      h.log.length = 0
      const { esito, c } = await lancia({
        dipendenze: {
          pubblicazioni: async (contesto) => {
            if (contesto.quando === quando) throw new Error('la pubblicazione è esplosa')
          },
        },
      })

      // Una pubblicazione che esplode non può costare una conversione né un esito già scritto.
      expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
      expect(c.pronti).toHaveLength(1)
      const log = riga('pubblicazioni-eccezione')
      expect(log[1]).toBe('error')
      expect(log[2]).toMatchObject({ azione: quando })
      expect(comeInTabella(log).messaggio).toContain('la pubblicazione è esplosa')
    }
  })

  it('senza aggancio (T7 non c’è ancora) non succede niente: il runner funziona uguale', async () => {
    const { esito } = await lancia()
    expect(esito).toMatchObject({ esito: 'pronto' })
    expect(conEsito('pubblicazioni-eccezione')).toEqual([])
  })
})

describe('runner video · il testimone: chi esce con `in-corso` rifà il ventaglio, DOPO aver rilasciato', () => {
  it('rilascia la sorveglianza, POI rifà il ventaglio senza escludere niente', async () => {
    const ordine: string[] = []
    const { esito, c } = await lancia({
      richiesta: CALCIO,
      risposta: rispostaSenzaMarcatore,
      coda: { ordine, ventaglio: { ok: true, conteggi: { candidati: 1, calciati: 1 } } },
    })

    expect(esito).toEqual({ esito: 'in-corso', jobId: JOB_ID })
    // L'ORDINE è la sostanza: un ventaglio PRIMA del rilascio calcerebbe il job mentre questa invocazione lo
    // sorveglia ancora, e il successore troverebbe `gia-sorvegliato` — cioè nessun successore.
    expect(ordine).toEqual([
      `sorveglianzaPrendi:${JOB_ID}`,
      `prendi:${JOB_ID}`,
      `sorveglianzaRilascia:${JOB_ID}`,
      'ventaglio:nessuno',
    ])
    expect(c.ventagli).toEqual([{ tetto: TETTO, escludi: null }])
    const log = riga('testimone-passato')
    expect(log[1]).toBe('info')
    expect(log[2]).toMatchObject({ candidati: 1, calciati: 1 })
  })

  it('il testimone calcia fino ai posti liberi del tetto CONFIGURATO, non di un numero scritto nel codice', async () => {
    // Con il tetto di default (3) un numero fisso sarebbe invisibile: qui è 6, e il ventaglio deve riceverlo.
    const { c } = await lancia({
      richiesta: CALCIO,
      risposta: rispostaSenzaMarcatore,
      dipendenze: { tettoConversioni: 6 },
    })

    expect(c.ventagli).toEqual([{ tetto: 6, escludi: null }])
  })

  it('anche il giro del cron, se il suo job continua, passa il testimone (dopo aver fatto il proprio ventaglio)', async () => {
    const ordine: string[] = []
    const { esito } = await lancia({ risposta: rispostaSenzaMarcatore, coda: { ordine } })

    expect(esito.esito).toBe('in-corso')
    expect(ordine.filter((x) => x.startsWith('ventaglio:'))).toEqual(['ventaglio:nessuno', 'ventaglio:nessuno'])
    expect(ordine[ordine.length - 1], 'il testimone è l’ultima cosa').toBe('ventaglio:nessuno')
    expect(ordine.indexOf(`sorveglianzaRilascia:${JOB_ID}`)).toBeLessThan(ordine.lastIndexOf('ventaglio:nessuno'))
  })

  it('se nessun calcio parte (`pg_net` assente, URL mancante) lo dice: `warn`, perché la catena torna al cron', async () => {
    await lancia({
      richiesta: CALCIO,
      risposta: rispostaSenzaMarcatore,
      coda: { ventaglio: { ok: true, conteggi: { candidati: 1, calciati: 0 } } },
    })

    expect(riga('testimone-passato')[1]).toBe('warn')
  })

  it('con zero candidati non è un guasto: `info`', async () => {
    await lancia({
      richiesta: CALCIO,
      risposta: rispostaSenzaMarcatore,
      coda: { ventaglio: { ok: true, conteggi: { candidati: 0, calciati: 0 } } },
    })

    expect(riga('testimone-passato')[1]).toBe('info')
  })

  it.each([
    ['un verdetto', { ventaglio: { ok: false, code: 'BAD_INPUT' } as EsitoConteggi }, 'testimone-rifiutato'],
    ['l’adattatore che lancia', { ventaglio: new Error('rete giù') }, 'testimone-eccezione'],
  ])('un ventaglio che non riesce (%s) non cambia l’esito: la conversione continua comunque', async (_nome, coda, evento) => {
    const { esito, s } = await lancia({ richiesta: CALCIO, risposta: rispostaSenzaMarcatore, coda })

    expect(esito).toEqual({ esito: 'in-corso', jobId: JOB_ID })
    // La MicroVM resta accesa: è lì che sta girando la conversione.
    expect(s.fermate()).toBe(0)
    expect(conEsito(evento)).toHaveLength(1)
  })

  it('il trasporto che cade (`RPC_ERROR`) lo scrive l’adattatore: qui nessuna riga in più', async () => {
    await lancia({
      richiesta: CALCIO,
      risposta: rispostaSenzaMarcatore,
      coda: { ventaglio: { ok: false, code: 'RPC_ERROR' } },
    })

    expect(conEsito('testimone-rifiutato')).toEqual([])
    expect(conEsito('testimone-passato')).toEqual([])
  })

  it('NON si passa il testimone se la conversione non continua (pronto, fallito, in riprova, lease persa, rifiuti)', async () => {
    for (const opzioni of [
      {},
      { apriFallisce: true },
      { risposta: rispostaSenzaMarcatore, coda: { battito: { ok: false, code: 'FENCE_MISMATCH' } } },
      { coda: { prendi: { ok: false, code: 'CAPACITA_PIENA' } } },
      { coda: { sorveglianzaPrendi: { ok: false, code: 'GIA_SORVEGLIATO' } } },
    ] as NonNullable<Parameters<typeof lancia>[0]>[]) {
      const { c } = await lancia({ ...opzioni, richiesta: CALCIO })
      // Il calcio non fa il suo ventaglio: se ce n'è uno, è il testimone.
      expect(c.ventagli, JSON.stringify(Object.keys(opzioni))).toEqual([])
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 14. IL BUDGET DELLA SORVEGLIANZA: 240 s MENO IL TEMPO GIÀ SPESO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · il budget della sorveglianza è 240 s meno il tempo già speso', () => {
  /** Il tempo che questa invocazione ha consumato in tutto, dall'inizio alla fine, secondo l'orologio finto. */
  async function trascorso(opzioni: Parameters<typeof lancia>[0]) {
    const orologio = orologioFinto()
    const inizio = orologio.adesso()
    const r = await lancia({ ...opzioni, orologio })
    return { ...r, ms: orologio.adesso() - inizio, orologio }
  }

  it('senza tempo speso la sorveglianza dura il tetto intero: 240 s (a meno di un periodo di sonda)', async () => {
    const { esito, ms } = await trascorso({ risposta: rispostaSenzaMarcatore })

    expect(esito.esito).toBe('in-corso')
    expect(ms).toBeGreaterThanOrEqual(TETTO_INVOCAZIONE_MS - PERIODO_SONDA_MS)
    expect(ms).toBeLessThanOrEqual(TETTO_INVOCAZIONE_MS + PERIODO_SONDA_MS)
  })

  it('un giro che spende 100 s PRIMA di sorvegliare (arrivi, ventaglio, pubblicazioni) sorveglia per 140 s, non per 240', async () => {
    const orologio = orologioFinto()
    const inizio = orologio.adesso()
    const { esito } = await lancia({
      orologio,
      risposta: rispostaSenzaMarcatore,
      dipendenze: { pubblicazioni: async () => orologio.avanza(100_000) },
    })

    expect(esito.esito).toBe('in-corso')
    const ms = orologio.adesso() - inizio
    // L'invocazione intera finisce a 240 s DALL'INIZIO, non a 100 + 240: con la misura vecchia (240 s dal
    // momento in cui si comincia a sorvegliare) sarebbero 340 s, cioè fuori dai 300 della piattaforma.
    expect(ms).toBeLessThanOrEqual(TETTO_INVOCAZIONE_MS + PERIODO_SONDA_MS)
    expect(ms).toBeGreaterThanOrEqual(TETTO_INVOCAZIONE_MS - PERIODO_SONDA_MS)
  })

  it('anche il tempo dell’apertura e dell’apparecchio è «già speso»: 60 s di apparecchio ⇒ 180 s di sorveglianza', async () => {
    const orologio = orologioFinto()
    const inizio = orologio.adesso()
    const { esito } = await lancia({
      orologio,
      richiesta: CALCIO,
      risposta: (cmd) => {
        if (eApparecchio(cmd)) orologio.avanza(60_000)
        return rispostaSenzaMarcatore(cmd)
      },
    })

    expect(esito.esito).toBe('in-corso')
    const ms = orologio.adesso() - inizio
    expect(ms).toBeLessThanOrEqual(TETTO_INVOCAZIONE_MS + PERIODO_SONDA_MS)
    expect(ms).toBeGreaterThanOrEqual(TETTO_INVOCAZIONE_MS - PERIODO_SONDA_MS)
  })

  it('con il budget già esaurito non si sorveglia: un solo controllo del marcatore, nessun battito, e si esce subito', async () => {
    const orologio = orologioFinto()
    const inizio = orologio.adesso()
    const { esito, c, s } = await lancia({
      orologio,
      risposta: rispostaSenzaMarcatore,
      // 300 s spesi PRIMA: il budget è 240 − 300 = −60, e non può essere negativo.
      dipendenze: { pubblicazioni: async () => orologio.avanza(300_000) },
    })

    expect(esito.esito).toBe('in-corso')
    expect(s.marcatoriLetti(), 'si guarda comunque se la conversione ha già finito').toBe(1)
    expect(c.battiti()).toBe(0)
    // Nessuna pausa: l'invocazione non spende un secondo di più di quello che già ha speso.
    expect(orologio.adesso() - inizio).toBe(300_000)
  })

  it('con il budget esaurito una conversione che ha GIÀ finito si conclude comunque (il marcatore si legge una volta)', async () => {
    const orologio = orologioFinto()
    const { esito } = await lancia({
      orologio,
      nuova: false,
      risposta: rispostaFelice(),
      coda: { miei: [job({ fence_epoch: 5 })] },
      dipendenze: {
        pubblicazioni: async ({ quando }) => {
          if (quando === 'giro') orologio.avanza(300_000)
        },
      },
    })

    // La conversione è finita mentre si facevano altre cose: l'esito si scrive, non si rimanda al giro dopo.
    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
  })

  it('il tempo che resta passato all’aggancio è `240 s` meno quello speso, e mai negativo', async () => {
    const orologio = orologioFinto()
    const viste: number[] = []
    await lancia({
      orologio,
      risposta: rispostaSenzaMarcatore,
      dipendenze: {
        pubblicazioni: async ({ restanteMs }) => {
          viste.push(restanteMs)
          orologio.avanza(300_000)
        },
      },
    })
    expect(viste).toEqual([TETTO_INVOCAZIONE_MS])

    // Una seconda chiamata, a budget esaurito, vede 0 e non un numero negativo.
    const orologio2 = orologioFinto()
    const viste2: number[] = []
    await lancia({
      orologio: orologio2,
      dipendenze: {
        pubblicazioni: async ({ restanteMs }) => {
          viste2.push(restanteMs)
          orologio2.avanza(300_000)
        },
      },
    })
    // Giro (240 s) e dopo-esito (budget esaurito: 0).
    expect(viste2).toEqual([TETTO_INVOCAZIONE_MS, 0])
  })

  it('il tetto dell’invocazione delle dipendenze è quello che conta (una prova con un tetto corto)', async () => {
    const orologio = orologioFinto()
    const inizio = orologio.adesso()
    await lancia({
      orologio,
      richiesta: CALCIO,
      risposta: rispostaSenzaMarcatore,
      dipendenze: { tettoInvocazioneMs: 90_000 },
    })

    expect(orologio.adesso() - inizio).toBeLessThanOrEqual(90_000 + PERIODO_SONDA_MS)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 15. SECONDARIO #9 — IL TIMEOUT DELLA SONDA TEMPORALE È PROPORZIONALE
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · il timeout della sonda temporale arriva dal probe (secondario #9)', () => {
  /** Un apparecchio che racconta questo probe, e una conversione che non finisce mai (così si guarda solo l'avvio). */
  const conProbe =
    (probe: string) =>
    (cmd: ComandoSandbox): EsitoComando =>
      eApparecchio(cmd) ? { exitCode: 0, stdout: uscitaApparecchio(probe), stderr: '' } : rispostaSenzaMarcatore(cmd)

  /** Il `timeoutMs` che lo script STACCATO porta dentro la sonda temporale. */
  function timeoutNelloScript(s: ReturnType<typeof sandboxFinta>): number {
    expect(s.avviati, 'la conversione staccata deve essere partita').toHaveLength(1)
    const script = s.avviati[0].args.join('\n')
    const trovato = /"timeoutMs":(\d+)/.exec(script)
    expect(trovato, 'lo script avviato non porta il timeout della sonda temporale').not.toBeNull()
    return Number(trovato?.[1])
  }

  it('un Full HD di 180 s: il timeout è nell’ordine dei 250 s (calcolato dal probe), NON il tetto di 900', async () => {
    const { s } = await lancia({ risposta: conProbe(probeSorgente(180)) })

    const timeoutMs = timeoutNelloScript(s)
    // Il valore è ESATTAMENTE quello che la funzione dà per le misure di QUEL probe: i tre numeri
    // (durata, larghezza, altezza) e il frame rate arrivano fin qui.
    expect(timeoutMs).toBe(
      timeoutSondaTemporaleMs({ durationSeconds: 180, width: 1920, height: 1080, fps: 30000 / 1001 }),
    )
    // ⚠️ Prima di questa correzione `esegui.ts` non passava durata e dimensioni, e OGNI sonda partiva col
    // tetto (900 s): due sonde in serie sono mezz'ora, cioè tutto `TETTO_SANDBOX_MS`, e un ffprobe
    // piantato consuma la MicroVM. Qui deve stare fra il pavimento (120 s) e un tempo da Full HD.
    expect(timeoutMs).not.toBe(SONDA_TEMPORALE.tettoMs)
    expect(timeoutMs).toBeGreaterThanOrEqual(SONDA_TEMPORALE.pavimentoMs)
    expect(timeoutMs).toBeLessThan(300_000)
  })

  it('un 4K a 60 fps di 60 s ha un timeout DIVERSO e più lungo: i numeri vengono dal probe, non da una costante', async () => {
    const full = await lancia({ risposta: conProbe(probeSorgente(180)) })
    const quattroK = await lancia({
      risposta: conProbe(probeSorgente(60, { larghezza: 3840, altezza: 2160, fps: '60/1' })),
    })

    const timeoutFull = timeoutNelloScript(full.s)
    const timeout4k = timeoutNelloScript(quattroK.s)
    expect(timeout4k).toBe(
      timeoutSondaTemporaleMs({ durationSeconds: 60, width: 3840, height: 2160, fps: 60 }),
    )
    expect(timeout4k).toBeGreaterThan(timeoutFull)
    expect(timeout4k).toBeLessThan(SONDA_TEMPORALE.tettoMs)
  })

  it('la durata è quella della SORGENTE nel probe dell’apparecchio: cambiarla cambia il timeout', async () => {
    const breve = await lancia({ risposta: conProbe(probeSorgente(20)) })
    const lungo = await lancia({ risposta: conProbe(probeSorgente(240)) })

    expect(timeoutNelloScript(breve.s)).toBeLessThan(timeoutNelloScript(lungo.s))
    // Un video breve non scende sotto il pavimento: un timeout più corto di quello di prima scarterebbe
    // un video buono (e «sbagliare in basso» è il difetto che la sonda proporzionale esiste per chiudere).
    expect(timeoutNelloScript(breve.s)).toBe(SONDA_TEMPORALE.pavimentoMs)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 16. SECONDARIO #23 — `last_error_code` A TENTATIVI ESAURITI È L'ULTIMO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · `last_error_code` a tentativi esauriti è quello dell’ULTIMO guasto (secondario #23)', () => {
  it('quattro tentativi con quattro guasti diversi: alla fine `error_code` e `last_error_code` sono entrambi l’ultimo', async () => {
    // Lo stato di UN job, condiviso fra i quattro giri come lo sarebbe nel database. `video_job_retry` annota
    // `last_error_code` ogni volta (anche all'esaurimento, prima di delegare); `video_job_fail` NON lo tocca.
    const stato = statoDelJob()
    const guasti: { opzioni: Parameters<typeof lancia>[0]; codice: string }[] = [
      { opzioni: { risposta: apparecchioCheEsce(21, curlConStato(503)) }, codice: 'BUILD_DOWNLOAD_FAILED' },
      { opzioni: { apriFallisce: true }, codice: 'SANDBOX_UNAVAILABLE' },
      { opzioni: CONVERSIONE_CON(34, CURL_TIMEOUT), codice: 'OUTPUT_UPLOAD_FAILED' },
      { opzioni: { risposta: apparecchioCheEsce(22, 'f.gz: FAILED') }, codice: 'BUILD_HASH_MISMATCH' },
    ]

    const esiti: string[] = []
    for (const [i, guasto] of guasti.entries()) {
      const attempt = i + 1
      const { esito } = await lancia({ ...guasto.opzioni, job: { attempt }, coda: { stato } })
      esiti.push(esito.esito)
      expect(stato.lastErrorCode, `dopo il tentativo ${attempt}`).toBe(guasto.codice)
    }

    expect(esiti).toEqual(['in-riprova', 'in-riprova', 'in-riprova', 'fallito'])
    // ⚠️ L'asserzione che vale il caso. Con `video_job_fail` chiamata direttamente all'ultimo giro,
    // `last_error_code` restava `OUTPUT_UPLOAD_FAILED` (quello del terzo) mentre `error_code` diceva
    // `BUILD_HASH_MISMATCH`: due codici diversi sulla stessa riga, e il commento della colonna dice
    // «o con cui ha esaurito i tentativi».
    expect(stato).toEqual({
      status: 'failed',
      errorCode: 'BUILD_HASH_MISMATCH',
      lastErrorCode: 'BUILD_HASH_MISMATCH',
    })
  })

  it('l’ULTIMO tentativo di un guasto che non si può chiamare «nostro» (il file, un guasto non ritentabile) resta `video_job_fail` diretta', async () => {
    // `last_error_code` è «il codice dell'ultimo guasto NOSTRO»: un file rifiutato non lo è, e non passa da
    // `video_job_retry` a nessun tentativo.
    const stato = statoDelJob()
    const { c } = await lancia({
      job: { attempt: 4 },
      risposta: apparecchioConProbe(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })),
      coda: { stato },
    })

    expect(c.ritentati).toEqual([])
    expect(c.falliti).toHaveLength(1)
    expect(stato).toEqual({ status: 'rejected', errorCode: 'MISSING_VIDEO_STREAM', lastErrorCode: null })
  })

  it('se la chiamata a `video_job_retry` non arriva (`RPC_ERROR`) anche all’ultimo tentativo si ripiega su `video_job_fail`, e il log dice «esauriti»', async () => {
    const { esito, c } = await lancia({
      job: { attempt: 4 },
      apriFallisce: true,
      coda: { riprova: { ok: false, code: 'RPC_ERROR' } },
    })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    expect(c.ritentati).toHaveLength(1)
    expect(c.falliti).toHaveLength(1)
    // Il ripiego conserva ciò che il fallimento ESAURITO dice di sé: era `tentativi_esauriti: true` quando
    // `video_job_fail` si chiamava da subito, e non deve sparire perché ora si prova prima la RPC dei ritentativi.
    expect(riga('riprova-non-scritta')[1]).toBe('error')
    expect(riga('conversione-fallita')[2]).toMatchObject({ tentativi_esauriti: true, rifiutato: false })
  })

  it('un verdetto del database all’ultimo tentativo (il job non è più nostro) è `lease-persa`: non si scrive niente', async () => {
    const { esito, c } = await lancia({
      job: { attempt: 4 },
      apriFallisce: true,
      coda: { riprova: { ok: false, code: 'FENCE_MISMATCH' } },
    })

    expect(esito).toEqual({ esito: 'lease-persa', jobId: JOB_ID, codice: 'FENCE_MISMATCH' })
    expect(c.falliti).toEqual([])
  })

  it('un `attempt` illeggibile non passa nemmeno dalla RPC: `video_job_retry` non ha un numero su cui decidere', async () => {
    for (const attempt of [0, -1, Number.NaN]) {
      const { c } = await lancia({ job: { attempt }, apriFallisce: true })
      expect(c.ritentati, `attempt ${String(attempt)}`).toEqual([])
      expect(c.falliti, `attempt ${String(attempt)}`).toHaveLength(1)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 17. SECONDARIO #33 — UN'ECCEZIONE DELL'SDK DEL SANDBOX È UN GUASTO NOSTRO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · un’eccezione dell’SDK del Sandbox passa da `riprova` (secondario #33)', () => {
  const SDK_GIU = 'sdk: la MicroVM non risponde'
  const sdk = () => new Error(SDK_GIU)
  const eMarcatore = (cmd: ComandoSandbox) => cmd.args.join(' ').includes('esito.txt')

  const PUNTI_DELL_SDK: [string, Parameters<typeof lancia>[0], string][] = [
    ['`esegui` dell’apparecchio', { risposta: (cmd) => (eApparecchio(cmd) ? sdk() : OK) }, 'esegui'],
    [
      '`esegui` che scrive gli argomenti di FFmpeg',
      { risposta: (cmd) => (cmd.args.includes('kv-argomenti') ? sdk() : rispostaFelice()(cmd)) },
      'esegui',
    ],
    ['`avvia` della conversione staccata', { avviaFallisce: sdk() }, 'avvia'],
    [
      '`esegui` che legge il marcatore, mentre si sorveglia',
      { risposta: (cmd) => (eMarcatore(cmd) ? sdk() : rispostaSenzaMarcatore(cmd)) },
      'esegui',
    ],
  ]

  it.each(PUNTI_DELL_SDK)(
    '%s lancia: il job si rimette in coda con la sua attesa, invece di restare `processing` fino alla scadenza della lease',
    async (_nome, opzioni, azione) => {
      const { esito, c, s } = await lancia(opzioni)

      // Classe `infra-transitoria`, codice `SANDBOX_UNAVAILABLE`: la MicroVM che non risponde.
      expect(esito).toEqual({
        esito: 'in-riprova',
        jobId: JOB_ID,
        codice: 'SANDBOX_UNAVAILABLE',
        tentativo: 1,
        attesaS: 300,
      })
      expect(c.ritentati).toEqual([
        {
          jobId: JOB_ID,
          fenceEpoch: 5,
          leaseOwner: WORKER,
          codice: 'SANDBOX_UNAVAILABLE',
          tentativiMassimi: 4,
          attesaSecondi: 300,
        },
      ])
      expect(c.falliti).toEqual([])
      // La MicroVM si spegne: un guasto dell'SDK non può lasciarne una accesa a `GB × ore`.
      expect(s.fermate()).toBe(1)
      // …e il log porta la CAUSA vera (il messaggio dell'SDK), la classe, e quale chiamata è esplosa.
      const log = riga('conversione-da-riprovare')
      expect(log[1]).toBe('warn')
      expect(log[2]).toMatchObject({ tipo: 'infra-transitoria', error_code: 'SANDBOX_UNAVAILABLE', azione })
      expect(comeInTabella(log).messaggio).toContain(SDK_GIU)
    },
  )

  it.each([
    [1, 300],
    [2, 600],
    [3, 900],
  ])('al tentativo %i l’attesa è %i secondi: la stessa scala di ogni altro guasto nostro', async (attempt, attesa) => {
    const { esito, c } = await lancia({ avviaFallisce: sdk(), job: { attempt } })

    expect(esito).toMatchObject({ esito: 'in-riprova', tentativo: attempt, attesaS: attesa })
    expect(c.ritentati[0]).toMatchObject({ tentativiMassimi: 4, attesaSecondi: attesa })
  })

  it('all’ultimo tentativo passa da `riprova` come ogni guasto nostro: i tentativi sono un TETTO, non un’opzione', async () => {
    const stato = statoDelJob()
    const { esito, c } = await lancia({ avviaFallisce: sdk(), job: { attempt: 4 }, coda: { stato } })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'SANDBOX_UNAVAILABLE', rifiutato: false })
    expect(c.ritentati).toHaveLength(1)
    expect(c.falliti).toEqual([])
    expect(stato.lastErrorCode).toBe('SANDBOX_UNAVAILABLE')
    expect(riga('conversione-fallita')[2]).toMatchObject({ tentativi_esauriti: true, azione: 'avvia' })
  })

  it('nel calcio vale lo stesso, e la sorveglianza si rilascia', async () => {
    const { esito, c } = await lancia({ avviaFallisce: sdk(), richiesta: CALCIO })

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SANDBOX_UNAVAILABLE' })
    expect(c.rilasci).toEqual([{ jobId: JOB_ID, invocazione: INVOCAZIONE }])
  })

  it('SOLO le eccezioni dell’SDK: una che arriva da un altro punto (il `ready`, la consegna a News) resta un’eccezione, e non si riprova', async () => {
    // `pronto` lancia: il job NON è fallito, è in uno stato che il runner non sa — riprovarlo con
    // `video_job_retry` (che risponderebbe `INVALID_STATE` su un job già `ready`) sarebbe un racconto falso.
    const dopoIlReady = codaFinta({ prossimo: { ok: true, job: job() }, pronto: new Error('database non raggiungibile') })
    await expect(
      eseguiUnJobVideo(dipendenze(dopoIlReady.coda, sandboxFinta({ risposta: rispostaFelice() }).macchina)),
    ).rejects.toThrow('database non raggiungibile')
    expect(dopoIlReady.ritentati).toEqual([])
    expect(dopoIlReady.falliti).toEqual([])

    const news = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    await expect(
      eseguiUnJobVideo(
        dipendenze(news.coda, sandboxFinta({ risposta: rispostaFelice() }).macchina, {
          consegnaNews: async () => {
            throw new Error('lo Storage non risponde')
          },
        }),
      ),
    ).rejects.toThrow('lo Storage non risponde')
    expect(news.ritentati).toEqual([])
    expect(news.falliti).toEqual([])
  })

  it('una MicroVM che non si spegne (anche lì l’SDK lancia) non toglie l’esito: si grida (`microvm-non-spenta`)', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ avviaFallisce: sdk(), risposta: rispostaFelice() })
    const spenta = vi.fn(async () => {
      throw new Error('stop non riuscito')
    })
    const macchina: MacchinaSandbox = {
      apri: async (p) => ({ ...(await s.macchina.apri(p)), ferma: spenta }),
    }

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, macchina))

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SANDBOX_UNAVAILABLE' })
    expect(spenta).toHaveBeenCalledTimes(1)
    expect(riga('microvm-non-spenta')[1]).toBe('error')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 18. SECONDARIO #37 — LE RIGHE DEL DATABASE NON ENTRANO NEI LOG
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · le RIGHE restituite dalle RPC non si loggano né si inoltrano (secondario #37)', () => {
  // I valori sono finti, ma hanno la forma di ciò che le RPC restituiscono ora: `to_jsonb(riga)` di
  // `video_jobs` porta l'hash del token di rinnovo, lo `sha256` dichiarato e la diagnosi; quella di
  // `video_intents` porta i bambini scelti. Le CHIAVI e i VALORI sono marcatori che nessun log innocente contiene.
  //
  // ⚠️ DALLA PR 2 lo `sha256` dichiarato è un valore che il runner LEGGE e usa (lo passa alla MicroVM, che lo
  // verifica prima di convertire): non è più un campo che passa inosservato. Un valore che non fosse un'impronta
  // — `\x5ECRE70123456789`, com'era qui — fa rifiutare il job prima ancora di aprire una MicroVM
  // (`sha256-dichiarato-illeggibile`), e gli scenari di questo gruppo non arriverebbero più al punto che vogliono
  // guardare (la lease persa, la consegna a News…): verdi, e vuoti. Perciò il veleno ha ora la FORMA di
  // un'impronta vera — `\x` più 64 cifre esadecimali — e continua a essere un marcatore che nessun log innocente
  // contiene. Che un valore SBAGLIATO non finisca in un log, nemmeno quando il job viene rifiutato per lui, lo prova
  // `video-runner-orchestrazione` più sotto (sezione sull'`sha256` dichiarato).
  const IMPRONTA_VELENO = '5ECDE70123456789'.repeat(4)
  const VELENO = {
    tag_alunni: ['aaaaaaaa-0000-4000-8000-00000000f001'],
    rinnovo_token_hash: '\\xDEADBEEFC0FFEE01',
    sha256_dichiarato: `\\x${IMPRONTA_VELENO}`,
    diagnosi_verifica: { frame_persi: 17 },
  }
  const MARCATORI = [
    'DEADBEEFC0FFEE01',
    '5ECDE70123456789',
    'aaaaaaaa-0000-4000-8000-00000000f001',
    'rinnovo_token_hash',
    'sha256_dichiarato',
    'tag_alunni',
    'diagnosi_verifica',
    'frame_persi',
  ]
  const avvelenato = (sovrascritture: Partial<JobVideo> = {}): JobVideo => ({ ...job(sovrascritture), ...VELENO }) as JobVideo

  /**
   * Ogni scenario riceve la riga avvelenata e dice come lanciare il runner: la riga arriva dalle RPC
   * (`prossimo`, `prendi`, `miei`), e deve uscirne senza che il runner ne porti niente nei log.
   */
  const SCENARI: [string, (riga: JobVideo) => Parameters<typeof lancia>[0]][] = [
    ['pronto (giro)', (r) => ({ coda: conRiga(r) })],
    ['pronto (calcio)', (r) => ({ richiesta: CALCIO, coda: conRiga(r) })],
    [
      'file rifiutato',
      (r) => ({
        coda: conRiga(r),
        risposta: apparecchioConProbe(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })),
      }),
    ],
    ['guasto nostro, si ritenta', (r) => ({ coda: conRiga(r), apriFallisce: true })],
    ['guasto nostro, tentativi esauriti', (r) => ({ coda: conRiga({ ...r, attempt: 4 }), apriFallisce: true })],
    ['eccezione dell’SDK', (r) => ({ coda: conRiga(r), avviaFallisce: new Error('sdk giù') })],
    [
      'lease persa',
      (r) => ({
        coda: { ...conRiga(r), battito: { ok: false, code: 'FENCE_MISMATCH' } },
        risposta: rispostaSenzaMarcatore,
      }),
    ],
    ['la conversione continua', (r) => ({ coda: conRiga(r), risposta: rispostaSenzaMarcatore })],
    ['ripresa di un job mio', (r) => ({ nuova: false, coda: { ...conRiga(r), miei: [r] } })],
  ]

  /** La riga avvelenata come la danno TUTTE le RPC che portano un job. */
  const conRiga = (r: JobVideo): CopioneCoda => ({
    prossimo: { ok: true, job: r },
    prendi: { ok: true, job: r },
  })

  it.each(SCENARI)('%s: nei log non entra niente della riga (token, sha256, bambini, diagnosi)', async (_nome, scenario) => {
    await lancia(scenario(avvelenato()))

    expect(righeDiLog().length, 'lo scenario deve aver scritto qualcosa, o il controllo non guarda niente').toBeGreaterThan(0)
    // Ciò che il codice PASSA al logger (campi ed errore)…
    const grezzo = JSON.stringify(righeDiLog().map((r) => [r[0], r[1], r[2], String(r[3] ?? '')]))
    for (const marcatore of MARCATORI) expect(grezzo, `«${marcatore}» è finito in un log`).not.toContain(marcatore)
    // …e ciò che ne uscirebbe in `app_log` dopo il serializzatore VERO.
    const inTabella = righeDiLog().map((r) => JSON.stringify(comeInTabella(r))).join('\n')
    for (const marcatore of MARCATORI) expect(inTabella, `«${marcatore}» è finito in app_log`).not.toContain(marcatore)
  })

  it('il veleno VIAGGIA con il job (la prova che non è il test a non guardare): `consegnaNews` lo riceve intero', async () => {
    // Il canale News passa il job a una porta iniettata: è un percorso dentro il processo, e lì la riga c'è
    // tutta. Se nei log non compare, è perché il runner sceglie i campi, non perché la riga fosse pulita.
    let ricevuto: JobVideo | null = null
    await lancia({
      coda: conRiga(avvelenato({ channel: 'news' })),
      dipendenze: {
        consegnaNews: async (j) => {
          ricevuto = j
          return { ok: true }
        },
      },
    })

    expect(ricevuto).not.toBeNull()
    expect((ricevuto as unknown as typeof VELENO).rinnovo_token_hash).toBe(VELENO.rinnovo_token_hash)
  })

  it('la risposta di una RPC che porta una riga (ventaglio, arrivi): passano i soli NUMERI', async () => {
    const client = {
      rpc: async () => ({
        data: {
          ok: true,
          candidati: 2,
          calciati: 1,
          motivo: 'testo libero',
          riga: { ...VELENO },
          tag_alunni: VELENO.tag_alunni,
        },
        error: null,
      }),
    } as unknown as SupabaseClient

    for (const esito of [await codaSupabase(client).ventaglio(3, null), await codaSupabase(client).arriviRecupera(50)]) {
      expect(esito).toEqual({ ok: true, conteggi: { candidati: 2, calciati: 1 } })
      for (const marcatore of MARCATORI) expect(JSON.stringify(esito)).not.toContain(marcatore)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 19. GLI ADATTATORI DELLA PR 2: sorveglianza, tetto, ventaglio, arrivi
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Come per `video_job_retry` (sezione 9): `adattatori.ts` parla con un database che in locale non c'è, e
 * un nome di argomento sbagliato non dà un errore di test ma un `RPC_ERROR` in produzione — cioè, per la
 * sorveglianza, un'invocazione che crede di non averla ottenuta, e per il tetto un runner che non prende
 * mai niente. I NOMI si leggono dalle migrazioni, non da una copia scritta a mano.
 */
describe('runner video · gli adattatori della coda della PR 2', () => {
  const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

  /** I nomi degli argomenti di una funzione, come li dichiara la migrazione che porta quel suffisso. */
  function argomentiDi(suffissoFile: string, funzione: string): string[] {
    const nome = readdirSync(MIGRAZIONI).find((n) => n.endsWith(suffissoFile))
    expect(nome, `la migrazione «…${suffissoFile}» non si trova (si cerca per suffisso)`).toBeDefined()
    const sql = readFileSync(join(MIGRAZIONI, nome as string), 'utf8')
    const inizio = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${funzione}(`)
    expect(inizio, `la firma di ${funzione} non si trova in ${nome}`).toBeGreaterThanOrEqual(0)
    const firma = sql.slice(inizio, sql.indexOf(')', inizio))
    return Array.from(firma.matchAll(/\bp_[a-z_]+/g), (m) => m[0]).sort()
  }

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

  const FILE_A = '_video_pubblicazione_automatica.sql'
  const FILE_B = '_video_arrivo_originale.sql'

  const RPC: {
    metodo: string
    funzione: string
    file: string
    chiama: (coda: CodaVideo) => Promise<unknown>
    attesi: Record<string, unknown>
  }[] = [
    {
      metodo: 'sorveglianzaPrendi',
      funzione: 'video_job_sorveglianza_prendi',
      file: FILE_A,
      chiama: (coda) => coda.sorveglianzaPrendi(JOB_ID, INVOCAZIONE, SECONDI_SORVEGLIANZA),
      attesi: { p_job_id: JOB_ID, p_invocazione: INVOCAZIONE, p_secondi: 270 },
    },
    {
      metodo: 'sorveglianzaRilascia',
      funzione: 'video_job_sorveglianza_rilascia',
      file: FILE_A,
      chiama: (coda) => coda.sorveglianzaRilascia(JOB_ID, INVOCAZIONE),
      attesi: { p_job_id: JOB_ID, p_invocazione: INVOCAZIONE },
    },
    {
      metodo: 'prendi',
      funzione: 'video_job_prendi',
      file: FILE_A,
      chiama: (coda) => coda.prendi(JOB_ID, WORKER, SECONDI_LEASE_PRESA, 3),
      attesi: { p_job_id: JOB_ID, p_lease_owner: WORKER, p_lease_seconds: 300, p_tetto: 3 },
    },
    {
      metodo: 'prossimo',
      funzione: 'video_job_prossimo',
      file: FILE_A,
      chiama: (coda) => coda.prossimo(WORKER, SECONDI_LEASE_PRESA, 3),
      attesi: { p_lease_owner: WORKER, p_lease_seconds: 300, p_tetto: 3 },
    },
    {
      metodo: 'ventaglio',
      funzione: 'video_runner_ventaglio',
      file: FILE_A,
      chiama: (coda) => coda.ventaglio(3, JOB_ID),
      attesi: { p_tetto: 3, p_escludi: JOB_ID },
    },
    {
      metodo: 'arriviRecupera',
      funzione: 'video_arrivi_recupera',
      file: FILE_B,
      chiama: (coda) => coda.arriviRecupera(50),
      attesi: { p_limite: 50 },
    },
    // T8 (secondario #10): i numeri di una verifica fallita. La RPC è del file A e vuole `processing`, fence e lease.
    {
      metodo: 'diagnosi',
      funzione: 'video_job_diagnosi',
      file: FILE_A,
      chiama: (coda) =>
        coda.diagnosi({ jobId: JOB_ID, fenceEpoch: 5, leaseOwner: WORKER, diagnosi: { v: 1, esito: 'OUTPUT_DIMENSIONS_INVALID' } }),
      attesi: {
        p_job_id: JOB_ID,
        p_fence_epoch: 5,
        p_lease_owner: WORKER,
        p_diagnosi: { v: 1, esito: 'OUTPUT_DIMENSIONS_INVALID' },
      },
    },
  ]

  it.each(RPC)('`$metodo` chiama `$funzione` con ESATTAMENTE gli argomenti che la migrazione dichiara', async (r) => {
    const { client, chiamate } = clienteFinto({ data: { ok: true, job: job() }, error: null })

    await r.chiama(codaSupabase(client))

    expect(chiamate).toHaveLength(1)
    expect(chiamate[0].nome).toBe(r.funzione)
    // Né uno in più né uno in meno, e con i nomi della funzione.
    expect(Object.keys(chiamate[0].args).sort()).toEqual(argomentiDi(r.file, r.funzione))
    expect(chiamate[0].args).toEqual(r.attesi)
  })

  it('il tetto della lease di sorveglianza sta dentro il campo che la RPC accetta (1–900 s), letto dalla migrazione', () => {
    const nome = readdirSync(MIGRAZIONI).find((n) => n.endsWith(FILE_A)) as string
    const sql = readFileSync(join(MIGRAZIONI, nome), 'utf8')
    const inizio = sql.indexOf('CREATE OR REPLACE FUNCTION public.video_job_sorveglianza_prendi(')
    const corpo = sql.slice(inizio, sql.indexOf('$$;', inizio))
    expect(corpo).toMatch(/p_secondi < 1\s+OR p_secondi > 900/)
    expect(SECONDI_SORVEGLIANZA).toBeGreaterThanOrEqual(1)
    expect(SECONDI_SORVEGLIANZA).toBeLessThanOrEqual(900)
  })

  describe('le due RPC della sorveglianza NON portano un job, e non per questo sono un errore', () => {
    it('`{ok:true, sorvegliato_fino_a}` è `{ok:true}` — NON `RPC_ERROR`', async () => {
      // Il difetto che questa prova blocca: passate da `esitoRpc`, che vuole un `job` dentro il corpo, ogni
      // sorveglianza RIUSCITA si sarebbe letta «RPC_ERROR», e ogni invocazione avrebbe creduto di non averla.
      const { client } = clienteFinto({
        data: { ok: true, sorvegliato_fino_a: '2026-10-02T16:00:00Z' },
        error: null,
      })
      expect(await codaSupabase(client).sorveglianzaPrendi(JOB_ID, INVOCAZIONE, 270)).toEqual({ ok: true })
    })

    it('il rilascio (`{ok:true, rilasciato:false}`: non era la sua) è `{ok:true}`: non è un errore', async () => {
      const { client } = clienteFinto({ data: { ok: true, rilasciato: false }, error: null })
      expect(await codaSupabase(client).sorveglianzaRilascia(JOB_ID, INVOCAZIONE)).toEqual({ ok: true })
    })

    it.each(['GIA_SORVEGLIATO', 'INVALID_STATE', 'NOT_FOUND', 'BAD_INPUT'])('il verdetto %s mantiene il SUO codice', async (code) => {
      const { client } = clienteFinto({ data: { ok: false, code }, error: null })
      expect(await codaSupabase(client).sorveglianzaPrendi(JOB_ID, INVOCAZIONE, 270)).toEqual({ ok: false, code })
    })

    it('«funzione non trovata» (la migrazione non è applicata) è `RPC_ERROR`, e l’adattatore scrive la sua riga', async () => {
      const { client } = clienteFinto({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.video_job_sorveglianza_prendi' },
      })

      expect(await codaSupabase(client).sorveglianzaPrendi(JOB_ID, INVOCAZIONE, 270)).toEqual({
        ok: false,
        code: 'RPC_ERROR',
      })
      expect(
        righeDiLog().some(
          (r) => r[2].esito === 'rpc-non-riuscita' && r[2].operazione === 'video-runner:sorveglianza-prendi',
        ),
      ).toBe(true)
    })

    it('una risposta che non è un oggetto è `RPC_ERROR` e si vede (`rpc-risposta-illeggibile`)', async () => {
      const { client } = clienteFinto({ data: 'ok', error: null })
      expect(await codaSupabase(client).sorveglianzaRilascia(JOB_ID, INVOCAZIONE)).toEqual({
        ok: false,
        code: 'RPC_ERROR',
      })
      expect(righeDiLog().some((r) => r[2].esito === 'rpc-risposta-illeggibile')).toBe(true)
    })
  })

  describe('`video_job_diagnosi` NON porta un job, e non per questo è un errore (T8)', () => {
    it('`{ok:true}` è `{ok:true}` — NON `RPC_ERROR`: passata da `esitoRpc`, ogni scrittura riuscita si leggerebbe come fallita', async () => {
      const { client } = clienteFinto({ data: { ok: true }, error: null })
      expect(await codaSupabase(client).diagnosi({ jobId: JOB_ID, fenceEpoch: 5, leaseOwner: WORKER, diagnosi: { v: 1 } })).toEqual({
        ok: true,
      })
    })

    it.each(['BAD_INPUT', 'NOT_FOUND', 'FENCE_MISMATCH', 'INVALID_STATE', 'LEASE_MISMATCH'])('il verdetto %s mantiene il SUO codice', async (code) => {
      const { client } = clienteFinto({ data: { ok: false, code }, error: null })
      expect(await codaSupabase(client).diagnosi({ jobId: JOB_ID, fenceEpoch: 5, leaseOwner: WORKER, diagnosi: {} })).toEqual({
        ok: false,
        code,
      })
    })

    it('«funzione non trovata» (la migrazione non è applicata) è `RPC_ERROR`, e l’adattatore scrive la sua riga', async () => {
      const { client } = clienteFinto({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.video_job_diagnosi' },
      })
      expect(await codaSupabase(client).diagnosi({ jobId: JOB_ID, fenceEpoch: 5, leaseOwner: WORKER, diagnosi: {} })).toEqual({
        ok: false,
        code: 'RPC_ERROR',
      })
      expect(
        righeDiLog().some((r) => r[2].esito === 'rpc-non-riuscita' && r[2].operazione === 'video-runner:diagnosi'),
      ).toBe(true)
    })
  })

  describe('il tetto: `video_job_prossimo` e `video_job_prendi` rispondono come le RPC della PR 1, più `CAPACITA_PIENA`', () => {
    it.each(['prossimo', 'prendi'] as const)('`%s`: `CAPACITA_PIENA` mantiene il suo codice, anche con i campi in più', async (metodo) => {
      const { client } = clienteFinto({
        data: { ok: false, code: 'CAPACITA_PIENA', in_lavorazione: 3, tetto: 3 },
        error: null,
      })
      const coda = codaSupabase(client)

      const esito =
        metodo === 'prossimo'
          ? await coda.prossimo(WORKER, 300, 3)
          : await coda.prendi(JOB_ID, WORKER, 300, 3)

      expect(esito).toEqual({ ok: false, code: 'CAPACITA_PIENA' })
    })

    it.each(['prossimo', 'prendi'] as const)('`%s`: il job preso passa com’è', async (metodo) => {
      const { client } = clienteFinto({ data: { ok: true, job: job({ status: 'processing' }) }, error: null })
      const coda = codaSupabase(client)

      const esito =
        metodo === 'prossimo'
          ? await coda.prossimo(WORKER, 300, 3)
          : await coda.prendi(JOB_ID, WORKER, 300, 3)

      expect(esito).toEqual({ ok: true, job: job({ status: 'processing' }) })
    })

    it('il runner NON chiama più `video_job_next` né `video_job_claim`: le due della PR 1 sono dietro le nuove', async () => {
      const { client, chiamate } = clienteFinto({ data: { ok: true, job: job() }, error: null })
      const coda = codaSupabase(client)

      await coda.prossimo(WORKER, 300, 3)
      await coda.prendi(JOB_ID, WORKER, 300, 3)

      // Il tetto sta nelle RPC nuove, che DELEGANO alle vecchie: chiamare le vecchie direttamente
      // salterebbe il tetto in silenzio.
      expect(chiamate.map((c) => c.nome)).toEqual(['video_job_prossimo', 'video_job_prendi'])
    })
  })

  describe('i conteggi (ventaglio, arrivi): dalla risposta passano i soli numeri', () => {
    it('il ventaglio: candidati, calciati, in lavorazione, liberi', async () => {
      const { client } = clienteFinto({
        data: { ok: true, candidati: 4, calciati: 3, in_lavorazione: 1, liberi: 2 },
        error: null,
      })
      expect(await codaSupabase(client).ventaglio(3, null)).toEqual({
        ok: true,
        conteggi: { candidati: 4, calciati: 3, in_lavorazione: 1, liberi: 2 },
      })
    })

    it('`escludi` NULL arriva al database come NULL, non come stringa vuota né come assente', async () => {
      const { client, chiamate } = clienteFinto({ data: { ok: true }, error: null })
      await codaSupabase(client).ventaglio(3, null)
      expect(chiamate[0].args).toEqual({ p_tetto: 3, p_escludi: null })
      expect(Object.keys(chiamate[0].args)).toContain('p_escludi')
    })

    it('gli arrivi: le stringhe (`motivo`) e i non numeri restano fuori', async () => {
      const { client } = clienteFinto({
        data: { ok: true, candidati: 1, arrivati: 1, motivo: 'storage-assente', errori: Number.NaN },
        error: null,
      })
      expect(await codaSupabase(client).arriviRecupera(50)).toEqual({
        ok: true,
        conteggi: { candidati: 1, arrivati: 1 },
      })
    })

    it('un verdetto (`BAD_INPUT`) e il trasporto che cade (`RPC_ERROR`)', async () => {
      expect(
        await codaSupabase(clienteFinto({ data: { ok: false, code: 'BAD_INPUT' }, error: null }).client).arriviRecupera(0),
      ).toEqual({ ok: false, code: 'BAD_INPUT' })
      expect(
        await codaSupabase(
          clienteFinto({ data: null, error: { code: 'PGRST202', message: 'non trovata' } }).client,
        ).ventaglio(3, null),
      ).toEqual({ ok: false, code: 'RPC_ERROR' })
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 20. L'AMBIENTE PRONTO — SNAPSHOT, RIPIEGO NELLA STESSA MICROVM, RIPIEGO DAL RUNTIME (T8, spec §10.1)
 *
 * Una MicroVM nata dallo SNAPSHOT ha i binari di FFmpeg in `/opt/kv-ffmpeg`: l'apparecchio li VERIFICA con
 * `sha256sum` invece di scaricarli dal bucket. Se non tornano (uscita 26) si ripiega nella stessa MicroVM con la
 * provvista della PR 1, e si grida. Una MicroVM nata dal runtime (o che non dichiara l'origine) va come sempre
 * per la provvista. La SCELTA «snapshot o runtime» sta in `apriLaMicroVm` e si prova in
 * `video-runner-ambiente.test.ts`; qui si prova ciò che `esegui.ts` ne fa.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · l’ambiente pronto: i binari dello snapshot si VERIFICANO, non si scaricano', () => {
  const SNAPSHOT = CARTELLA_BINARI_NELLO_SNAPSHOT
  const testoDi = (c: ComandoSandbox): string => c.args.join('\n')
  /** L'apparecchio che verifica i binari dello snapshot: l'unico il cui script nomina `/opt/kv-ffmpeg`. */
  const eApparecchioDelloSnapshot = (c: ComandoSandbox): boolean => eApparecchio(c) && testoDi(c).includes(SNAPSHOT)
  /** L'apparecchio con la provvista dal bucket: l'unico il cui script nomina i `.gz`. */
  const eApparecchioConProvvista = (c: ComandoSandbox): boolean =>
    eApparecchio(c) && testoDi(c).includes(`${CARTELLA_BUILD}/ffmpeg.gz`)

  /** I binari dello snapshot non tornano (uscita 26, come lo script, con la riga `FAILED` di `sha256sum`); poi tutto riesce. */
  const SNAPSHOT_CHE_NON_TORNA = (cmd: ComandoSandbox): EsitoComando =>
    eApparecchioDelloSnapshot(cmd)
      ? {
          exitCode: USCITE_APPARECCHIO.binari,
          stdout: '',
          stderr: `${SNAPSHOT}/ffmpeg: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match`,
        }
      : rispostaFelice()(cmd)

  const conErroriOAvvisi = () => righeDiLog().filter((r) => r[1] === 'error' || r[1] === 'warn')

  it('nata dallo snapshot: UN comando di apparecchio, che verifica i binari in `/opt/kv-ffmpeg` e non scarica niente', async () => {
    const { archivio: a, firme } = archivioFinto()
    const { esito, s } = await lancia({ origine: 'snapshot', archivio: a })

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    const apparecchi = s.eseguiti.filter(eApparecchio)
    expect(apparecchi, 'la verifica sta DENTRO l’apparecchio: un solo giro verso la MicroVM').toHaveLength(1)
    const script = testoDi(apparecchi[0])
    // Le due impronte dei BINARI (le stesse della provvista), accoppiate ciascuna al suo file DELLO SNAPSHOT.
    expect(script).toContain(`'${FFMPEG_SHA256}' ${SNAPSHOT}/ffmpeg '${FFPROBE_SHA256}' ${SNAPSHOT}/ffprobe`)
    expect(script).toContain('sha256sum -c -')
    // …e NIENTE della provvista: né i `.gz`, né la decompressione, né gli URL della build.
    expect(script).not.toContain('gzip -dc')
    expect(script).not.toContain('.gz')
    expect(script).not.toContain(`$${ENV_URL_FFMPEG}`)
    // La verifica viene PRIMA di ogni uso dei binari: prima dell'inventario, che li esegue.
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf('===INVENTARIO==='))

    // Gli URL della build non entrano nell'ambiente e il bucket `video_build` non si firma nemmeno:
    // lo snapshot esiste perché a runtime il bucket non serva.
    expect(Object.keys(apparecchi[0].env ?? {})).not.toContain(ENV_URL_FFMPEG)
    expect(Object.keys(apparecchi[0].env ?? {})).not.toContain(ENV_URL_FFPROBE)
    expect(firme.filter((f) => f.bucket === BUCKET_BUILD_VIDEO)).toEqual([])
    expect(firme, 'solo l’originale e l’uscita').toHaveLength(2)
  })

  it('la conversione staccata chiama i binari DELLO SNAPSHOT, ovunque li nomini (codifica, probe, decodifica, sonda temporale)', async () => {
    const { s } = await lancia({ origine: 'snapshot' })

    expect(s.avviati).toHaveLength(1)
    const script = testoDi(s.avviati[0])
    expect(script).toContain(`xargs -0 -a /tmp/kv-video/argomenti ${SNAPSHOT}/ffmpeg`)
    expect(script).toContain(`${SNAPSHOT}/ffprobe -v error -print_format json`)
    expect(script).toContain(`node - ${SNAPSHOT}/ffprobe ${INGRESSO}`)
    // Nemmeno un riferimento alla cartella del ripiego: una conversione che mescolasse le due userebbe un binario non verificato.
    expect(script).not.toContain(CARTELLA_BUILD)
  })

  it('il log dice COME l’ambiente è diventato pronto, e in quanto: `ambiente-pronto`, senza `build-pronta` (non c’è stata nessuna provvista)', async () => {
    const { esito } = await lancia({ origine: 'snapshot' })

    expect(esito).toMatchObject({ esito: 'pronto' })
    const pronto = riga('ambiente-pronto')
    expect(pronto[0]).toBe('galleria')
    expect(pronto[1]).toBe('info')
    expect(pronto[2]).toMatchObject({ operazione: 'video-runner', ambiente: 'snapshot', job_id: JOB_ID })
    expect(typeof pronto[2].ms).toBe('number')
    expect(typeof pronto[2].apertura_ms).toBe('number')
    // Una riga al giorno PER MODO: senza, il ripiego che arriva dopo il primo `snapshot` del mattino sarebbe sommato ai primi.
    expect(pronto[4]).toEqual({ distingui: ['ambiente'] })
    // Il valore passa dalla lista bianca di `redact`: `ambiente` è fra le chiavi in chiaro, `modalita` non lo sarebbe.
    expect(comeInTabella(pronto).contestoExtra?.campi).toMatchObject({ ambiente: 'snapshot' })

    // `build-pronta` dice «la provvista dal bucket è riuscita»: con i binari dello snapshot non c'è stata, e dirlo sarebbe una bugia.
    expect(conEsito('build-pronta')).toEqual([])
    expect(conErroriOAvvisi()).toEqual([])
  })

  it('`ms` è il tempo dell’apparecchio e `apertura_ms` quello di `apri`: due numeri misurati, ciascuno col suo orologio', async () => {
    const orologio = orologioFinto()
    const preso: EsitoRpcVideo = { ok: true, job: job() }
    const c = codaFinta({ prossimo: preso, prendi: preso })
    const s = sandboxFinta({
      origine: 'snapshot',
      risposta: (cmd) => {
        if (eApparecchio(cmd)) orologio.avanza(2_000)
        return rispostaFelice()(cmd)
      },
    })
    // Un `apri` che impiega 1,5 s (lo snapshot che si ripristina).
    const macchina: MacchinaSandbox = {
      apri: async (p) => {
        orologio.avanza(1_500)
        return s.macchina.apri(p)
      },
    }

    await eseguiUnJobVideo(dipendenze(c.coda, macchina, { orologio }))

    expect(riga('ambiente-pronto')[2]).toMatchObject({ apertura_ms: 1_500, ms: 2_000 })
  })

  it('i binari dello snapshot NON TORNANO: si ripiega nella STESSA MicroVM con la provvista dal bucket, e si GRIDA', async () => {
    const { archivio: a, firme } = archivioFinto()
    const { esito, c, s } = await lancia({ origine: 'snapshot', archivio: a, risposta: SNAPSHOT_CHE_NON_TORNA })

    // Il video si converte lo stesso.
    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    expect(c.falliti).toEqual([])
    expect(c.ritentati).toEqual([])
    // Una MicroVM sola: non se ne apre un'altra, e quella aperta si spegne.
    expect(s.nomi).toHaveLength(1)
    expect(s.fermate()).toBe(1)

    // Due apparecchi, nell'ordine: prima la verifica dello snapshot, poi la provvista della PR 1.
    const apparecchi = s.eseguiti.filter(eApparecchio)
    expect(apparecchi).toHaveLength(2)
    expect(eApparecchioDelloSnapshot(apparecchi[0])).toBe(true)
    expect(eApparecchioConProvvista(apparecchi[1])).toBe(true)
    // Gli URL della build entrano nell'ambiente del SECONDO, e solo lì (il primo non li aveva chiesti).
    expect(Object.keys(apparecchi[0].env ?? {})).not.toContain(ENV_URL_FFMPEG)
    expect(apparecchi[1].env?.[ENV_URL_FFMPEG]).toContain(`/video_build/${PERCORSO_FFMPEG_GZ}?token=`)
    expect(apparecchi[1].env?.[ENV_URL_FFPROBE]).toContain(`/video_build/${PERCORSO_FFPROBE_GZ}?token=`)
    expect(firme.filter((f) => f.bucket === BUCKET_BUILD_VIDEO)).toHaveLength(2)

    // La conversione usa i binari che la provvista ha VERIFICATO, quelli di `/tmp`: non lo snapshot, che non è tornato.
    const conversione = testoDi(s.avviati[0])
    expect(conversione).toContain(`xargs -0 -a /tmp/kv-video/argomenti ${CARTELLA_BUILD}/ffmpeg`)
    expect(conversione).not.toContain(SNAPSHOT)

    // Il grido: `error`, col MOTIVO e con la riga `FAILED` di `sha256sum` nel messaggio (è lì che si legge QUALE non torna).
    const assente = riga('ambiente-pronto-assente')
    expect(assente[1]).toBe('error')
    expect(assente[2]).toMatchObject({ error_code: 'BINARI_NON_VERIFICATI', uscita: 26, job_id: JOB_ID })
    expect(comeInTabella(assente).messaggio).toContain(`${SNAPSHOT}/ffmpeg: FAILED`)
    // …e poi l'ambiente è pronto, ma NON «snapshot»: `ripiego-vm`, con la provvista che è riuscita.
    expect(riga('ambiente-pronto')[2]).toMatchObject({ ambiente: 'ripiego-vm' })
    expect(riga('build-pronta')[1]).toBe('info')
  })

  it.each<[string, 'runtime' | undefined]>([
    ['nata dal runtime', 'runtime'],
    ['che non dichiara l’origine (la PR 1, parola per parola)', undefined],
  ])('una MicroVM %s: la provvista dal bucket di sempre, e `ambiente-pronto` dice `ripiego-runtime`', async (_nome, origine) => {
    const { archivio: a, firme } = archivioFinto()
    const { esito, s } = await lancia({ origine, archivio: a })

    expect(esito).toMatchObject({ esito: 'pronto' })
    // Quattro firme (l'originale, l'uscita, i due `.gz`) e UN apparecchio con la provvista in `/tmp/kv-ffmpeg`.
    expect(firme).toHaveLength(4)
    const apparecchi = s.eseguiti.filter(eApparecchio)
    expect(apparecchi).toHaveLength(1)
    expect(eApparecchioConProvvista(apparecchi[0])).toBe(true)
    expect(testoDi(apparecchi[0])).not.toContain(SNAPSHOT)
    expect(testoDi(s.avviati[0])).toContain(`${CARTELLA_BUILD}/ffmpeg`)

    expect(riga('ambiente-pronto')[2]).toMatchObject({ ambiente: 'ripiego-runtime' })
    expect(riga('build-pronta')[1]).toBe('info')
    // Il grido «lo snapshot non c'era» lo scrive `apriLaMicroVm` (che sa il perché), non `esegui.ts`.
    expect(conEsito('ambiente-pronto-assente')).toEqual([])
  })

  it('le altre uscite dell’apparecchio di uno snapshot sono guasti come prima: NESSUN ripiego, nessuna firma della build', async () => {
    // Una HEAD che dà 404 non dice niente dei binari: ripiegare scaricherebbe 134 MB per ottenere lo stesso 404.
    const { archivio: a, firme } = archivioFinto()
    const { esito, s } = await lancia({
      origine: 'snapshot',
      archivio: a,
      risposta: apparecchioCheEsce(24, curlConStato(404)),
    })

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SOURCE_DOWNLOAD_FAILED' })
    expect(s.eseguiti.filter(eApparecchio)).toHaveLength(1)
    expect(firme.filter((f) => f.bucket === BUCKET_BUILD_VIDEO)).toEqual([])
    expect(conEsito('ambiente-pronto-assente')).toEqual([])
    expect(riga('conversione-da-riprovare')[2].tipo).toBe('infra-permanente')
  })

  it('un file illeggibile (ffprobe, uscita 25, senza segni di rete) resta `non-ritentabile` anche da uno snapshot', async () => {
    const { esito, c } = await lancia({ origine: 'snapshot', risposta: apparecchioCheEsce(25, FFPROBE_FILE_ROTTO) })

    expect(esito).toMatchObject({ esito: 'fallito', codice: 'PROBE_COMMAND_FAILED', rifiutato: false })
    expect(c.ritentati).toEqual([])
    expect(conEsito('ambiente-pronto-assente')).toEqual([])
  })

  it('l’inventario si chiede SEMPRE, anche a un binario di cui l’impronta torna: una build senza `zscale` è `BUILD_INCOMPLETE`', async () => {
    // Le impronte dicono che i binari sono quelli attesi, non che sappiano fare ciò che serve (testata di `build.ts`).
    const { esito, s } = await lancia({
      origine: 'snapshot',
      risposta: (cmd) =>
        eApparecchio(cmd)
          ? { exitCode: 0, stdout: uscitaApparecchio().replace(/^ \.\. zscale.*$/m, ''), stderr: '' }
          : OK,
    })

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'BUILD_INCOMPLETE' })
    expect(s.avviati).toEqual([])
    expect(s.eseguiti.filter(eApparecchio)).toHaveLength(1)
  })

  it('una MicroVM RIAGGANCIATA non rifà niente: né l’apparecchio né i log dell’ambiente, qualunque sia la sua origine', async () => {
    const { archivio: a, firme } = archivioFinto()
    const c = codaFinta({ miei: [job()] })
    const s = sandboxFinta({ nuova: false, origine: 'snapshot', risposta: rispostaFelice() })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina, { archivio: a }))

    expect(esito).toMatchObject({ esito: 'pronto' })
    expect(s.eseguiti.filter(eApparecchio)).toEqual([])
    expect(s.avviati).toEqual([])
    expect(conEsito('ambiente-pronto')).toEqual([])
    expect(firme.some((f) => f.bucket === BUCKET_BUILD_VIDEO)).toBe(false)
  })

  it('se la lease si perde il comando di interruzione ferma `ffmpeg` in ENTRAMBE le cartelle: `/opt` dello snapshot e `/tmp` del ripiego', async () => {
    // `pkill -f /tmp/kv-ffmpeg` (la PR 1) lascerebbe acceso un ffmpeg che gira da `/opt/kv-ffmpeg` per un job che non è più nostro.
    const { esito, s } = await lancia({
      origine: 'snapshot',
      risposta: rispostaSenzaMarcatore,
      coda: { battito: { ok: false, code: 'FENCE_MISMATCH' } },
    })

    expect(esito).toMatchObject({ esito: 'lease-persa' })
    const interruzioni = s.eseguiti.filter((c) => testoDi(c).includes('pkill'))
    expect(interruzioni).toHaveLength(1)
    expect(testoDi(interruzioni[0])).toContain(`pkill -f '${MODELLO_PROCESSI_DEI_BINARI}'`)
    // Il modello riconosce le righe di comando dei binari di tutte e due le cartelle, e NON il proprio testo
    // (altrimenti `pkill` ucciderebbe la shell che lo ha lanciato prima del `|| true`).
    const modello = new RegExp(MODELLO_PROCESSI_DEI_BINARI)
    expect(modello.test(`${SNAPSHOT}/ffmpeg -i /tmp/kv-video/ingresso`)).toBe(true)
    expect(modello.test(`${CARTELLA_BUILD}/ffmpeg -i /tmp/kv-video/ingresso`)).toBe(true)
    expect(modello.test(testoDi(interruzioni[0]))).toBe(false)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 21. LO `sha256` DICHIARATO — SI VERIFICA NEL SANDBOX, PRIMA DI CONVERTIRE (T8, spec §10.4)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · lo `sha256` dichiarato (caricamento nativo) si verifica prima di convertire', () => {
  const HEX = 'ab12'.repeat(16)
  const testoDi = (c: ComandoSandbox): string => c.args.join('\n')
  /** Il job com'è nella riga che le RPC di presa restituiscono: l'impronta è la stringa `\x<64 cifre>` di un `bytea`. */
  const conSha = (valore: unknown): Parameters<typeof lancia>[0] => ({
    job: { sha256_dichiarato: valore as string },
  })

  it('l’impronta entra nell’AMBIENTE della conversione, e lo script la verifica DOPO lo scarico e PRIMA di tutto il resto', async () => {
    const { s } = await lancia({ ...conSha(`\\x${HEX}`), risposta: rispostaSenzaMarcatore })

    expect(s.avviati).toHaveLength(1)
    const avvio = s.avviati[0]
    expect(avvio.env?.[ENV_SHA256_ATTESO]).toBe(HEX)
    const script = testoDi(avvio)
    expect(script).toContain(`printf '%s  %s\\n' "$${ENV_SHA256_ATTESO}" ${INGRESSO} | sha256sum -c -`)
    // L'ordine è la sostanza: scarico → verifica → watermark → codifica. Un originale che non è quello dichiarato non
    // merita né il watermark né la codifica.
    const scarico = script.indexOf(`-o ${INGRESSO}`)
    const verifica = script.indexOf('sha256sum -c -')
    const watermark = script.indexOf(`-o ${WATERMARK}`)
    const codifica = script.indexOf('xargs -0 -a')
    expect(scarico).toBeGreaterThan(0)
    expect(verifica).toBeGreaterThan(scarico)
    expect(watermark).toBeGreaterThan(verifica)
    expect(codifica).toBeGreaterThan(watermark)
    expect(script).toContain(`|| exit ${USCITE_CONVERSIONE.impronta}`)
  })

  it('un’impronta in MAIUSCOLO (un altro serializzatore) arriva in minuscolo, e anche senza il prefisso `\\x`', async () => {
    for (const valore of [`\\x${HEX.toUpperCase()}`, HEX.toUpperCase(), HEX]) {
      const { s } = await lancia({ ...conSha(valore), risposta: rispostaSenzaMarcatore })
      expect(s.avviati[0].env?.[ENV_SHA256_ATTESO], `valore ${valore.slice(0, 6)}…`).toBe(HEX)
    }
  })

  it('l’impronta non viaggia MAI fuori dall’ambiente della conversione: non negli argomenti, non nell’apparecchio, non nei log', async () => {
    // Un valore che non compare in nessun altro posto di un percorso FELICE e di uno che fallisce.
    for (const opzioni of [
      { risposta: rispostaFelice() },
      { risposta: rispostaFelice(marcatore({ uscita: 35, diagnosi: `${INGRESSO}: FAILED` })) },
      { risposta: apparecchioCheEsce(25, FFPROBE_FILE_ROTTO) },
    ]) {
      h.log.length = 0
      const { s } = await lancia({ ...conSha(`\\x${HEX}`), ...opzioni })

      for (const comando of [...s.eseguiti, ...s.avviati]) {
        expect(testoDi(comando), 'negli argomenti di un comando').not.toContain(HEX)
      }
      for (const comando of s.eseguiti) {
        expect(Object.values(comando.env ?? {}).join('\n'), 'nell’ambiente di un comando sincrono').not.toContain(HEX)
      }
      const nelLog = JSON.stringify(righeDiLog().map((r) => [r[0], r[1], r[2], String(r[3] ?? '')]))
      expect(nelLog, 'in un log').not.toContain(HEX)
      expect(JSON.stringify(righeDiLog().map((r) => comeInTabella(r))), 'in `app_log`').not.toContain(HEX)
    }
  })

  it.each<[string, Parameters<typeof lancia>[0]]>([
    ['il campo manca (web, TUS, News)', {}],
    ['il campo è `null`', conSha(null)],
  ])('senza `sha256` dichiarato (%s) il passo NON esiste: lo script è quello di prima', async (_nome, opzioni) => {
    const { s } = await lancia({ ...opzioni, risposta: rispostaSenzaMarcatore })

    const avvio = s.avviati[0]
    expect(Object.keys(avvio.env ?? {})).not.toContain(ENV_SHA256_ATTESO)
    expect(testoDi(avvio)).not.toContain(ENV_SHA256_ATTESO)
    expect(testoDi(avvio)).not.toContain('sha256sum')
  })

  it.each([1, 2, 3, 4])(
    'l’uscita 35 è `ORIGINALE_DIVERSO` e NON si ritenta MAI — nemmeno al tentativo %i, dove un guasto nostro si ritenterebbe',
    async (attempt) => {
      const { esito, c } = await lancia({
        job: { attempt, sha256_dichiarato: `\\x${HEX}` },
        risposta: rispostaFelice(marcatore({ uscita: 35, diagnosi: `${INGRESSO}: FAILED` })),
      })

      expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'ORIGINALE_DIVERSO', rifiutato: true })
      // `file`: `video_job_fail` col job RIFIUTATO. Mai `video_job_retry`.
      expect(c.ritentati).toEqual([])
      expect(c.falliti).toHaveLength(1)
      expect(c.falliti[0]).toMatchObject({ codice: 'ORIGINALE_DIVERSO', rifiutato: true })
      const log = riga('conversione-fallita')
      expect(log[2]).toMatchObject({ error_code: 'ORIGINALE_DIVERSO', tipo: 'file', rifiutato: true })
      // La riga `FAILED` di `sha256sum` sta nella diagnosi (è la prova del fatto), e l'impronta no.
      expect(comeInTabella(log).messaggio).toContain('FAILED')
      expect(comeInTabella(log).messaggio).not.toContain(HEX)
    },
  )

  it.each<[string, unknown]>([
    ['una stringa che non è un’impronta', 'non-un-hash'],
    ['una stringa vuota', ''],
    ['63 cifre', `\\x${HEX.slice(1)}`],
    ['65 cifre', `\\x${HEX}a`],
    ['64 caratteri non esadecimali', `\\x${'zz'.repeat(32)}`],
    ['un numero', 5],
    ['un booleano', true],
    ['un oggetto', { hex: HEX }],
  ])('un valore ILLEGGIBILE (%s) non passa in silenzio: il job è rifiutato PRIMA di aprire qualunque cosa', async (_nome, valore) => {
    const { archivio: a, firme } = archivioFinto()
    const { esito, c, s } = await lancia({ ...conSha(valore), archivio: a })

    // Un controllo di integrità richiesto e non eseguibile non si salta: `ORIGINALE_DIVERSO`, `file`, mai ritentato…
    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'ORIGINALE_DIVERSO', rifiutato: true })
    expect(c.ritentati).toEqual([])
    expect(c.falliti).toHaveLength(1)
    // …senza spendere niente: nessuna firma, nessuna MicroVM.
    expect(firme).toEqual([])
    expect(s.nomi).toEqual([])
    // Il log dice che il guaio è il VALORE, non il file, e il valore non c'è.
    const log = riga('sha256-dichiarato-illeggibile')
    expect(log[1]).toBe('error')
    expect(log[2]).toMatchObject({ job_id: JOB_ID })
    const nelLog = JSON.stringify(righeDiLog().map((r) => [r[0], r[1], r[2], String(r[3] ?? '')]))
    for (const frammento of [HEX, 'non-un-hash', 'zz'.repeat(8)]) expect(nelLog).not.toContain(frammento)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 22. LA DIAGNOSI DELLA VERIFICA FALLITA (T8, secondario #10)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · la verifica fallita scrive i NUMERI sul job (`video_job_diagnosi`)', () => {
  /** Un'uscita a 1280×720 invece del Full HD: `OUTPUT_DIMENSIONS_INVALID`. */
  const USCITA_FUORI_MISURA = marcatore({ probeOut: probeUscita().replace('"width":1920', '"width":1280') })
  const VERIFICA_FALLITA = { risposta: rispostaFelice(USCITA_FUORI_MISURA) }

  it('la diagnosi si scrive PRIMA di chiudere il job (la RPC vuole un `processing`), col job, il fence e il worker giusti', async () => {
    const ordine: string[] = []
    const { esito, c } = await lancia({ ...VERIFICA_FALLITA, coda: { ordine } })

    expect(esito).toMatchObject({ esito: 'fallito', codice: 'OUTPUT_DIMENSIONS_INVALID', rifiutato: true })
    expect(c.diagnosi).toHaveLength(1)
    expect(c.diagnosi[0]).toMatchObject({ jobId: JOB_ID, fenceEpoch: 5, leaseOwner: WORKER })
    expect(ordine.filter((x) => x === 'diagnosi' || x === 'fallito')).toEqual(['diagnosi', 'fallito'])
  })

  it('è `diagnosiVerifica` calcolata sugli ingressi GIUSTI: la sorgente nel suo probe, l’uscita com’è, la prova di decodifica', async () => {
    const { c } = await lancia(VERIFICA_FALLITA)

    // Gli ingressi li ricostruisce il TEST dalle fixture, non li copia dal runner: se quest'ultimo passasse il probe
    // dell'uscita al posto di quello della sorgente, o la prova sbagliata, i numeri sarebbero altri.
    const sorgente = parseVideoProbe(probeSorgente(), 20_000_000)
    if (!sorgente.ok) throw new Error(`la fixture deve essere un probe valido: ${sorgente.code}`)
    const prova = leggiEsitoConversione(USCITA_FUORI_MISURA).prova
    const atteso = diagnosiVerifica(sorgente.probe, probeUscita().replace('"width":1920', '"width":1280'), prova, 'OUTPUT_DIMENSIONS_INVALID')

    expect(c.diagnosi[0].diagnosi).toEqual(atteso)
    // E qualche numero che si legge a occhio: i frame decodificati sono quelli del marcatore, l'esito è il codice del rifiuto.
    expect(c.diagnosi[0].diagnosi).toMatchObject({ v: 1, esito: 'OUTPUT_DIMENSIONS_INVALID', frame_decodificati: 5391 })
  })

  it('passa la regola che la RPC applica: solo numeri e stringhe-enumerato, chiavi comprese, entro 2048 byte (letta dalla migrazione)', async () => {
    // Una diagnosi che la RPC rifiuta (`BAD_INPUT`) non sparisce con un errore: diventa una riga `diagnosi-non-scritta`
    // che nessuno legge, e il guasto è un job rifiutato senza i suoi numeri per sempre. La regola si LEGGE dalla migrazione.
    const cartella = join(process.cwd(), 'supabase', 'migrations')
    const nome = readdirSync(cartella).find((n) => n.endsWith('_video_pubblicazione_automatica.sql')) as string
    const sql = readFileSync(join(cartella, nome), 'utf8')
    const corpo = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.video_job_diagnosi('))
    const regola = /like_regex "(\^\[A-Za-z\]\[A-Za-z0-9_-\]\{0,63\}\$)"/.exec(corpo)
    expect(regola, 'la RPC deve avere una regola sulle stringhe').not.toBeNull()
    const enumerato = new RegExp(regola?.[1] as string)
    const limite = Number(/octet_length\(p_diagnosi::text\) > (\d+)/.exec(corpo)?.[1])
    expect(limite).toBe(2048)

    const { c } = await lancia(VERIFICA_FALLITA)
    const diagnosi = c.diagnosi[0].diagnosi as Record<string, unknown>
    expect(Object.keys(diagnosi).length).toBeGreaterThan(3)
    for (const [chiave, valore] of Object.entries(diagnosi)) {
      expect(chiave, `la chiave «${chiave}»`).toMatch(enumerato)
      if (typeof valore === 'string') expect(valore, `il valore di «${chiave}»`).toMatch(enumerato)
      else expect(typeof valore === 'number' && Number.isFinite(valore), `il valore di «${chiave}» è un numero`).toBe(true)
    }
    expect(JSON.stringify(diagnosi).length).toBeLessThanOrEqual(limite)
  })

  it('OGNI motivo della prova temporale e ogni modo passano la stessa regola della RPC: nessuna stringa che la RPC respingerebbe', () => {
    // Un solo caso (le dimensioni) non basta: `motivo` e `modo` sono le uniche stringhe che arrivano da un elenco, e un nome nuovo che
    // cominciasse per cifra o avesse uno spazio farebbe respingere (`BAD_INPUT`) la diagnosi proprio dei rifiuti temporali.
    const cartella = join(process.cwd(), 'supabase', 'migrations')
    const nome = readdirSync(cartella).find((n) => n.endsWith('_video_pubblicazione_automatica.sql')) as string
    const sql = readFileSync(join(cartella, nome), 'utf8')
    const regola = /like_regex "(\^\[A-Za-z\]\[A-Za-z0-9_-\]\{0,63\}\$)"/.exec(sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.video_job_diagnosi(')))
    const enumerato = new RegExp(regola?.[1] as string)

    const sorgente = parseVideoProbe(probeSorgente(), 20_000_000)
    if (!sorgente.ok) throw new Error(`la fixture deve essere un probe valido: ${sorgente.code}`)
    for (const modo of ['preserve', 'reduce60'] as const) {
      for (const motivo of VIDEO_TEMPORAL_REASONS) {
        const diagnosi = diagnosiVerifica(
          sorgente.probe,
          probeUscita(),
          {
            exitCode: 0,
            decodedFrames: 10,
            temporal: { version: 1, ok: false, mode: modo, sourceFrames: 10, outputFrames: 9, sourceFps: 30, outputFps: 30, reason: motivo },
          },
          'OUTPUT_FPS_INVALID',
        ) as Record<string, unknown>
        expect(diagnosi, `${modo}/${motivo}: il motivo deve arrivare nei numeri`).toMatchObject({ modo, motivo })
        for (const [chiave, valore] of Object.entries(diagnosi)) {
          expect(chiave, `${modo}/${motivo}: la chiave «${chiave}»`).toMatch(enumerato)
          if (typeof valore === 'string') expect(valore, `${modo}/${motivo}: «${chiave}»`).toMatch(enumerato)
        }
      }
    }
    expect(VIDEO_TEMPORAL_REASONS.length).toBeGreaterThanOrEqual(7)
  })

  it('un job che passa la verifica NON ne scrive una: la diagnosi è del rifiuto', async () => {
    const { esito, c } = await lancia()

    expect(esito).toMatchObject({ esito: 'pronto' })
    expect(c.diagnosi).toEqual([])
  })

  it('un guasto che NON è la verifica (uscita della conversione, probe della sorgente) non scrive nessuna diagnosi', async () => {
    const { c } = await lancia(CONVERSIONE_CON(32, 'Conversion failed!'))
    expect(c.diagnosi).toEqual([])
    expect(c.falliti).toHaveLength(1)
  })

  it.each<[string, NonNullable<Parameters<typeof lancia>[0]>['coda']]>([
    ['la RPC dice di no (`FENCE_MISMATCH`)', { diagnosi: { ok: false, code: 'FENCE_MISMATCH' } }],
    ['la chiamata non arriva (`RPC_ERROR`)', { diagnosi: { ok: false, code: 'RPC_ERROR' } }],
  ])('%s: l’ESITO non cambia (il job è rifiutato lo stesso) e si logga `warn`', async (_nome, coda) => {
    const { esito, c } = await lancia({ ...VERIFICA_FALLITA, coda })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'OUTPUT_DIMENSIONS_INVALID', rifiutato: true })
    expect(c.falliti).toHaveLength(1)
    const log = riga('diagnosi-non-scritta')
    expect(log[1]).toBe('warn')
    expect(log[2]).toMatchObject({ error_code: (coda?.diagnosi as { code: string }).code, job_id: JOB_ID })
  })

  it('un adattatore che LANCIA non cambia l’esito, e il motivo si legge (un catch che non logga è un bug)', async () => {
    const { esito, c } = await lancia({ ...VERIFICA_FALLITA, coda: { diagnosi: new Error('rete giù') } })

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB_ID, codice: 'OUTPUT_DIMENSIONS_INVALID', rifiutato: true })
    expect(c.falliti).toHaveLength(1)
    const log = riga('diagnosi-non-scritta')
    expect(log[1]).toBe('warn')
    expect(comeInTabella(log).messaggio).toContain('rete giù')
  })

  it('anche `OUTPUT_FPS_INVALID` (la prova temporale) scrive i numeri, con modo e motivo della prova', async () => {
    const marcatoreTemporale = [
      'KV_ESITO_EXIT=0',
      'KV_BYTE_SORGENTE=20000000',
      'KV_BYTE_USCITA=8000000',
      'KV_DECODE_EXIT=0',
      'KV_DECODE_FRAMES=5391',
      `KV_TEMPORAL=${JSON.stringify({ version: 1, ok: false, mode: 'preserve', sourceFrames: 5391, outputFrames: 5390, sourceFps: 30000 / 1001, outputFps: 30000 / 1001, reason: 'FRAME_COUNT_MISMATCH' })}`,
      '===PROBE_SORGENTE===',
      probeSorgente(),
      '===PROBE_USCITA===',
      probeUscita(),
      '===DIAGNOSI===',
      'frame= 5391 fps=120 q=-1.0',
    ].join('\n')
    const { esito, c } = await lancia({ risposta: rispostaFelice(marcatoreTemporale) })

    expect(esito).toMatchObject({ esito: 'fallito', codice: 'OUTPUT_FPS_INVALID' })
    expect(c.diagnosi).toHaveLength(1)
    expect(c.diagnosi[0].diagnosi).toMatchObject({
      esito: 'OUTPUT_FPS_INVALID',
      modo: 'preserve',
      motivo: 'FRAME_COUNT_MISMATCH',
      frame_sorgente: 5391,
      frame_uscita: 5390,
    })
  })

  it('le tracce audio IGNORATE si vedono nel log (`info`, solo il conteggio, una riga per job)', async () => {
    const conDueAudio = JSON.parse(probeSorgente()) as { streams: Record<string, unknown>[] }
    conDueAudio.streams.push(
      { index: 1, codec_type: 'audio', codec_name: 'aac', duration: String(DURATA_SORGENTE), disposition: { default: 1 } },
      // Il codec ignoto: ffprobe NON scrive `codec_name`.
      { index: 2, codec_type: 'audio', duration: String(DURATA_SORGENTE), disposition: { default: 0 } },
    )
    const { esito } = await lancia({
      risposta: (cmd) =>
        eApparecchio(cmd)
          ? { exitCode: 0, stdout: uscitaApparecchio(JSON.stringify(conDueAudio)), stderr: '' }
          : rispostaFelice()(cmd),
    })

    // L'audio che non si sa convertire non ferma il video: l'uscita ne ha UNA, la scelta, e il job arriva a `pronto`.
    expect(esito).toMatchObject({ esito: 'pronto' })
    const log = riga('tracce-audio-ignorate')
    expect(log[1]).toBe('info')
    expect(log[2]).toMatchObject({ tracce_ignorate: 1, job_id: JOB_ID })
    expect(log[4]).toEqual({ distingui: ['job_id'] })
  })

  it('senza tracce ignorate (un solo audio, o nessuno) non scrive niente: un caso normale non è una riga', async () => {
    await lancia()
    expect(conEsito('tracce-audio-ignorate')).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 23. L'ECCEZIONE DELL'SDK NON ENTRA NEL LOG COM'È (T8, secondario #104; T8b, secondario #163: anche lo spegnimento)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · l’eccezione dell’SDK passa dalla sanificazione prima di entrare nel log (secondari #104 e #163)', () => {
  /** Il messaggio di un SDK che fa richieste autenticate e, fallendo, scrive l'indirizzo che chiamava. */
  const CON_SEGRETI =
    'Sandbox API 429 su https://api.vercel.com/v1/sandboxes?teamId=team_x&token=eyJhbGciOi.SEGRETO: troppe richieste'
  const SEGRETI = ['https://', 'api.vercel.com', 'eyJhbGciOi', 'SEGRETO', 'token=']

  /** Un errore come quello dell'SDK di Vercel: `APIError`, con `response.status` e `json.error.code`. */
  class ErroreApiFinto extends Error {
    response = { status: 429 }
    json = { error: { code: 'rate_limited' } }
    constructor(messaggio: string) {
      super(messaggio)
      this.name = 'APIError'
    }
  }

  const nessunSegreto = (): void => {
    const nelLog = JSON.stringify(righeDiLog().map((r) => [r[0], r[1], r[2], String(r[3] ?? '')]))
    const inTabella = JSON.stringify(righeDiLog().map((r) => comeInTabella(r)))
    for (const segreto of SEGRETI) {
      expect(nelLog, `«${segreto}» è finito in un log`).not.toContain(segreto)
      expect(inTabella, `«${segreto}» è finito in app_log`).not.toContain(segreto)
    }
  }

  it.each<[string, (e: Error) => Parameters<typeof lancia>[0], string]>([
    ['`avvia` della conversione staccata', (e) => ({ avviaFallisce: e }), 'avvia'],
    [
      '`esegui` dell’apparecchio',
      (e) => ({ risposta: (cmd) => (eApparecchio(cmd) ? e : OK) }),
      'esegui',
    ],
  ])('%s lancia con un URL e un token nel messaggio: il log tiene il motivo e perde il segreto', async (_nome, opzioni, azione) => {
    const { esito } = await lancia(opzioni(new Error(CON_SEGRETI)))

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SANDBOX_UNAVAILABLE' })
    const log = riga('conversione-da-riprovare')
    expect(log[2]).toMatchObject({ azione })
    // La CAUSA resta leggibile (è l'unica cosa che dice «quota finita» e non «regione giù»)…
    expect(comeInTabella(log).messaggio).toContain('troppe richieste')
    // …e il segreto no.
    nessunSegreto()
  })

  it('l’apertura della MicroVM che lancia (snapshot e ripiego falliti entrambi) passa dalla stessa sanificazione', async () => {
    const { esito } = await lancia({
      dipendenze: {
        macchina: {
          apri: async () => {
            throw new Error(CON_SEGRETI)
          },
        },
      },
    })

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SANDBOX_UNAVAILABLE' })
    expect(comeInTabella(riga('conversione-da-riprovare')).messaggio).toContain('troppe richieste')
    nessunSegreto()
  })

  it('un errore dell’SDK con stato e codice (`APIError`) porta nome, stato HTTP e codice nel messaggio, e lo stato nei campi', async () => {
    const { esito } = await lancia({
      dipendenze: {
        macchina: {
          apri: async () => {
            throw new ErroreApiFinto(CON_SEGRETI)
          },
        },
      },
    })

    expect(esito).toMatchObject({ esito: 'in-riprova', codice: 'SANDBOX_UNAVAILABLE' })
    const log = riga('conversione-da-riprovare')
    // Lo stato HTTP in un campo NUMERICO: una query «i 429 di oggi» lo trova senza leggere il testo.
    expect(log[2]).toMatchObject({ http: 429, error_code: 'SANDBOX_UNAVAILABLE' })
    const messaggio = comeInTabella(log).messaggio
    expect(messaggio.startsWith('APIError HTTP 429 rate_limited: ')).toBe(true)
    expect(messaggio).toContain('troppe richieste')
    nessunSegreto()
  })

  /** Un JWT di fantasia a tre segmenti (il primo comincia per `eyJ`): quello che un client scrive nell'intestazione di una richiesta. */
  const JWT_FINTO = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm92YSJ9.c2lnbmF0dXJhLWZpbnRh'

  it.each<[string, () => Error, string]>([
    ['un `APIError` (stato e codice) con un URL e un token nel messaggio', () => new ErroreApiFinto(CON_SEGRETI), 'troppe richieste'],
    ['un errore qualunque con un URL e un token nel messaggio', () => new Error(CON_SEGRETI), 'troppe richieste'],
    [
      'un URL firmato dello Storage col JWT nel parametro',
      () => new Error(`PUT https://esempio.invalid/storage/v1/object/sign/video_originals/x?token=${JWT_FINTO} rifiutato: oggetto assente`),
      'oggetto assente',
    ],
    ['un JWT SENZA indirizzo né `token=` (la coda di un log, un’intestazione)', () => new Error(`sessione rifiutata per ${JWT_FINTO}: scaduta`), 'scaduta'],
  ])(
    'lo SPEGNIMENTO che lancia — %s —: `microvm-non-spenta` tiene il motivo e perde il segreto (secondario #163)',
    async (_nome, errore, motivo) => {
      const { esito, s } = await lancia({ fermaFallisce: errore() })

      // L'esito del job NON si tocca: la conversione è finita bene, e che la MicroVM non si spenga è un conto a parte…
      expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
      expect(s.fermate()).toBe(1)
      // …che si grida a `error` (una MicroVM accesa si paga a `GB × ore`), una volta sola…
      const log = riga('microvm-non-spenta')
      expect(log[1]).toBe('error')
      // …col MOTIVO ancora leggibile (è l'unica cosa che dice «quota finita» e non «piattaforma giù»)…
      expect(comeInTabella(log).messaggio).toContain(motivo)
      // …e senza il segreto: né nel messaggio, né nei campi, né fra gli argomenti che il codice passa al logger.
      nessunSegreto()
      expect(String(log[3])).not.toContain('SEGRETO')
      // Nemmeno un pezzo di JWT (la FIRMA è l'ultimo segmento: sola, non autorizza niente, ma «un pezzo» è già una perdita).
      const nelLog = JSON.stringify(righeDiLog().map((r) => [r[2], String(r[3] ?? ''), comeInTabella(r)]))
      for (const pezzo of JWT_FINTO.split('.')) expect(nelLog, `un segmento del JWT è finito in un log: ${pezzo}`).not.toContain(pezzo)
    },
  )

  it('lo spegnimento che lancia un `APIError` porta nome, stato e codice DAVANTI al testo: è la forma di `erroreSanificatoPerIlLog`, non l’eccezione grezza', async () => {
    await lancia({ fermaFallisce: new ErroreApiFinto(CON_SEGRETI) })

    const messaggio = comeInTabella(riga('microvm-non-spenta')).messaggio
    expect(messaggio.startsWith('APIError HTTP 429 rate_limited: ')).toBe(true)
  })

  it('le altre cause (la geometria che `buildVideoEncodeArgs` rifiuta) passano dallo stesso filtro, e il messaggio resta', async () => {
    const { esito } = await lancia({
      risposta: apparecchioConProbe(probeSorgente().replace('"width":1920', '"width":1').replace('"coded_width":1920', '"coded_width":1')),
    })

    expect(esito).toMatchObject({ esito: 'fallito', codice: 'ENCODE_FAILED', rifiutato: true })
    // Il messaggio è quello di `buildVideoEncodeArgs`, e c'è: ripulirlo non è cancellarlo.
    expect(comeInTabella(riga('conversione-fallita')).messaggio.length).toBeGreaterThan(10)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 24. LA RETE DEGLI ARRIVI: I NUMERI NEL REGISTRO DEL RUNNER (T8, secondario #128)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · la rete degli arrivi porta i suoi numeri nel registro (secondario #128)', () => {
  const arrivi = (conteggi: Record<string, number>): { coda: CopioneCoda } => ({
    coda: { arriviRecupera: { ok: true, conteggi } },
  })

  it('`non_risolti` > 0: una riga `warn` con i QUATTRO numeri, nei campi e nell’impronta', async () => {
    await lancia(arrivi({ candidati: 4, arrivati: 0, diversi: 0, non_risolti: 4, errori: 0 }))

    const log = riga('arrivi-recuperati')
    expect(log[0]).toBe('cron')
    expect(log[1]).toBe('warn')
    expect(log[2]).toMatchObject({
      operazione: 'video-runner',
      candidati: 4,
      arrivati: 0,
      diversi: 0,
      non_risolti: 4,
      errori: 0,
    })
    // Lo stesso giorno con `non_risolti` 2 e con 9 sono due righe: `app_log` somma le occorrenze e tiene il contesto
    // della PRIMA, quindi senza `distingui` il numero che cresce durante il giorno non si vedrebbe mai.
    expect(log[4]).toEqual({ distingui: ['arrivati', 'diversi', 'non_risolti', 'errori'] })
    expect(comeInTabella(log).contestoExtra?.campi).toMatchObject({ non_risolti: 4 })
  })

  it.each<[string, Record<string, number>]>([
    ['`arrivati` > 0: il TRIGGER non ha visto un arrivo', { candidati: 1, arrivati: 1 }],
    ['`diversi` > 0: un file rifiutato per dimensione', { candidati: 1, diversi: 1 }],
    ['`errori` > 0: un candidato ha fatto esplodere il giro', { candidati: 1, errori: 1 }],
  ])('%s: una riga, perché è un segno da vedere', async (_nome, conteggi) => {
    await lancia(arrivi(conteggi))
    expect(conEsito('arrivi-recuperati')).toHaveLength(1)
  })

  it('tutto a zero è il funzionamento normale e NON scrive niente (la riga del database c’è già a ogni giro)', async () => {
    await lancia(arrivi({ candidati: 0, arrivati: 0, diversi: 0, non_risolti: 0, errori: 0 }))
    expect(conEsito('arrivi-recuperati')).toEqual([])
    // Nemmeno il caso che il doppio dà di default (solo `candidati` e `arrivati` a zero).
    h.log.length = 0
    await lancia()
    expect(conEsito('arrivi-recuperati')).toEqual([])
  })

  it('la riga non ferma il giro: il job si converte lo stesso', async () => {
    const { esito } = await lancia(arrivi({ candidati: 3, non_risolti: 3 }))
    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
  })

  it('il commento del limite dice «dal più recente», non «dal più vecchio» (l’ordine l’ha cambiato il database)', () => {
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/media/video/runner/esegui.ts'), 'utf8')
    const punto = sorgente.indexOf('const LIMITE_ARRIVI_PER_GIRO')
    expect(punto).toBeGreaterThan(0)
    // Il commento che sta SOPRA la costante (i 1500 caratteri precedenti): è proprio quello che è invecchiato.
    const commento = sorgente.slice(Math.max(0, punto - 1500), punto)
    expect(commento).toContain('dal più recente')
    // «dal più vecchio» ricompare solo come ciò che NON si fa (la spiegazione del perché), mai come descrizione dell'ordine.
    expect(commento).not.toMatch(/guardano al più cinquanta,\s*dal più vecchio/)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 25. IL TIMEOUT DELLA SONDA NELLO SCRIPT GENERATO (T8, secondario #9: la verifica che T6 l'abbia chiuso)
 *
 * Il test di T6 (sezione 15) passa dal runner. Qui si guarda lo script che `scriptConversione` PRODUCE per i
 * due casi che il titolare ha nominato: un Full HD di 180 s (il caso di oggi) e un 4K di 300 s (il tetto nuovo).
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · il timeout della sonda temporale nello script GENERATO (secondario #9)', () => {
  const timeoutDi = (script: string): number => {
    const trovato = /"timeoutMs":(\d+)/.exec(script)
    expect(trovato, 'lo script non porta il timeout della sonda temporale').not.toBeNull()
    return Number(trovato?.[1])
  }
  const script = (misure: { durationSeconds?: number; width?: number; height?: number; sourceFps: number }) =>
    scriptConversione({ conWatermark: true, videoIndex: 0, audioIndex: 1, ...misure })

  it('1080p di 180 s a 30 fps: ~254 s, PROPORZIONALE — né il pavimento di prima (120 s) né il tetto (900 s)', () => {
    const t = timeoutDi(script({ durationSeconds: 180, width: 1920, height: 1080, sourceFps: 30 }))

    expect(t).toBe(timeoutSondaTemporaleMs({ durationSeconds: 180, width: 1920, height: 1080, fps: 30 }))
    // Il numero a occhio, dalla regola dichiarata (30 s fissi + 20 ms per megapixel decodificato): un Full HD a 30 fps per 180 s
    // sono ~11.200 megapixel, cioè ~224 s più i 30 di base. Sotto i 250 s non si scende: un video buono verrebbe scartato.
    expect(t).toBeGreaterThanOrEqual(250_000)
    expect(t).toBeLessThanOrEqual(258_000)
    expect(t).toBeGreaterThan(SONDA_TEMPORALE.pavimentoMs)
    expect(t).toBeLessThan(SONDA_TEMPORALE.tettoMs)
  })

  it.each([30, 60])('4K di 300 s a %i fps: la stima supera il tetto, e il timeout È il tetto (900 s) — mai di più', (fps) => {
    const t = timeoutDi(script({ durationSeconds: 300, width: 3840, height: 2160, sourceFps: fps }))

    expect(t).toBe(SONDA_TEMPORALE.tettoMs)
    // È il tetto PERCHÉ la stima lo supera, non perché mancassero i numeri (con le misure assenti vale lo stesso 900 s: il
    // 4K breve qui sotto è ciò che distingue i due casi). La stima si riscrive dalla regola dichiarata nelle costanti —
    // la base fissa più i millisecondi per megapixel decodificato — e non si chiede alla funzione che la limita.
    const stimaGrezza =
      SONDA_TEMPORALE.baseMs + ((3840 * 2160) / 1_000_000) * fps * 300 * SONDA_TEMPORALE.msPerMegapixelDecodificato
    expect(stimaGrezza).toBeGreaterThan(SONDA_TEMPORALE.tettoMs)
  })

  it('un 4K BREVE (20 s a 30 fps) non è il tetto: i numeri contano, e arrivano fino al programma', () => {
    const lungo = timeoutDi(script({ durationSeconds: 300, width: 3840, height: 2160, sourceFps: 30 }))
    const breve = timeoutDi(script({ durationSeconds: 20, width: 3840, height: 2160, sourceFps: 30 }))

    expect(breve).toBeLessThan(lungo)
    expect(breve).toBeLessThan(SONDA_TEMPORALE.tettoMs)
    expect(breve).toBeGreaterThan(SONDA_TEMPORALE.pavimentoMs)
    expect(breve).toBe(timeoutSondaTemporaleMs({ durationSeconds: 20, width: 3840, height: 2160, fps: 30 }))
  })

  it('senza le tre misure la sonda parte col TETTO (non sapere quanto è grande il file è il caso in cui meno si scarta): è il difetto che il cablaggio chiude', () => {
    const t = timeoutDi(script({ sourceFps: 30 }))
    expect(t).toBe(SONDA_TEMPORALE.tettoMs)
    // Lo stesso Full HD di 180 s CON le misure è molto più corto: la differenza è ciò che `esegui.ts` guadagna passandole.
    expect(timeoutDi(script({ durationSeconds: 180, width: 1920, height: 1080, sourceFps: 30 }))).toBeLessThan(t / 3)
  })

  it('il programma porta anche il tetto di durata dell’ingresso (300 s), non quello vecchio', () => {
    expect(script({ durationSeconds: 180, width: 1920, height: 1080, sourceFps: 30 })).toContain(
      `"maxDurationSeconds":${MAX_VIDEO_DURATION_SECONDS}`,
    )
    expect(MAX_VIDEO_DURATION_SECONDS).toBe(300)
  })
})
