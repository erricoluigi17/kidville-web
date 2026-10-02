// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rigaEvento } from '@/lib/logging/logger'
import { MESSAGGIO_MAX } from '@/lib/logging/serialize'
import {
  BUCKET_BUILD_VIDEO,
  CARTELLA_BINARI_NELLO_SNAPSHOT,
  FFMPEG_GZ_SHA256,
  FFMPEG_SHA256,
  FFPROBE_GZ_SHA256,
  FFPROBE_SHA256,
} from '@/lib/media/video/build'
import { macchinaVercel } from '@/lib/media/video/runner/adattatori'
import {
  ENV_SNAPSHOT_SANDBOX,
  MOTIVI_AMBIENTE_ASSENTE,
  RUNTIME_DI_RIPIEGO,
  apriLaMicroVm,
  erroreSanificatoPerIlLog,
  fattiDellErrore,
  leggiSnapshotConfigurato,
  type ParametriCreazione,
  type SdkMicroVm,
} from '@/lib/media/video/runner/ambiente'
import { CODICI_RUNNER_VIDEO } from '@/lib/media/video/runner/codici'
import {
  CARTELLA_BUILD,
  ENV_URL_FFMPEG,
  ENV_URL_FFPROBE,
  USCITE_PREPARAZIONE,
  codiceDaUscitaPreparazione,
  comandoInventarioBuild,
  scriptPreparazioneBuild,
} from '@/lib/media/video/runner/preparazione'
import { decidiRitentativo, classeDaUscitaApparecchio, classeDaUscitaConversione } from '@/lib/media/video/runner/ritentativi'
import {
  ENV_SHA256_ATTESO,
  MODELLO_PROCESSI_DEI_BINARI,
  USCITE_APPARECCHIO,
  USCITE_CONVERSIONE,
  codiceDaUscitaApparecchio,
  codiceDaUscitaConversione,
  comandoInterruzione,
  leggiSha256Dichiarato,
  scriptApparecchio,
  scriptConversione,
  scriptVerificaBinari,
} from '@/lib/media/video/runner/script'

/**
 * L'AMBIENTE PRONTO — lo snapshot, il ripiego, lo `sha256` dichiarato, e lo script che costruisce lo snapshot.
 *
 * Che cosa si prova QUI, e che cosa altrove:
 *
 *  · la SCELTA «riaggancia, poi snapshot, poi ripiego» (`apriLaMicroVm`) con un SDK FINTO che lancia dove si vuole:
 *    il test che mancava a un adattatore che in locale non si può eseguire;
 *  · il cablaggio di `macchinaVercel()` — che cosa chiede davvero a `Sandbox.get` e `Sandbox.create` — con l'SDK
 *    sostituito da un doppio. Le FIRME dell'SDK vero le controlla `tsc` (l'adattatore compila contro i suoi tipi);
 *  · gli script di shell come TESTO e come ESECUZIONE: l'esecuzione con una `sh` vera è in
 *    `video-runner-apparecchio-shell.test.ts` e `video-runner-preparazione-shell.test.ts`;
 *  · il giro dentro `esegui.ts` (che cosa fa il runner di un ambiente da snapshot, di un `sha256`, di una diagnosi)
 *    è in `video-runner-orchestrazione.test.ts`, sezioni 20–25.
 *
 * Che cosa NON si prova, e resta al Sandbox vero (T16, §10.3): che uno snapshot costruito da
 * `scripts/video-sandbox-ambiente.mjs` si ripristini davvero in `dub1`, che Ubuntu 26.04 esegua i binari statici, e
 * quanto più veloce sia l'avvio.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Il registratore dei log, e l'SDK finto
 * ──────────────────────────────────────────────────────────────────────────── */

const h = vi.hoisted(() => ({
  log: [] as unknown[][],
  get: vi.fn(),
  create: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...argomenti: unknown[]) => {
    h.log.push(argomenti)
  },
}))

// L'SDK del Sandbox: due metodi statici sostituibili. Quello vero non si esercita in un test.
vi.mock('@vercel/sandbox', () => ({ Sandbox: { get: h.get, create: h.create } }))

beforeEach(() => {
  h.log.length = 0
  h.get.mockReset()
  h.create.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

type ChiamataLog = [
  evento: string,
  livello: 'info' | 'warn' | 'error',
  campi: Record<string, unknown>,
  err?: unknown,
  opzioni?: { distingui?: readonly string[] },
]
const righeDiLog = (): ChiamataLog[] => h.log as unknown as ChiamataLog[]
const conEsito = (esito: string): ChiamataLog[] => righeDiLog().filter((r) => r[2].esito === esito)

function comeInTabella(r: ChiamataLog) {
  const tabella = rigaEvento(r[0], r[1], r[2] as never, r[3], r[4])
  expect(tabella, 'rigaEvento deve produrre una riga').toBeDefined()
  return tabella as NonNullable<typeof tabella>
}

const senzaCommenti = (sorgente: string): string =>
  sorgente
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((riga) => !riga.trimStart().startsWith('//'))
    .join('\n')

const RADICE = process.cwd()
const leggi = (...percorso: string[]): string => readFileSync(join(RADICE, ...percorso), 'utf8')

/* ════════════════════════════════════════════════════════════════════════════
 * 1. LA VARIABILE
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · la variabile VIDEO_SANDBOX_SNAPSHOT_ID', () => {
  it('si chiama come dice la spec (§10.1)', () => {
    expect(ENV_SNAPSHOT_SANDBOX).toBe('VIDEO_SANDBOX_SNAPSHOT_ID')
  })

  it.each<[string, string | undefined]>([
    ['non impostata', undefined],
    ['vuota', ''],
    ['solo spazi', '   '],
    ['un a capo (incollata con `echo`)', '\n'],
  ])('%s → `assente`', (_nome, valore) => {
    expect(leggiSnapshotConfigurato(valore)).toEqual({ stato: 'assente' })
  })

  it.each([
    ['spazi in mezzo', 'snap abc123'],
    ['una barra', 'snap/abc123'],
    ['le virgolette incollate', '"snap_abc123"'],
    ['troppo corto', 'snap'],
    ['un URL', 'https://esempio.invalid/snap_abc123'],
    ['il punto e virgola di un comando', 'snap_abc123;rm'],
  ])('un valore che non somiglia a un identificativo (%s) → `non-valido`', (_nome, valore) => {
    expect(leggiSnapshotConfigurato(valore)).toEqual({ stato: 'non-valido' })
  })

  it.each(['snap_AbCdEf123456', 'snap_0123456789abcdefghij', 'abc-123_XYZ456'])('un identificativo (%s) → `ok`, senza spazi ai lati', (id) => {
    expect(leggiSnapshotConfigurato(id)).toEqual({ stato: 'ok', id })
    expect(leggiSnapshotConfigurato(`  ${id}\n`)).toEqual({ stato: 'ok', id })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. L'ERRORE DELL'SDK, IN UNA FORMA CHE PUÒ ENTRARE IN UN LOG
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · i fatti di un errore (nome, stato HTTP, codice) e il suo testo ripulito', () => {
  class ErroreApiFinto extends Error {
    response: { status: unknown }
    json: unknown
    constructor(messaggio: string, stato: unknown, codice: unknown) {
      super(messaggio)
      this.name = 'APIError'
      this.response = { status: stato }
      this.json = { error: { code: codice } }
    }
  }

  it('un `APIError` dell’SDK: nome, `response.status` e `json.error.code`', () => {
    expect(fattiDellErrore(new ErroreApiFinto('x', 410, 'snapshot_not_found'))).toEqual({
      nome: 'APIError',
      http: 410,
      codice: 'snapshot_not_found',
    })
  })

  it('un errore di rete di Node: il `code` di Node, anche dentro `cause` (è lì che undici scrive il motivo vero)', () => {
    const diretto = Object.assign(new Error('boom'), { code: 'ECONNRESET' })
    expect(fattiDellErrore(diretto)).toEqual({ nome: 'Error', http: null, codice: 'ECONNRESET' })

    const dentroCause = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
    expect(fattiDellErrore(dentroCause)).toEqual({ nome: 'TypeError', http: null, codice: 'UND_ERR_CONNECT_TIMEOUT' })
  })

  it('un errore di un altro client: `status` o `statusCode` al posto di `response.status`', () => {
    expect(fattiDellErrore(Object.assign(new Error('x'), { status: 503 })).http).toBe(503)
    expect(fattiDellErrore(Object.assign(new Error('x'), { statusCode: 502 })).http).toBe(502)
  })

  it('il codice dell’API vince su quello di Node, e lo stato di `response` su `status`', () => {
    const e = Object.assign(new ErroreApiFinto('x', 429, 'rate_limited'), { code: 'ECONNRESET', status: 500 })
    expect(fattiDellErrore(e)).toMatchObject({ http: 429, codice: 'rate_limited' })
  })

  it.each<[string, unknown]>([
    ['un codice con spazi (testo libero)', 'questa è una frase intera'],
    ['un codice che comincia per cifra', '404_non_trovato'],
    ['un codice di 65 caratteri', 'a'.repeat(65)],
    ['un numero al posto del codice', 410],
    ['un oggetto al posto del codice', { dentro: 1 }],
  ])('%s NON passa: il campo resta `null`', (_nome, codice) => {
    expect(fattiDellErrore(new ErroreApiFinto('x', 200, codice)).codice).toBeNull()
  })

  it.each<[string, unknown]>([
    ['99 (sotto i 100)', 99],
    ['600 (oltre i 599)', 600],
    ['un decimale', 404.5],
    ['una stringa', '404'],
    ['NaN', Number.NaN],
  ])('uno stato HTTP che non è tale (%s) → `null`', (_nome, stato) => {
    expect(fattiDellErrore(new ErroreApiFinto('x', stato, null)).http).toBeNull()
  })

  it('non si fida dell’oggetto: un getter che lancia, un valore che non è un oggetto, `null`, una stringa', () => {
    const ostile = {
      get response(): never {
        throw new Error('getter ostile')
      },
      get name(): never {
        throw new Error('getter ostile')
      },
    }
    expect(fattiDellErrore(ostile)).toEqual({ nome: null, http: null, codice: null })
    for (const valore of [null, undefined, 'stringa', 42, true]) {
      expect(fattiDellErrore(valore), String(valore)).toEqual({ nome: null, http: null, codice: null })
    }
  })

  describe('`erroreSanificatoPerIlLog`', () => {
    const CON_SEGRETI = 'chiamata a https://api.esempio.invalid/v1/sandboxes?token=eyJhbGciOi.SEGRETO fallita: quota finita'

    it('toglie URL e credenziali e TIENE il motivo: «quota finita» non sparisce', () => {
      const e = erroreSanificatoPerIlLog(new Error(CON_SEGRETI))
      expect(e).toBeInstanceOf(Error)
      expect(e.message).toContain('quota finita')
      for (const segreto of ['https://', 'api.esempio.invalid', 'eyJhbGciOi', 'SEGRETO', 'token=']) {
        expect(e.message, segreto).not.toContain(segreto)
      }
    })

    it('porta nome, stato HTTP e codice DAVANTI al testo, e il codice anche nella proprietà `code`', () => {
      const e = erroreSanificatoPerIlLog(new ErroreApiFinto(CON_SEGRETI, 429, 'rate_limited'))
      expect(e.message.startsWith('APIError HTTP 429 rate_limited: ')).toBe(true)
      expect(e.name).toBe('VideoSandboxError')
      expect((e as Error & { code?: string }).code).toBe('rate_limited')
    })

    it('un errore chiamato soltanto «Error» non porta il nome davanti (non dice niente), uno che ha un nome vero sì', () => {
      expect(erroreSanificatoPerIlLog(new Error('la MicroVM non risponde')).message).toBe('la MicroVM non risponde')
      expect(erroreSanificatoPerIlLog(new TypeError('fetch failed')).message).toBe('TypeError: fetch failed')
      // Con stato o codice il prefisso c'è anche per un `Error` nudo: sono loro a dire qualcosa.
      expect(erroreSanificatoPerIlLog(Object.assign(new Error('x'), { status: 503 })).message).toBe('HTTP 503: x')
    })

    it('senza codice non inventa la proprietà `code`', () => {
      expect(erroreSanificatoPerIlLog(new Error('x'))).not.toHaveProperty('code')
    })

    it('un’email o un codice fiscale dentro il messaggio sono mascherati (la stessa sanificazione del logger)', () => {
      const e = erroreSanificatoPerIlLog(new Error('utente rossi.maria@esempio.invalid, cf RSSMRA85T10A562S'))
      expect(e.message).not.toContain('@')
      expect(e.message).not.toContain('RSSMRA85T10A562S')
    })

    it('un messaggio lungo non gonfia il log: sta sotto il tetto del messaggio', () => {
      const e = erroreSanificatoPerIlLog(new Error('riga di errore. '.repeat(500)))
      expect(e.message.length).toBeLessThan(MESSAGGIO_MAX)
    })

    it.each<[string, unknown, string]>([
      ['una stringa lanciata (`throw "x"`)', 'qualcosa è andato storto', 'qualcosa è andato storto'],
      ['un valore che non è un errore', 42, 'errore non descrivibile'],
      ['`undefined`', undefined, 'errore non descrivibile'],
      ['un oggetto nudo', { dentro: 1 }, 'errore non descrivibile'],
    ])('%s: un errore ben formato, e MAI un’eccezione', (_nome, valore, atteso) => {
      const e = erroreSanificatoPerIlLog(valore)
      expect(e).toBeInstanceOf(Error)
      expect(e.message).toContain(atteso)
    })

    it('un errore il cui `message` è un getter che lancia non fa lanciare il log di un guasto', () => {
      const ostile = Object.defineProperty(new Error('x'), 'message', {
        get() {
          throw new Error('getter ostile')
        },
      })
      expect(() => erroreSanificatoPerIlLog(ostile)).not.toThrow()
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. APRIRE LA MICROVM: riaggancio, snapshot, ripiego (con un SDK FINTO)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · apriLaMicroVm: riaggancio, poi snapshot, poi ripiego — provato con un SDK che lancia dove si vuole', () => {
  const RICHIESTA = { nome: 'kv-video-abc-5', regione: 'dub1', vcpus: 4, tettoMs: 1_800_000 }
  const SNAPSHOT_OK = { stato: 'ok', id: 'snap_AbCdEf123456' } as const

  class ErroreApi extends Error {
    response: { status: number }
    json: { error: { code: string } }
    constructor(stato: number, codice: string, messaggio = 'snapshot non trovato') {
      super(messaggio)
      this.name = 'APIError'
      this.response = { status: stato }
      this.json = { error: { code: codice } }
    }
  }

  /** Un SDK finto: ogni chiamata si registra, e le tre risposte si decidono per scenario. */
  function sdkFinto(copione: {
    riaggancia?: 'riesce' | Error
    creaDaSnapshot?: 'riesce' | Error
    creaDaRuntime?: 'riesce' | Error
  }) {
    const chiamate: { tipo: 'riaggancia' | 'crea'; argomento: unknown }[] = []
    const sdk: SdkMicroVm<{ id: string }> = {
      async riaggancia(nome) {
        chiamate.push({ tipo: 'riaggancia', argomento: nome })
        const risposta = copione.riaggancia ?? new Error('Sandbox non trovato')
        if (risposta instanceof Error) throw risposta
        return { id: 'riagganciata' }
      },
      async crea(parametri) {
        chiamate.push({ tipo: 'crea', argomento: parametri })
        const daSnapshot = 'source' in parametri
        const risposta = daSnapshot ? (copione.creaDaSnapshot ?? 'riesce') : (copione.creaDaRuntime ?? 'riesce')
        if (risposta instanceof Error) throw risposta
        return { id: daSnapshot ? 'dallo-snapshot' : 'dal-runtime' }
      },
    }
    return { sdk, chiamate, creazioni: () => chiamate.filter((c) => c.tipo === 'crea').map((c) => c.argomento as ParametriCreazione) }
  }

  it('una MicroVM che esiste già (la conversione sta girando) si RIAGGANCIA: nessuna creazione, nessun grido', async () => {
    const { sdk, chiamate } = sdkFinto({ riaggancia: 'riesce' })

    const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

    expect(aperta).toEqual({ sandbox: { id: 'riagganciata' }, nuova: false, origine: undefined })
    expect(chiamate).toEqual([{ tipo: 'riaggancia', argomento: 'kv-video-abc-5' }])
    expect(righeDiLog()).toEqual([])
  })

  it('il caso normale: non c’è ancora → si crea DALLO SNAPSHOT, con i parametri giusti, e il riaggancio non riuscito si legge a `info`', async () => {
    const { sdk, creazioni } = sdkFinto({})

    const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

    expect(aperta).toEqual({ sandbox: { id: 'dallo-snapshot' }, nuova: true, origine: 'snapshot' })
    // ESATTAMENTE questi parametri: né `runtime`, né `image` (l'SDK li vieta insieme a `source`).
    expect(creazioni()).toEqual([
      {
        name: 'kv-video-abc-5',
        region: 'dub1',
        resources: { vcpus: 4 },
        timeout: 1_800_000,
        persistent: false,
        source: { type: 'snapshot', snapshotId: 'snap_AbCdEf123456' },
      },
    ])
    // Senza questa riga «creata» e «riagganciata» sarebbero indistinguibili: non si misurerebbe mai se la ripresa funziona.
    const riaggancio = conEsito('riaggancio-non-riuscito')
    expect(riaggancio).toHaveLength(1)
    expect(riaggancio[0][0]).toBe('cron')
    expect(riaggancio[0][1]).toBe('info')
    expect(conEsito('ambiente-pronto-assente')).toEqual([])
  })

  describe('lo snapshot non si può usare: si ripiega sul percorso della PR 1, INVARIATO, e si grida', () => {
    /** I parametri del ripiego, come li dava `macchinaVercel` nella PR 1: parola per parola. */
    const PARAMETRI_DELLA_PR_1 = {
      runtime: 'node22',
      name: 'kv-video-abc-5',
      region: 'dub1',
      resources: { vcpus: 4 },
      timeout: 1_800_000,
      persistent: false,
    }

    it('lo snapshot MANCA (l’SDK risponde 410 `snapshot_not_found`): ripiego, con il codice dell’SDK nel grido', async () => {
      const { sdk, creazioni } = sdkFinto({ creaDaSnapshot: new ErroreApi(410, 'snapshot_not_found') })

      const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

      expect(aperta).toEqual({ sandbox: { id: 'dal-runtime' }, nuova: true, origine: 'runtime' })
      // Due creazioni, nell'ordine: prima lo snapshot (fallita), poi il percorso della PR 1.
      expect(creazioni()).toHaveLength(2)
      expect('source' in creazioni()[0]).toBe(true)
      // Il ripiego è IDENTICO alla PR 1, non «simile»: `toEqual` su tutte le chiavi, e nessuna chiave in più.
      expect(creazioni()[1]).toEqual(PARAMETRI_DELLA_PR_1)
      expect(Object.keys(creazioni()[1]).sort()).toEqual(Object.keys(PARAMETRI_DELLA_PR_1).sort())

      const grido = conEsito('ambiente-pronto-assente')
      expect(grido).toHaveLength(1)
      expect(grido[0][0]).toBe('config')
      expect(grido[0][1]).toBe('error')
      expect(grido[0][2]).toMatchObject({ operazione: 'video-runner', error_code: 'snapshot_not_found', http: 410 })
      // Il codice e lo stato arrivano in tabella in CHIARO: `error_code` è fra le chiavi in lista bianca, e il valore è un enumerato.
      expect(comeInTabella(grido[0]).contestoExtra?.campi).toMatchObject({ error_code: 'snapshot_not_found', http: 410 })
    })

    it.each<[string, Error, string, number | null]>([
      ['scaduto (410, un altro codice)', new ErroreApi(410, 'snapshot_expired'), 'snapshot_expired', 410],
      ['in un’altra regione', new ErroreApi(422, 'snapshot_region_mismatch'), 'snapshot_region_mismatch', 422],
      ['quota finita', new ErroreApi(429, 'rate_limited'), 'rate_limited', 429],
      ['la rete (un errore di Node)', Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }), 'ECONNRESET', null],
      ['un errore senza codice con lo stato', Object.assign(new Error('boom'), { status: 503 }), 'HTTP_503', 503],
      ['un errore senza niente', new Error('boom'), MOTIVI_AMBIENTE_ASSENTE.erroreSdk, null],
    ])('QUALUNQUE motivo — %s — ripiega, e il motivo è nel grido', async (_nome, errore, codice, http) => {
      const { sdk, creazioni } = sdkFinto({ creaDaSnapshot: errore })

      const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

      expect(aperta.origine).toBe('runtime')
      expect(creazioni()[1]).toEqual(PARAMETRI_DELLA_PR_1)
      const grido = conEsito('ambiente-pronto-assente')
      expect(grido).toHaveLength(1)
      expect(grido[0][2].error_code).toBe(codice)
      if (http === null) expect(grido[0][2]).not.toHaveProperty('http')
      else expect(grido[0][2].http).toBe(http)
    })

    it('il grido porta l’errore dell’SDK RIPULITO: né URL né token, e il testo resta', async () => {
      const grezzo = 'POST https://api.esempio.invalid/v1/sandboxes?token=eyJhbGciOi.SEGRETO: snapshot non trovato'
      const { sdk } = sdkFinto({ creaDaSnapshot: new ErroreApi(410, 'snapshot_not_found', grezzo) })

      await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

      const messaggio = comeInTabella(conEsito('ambiente-pronto-assente')[0]).messaggio
      expect(messaggio).toContain('snapshot non trovato')
      for (const segreto of ['https://', 'eyJhbGciOi', 'SEGRETO', 'token=']) expect(messaggio, segreto).not.toContain(segreto)
    })

    it('la variabile ASSENTE: nessun tentativo di snapshot, ripiego, grido `VARIABILE_ASSENTE` col NOME della variabile nel messaggio', async () => {
      const { sdk, creazioni } = sdkFinto({})

      const aperta = await apriLaMicroVm(sdk, RICHIESTA, { stato: 'assente' })

      expect(aperta.origine).toBe('runtime')
      // UNA sola creazione: quella del ripiego. Non si prova uno snapshot che non si sa quale sia.
      expect(creazioni()).toEqual([PARAMETRI_DELLA_PR_1])
      const grido = conEsito('ambiente-pronto-assente')
      expect(grido).toHaveLength(1)
      expect(grido[0][1]).toBe('error')
      expect(grido[0][2].error_code).toBe('VARIABILE_ASSENTE')
      // Il NOME viaggia nel messaggio, non in un campo: `redact` è a lista bianca e `variabile` uscirebbe `[redatto:str/…]`.
      expect(comeInTabella(grido[0]).messaggio).toContain('VIDEO_SANDBOX_SNAPSHOT_ID')
    })

    it('la variabile NON VALIDA: stessa cosa, con il suo motivo', async () => {
      const { sdk, creazioni } = sdkFinto({})

      await apriLaMicroVm(sdk, RICHIESTA, { stato: 'non-valido' })

      expect(creazioni()).toEqual([PARAMETRI_DELLA_PR_1])
      expect(conEsito('ambiente-pronto-assente')[0][2].error_code).toBe('VARIABILE_NON_VALIDA')
    })

    it('se fallisce anche il RIPIEGO l’eccezione ESCE: è `SANDBOX_UNAVAILABLE` per chi chiama, con le sue attese', async () => {
      const dalRuntime = new Error('runtime non disponibile')
      const { sdk } = sdkFinto({ creaDaSnapshot: new ErroreApi(410, 'snapshot_not_found'), creaDaRuntime: dalRuntime })

      await expect(apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)).rejects.toBe(dalRuntime)
      // Il grido dello snapshot c'è stato lo stesso: dice perché si è provato il ripiego.
      expect(conEsito('ambiente-pronto-assente')).toHaveLength(1)
    })
  })

  it('il riaggancio non riuscito entra nel log RIPULITO, come ogni altra eccezione dell’SDK: né URL né token (secondario #104)', async () => {
    const grezzo = 'GET https://api.esempio.invalid/v1/sandboxes/kv-video-abc-5?token=eyJhbGciOi.SEGRETO: Sandbox non trovato'
    const { sdk } = sdkFinto({ riaggancia: new ErroreApi(404, 'not_found', grezzo) })

    await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

    const riaggancio = conEsito('riaggancio-non-riuscito')
    expect(riaggancio).toHaveLength(1)
    const messaggio = comeInTabella(riaggancio[0]).messaggio
    // Il motivo resta: è la riga che dice «non c'è ancora» (il caso normale) o «la piattaforma non risponde» (un guasto).
    expect(messaggio).toContain('Sandbox non trovato')
    expect(messaggio.startsWith('APIError HTTP 404 not_found: ')).toBe(true)
    for (const segreto of ['https://', 'api.esempio.invalid', 'eyJhbGciOi', 'SEGRETO', 'token=']) {
      expect(messaggio, segreto).not.toContain(segreto)
    }
    // E ciò che il codice PASSA al logger (non solo ciò che ne esce): nessuna eccezione grezza fra gli argomenti.
    expect(String(riaggancio[0][3])).not.toContain('SEGRETO')
  })

  it('lo snapshot e il riaggancio che falliscono per un errore di piattaforma (non «non trovato») non cambiano la strada: si crea', async () => {
    const { sdk, creazioni } = sdkFinto({ riaggancia: new ErroreApi(503, 'unavailable', 'piattaforma giù') })

    const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

    expect(aperta.origine).toBe('snapshot')
    expect(creazioni()).toHaveLength(1)
    // …ma il motivo del riaggancio fallito si legge, ripulito.
    expect(comeInTabella(conEsito('riaggancio-non-riuscito')[0]).messaggio).toContain('piattaforma giù')
  })

  it('il tipo dei parametri vieta le forme che l’SDK vieta: `source` e `runtime` insieme non compilano (lo controlla tsc, qui lo si dice)', () => {
    // Un'asserzione di tipo, non di valore: se `ParametriCreazione` smettesse di essere un'unione esclusiva (`runtime?: never`
    // accanto a `source`, come nell'SDK), la riga con la direttiva diventerebbe un `@ts-expect-error` inutilizzato, cioè un
    // errore di compilazione.
    // (Su UNA riga: il compilatore segnala l'errore sul primo membro che non torna, e la direttiva copre solo la riga che segue.)
    // @ts-expect-error `source` e `runtime` non vanno insieme
    const impossibile: ParametriCreazione = { name: 'x', region: 'dub1', resources: { vcpus: 1 }, timeout: 1, persistent: false, source: { type: 'snapshot', snapshotId: 'snap_x' }, runtime: RUNTIME_DI_RIPIEGO }
    expect(impossibile).toBeDefined()
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. macchinaVercel(): che cosa chiede davvero all'SDK
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · macchinaVercel cabla la scelta sull’SDK: Sandbox.get, Sandbox.create, e la sessione che ne esce', () => {
  const RICHIESTA = { nome: 'kv-video-abc-5', regione: 'dub1', vcpus: 4, tettoMs: 1_800_000 }

  /** Un Sandbox finto con le sole chiamate che l'adattatore usa. */
  function sandboxFinto() {
    const runCommand = vi.fn<(parametri: unknown) => Promise<{ exitCode: number; stdout: () => Promise<string>; stderr: () => Promise<string> }>>()
    runCommand.mockResolvedValue({ exitCode: 0, stdout: async () => 'uscita', stderr: async () => 'errori' })
    return { runCommand, stop: vi.fn(async () => undefined) }
  }

  it('con la variabile impostata e nessuna MicroVM da riagganciare: `Sandbox.get({ name, resume: true })`, poi `create` dallo snapshot', async () => {
    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, 'snap_AbCdEf123456')
    h.get.mockRejectedValue(new Error('Sandbox non trovato'))
    h.create.mockResolvedValue(sandboxFinto())

    const sessione = await macchinaVercel().apri(RICHIESTA)

    expect(h.get).toHaveBeenCalledTimes(1)
    expect(h.get).toHaveBeenCalledWith({ name: 'kv-video-abc-5', resume: true })
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create).toHaveBeenCalledWith({
      name: 'kv-video-abc-5',
      region: 'dub1',
      resources: { vcpus: 4 },
      timeout: 1_800_000,
      persistent: false,
      source: { type: 'snapshot', snapshotId: 'snap_AbCdEf123456' },
    })
    expect(sessione.nuova).toBe(true)
    expect(sessione.origine).toBe('snapshot')
  })

  it('la variabile si legge A OGNI APERTURA, non al caricamento del modulo: lo snapshot si ricostruisce e il valore cambia', async () => {
    h.get.mockRejectedValue(new Error('non trovato'))
    h.create.mockResolvedValue(sandboxFinto())
    const macchina = macchinaVercel()

    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, 'snap_primo123456')
    await macchina.apri(RICHIESTA)
    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, 'snap_secondo123456')
    await macchina.apri(RICHIESTA)

    const usati = h.create.mock.calls.map((c) => (c[0] as { source: { snapshotId: string } }).source.snapshotId)
    expect(usati).toEqual(['snap_primo123456', 'snap_secondo123456'])
  })

  it('SENZA la variabile il percorso è quello della PR 1, parola per parola: `runtime: node22`, e basta', async () => {
    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, '')
    h.get.mockRejectedValue(new Error('non trovato'))
    h.create.mockResolvedValue(sandboxFinto())

    const sessione = await macchinaVercel().apri(RICHIESTA)

    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create.mock.calls[0][0]).toEqual({
      runtime: 'node22',
      name: 'kv-video-abc-5',
      region: 'dub1',
      resources: { vcpus: 4 },
      timeout: 1_800_000,
      persistent: false,
    })
    expect(sessione.origine).toBe('runtime')
    expect(conEsito('ambiente-pronto-assente')[0][2].error_code).toBe('VARIABILE_ASSENTE')
  })

  it('lo snapshot non si crea (l’SDK lancia): `Sandbox.create` è chiamata DUE volte e la sessione è quella del runtime', async () => {
    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, 'snap_AbCdEf123456')
    h.get.mockRejectedValue(new Error('non trovato'))
    h.create.mockRejectedValueOnce(new Error('snapshot non trovato')).mockResolvedValueOnce(sandboxFinto())

    const sessione = await macchinaVercel().apri(RICHIESTA)

    expect(h.create).toHaveBeenCalledTimes(2)
    expect('source' in h.create.mock.calls[0][0]).toBe(true)
    expect(h.create.mock.calls[1][0]).toMatchObject({ runtime: 'node22' })
    expect(sessione.origine).toBe('runtime')
  })

  it('una MicroVM riagganciata: `nuova` falso, NESSUNA origine, e nessuna creazione', async () => {
    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, 'snap_AbCdEf123456')
    h.get.mockResolvedValue(sandboxFinto())

    const sessione = await macchinaVercel().apri(RICHIESTA)

    expect(sessione.nuova).toBe(false)
    expect('origine' in sessione).toBe(false)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('la sessione traduce i tre verbi: `esegui` aspetta e restituisce esito e testi, `avvia` stacca, `ferma` spegne', async () => {
    const sandbox = sandboxFinto()
    h.get.mockResolvedValue(sandbox)
    const sessione = await macchinaVercel().apri(RICHIESTA)

    const esito = await sessione.esegui({ cmd: 'sh', args: ['-c', 'true'], env: { A: 'b' }, tettoMs: 30_000 })
    expect(esito).toEqual({ exitCode: 0, stdout: 'uscita', stderr: 'errori' })
    expect(sandbox.runCommand).toHaveBeenLastCalledWith({ cmd: 'sh', args: ['-c', 'true'], env: { A: 'b' }, timeoutMs: 30_000 })

    await sessione.avvia({ cmd: 'sh', args: ['-c', 'true'], tettoMs: 1_800_000 })
    expect(sandbox.runCommand).toHaveBeenLastCalledWith(expect.objectContaining({ detached: true, timeoutMs: 1_800_000 }))

    await sessione.ferma()
    expect(sandbox.stop).toHaveBeenCalledTimes(1)
  })

  it('`adattatori.ts` non decide più niente sul runtime né sullo snapshot: scelta e nomi stanno in `ambiente.ts`', () => {
    const adattatori = senzaCommenti(leggi('src', 'lib', 'media', 'video', 'runner', 'adattatori.ts'))
    expect(adattatori).not.toMatch(/runtime:/)
    expect(adattatori).not.toMatch(/snapshotId/)
    expect(adattatori).toContain('apriLaMicroVm')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 5. GLI SCRIPT: la cartella dei binari è un parametro, il predefinito è la PR 1
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · gli script di shell con la cartella come parametro', () => {
  const SNAPSHOT = CARTELLA_BINARI_NELLO_SNAPSHOT

  it('la cartella dello snapshot è `/opt/kv-ffmpeg`, e quella del ripiego resta `/tmp/kv-ffmpeg`', () => {
    expect(SNAPSHOT).toBe('/opt/kv-ffmpeg')
    expect(CARTELLA_BUILD).toBe('/tmp/kv-ffmpeg')
  })

  it('SENZA parametri ogni script è quello della PR 1: passare la cartella predefinita non lo cambia di un carattere', () => {
    expect(scriptPreparazioneBuild()).toBe(scriptPreparazioneBuild(CARTELLA_BUILD))
    expect(comandoInventarioBuild()).toBe(comandoInventarioBuild(CARTELLA_BUILD))
    expect(scriptApparecchio()).toBe(scriptApparecchio({}))
    expect(scriptApparecchio()).toBe(scriptApparecchio({ cartella: CARTELLA_BUILD }))
    expect(scriptApparecchio()).toBe(scriptApparecchio({ cartella: CARTELLA_BUILD, binariGiaPresenti: false }))
  })

  describe('`scriptPreparazioneBuild(cartella)`: lo STESSO script, in un altro posto', () => {
    it('è lo script del runtime con la cartella sostituita, riga per riga: nessuna riga in più, nessuna in meno', () => {
      // È la proprietà che lo snapshot promette: chi lo costruisce esegue le stesse due verifiche, nello stesso ordine, di chi
      // ripiega a runtime. Se qualcuno ritoccasse lo script per l'uno e non per l'altro, questa uguaglianza cadrebbe.
      expect(scriptPreparazioneBuild(SNAPSHOT)).toBe(scriptPreparazioneBuild().replaceAll(CARTELLA_BUILD, SNAPSHOT))
    })

    it('ogni percorso sta sotto la cartella passata, e `/tmp/kv-ffmpeg` non compare', () => {
      const script = scriptPreparazioneBuild(SNAPSHOT)
      expect(script).not.toContain(CARTELLA_BUILD)
      for (const file of ['ffmpeg.gz', 'ffprobe.gz', 'ffmpeg', 'ffprobe']) expect(script).toContain(`${SNAPSHOT}/${file}`)
      expect(script).toContain(`mkdir -p ${SNAPSHOT}`)
      expect(script).toContain(`rm -f ${SNAPSHOT}/*.gz`)
    })

    it('le impronte accanto ai file giusti, anche nella nuova cartella', () => {
      const script = scriptPreparazioneBuild(SNAPSHOT)
      expect(script).toContain(`'${FFMPEG_GZ_SHA256}' ${SNAPSHOT}/ffmpeg.gz '${FFPROBE_GZ_SHA256}' ${SNAPSHOT}/ffprobe.gz`)
      expect(script).toContain(`'${FFMPEG_SHA256}' ${SNAPSHOT}/ffmpeg '${FFPROBE_SHA256}' ${SNAPSHOT}/ffprobe`)
    })

    it('niente `sudo` né gestori di pacchetti: la cartella la prepara chi costruisce lo snapshot, una volta', () => {
      for (const vietato of ['sudo', 'apt', 'dnf', 'chown']) expect(scriptPreparazioneBuild(SNAPSHOT)).not.toContain(vietato)
    })
  })

  describe('`scriptVerificaBinari(cartella)`: la verifica che il runner rifà a OGNI avvio', () => {
    const script = scriptVerificaBinari(SNAPSHOT)
    const righe = script.split('\n')

    it('verifica le due impronte dei BINARI — ciascuna accanto al suo file — con `sha256sum -c -`, e nient’altro', () => {
      expect(script).toContain(`'${FFMPEG_SHA256}' ${SNAPSHOT}/ffmpeg '${FFPROBE_SHA256}' ${SNAPSHOT}/ffprobe`)
      expect(script.match(/sha256sum -c -/g)).toHaveLength(1)
      // Le impronte dei `.gz` NON ci sono: lo snapshot non ha `.gz` da verificare.
      expect(script).not.toContain(FFMPEG_GZ_SHA256)
      expect(script).not.toContain(FFPROBE_GZ_SHA256)
    })

    it('prima controlla che i file ci siano ed eseguibili (`test -x`), POI le impronte', () => {
      const prova = righe.findIndex((r) => r.includes('test -x'))
      const impronte = righe.findIndex((r) => r.includes('sha256sum -c -'))
      expect(prova).toBeGreaterThan(0)
      expect(impronte).toBeGreaterThan(prova)
    })

    it('si ferma al primo comando che fallisce, e ogni modo di fallire esce 26', () => {
      expect(righe[0]).toBe('set -eu')
      expect(USCITE_APPARECCHIO.binari).toBe(26)
      for (const riga of righe.filter((r) => r.includes('test -x') || r.includes('sha256sum'))) {
        expect(riga).toContain(`|| exit ${USCITE_APPARECCHIO.binari}`)
      }
      // La riga `FAILED` di `sha256sum` va nella diagnosi: sullo stdout resterebbe un «OK» che nessuno legge.
      expect(righe.find((r) => r.includes('sha256sum'))).toContain('>&2')
    })

    it('NON tocca la rete e non scarica niente: niente `curl`, niente `gzip`, niente indirizzi', () => {
      for (const vietato of ['curl', 'gzip', 'wget', 'http', 'chmod']) expect(script).not.toContain(vietato)
    })

    it('SENZA parametri verifica la cartella del ripiego', () => {
      expect(scriptVerificaBinari()).toBe(scriptVerificaBinari(CARTELLA_BUILD))
    })
  })

  describe('`scriptApparecchio({ cartella, binariGiaPresenti })`: la verifica al posto della provvista', () => {
    const snapshot = scriptApparecchio({ cartella: SNAPSHOT, binariGiaPresenti: true })

    it('comincia con la VERIFICA dei binari e non con la provvista: niente `curl` dei `.gz`, niente `gzip`, nessuna variabile `KV_URL_FFMPEG`', () => {
      expect(snapshot.startsWith(scriptVerificaBinari(SNAPSHOT))).toBe(true)
      expect(snapshot).not.toContain('gzip -dc')
      expect(snapshot).not.toContain('.gz')
      expect(snapshot).not.toContain(ENV_URL_FFMPEG)
      expect(snapshot).not.toContain(ENV_URL_FFPROBE)
    })

    it('la parte che segue è IDENTICA a quella dello script della PR 1: inventario, HEAD e probe non cambiano col posto da cui vengono i binari', () => {
      const dellaPr1 = scriptApparecchio()
      const coda = (testo: string, cartella: string) => testo.slice(testo.indexOf('mkdir -p /tmp/kv-video')).replaceAll(cartella, '<BINARI>')
      expect(coda(snapshot, SNAPSHOT)).toBe(coda(dellaPr1, CARTELLA_BUILD))
    })

    it('l’inventario e il probe chiamano i binari DELLA CARTELLA, e `/tmp/kv-ffmpeg` non compare', () => {
      expect(snapshot).toContain(`${SNAPSHOT}/ffmpeg -hide_banner -filters`)
      expect(snapshot).toContain(`${SNAPSHOT}/ffprobe -v error -print_format json`)
      expect(snapshot).not.toContain(CARTELLA_BUILD)
    })

    it('la cartella da sola, senza `binariGiaPresenti`, è la provvista in un altro posto (il ripiego di una MicroVM che ha un’altra cartella)', () => {
      const conProvvista = scriptApparecchio({ cartella: SNAPSHOT })
      expect(conProvvista.startsWith(scriptPreparazioneBuild(SNAPSHOT))).toBe(true)
      expect(conProvvista).toContain('gzip -dc')
    })
  })

  describe('`scriptConversione`: la cartella dei binari e la verifica dello `sha256`', () => {
    const BASE = { conWatermark: true, videoIndex: 0, audioIndex: 1, sourceFps: 30 } as const

    it('senza parametri nuovi lo script chiama i binari di `/tmp/kv-ffmpeg` e NON ha il passo dello `sha256`', () => {
      const script = scriptConversione(BASE)
      expect(script).toContain(`xargs -0 -a /tmp/kv-video/argomenti ${CARTELLA_BUILD}/ffmpeg`)
      expect(script).not.toContain(ENV_SHA256_ATTESO)
      expect(script).not.toContain('sha256sum')
    })

    it('`cartellaBuild` cambia OGNI riferimento ai binari — codifica, probe dell’uscita, decodifica, sonda temporale — e nessuno resta indietro', () => {
      const script = scriptConversione({ ...BASE, cartellaBuild: SNAPSHOT })
      expect(script).not.toContain(CARTELLA_BUILD)
      expect(script).toContain(`xargs -0 -a /tmp/kv-video/argomenti ${SNAPSHOT}/ffmpeg`)
      expect(script).toContain(`${SNAPSHOT}/ffprobe -v error -print_format json -show_format -show_streams /tmp/kv-video/uscita.mp4`)
      expect(script).toContain(`${SNAPSHOT}/ffmpeg -hide_banner -nostdin -v error -stats -xerror -err_detect explode`)
      expect(script).toContain(`node - ${SNAPSHOT}/ffprobe /tmp/kv-video/ingresso /tmp/kv-video/uscita.mp4`)
    })

    it('lo script è IDENTICO a quello della PR 1 con la sola cartella cambiata: nessun’altra differenza', () => {
      expect(scriptConversione({ ...BASE, cartellaBuild: SNAPSHOT })).toBe(
        scriptConversione(BASE).replaceAll(CARTELLA_BUILD, SNAPSHOT),
      )
    })

    it('`verificaSha256` aggiunge UN passo, dopo lo scarico e prima del resto, che esce 35 se non torna', () => {
      const senza = scriptConversione(BASE)
      const con = scriptConversione({ ...BASE, verificaSha256: true })
      const righeSenza = senza.split('\n')
      const righeCon = con.split('\n')

      // Una riga in più, e basta.
      expect(righeCon).toHaveLength(righeSenza.length + 1)
      const passo = righeCon.find((r) => r.includes(ENV_SHA256_ATTESO)) as string
      expect(passo).toBeDefined()
      expect(passo).toContain('sha256sum -c -')
      expect(passo).toContain('/tmp/kv-video/ingresso')
      expect(passo).toContain(`|| exit ${USCITE_CONVERSIONE.impronta}`)
      expect(USCITE_CONVERSIONE.impronta).toBe(35)
      // Togliendola si torna allo script di prima.
      expect(righeCon.filter((r) => r !== passo)).toEqual(righeSenza)
      // L'impronta si legge dall'AMBIENTE: nessun valore letterale nello script.
      expect(passo).toContain(`"$${ENV_SHA256_ATTESO}"`)
      expect(con).not.toMatch(/\b[0-9a-f]{64}\b/)
    })

    it('il passo sta dopo lo scarico dell’originale e PRIMA del watermark e della codifica', () => {
      const righe = scriptConversione({ ...BASE, verificaSha256: true }).split('\n')
      const scarico = righe.findIndex((r) => r.startsWith('curl') && r.includes('/tmp/kv-video/ingresso'))
      const passo = righe.findIndex((r) => r.includes(ENV_SHA256_ATTESO))
      const watermark = righe.findIndex((r) => r.startsWith('curl') && r.includes('watermark.png'))
      const codifica = righe.findIndex((r) => r.startsWith('xargs'))
      expect(scarico).toBeGreaterThan(0)
      expect(passo).toBeGreaterThan(scarico)
      expect(watermark).toBeGreaterThan(passo)
      expect(codifica).toBeGreaterThan(watermark)
    })

    it('la verifica non dipende dal watermark: anche una News (nessun watermark) la porta, dopo lo scarico', () => {
      const righe = scriptConversione({ ...BASE, conWatermark: false, verificaSha256: true }).split('\n')
      expect(righe.findIndex((r) => r.includes(ENV_SHA256_ATTESO))).toBeGreaterThan(
        righe.findIndex((r) => r.startsWith('curl') && r.includes('/tmp/kv-video/ingresso')),
      )
    })
  })

  describe('`comandoInterruzione`: ferma `ffmpeg` qualunque sia la cartella', () => {
    const [cmd, ...args] = [comandoInterruzione().cmd, ...comandoInterruzione().args]
    const testo = args.join(' ')

    it('è `sh -c` con `pkill -f` e il modello `[k]v-ffmpeg`', () => {
      expect(cmd).toBe('sh')
      expect(testo).toContain(`pkill -f '${MODELLO_PROCESSI_DEI_BINARI}'`)
      expect(MODELLO_PROCESSI_DEI_BINARI).toBe('[k]v-ffmpeg')
    })

    it('il modello riconosce le righe di comando di ENTRAMBE le cartelle, e NON il testo del comando che lo contiene', () => {
      const modello = new RegExp(MODELLO_PROCESSI_DEI_BINARI)
      for (const cartella of [CARTELLA_BUILD, CARTELLA_BINARI_NELLO_SNAPSHOT]) {
        expect(modello.test(`${cartella}/ffmpeg -i /tmp/kv-video/ingresso -y /tmp/kv-video/uscita.mp4`), cartella).toBe(true)
        expect(modello.test(`${cartella}/ffprobe -v error ${cartella}/x`), cartella).toBe(true)
      }
      // Il punto della parentesi: la shell che lancia `pkill` ha il modello nella SUA riga di comando, e `pkill -f`
      // escluderebbe sé stesso ma non la shell — che morirebbe prima di arrivare al `|| true`.
      expect(modello.test(`sh -c pkill -f '${MODELLO_PROCESSI_DEI_BINARI}' || true`)).toBe(false)
      // E non ferma processi che non sono dei binari.
      expect(modello.test('node /tmp/kv-video/convert.js')).toBe(false)
    })

    it('il nome `kv-ffmpeg` è in ENTRAMBE le cartelle: cambiare una delle due senza il modello lo renderebbe cieco', () => {
      expect(CARTELLA_BUILD.endsWith('kv-ffmpeg')).toBe(true)
      expect(CARTELLA_BINARI_NELLO_SNAPSHOT.endsWith('kv-ffmpeg')).toBe(true)
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 6. LE USCITE E LE CLASSI: lo `sha256` che non torna è del FILE, e non si ritenta mai
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · le uscite degli script e il loro destino', () => {
  it('le uscite sono tutte diverse e non collidono con le altre dello stesso giro: 21–23, 24–26, 31–35', () => {
    const tutte = [
      ...Object.values(USCITE_PREPARAZIONE),
      ...Object.values(USCITE_APPARECCHIO),
      ...Object.values(USCITE_CONVERSIONE),
    ]
    expect(new Set(tutte).size).toBe(tutte.length)
    expect([...tutte].sort((a, b) => a - b)).toEqual([21, 22, 23, 24, 25, 26, 31, 32, 33, 34, 35])
    // Tutte sotto 125, dove cominciano i codici riservati alla shell.
    for (const uscita of tutte) expect(uscita).toBeLessThan(125)
  })

  it('35 → `ORIGINALE_DIVERSO`, un codice del contratto e del runner', () => {
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.impronta)).toBe('ORIGINALE_DIVERSO')
    expect((CODICI_RUNNER_VIDEO as readonly string[]).includes('ORIGINALE_DIVERSO')).toBe(true)
  })

  it.each([
    ['diario vuoto', ''],
    ['un 404 recuperato nel diario', 'curl: (22) The requested URL returned error: 404'],
    ['un timeout recuperato nel diario', 'curl: (28) Operation timed out after 60001 milliseconds with 0 bytes received'],
    ['la riga FAILED di sha256sum', '/tmp/kv-video/ingresso: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match'],
    ['un diario che non è un testo', undefined as unknown as string],
  ])('35 è `file` QUALUNQUE cosa dica il diario (%s): né la rete né la MicroVM c’entrano', (_nome, diagnosi) => {
    expect(classeDaUscitaConversione(USCITE_CONVERSIONE.impronta, diagnosi)).toBe('file')
  })

  it('e `file` non si ritenta MAI, a nessun tentativo: la differenza con i guasti nostri, che ne hanno quattro', () => {
    for (const attempt of [1, 2, 3, 4, 10]) {
      expect(decidiRitentativo(attempt, 'file')).toEqual({ ritenta: false, motivo: 'classe-non-ritentabile' })
    }
    // Il confronto che dà senso al caso: lo stesso `attempt`, un guasto nostro, SI ritenta.
    expect(decidiRitentativo(1, 'infra-transitoria')).toMatchObject({ ritenta: true })
  })

  it('26 (binari dello snapshot non verificati) ha un codice e una classe, anche se il runner la intercetta prima', () => {
    expect(codiceDaUscitaApparecchio(USCITE_APPARECCHIO.binari)).toBe('BUILD_HASH_MISMATCH')
    expect(classeDaUscitaApparecchio(USCITE_APPARECCHIO.binari, '')).toBe('infra-permanente')
    // Non ricade sul «non lo so» di un’uscita sconosciuta (che per l'apparecchio è transitoria e col codice del download).
    expect(codiceDaUscitaApparecchio(USCITE_APPARECCHIO.binari)).not.toBe(codiceDaUscitaApparecchio(137))
  })

  it('le uscite della provvista restano quelle: nessuna è stata toccata', () => {
    expect(codiceDaUscitaPreparazione(USCITE_PREPARAZIONE.impronta)).toBe('BUILD_HASH_MISMATCH')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 7. LO `sha256` DICHIARATO: com'è nella riga del job, e come si legge
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · lo `sha256` dichiarato nella riga del job', () => {
  const HEX = '0123456789abcdef'.repeat(4)

  it.each<[string, unknown]>([
    ['`null` (web, TUS, News)', null],
    ['assente', undefined],
  ])('%s → `assente`: il passo si salta', (_nome, valore) => {
    expect(leggiSha256Dichiarato(valore)).toEqual({ stato: 'assente' })
  })

  it('`\\x` più 64 cifre — la forma di un `bytea` dentro `to_jsonb` — → `ok`, in minuscolo', () => {
    expect(leggiSha256Dichiarato(`\\x${HEX}`)).toEqual({ stato: 'ok', hex: HEX })
    expect(leggiSha256Dichiarato(`\\x${HEX.toUpperCase()}`)).toEqual({ stato: 'ok', hex: HEX })
    expect(leggiSha256Dichiarato(HEX)).toEqual({ stato: 'ok', hex: HEX })
  })

  it.each<[string, unknown]>([
    ['una stringa qualunque', 'non-un-hash'],
    ['una stringa vuota', ''],
    ['63 cifre', HEX.slice(1)],
    ['65 cifre', `${HEX}0`],
    ['il prefisso ripetuto', `\\x\\x${HEX}`],
    ['cifre non esadecimali', 'g'.repeat(64)],
    ['uno spazio ai lati', ` ${HEX} `],
    ['a capo in fondo', `${HEX}\n`],
    ['un’iniezione di shell', `${HEX.slice(0, 40)};rm -rf /;${HEX.slice(0, 20)}`],
    ['un numero', 5],
    ['un booleano', false],
    ['un oggetto', { hex: HEX }],
    ['un array', [HEX]],
  ])('%s → `illeggibile`, MAI «assente»: un controllo richiesto e non eseguibile non passa in silenzio', (_nome, valore) => {
    expect(leggiSha256Dichiarato(valore)).toEqual({ stato: 'illeggibile' })
  })

  it('una `ok` porta SOLO cifre esadecimali: è l’unica cosa che entra nell’ambiente di un comando', () => {
    const letto = leggiSha256Dichiarato(`\\x${HEX}`)
    expect(letto.stato).toBe('ok')
    if (letto.stato === 'ok') expect(letto.hex).toMatch(/^[0-9a-f]{64}$/)
  })

  describe('la forma REALE: un `bytea` di Postgres dentro `to_jsonb(riga)`, come lo restituiscono le RPC di presa', () => {
    it('è la stringa `\\x<64 cifre>` — e `leggiSha256Dichiarato` ne ricava ESATTAMENTE lo SHA-256 che `sha256sum` calcolerebbe', async () => {
      // PGlite è Postgres vero compilato in WASM: la forma di un `bytea` in JSON è la sua, non una nostra ipotesi.
      const db = new PGlite()
      try {
        await db.exec(`
          CREATE TABLE riga_di_prova (id int PRIMARY KEY, sha256_dichiarato bytea);
          INSERT INTO riga_di_prova VALUES
            (1, sha256(convert_to('contenuto del filmato', 'UTF8'))),
            (2, NULL);
        `)
        const { rows } = await db.query<{ riga: { sha256_dichiarato: unknown } }>(
          'SELECT to_jsonb(t) AS riga FROM riga_di_prova AS t ORDER BY id',
        )

        const atteso = createHash('sha256').update('contenuto del filmato').digest('hex')
        expect(rows[0].riga.sha256_dichiarato).toBe(`\\x${atteso}`)
        expect(leggiSha256Dichiarato(rows[0].riga.sha256_dichiarato)).toEqual({ stato: 'ok', hex: atteso })
        // Il job senza impronta dichiarata: `null` nel JSON, e il passo si salta.
        expect(rows[1].riga.sha256_dichiarato).toBeNull()
        expect(leggiSha256Dichiarato(rows[1].riga.sha256_dichiarato)).toEqual({ stato: 'assente' })
      } finally {
        await db.close()
      }
    })
  })

  describe('la presa RESTITUISCE la riga intera, `sha256_dichiarato` compreso (letto dalle migrazioni)', () => {
    const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
    const senzaCommentiSql = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, '')
    const corpoDi = (suffisso: string, funzione: string): string => {
      const nome = readdirSync(MIGRAZIONI).find((n) => n.endsWith(suffisso))
      expect(nome, `la migrazione «…${suffisso}» non si trova`).toBeDefined()
      const sql = senzaCommentiSql(readFileSync(join(MIGRAZIONI, nome as string), 'utf8'))
      const inizio = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${funzione}(`)
      expect(inizio, `${funzione} non si trova in ${nome}`).toBeGreaterThanOrEqual(0)
      return sql.slice(inizio, sql.indexOf('$$;', inizio))
    }

    it('`video_job_claim` risponde con `to_jsonb(v_job)` — la riga intera, senza togliere colonne', () => {
      const claim = corpoDi('_video_job_ritentativi.sql', 'video_job_claim')
      expect(claim).toContain("pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job))")
      // Nessuna sottrazione di colonne dal JSON del job (come fa `video_galleria_intent_apri`, che le toglie apposta).
      expect(claim).not.toMatch(/to_jsonb\(v_job\)\s*-/)
      expect(claim).not.toContain('sha256_dichiarato')
    })

    it('`video_job_prendi` e `video_job_next`/`video_job_prossimo` passano quella risposta tale e quale', () => {
      expect(corpoDi('_video_pubblicazione_automatica.sql', 'video_job_prendi')).toContain('RETURN public.video_job_claim(')
      expect(corpoDi('_video_job_ritentativi.sql', 'video_job_next')).toContain('RETURN v_esito;')
      expect(corpoDi('_video_job_ritentativi.sql', 'video_job_next')).toContain('v_esito := public.video_job_claim(')
      expect(corpoDi('_video_pubblicazione_automatica.sql', 'video_job_prossimo')).toContain('RETURN public.video_job_next(')
    })

    it('il runner non scarta il campo: `esitoRpc` consegna `job` così com’è, e `JobVideo` lo dichiara', () => {
      const porte = senzaCommenti(leggi('src', 'lib', 'media', 'video', 'runner', 'porte.ts'))
      expect(porte).toMatch(/sha256_dichiarato\?:\s*string\s*\|\s*null/)
      const adattatori = senzaCommenti(leggi('src', 'lib', 'media', 'video', 'runner', 'adattatori.ts'))
      expect(adattatori).toContain('job: letto.job as JobVideo')
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 8. scripts/video-sandbox-ambiente.mjs — non si esegue il Sandbox, si prova che non stampi segreti
 * ════════════════════════════════════════════════════════════════════════════ */

describe('scripts/video-sandbox-ambiente.mjs: usa la preparazione CONDIVISA e non stampa segreti', () => {
  const SCRIPT = 'scripts/video-sandbox-ambiente.mjs'
  const CHIAVE_FINTA = 'FINTA-CHIAVE-DI-PROVA-0123456789'
  const TOKEN_FINTO = 'FINTO-TOKEN-VERCEL-9876543210'
  const JSON_CHIAVI = JSON.stringify([{ name: 'service_role', api_key: CHIAVE_FINTA, type: 'legacy' }])
  const sha256 = (testo: string) => createHash('sha256').update(testo).digest('hex')

  function esegui(argomenti: string[], input: string | undefined = JSON_CHIAVI) {
    const esito = spawnSync(process.execPath, [join(RADICE, SCRIPT), ...argomenti], {
      cwd: RADICE,
      input,
      encoding: 'utf8',
      timeout: 60_000,
      // L'ambiente porta un token Vercel finto: se lo script lo leggesse e lo stampasse, il test lo vedrebbe.
      env: { ...process.env, VERCEL_TOKEN: TOKEN_FINTO },
    })
    return { stato: esito.status, stdout: esito.stdout, stderr: esito.stderr, tutto: `${esito.stdout}\n${esito.stderr}` }
  }

  describe('eseguito `--a-secco` (nessuna rete, nessun Sandbox) con una chiave FINTA su stdin', () => {
    const esito = esegui(['--a-secco'])

    it('esce 0 e descrive il piano', () => {
      expect(esito.stato, esito.stderr).toBe(0)
      expect(esito.stdout).toContain('immagine: vercel/sandbox/node:24')
      expect(esito.stdout).toContain('regione: dub1')
      expect(esito.stdout).toContain(`cartella-binari: ${CARTELLA_BINARI_NELLO_SNAPSHOT}`)
      expect(esito.stdout).toContain(`bucket: ${BUCKET_BUILD_VIDEO}`)
    })

    it('gli script che eseguirebbe sono QUELLI del runner: le impronte dei testi coincidono con quelle calcolate qui dalle stesse funzioni', () => {
      // Lo script importa `scriptPreparazioneBuild` e `scriptVerificaBinari` da `src/`; se ne avesse una COPIA
      // ritoccata, il testo — e quindi l'impronta — sarebbe un altro.
      expect(esito.stdout).toContain(`script-provvista-sha256: ${sha256(scriptPreparazioneBuild(CARTELLA_BINARI_NELLO_SNAPSHOT))}`)
      expect(esito.stdout).toContain(`script-verifica-sha256: ${sha256(scriptVerificaBinari(CARTELLA_BINARI_NELLO_SNAPSHOT))}`)
      expect(esito.stdout).toContain(`script-inventario-sha256: ${sha256(comandoInventarioBuild(CARTELLA_BINARI_NELLO_SNAPSHOT))}`)
    })

    it('NON stampa la chiave, il token, né un indirizzo — né su stdout né su stderr', () => {
      expect(esito.tutto).not.toContain(CHIAVE_FINTA)
      expect(esito.tutto).not.toContain(TOKEN_FINTO)
      expect(esito.tutto).not.toMatch(/https?:\/\//)
      // …ma dice COME ha trovato la chiave, che è tutto ciò che si può dire senza dirla.
      expect(esito.stdout).toContain('chiave-di-servizio: trovata per nome, mai stampata')
    })
  })

  it('con una chiave scelta per TIPO (`secret`) lo dice, e la chiave resta fuori', () => {
    const chiave = 'sb_secret_FINTA0123456789abcdef'
    const esito = esegui(['--a-secco'], JSON.stringify([{ name: 'altra', api_key: chiave, type: 'secret' }]))
    expect(esito.stato, esito.stderr).toBe(0)
    expect(esito.stdout).toContain('trovata per tipo')
    expect(esito.tutto).not.toContain(chiave)
  })

  it.each<[string, string]>([
    ['stdin che non è JSON', `non è json ${CHIAVE_FINTA}`],
    ['un JSON che non è un elenco', JSON.stringify({ api_key: CHIAVE_FINTA })],
    ['nessuna chiave di servizio fra quelle elencate', JSON.stringify([{ name: 'anon', api_key: CHIAVE_FINTA, type: 'legacy' }])],
    ['una chiave mascherata (senza --reveal)', JSON.stringify([{ name: 'service_role', api_key: 'sb_secret_abc••••••••', type: 'secret' }])],
  ])('%s: esce 1 col suo messaggio e NON ripete ciò che ha letto', (_nome, input) => {
    const esito = esegui(['--a-secco'], input)
    expect(esito.stato).toBe(1)
    expect(esito.stderr).toContain('KO')
    expect(esito.tutto).not.toContain(CHIAVE_FINTA)
  })

  it.each([
    ['un argomento che non esiste', ['--sconosciuto']],
    ['una regione che non è una regione', ['--a-secco', '--regione', 'Dublino']],
    ['core fuori da 1–8', ['--a-secco', '--vcpus', '99']],
  ])('%s: esce 2, con l’uso', (_nome, argomenti) => {
    const esito = esegui(argomenti)
    expect(esito.stato).toBe(2)
    expect(esito.stderr).toContain('Uso:')
  })

  describe('il SORGENTE dello script (senza i commenti): il solo modo di scrivere è uno, e passa dal filtro dei segreti', () => {
    const codice = senzaCommenti(leggi(SCRIPT))

    it('niente `console.*`: l’uscita sta in due funzioni, `scrivi` e `scriviErrore`', () => {
      expect(codice).not.toMatch(/\bconsole\./)
      const scritture = [...codice.matchAll(/process\.(stdout|stderr)\.write\s*\(/g)]
      expect(scritture.map((s) => s[1])).toEqual(['stdout', 'stderr'])
      // …e ciascuna sta DENTRO la sua funzione, che prima di scrivere passa da `senzaSegreti`.
      expect(codice).toMatch(/function scrivi\(riga = ''\) \{\s*process\.stdout\.write\(`\$\{senzaSegreti\(riga\)\}\\n`\)\s*\}/)
      expect(codice).toMatch(/function scriviErrore\(riga = ''\) \{\s*process\.stderr\.write\(`\$\{senzaSegreti\(riga\)\}\\n`\)\s*\}/)
    })

    it('i comandi del Sandbox non ereditano gli stream del processo: nessuno `stdout`/`stderr` passato a `runCommand`', () => {
      expect(codice).not.toMatch(/stdio\s*:/)
      expect(codice).not.toMatch(/\bstdout\s*:\s*process\./)
      expect(codice).not.toMatch(/\bstderr\s*:\s*process\./)
    })

    it('il filtro conosce le forme dei segreti: i valori registrati, i JWT, le chiavi `sb_…`, `token=…`, gli URL', () => {
      const filtro = codice.slice(codice.indexOf('function senzaSegreti'), codice.indexOf('function scrivi('))
      for (const forma of ['segreti', 'eyJ', 'sb_', 'token|signature|apikey', 'https?:']) expect(filtro, forma).toContain(forma)
    })

    it('importa le funzioni condivise e NON ne ha una copia: nessuna impronta, nessun `sha256sum`, nessun `gzip`, nessun `curl` scritti qui', () => {
      for (const nome of ['scriptPreparazioneBuild', 'scriptVerificaBinari', 'comandoInventarioBuild', 'inventarioDellaBuild', 'mancanzeDellaBuild']) {
        expect(codice, nome).toContain(nome)
      }
      expect(codice).toMatch(/provvista:\s*scriptPreparazioneBuild\(cartella\)/)
      for (const copia of ['sha256sum -c', 'gzip -dc', 'curl -fsS', '--retry']) expect(codice, copia).not.toContain(copia)
      // Le impronte stanno in `build.ts` e basta (il lock `fixture-video-reali` le conta in tre posti): qui nemmeno una.
      expect(codice.match(/\b[0-9a-f]{64}\b/g)).toBeNull()
    })

    it('la costruzione fa quello che la testata promette: apt solo con `sudo`, snapshot senza scadenza, il Sandbox si ferma se qualcosa va storto', () => {
      expect(codice).toMatch(/'apt-get'[\s\S]{0,80}sudo:\s*true/)
      expect(codice).toContain('snapshot({ expiration: 0 })')
      expect(codice).toContain("image: IMMAGINE_DEL_SANDBOX")
      expect(codice).toContain("IMMAGINE_DEL_SANDBOX = 'vercel/sandbox/node:24'")
      expect(codice).toContain('await sandbox.stop()')
      // Gli URL firmati entrano nell'AMBIENTE del comando della provvista, mai negli argomenti.
      expect(codice).toMatch(/env:\s*\{\s*\[ENV_URL_FFMPEG\]:\s*urlFfmpeg,\s*\[ENV_URL_FFPROBE\]:\s*urlFfprobe\s*\}/)
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 9. I LOCK: ciò che questo compito promette e che un domani si romperebbe in silenzio
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ambiente · lock sulle promesse del compito', () => {
  it('lo snapshot e il ripiego usano le STESSE impronte dei binari: nessuna costante nuova', () => {
    const verifica = scriptVerificaBinari(CARTELLA_BINARI_NELLO_SNAPSHOT)
    const provvista = scriptPreparazioneBuild(CARTELLA_BUILD)
    for (const impronta of [FFMPEG_SHA256, FFPROBE_SHA256]) {
      expect(verifica).toContain(impronta)
      expect(provvista).toContain(impronta)
    }
    // Le sole sequenze di 64 cifre nei due script sono quelle di `build.ts`.
    const attese = new Set([FFMPEG_GZ_SHA256, FFPROBE_GZ_SHA256, FFMPEG_SHA256, FFPROBE_SHA256])
    for (const script of [verifica, provvista, scriptApparecchio(), scriptApparecchio({ cartella: CARTELLA_BINARI_NELLO_SNAPSHOT, binariGiaPresenti: true })]) {
      for (const trovata of script.match(/\b[0-9a-f]{64}\b/g) ?? []) expect(attese.has(trovata), trovata).toBe(true)
    }
  })

  it('`ambiente.ts` non importa l’SDK del Sandbox: è la ragione per cui la scelta si prova con un SDK finto', () => {
    const codice = senzaCommenti(leggi('src', 'lib', 'media', 'video', 'runner', 'ambiente.ts'))
    expect(codice).not.toMatch(/from\s+['"]@vercel\/sandbox['"]/)
    expect(codice).not.toMatch(/\bconsole\./)
  })

  it('la variabile è documentata in `docs/env.md` insieme al parallelismo, col suo predefinito e il suo intervallo', () => {
    const env = leggi('docs', 'env.md')
    expect(env).toContain('`VIDEO_SANDBOX_SNAPSHOT_ID`')
    expect(env).toContain('`VIDEO_CONVERSIONI_PARALLELE`')
    expect(env).toContain('scripts/video-sandbox-ambiente.mjs')
  })
})
