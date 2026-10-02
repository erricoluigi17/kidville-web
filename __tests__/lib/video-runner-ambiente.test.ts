// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rigaEvento } from '@/lib/logging/logger'
import { MESSAGGIO_MAX } from '@/lib/logging/serialize'
import {
  BUCKET_BUILD_VIDEO,
  CARTELLA_BINARI_NELLO_SNAPSHOT,
  DECODER_RICHIESTI,
  ENCODER_RICHIESTI,
  FFMPEG_GZ_SHA256,
  FFMPEG_SHA256,
  FFPROBE_GZ_SHA256,
  FFPROBE_SHA256,
  FILTRI_RICHIESTI,
} from '@/lib/media/video/build'
import { macchinaVercel } from '@/lib/media/video/runner/adattatori'
import {
  ENV_SNAPSHOT_SANDBOX,
  MOTIVI_AMBIENTE_ASSENTE,
  RUNTIME_DI_RIPIEGO,
  SUFFISSO_NOME_DI_RIPIEGO,
  apriLaMicroVm,
  erroreSanificatoPerIlLog,
  fattiDellErrore,
  leggiSnapshotConfigurato,
  nomeDelRipiego,
  type ParametriCreazione,
  type SdkMicroVm,
} from '@/lib/media/video/runner/ambiente'
import { CODICI_RUNNER_VIDEO } from '@/lib/media/video/runner/codici'
import {
  STRUMENTI_DELL_AMBIENTE,
  messaggioStrumentiMancanti,
  scriptControlloRete,
  scriptControlloStrumenti,
  spiegaUscitaDellaRete,
  strumentiMancanti,
} from '@/lib/media/video/runner/controlli-ambiente'
import {
  CARTELLA_BUILD,
  ENV_URL_FFMPEG,
  ENV_URL_FFPROBE,
  SEPARATORE_INVENTARIO,
  USCITE_PREPARAZIONE,
  codiceDaUscitaPreparazione,
  comandoInventarioBuild,
  nomeSandboxVideo,
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
  comandoMarcatore,
  comandoScritturaArgomenti,
  leggiSha256Dichiarato,
  scriptApparecchio,
  scriptConversione,
  scriptVerificaBinari,
} from '@/lib/media/video/runner/script'

import { ErroreKO, costruisci, main as mainDelloScript, piano } from '../../scripts/video-sandbox-ambiente.mjs'

/**
 * L'AMBIENTE PRONTO — lo snapshot, il ripiego, lo `sha256` dichiarato, e lo script che costruisce lo snapshot.
 *
 * Che cosa si prova QUI, e che cosa altrove:
 *
 *  · la SCELTA «riaggancia, poi snapshot, poi ripiego» (`apriLaMicroVm`) con un SDK FINTO che lancia dove si vuole:
 *    il test che mancava a un adattatore che in locale non si può eseguire. Con una piattaforma finta CON MEMORIA per i nomi,
 *    dove si vede che il ripiego dopo uno snapshot fallito non va in conflitto di nome e che la sua MicroVM si ritrova
 *    (secondario #167);
 *  · i CONTROLLI dell'immagine che lo script di costruzione fa prima dello snapshot — gli strumenti che gli script del
 *    runner danno per scontati e la rete verso il bucket — dal testo, da una `sh` vera e da `costruisci` con un Sandbox
 *    finto (sezione 10, secondario #166);
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

    describe('un messaggio più lungo del tetto perde la TESTA e tiene la CODA (secondario #165)', () => {
      // Il commento di `MESSAGGIO_ERRORE_MAX` diceva «quello che serve sta nell'inizio», e il codice faceva il contrario: la
      // coda. La coda è la scelta giusta (l'SDK di Vercel scrive `Status code 429 is not ok: ` e POI il motivo del server, e lo
      // stato sta già nell'intestazione): qui si prova che il comportamento è quello, perché il commento ora lo dica a ragione.
      const TESTA = 'INIZIO-DEL-MESSAGGIO'
      const CODA = 'MOTIVO-VERO-IN-CODA'
      const lungo = `${TESTA} ${'x'.repeat(700)} ${CODA}`

      it('la CODA c’è, la TESTA no, e il taglio si vede (`…` davanti al corpo)', () => {
        const e = erroreSanificatoPerIlLog(new ErroreApiFinto(lungo, 429, 'rate_limited'))

        expect(e.message).toContain(CODA)
        expect(e.message).not.toContain(TESTA)
        expect(e.message.startsWith('APIError HTTP 429 rate_limited: …')).toBe(true)
        // Il corpo sta nel tetto dichiarato (ellissi compresa); l'intestazione è un'altra cosa e non si conta.
        const corpo = e.message.slice('APIError HTTP 429 rate_limited: '.length)
        expect(corpo.length).toBeLessThanOrEqual(260)
      })

      it('un messaggio che sta nel tetto passa INTERO, testa e coda: si taglia solo ciò che avanza', () => {
        const corto = `${TESTA} ${CODA}`
        const e = erroreSanificatoPerIlLog(new Error(corto))

        expect(e.message).toBe(corto)
      })

      it('il commento di `MESSAGGIO_ERRORE_MAX` dice «coda» e non il contrario: il commento e il codice non si separano di nuovo', () => {
        const sorgente = leggi('src', 'lib', 'media', 'video', 'runner', 'ambiente.ts')
        const punto = sorgente.indexOf('const MESSAGGIO_ERRORE_MAX')
        expect(punto).toBeGreaterThan(0)
        // Il commento che sta SOPRA la costante: è proprio quello che era invecchiato.
        const commento = sorgente.slice(Math.max(0, punto - 1200), punto)
        expect(commento).toContain('CODA')
        expect(commento).toContain('ULTIME')
        expect(commento).not.toMatch(/sta nell['’]inizio/)
      })
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
    /** Per tutti i nomi, oppure per nome (`(nome) => 'riesce' | Error`). Senza copione nessuna MicroVM esiste. */
    riaggancia?: 'riesce' | Error | ((nome: string) => 'riesce' | Error)
    creaDaSnapshot?: 'riesce' | Error
    creaDaRuntime?: 'riesce' | Error
  }) {
    const chiamate: { tipo: 'riaggancia' | 'crea'; argomento: unknown }[] = []
    const sdk: SdkMicroVm<{ id: string }> = {
      async riaggancia(nome) {
        chiamate.push({ tipo: 'riaggancia', argomento: nome })
        const perQuestoNome = typeof copione.riaggancia === 'function' ? copione.riaggancia(nome) : copione.riaggancia
        const risposta = perQuestoNome ?? new Error('Sandbox non trovato')
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
    const { sdk, chiamate } = sdkFinto({
      riaggancia: (nome) => (nome === RICHIESTA.nome ? 'riesce' : new Error('Sandbox non trovato')),
    })

    const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

    expect(aperta).toEqual({ sandbox: { id: 'riagganciata' }, nuova: false, origine: undefined })
    // Si guarda PRIMA il nome del ripiego (che non c'è), poi quello principale (che c'è): nessuna creazione, e il riaggancio
    // riuscito non scrive niente — il ripiego «assente» è il caso normale, non un errore (secondario #167).
    expect(chiamate).toEqual([
      { tipo: 'riaggancia', argomento: 'kv-video-abc-5-r' },
      { tipo: 'riaggancia', argomento: 'kv-video-abc-5' },
    ])
    expect(righeDiLog()).toEqual([])
  })

  it('una MicroVM del RIPIEGO che sta convertendo si riaggancia al PRIMO tentativo: il suo nome è il primo che si guarda', async () => {
    const { sdk, chiamate, creazioni } = sdkFinto({ riaggancia: (nome) => (nome === 'kv-video-abc-5-r' ? 'riesce' : new Error('x')) })

    const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

    expect(aperta).toEqual({ sandbox: { id: 'riagganciata' }, nuova: false, origine: undefined })
    expect(chiamate).toEqual([{ tipo: 'riaggancia', argomento: 'kv-video-abc-5-r' }])
    expect(creazioni()).toEqual([])
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
    // UNA per apertura: conta le creazioni, e il riaggancio del nome del ripiego (che fallisce sempre nel caso normale) ha
    // un evento suo, così non le raddoppia.
    const riaggancio = conEsito('riaggancio-non-riuscito')
    expect(riaggancio).toHaveLength(1)
    expect(riaggancio[0][0]).toBe('cron')
    expect(riaggancio[0][1]).toBe('info')
    const riaggancioDelRipiego = conEsito('riaggancio-ripiego-non-riuscito')
    expect(riaggancioDelRipiego).toHaveLength(1)
    expect(riaggancioDelRipiego[0][0]).toBe('cron')
    expect(riaggancioDelRipiego[0][1]).toBe('info')
    expect(conEsito('ambiente-pronto-assente')).toEqual([])
  })

  describe('lo snapshot non si può usare: si ripiega sul percorso della PR 1, INVARIATO (salvo il nome), e si grida', () => {
    /** I parametri del ripiego, come li dava `macchinaVercel` nella PR 1: parola per parola. */
    const PARAMETRI_DELLA_PR_1 = {
      runtime: 'node22',
      name: 'kv-video-abc-5',
      region: 'dub1',
      resources: { vcpus: 4 },
      timeout: 1_800_000,
      persistent: false,
    }
    /**
     * Il ripiego DOPO uno snapshot tentato e fallito: gli stessi parametri, e un nome suo (secondario #167). Senza snapshot
     * configurato — nessun tentativo — il nome resta quello della PR 1.
     */
    const PARAMETRI_DEL_RIPIEGO_DOPO_LO_SNAPSHOT = { ...PARAMETRI_DELLA_PR_1, name: 'kv-video-abc-5-r' }

    it('lo snapshot MANCA (l’SDK risponde 410 `snapshot_not_found`): ripiego, con il codice dell’SDK nel grido', async () => {
      const { sdk, creazioni } = sdkFinto({ creaDaSnapshot: new ErroreApi(410, 'snapshot_not_found') })

      const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

      expect(aperta).toEqual({ sandbox: { id: 'dal-runtime' }, nuova: true, origine: 'runtime' })
      // Due creazioni, nell'ordine: prima lo snapshot (fallita), poi il percorso della PR 1.
      expect(creazioni()).toHaveLength(2)
      expect('source' in creazioni()[0]).toBe(true)
      // Il ripiego è IDENTICO alla PR 1, non «simile», tranne il nome (la creazione fallita può averlo lasciato occupato):
      // `toEqual` su tutte le chiavi, e nessuna chiave in più.
      expect(creazioni()[1]).toEqual(PARAMETRI_DEL_RIPIEGO_DOPO_LO_SNAPSHOT)
      expect(Object.keys(creazioni()[1]).sort()).toEqual(Object.keys(PARAMETRI_DELLA_PR_1).sort())
      expect(creazioni()[1].name).not.toBe(creazioni()[0].name)

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
      expect(creazioni()[1]).toEqual(PARAMETRI_DEL_RIPIEGO_DOPO_LO_SNAPSHOT)
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

  describe('il ripiego dopo uno snapshot fallito ha un NOME DIVERSO, e la sua MicroVM si ritrova (secondario #167)', () => {
    /**
     * Una piattaforma finta CON MEMORIA: i nomi sono unici nel progetto, `crea` registra la MicroVM e `riaggancia` la ritrova
     * per nome. È il pezzo che il finto piatto di `sdkFinto` non ha: senza memoria un nome occupato non può andare in
     * conflitto, e il difetto resterebbe invisibile — verde CON e SENZA la correzione.
     *
     * ⚠️ Ciò che si assume qui è la documentazione dell'SDK (i nomi sono unici nel progetto: `getOrCreate` li usa per ritrovare
     * una MicroVM), non una misura: il codice dell'errore di conflitto è di fantasia. Non importa quale sia: importa che un
     * secondo `crea` con un nome già preso LANCI.
     */
    function piattaformaFinta(copione: { creaDaSnapshot?: 'riesce' | 'rifiutata' | 'registrata-poi-persa' } = {}) {
      const vive = new Map<string, string>()
      const creazioni: ParametriCreazione[] = []
      const riagganci: string[] = []
      const sdk: SdkMicroVm<{ id: string }> = {
        async riaggancia(nome) {
          riagganci.push(nome)
          const id = vive.get(nome)
          if (id === undefined) throw new ErroreApi(404, 'not_found', 'Sandbox non trovato')
          return { id }
        },
        async crea(parametri) {
          creazioni.push(parametri)
          if (vive.has(parametri.name)) throw new ErroreApi(409, 'name_already_used', 'il nome è già preso')
          const daSnapshot = 'source' in parametri
          const esito = daSnapshot ? (copione.creaDaSnapshot ?? 'riesce') : 'riesce'
          if (esito === 'rifiutata') throw new ErroreApi(410, 'snapshot_not_found')
          const id = `${daSnapshot ? 'dallo-snapshot' : 'dal-runtime'}:${parametri.name}`
          vive.set(parametri.name, id)
          // La piattaforma ha creato la MicroVM, ma la risposta si è persa: per chi chiama è un'eccezione.
          if (esito === 'registrata-poi-persa') throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })
          return { id }
        },
      }
      return { sdk, vive, creazioni, riagganci }
    }

    it('il finto ha memoria: lo STESSO nome due volte va in conflitto (se non lo facesse, questi test sarebbero verdi anche col difetto)', async () => {
      const { sdk } = piattaformaFinta()
      const parametri: ParametriCreazione = { name: 'kv-video-abc-5', region: 'dub1', resources: { vcpus: 4 }, timeout: 1, persistent: false, runtime: RUNTIME_DI_RIPIEGO }

      await sdk.crea(parametri)
      await expect(sdk.crea(parametri)).rejects.toMatchObject({ response: { status: 409 } })
    })

    it('una creazione dallo snapshot che LANCIA dopo aver preso il nome (la risposta si perde): il ripiego nasce con un nome DIVERSO e riesce', async () => {
      const { sdk, creazioni, vive } = piattaformaFinta({ creaDaSnapshot: 'registrata-poi-persa' })

      const aperta = await apriLaMicroVm(sdk, RICHIESTA, SNAPSHOT_OK)

      expect(aperta).toMatchObject({ nuova: true, origine: 'runtime' })
      // Due creazioni: quella dello snapshot (col nome principale, che la piattaforma ha PRESO) e quella del ripiego.
      expect(creazioni.map((c) => c.name)).toEqual(['kv-video-abc-5', 'kv-video-abc-5-r'])
      expect(creazioni[1].name).toBe(nomeDelRipiego(RICHIESTA.nome))
      expect(creazioni[1].name).not.toBe(creazioni[0].name)
      // Entrambe le MicroVM esistono: quella dello snapshot è il RESIDUO, l'altra è dove si converte.
      expect([...vive.keys()].sort()).toEqual(['kv-video-abc-5', 'kv-video-abc-5-r'])
      // E il grido c'è, col motivo (la rete): il ripiego si grida sempre.
      expect(conEsito('ambiente-pronto-assente')[0][2]).toMatchObject({ error_code: 'ECONNRESET' })
    })

    it('il giro dopo, la MicroVM del RIPIEGO si RIAGGANCIA — e quando esiste anche il residuo con il nome principale, vince il ripiego', async () => {
      const piattaforma = piattaformaFinta({ creaDaSnapshot: 'registrata-poi-persa' })
      await apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)
      // Il punto di partenza è quello pericoloso: ESISTONO tutte e due.
      expect(piattaforma.vive.size).toBe(2)
      const creazioniPrima = piattaforma.creazioni.length
      piattaforma.riagganci.length = 0

      const aperta = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)

      // La conversione sta nella MicroVM del ripiego: è quella che si ritrova, non il residuo dello snapshot.
      expect(aperta).toEqual({ sandbox: { id: 'dal-runtime:kv-video-abc-5-r' }, nuova: false, origine: undefined })
      expect(piattaforma.creazioni).toHaveLength(creazioniPrima)
      // Si è fermato al primo nome: il ripiego si guarda PER PRIMO.
      expect(piattaforma.riagganci).toEqual(['kv-video-abc-5-r'])
    })

    it('uno snapshot che non si crea affatto (410, nessun nome preso): il ripiego riesce lo stesso, e si riaggancia lo stesso', async () => {
      const piattaforma = piattaformaFinta({ creaDaSnapshot: 'rifiutata' })

      const prima = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)
      const dopo = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)

      expect(prima).toMatchObject({ nuova: true, origine: 'runtime' })
      expect(dopo).toEqual({ sandbox: prima.sandbox, nuova: false, origine: undefined })
      expect([...piattaforma.vive.keys()]).toEqual(['kv-video-abc-5-r'])
    })

    it('una MicroVM nata dallo snapshot (il caso normale) si riaggancia col nome principale, senza creare altro', async () => {
      const piattaforma = piattaformaFinta()

      const prima = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)
      const dopo = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)

      expect(prima).toMatchObject({ nuova: true, origine: 'snapshot' })
      expect(dopo).toEqual({ sandbox: prima.sandbox, nuova: false, origine: undefined })
      expect(piattaforma.creazioni).toHaveLength(1)
      expect(piattaforma.creazioni[0].name).toBe('kv-video-abc-5')
    })

    it('SENZA snapshot configurato non c’è stato nessun tentativo che abbia potuto prendere il nome: il ripiego ha quello della PR 1', async () => {
      const piattaforma = piattaformaFinta()

      const prima = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, { stato: 'assente' })
      const dopo = await apriLaMicroVm(piattaforma.sdk, RICHIESTA, { stato: 'assente' })

      expect(prima).toMatchObject({ nuova: true, origine: 'runtime' })
      expect(piattaforma.creazioni.map((c) => c.name)).toEqual(['kv-video-abc-5'])
      // …e si ritrova lo stesso: i due nomi si guardano comunque.
      expect(dopo).toEqual({ sandbox: prima.sandbox, nuova: false, origine: undefined })
    })

    it('se il ripiego lancia anche col nome nuovo, l’eccezione ESCE (è `SANDBOX_UNAVAILABLE` per chi chiama), e non resta nessun nome del ripiego', async () => {
      const piattaforma = piattaformaFinta({ creaDaSnapshot: 'rifiutata' })
      const originale = piattaforma.sdk.crea.bind(piattaforma.sdk)
      const dalRuntime = new ErroreApi(503, 'unavailable', 'piattaforma giù')
      piattaforma.sdk.crea = async (parametri) => {
        if ('runtime' in parametri) throw dalRuntime
        return originale(parametri)
      }

      await expect(apriLaMicroVm(piattaforma.sdk, RICHIESTA, SNAPSHOT_OK)).rejects.toBe(dalRuntime)
      expect(piattaforma.vive.size).toBe(0)
    })

    it('il nome del ripiego è quello principale più `-r`, sta in un’etichetta DNS anche col `fence_epoch` più lungo, e non collide mai con un nome principale', () => {
      expect(SUFFISSO_NOME_DI_RIPIEGO).toBe('-r')
      expect(nomeDelRipiego('kv-video-abc-5')).toBe('kv-video-abc-5-r')

      const job = '3f2a61b4-1c7d-4e58-9a0b-2d4c6e8f0a12'
      for (const fence of [0, 1, 4, 1234, Number.MAX_SAFE_INTEGER]) {
        const principale = nomeSandboxVideo(job, fence)
        const ripiego = nomeDelRipiego(principale)
        // Un'etichetta DNS è lunga al più 63 caratteri: il nome finisce in un sottodominio se si espone una porta.
        expect(ripiego.length, `fence ${fence}`).toBeLessThanOrEqual(63)
        expect(principale).toMatch(/^kv-video-[0-9a-f]{32}-[0-9]+$/)
        expect(ripiego).toMatch(/^kv-video-[0-9a-f]{32}-[0-9]+-r$/)
        // Un nome principale finisce sempre con una cifra (il `fence_epoch`): quello del ripiego no, quindi non può essere il
        // principale di nessun altro tentativo — le due forme non si sovrappongono.
        expect(ripiego).not.toMatch(/^kv-video-[0-9a-f]{32}-[0-9]+$/)
      }
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

  it('con la variabile impostata e nessuna MicroVM da riagganciare: `Sandbox.get({ name, resume: true })` per i DUE nomi, poi `create` dallo snapshot', async () => {
    vi.stubEnv(ENV_SNAPSHOT_SANDBOX, 'snap_AbCdEf123456')
    h.get.mockRejectedValue(new Error('Sandbox non trovato'))
    h.create.mockResolvedValue(sandboxFinto())

    const sessione = await macchinaVercel().apri(RICHIESTA)

    // Il nome del ripiego per primo, poi quello principale (secondario #167).
    expect(h.get).toHaveBeenCalledTimes(2)
    expect(h.get).toHaveBeenNthCalledWith(1, { name: 'kv-video-abc-5-r', resume: true })
    expect(h.get).toHaveBeenNthCalledWith(2, { name: 'kv-video-abc-5', resume: true })
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
    expect(h.create.mock.calls[0][0]).toMatchObject({ name: 'kv-video-abc-5' })
    // Il ripiego dopo lo snapshot fallito nasce con un nome suo: la creazione fallita può aver lasciato il primo occupato.
    expect(h.create.mock.calls[1][0]).toMatchObject({ runtime: 'node22', name: 'kv-video-abc-5-r' })
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

    it('il piano elenca anche i controlli dell’immagine: le impronte dei due script e gli strumenti richiesti (secondario #166)', () => {
      expect(esito.stdout).toContain(`script-controllo-strumenti-sha256: ${sha256(scriptControlloStrumenti())}`)
      expect(esito.stdout).toContain(`script-controllo-rete-sha256: ${sha256(scriptControlloRete())}`)
      expect(esito.stdout).toContain(`strumenti-richiesti: ${STRUMENTI_DELL_AMBIENTE.map((strumento) => strumento.nome).join(' ')}`)
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

    it('i controlli dell’immagine sono presi da `src/` e NON scritti qui: nessun `command -v`, nessuna riga `MANCA`, e l’URL firmato entra nell’ambiente (secondario #166)', () => {
      for (const nome of ['scriptControlloStrumenti', 'scriptControlloRete', 'strumentiMancanti', 'spiegaUscitaDellaRete']) {
        expect(codice, nome).toContain(nome)
      }
      expect(codice).not.toContain('command -v')
      expect(codice).not.toContain('MANCA')
      expect(codice).toMatch(/args:\s*\['-c',\s*controlloStrumenti\]/)
      expect(codice).toMatch(/args:\s*\['-c',\s*controlloRete\],\s*env:\s*\{\s*\[ENV_URL_FFPROBE\]:\s*urlFfprobe\s*\}/)
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

/* ════════════════════════════════════════════════════════════════════════════
 * 10. I CONTROLLI DELL'IMMAGINE: gli strumenti e la rete (secondario #166)
 *
 * La costruzione dello snapshot guardava le impronte e l'inventario dei binari, e nient'altro: un'immagine senza `pkill`, senza
 * `awk` o senza rete verso il bucket costruiva uno snapshot che SEMBRAVA a posto e faceva fallire OGNI conversione — senza
 * ripiegare, perché il ripiego scatta solo con l'uscita 26. Qui si prova che i controlli ci sono, che sono quelli giusti, e che
 * un'immagine a cui manca qualcosa NON diventa uno snapshot.
 *
 * Tre misure diverse, perché nessuna basta da sola:
 *  · il TESTO — l'elenco degli strumenti contro gli script veri del runner (un `sed` aggiunto a `script.ts` farebbe cadere il lock);
 *  · l'ESECUZIONE — i due comandi dati a una `sh` vera, con un `PATH` fatto apposta (uno strumento che manca, uno che c'è ma
 *    non è eseguibile, `curl` che esce col codice di un DNS giù);
 *  · il GIRO — `costruisci` con un Sandbox finto, per vedere l'ORDINE (controlli prima della provvista) e che senza strumenti
 *    nessuno snapshot venga chiesto.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('controlli dell’immagine · l’elenco degli strumenti contro gli script veri del runner (lock)', () => {
  /**
   * I comandi esterni che un testo di shell nomina, ricavati con un vocabolario: ogni parola che è il nome di un comando di
   * sistema comune. Non è un parser — gli script sono generati, e un parser vero sarebbe più fragile degli script che deve
   * leggere — ma ha il pregio di non dipendere da dove stia il comando (una pipeline, un `$(…)`, dentro un `sh -c '…'`).
   *
   * Si saltano le opzioni (`--connect-timeout` non è il comando `timeout`) e il programma Node dell'`here-document`, che è
   * JavaScript e non shell. Dei percorsi conta l'ultimo pezzo (`/tmp/kv-ffmpeg/ffmpeg` → `ffmpeg`).
   *
   * Fuori dal vocabolario per scelta: ciò che è interno a `sh` (`echo`, `printf`, `test`, `trap`, `true`, `exit`…) e `ffmpeg` e
   * `ffprobe`, che verificano le impronte e l'inventario.
   */
  const VOCABOLARIO = new Set([
    'apt', 'apt-get', 'awk', 'base64', 'basename', 'bash', 'bc', 'cat', 'chgrp', 'chmod', 'chown', 'cmp', 'cp', 'curl', 'cut', 'date',
    'dd', 'df', 'dig', 'diff', 'dirname', 'dnf', 'du', 'env', 'expr', 'file', 'find', 'fold', 'free', 'gawk', 'getconf', 'grep',
    'gunzip', 'gzip', 'head', 'hostname', 'id', 'install', 'jq', 'ln', 'ls', 'md5sum', 'mkdir', 'mktemp', 'mv', 'nl', 'node', 'nproc',
    'od', 'openssl', 'paste', 'perl', 'pgrep', 'ping', 'pkill', 'ps', 'python', 'python3', 'readlink', 'realpath', 'rev', 'rm', 'rmdir',
    'sed', 'seq', 'sha1sum', 'sha256sum', 'sha512sum', 'sleep', 'sort', 'split', 'stat', 'sudo', 'sync', 'tac', 'tail', 'tar', 'tee',
    'timeout', 'touch', 'tr', 'uname', 'uniq', 'unzip', 'wc', 'wget', 'which', 'whoami', 'xargs', 'xxd', 'xz', 'yes', 'yum', 'zcat',
  ])

  function comandiUsati(testi: readonly string[]): Set<string> {
    const trovati = new Set<string>()
    for (const testo of testi) {
      const senzaProgramma = testo.replace(/<<'KV_TEMPORAL_PROGRAM'\n[\s\S]*?\nKV_TEMPORAL_PROGRAM/g, '')
      for (let token of senzaProgramma.split(/[\s|&;()<>{}$"'`=,]+/)) {
        if (token === '' || token.startsWith('-')) continue
        if (token.includes('/')) token = token.slice(token.lastIndexOf('/') + 1)
        if (VOCABOLARIO.has(token)) trovati.add(token)
      }
    }
    return trovati
  }

  /** Ogni script e ogni comando che il runner manda alla MicroVM, su tutti i loro rami: con e senza snapshot, watermark, `sha256`. */
  function scriptDelRunner(): string[] {
    const snapshot = CARTELLA_BINARI_NELLO_SNAPSHOT
    const conversione = { videoIndex: 0, sourceFps: 30, durationSeconds: 10, width: 1920, height: 1080 }
    return [
      scriptPreparazioneBuild(),
      scriptPreparazioneBuild(snapshot),
      scriptVerificaBinari(),
      scriptVerificaBinari(snapshot),
      comandoInventarioBuild(),
      comandoInventarioBuild(snapshot),
      scriptApparecchio(),
      scriptApparecchio({ cartella: snapshot, binariGiaPresenti: true }),
      scriptConversione({ ...conversione, conWatermark: true, audioIndex: 1, verificaSha256: true, cartellaBuild: snapshot }),
      scriptConversione({ ...conversione, conWatermark: false, audioIndex: null }),
      ...[comandoMarcatore(), comandoInterruzione(), comandoScritturaArgomenti(['-i', 'x'])].map((c) => c.args.join(' ')),
    ]
  }

  const CONTROLLATI = STRUMENTI_DELL_AMBIENTE.map((s) => s.nome)

  it('ogni comando che gli script chiamano è fra gli strumenti controllati: un `sed` nuovo in `script.ts` farebbe fallire ogni conversione e passerebbe lo snapshot', () => {
    const nonControllati = [...comandiUsati(scriptDelRunner())].filter((nome) => !CONTROLLATI.includes(nome)).sort()

    expect(
      nonControllati,
      'questi comandi sono negli script del runner ma non in STRUMENTI_DELL_AMBIENTE (src/lib/media/video/runner/controlli-ambiente.ts): ' +
        'lo snapshot li darebbe per scontati senza mai controllarli',
    ).toEqual([])
  })

  it('e viceversa: ogni strumento dell’elenco è chiamato da almeno uno script (nessuna voce morta)', () => {
    const usati = comandiUsati(scriptDelRunner())

    expect(CONTROLLATI.filter((nome) => !usati.has(nome))).toEqual([])
  })

  it('il lock vede qualcosa: i comandi trovati sono QUELLI che si sanno chiamati (e non un insieme vuoto che passa per vuotezza)', () => {
    const usati = comandiUsati(scriptDelRunner())

    // I tre che il secondario #166 nomina, più uno per ciascun modo di chiamare: pipeline, `$(…)`, `sh -c`, here-document.
    for (const nome of ['pkill', 'awk', 'grep', 'curl', 'sha256sum', 'gzip', 'stat', 'wc', 'xargs', 'node']) {
      expect(usati.has(nome), nome).toBe(true)
    }
  })

  it('CONTROPROVA: un comando che l’elenco non conosce viene visto (`sed`, `jq`), e un’opzione che somiglia a un comando no (`--connect-timeout`)', () => {
    const visti = comandiUsati(["sed -n 1p /tmp/x | jq . > /tmp/y", 'curl --connect-timeout 10 --max-time 5 "$URL"'])

    expect([...visti].sort()).toEqual(['curl', 'jq', 'sed'])
  })

  it('l’elenco è in ordine alfabetico, senza doppioni, e ogni voce ha il suo pacchetto', () => {
    expect([...CONTROLLATI]).toEqual([...CONTROLLATI].sort())
    expect(new Set(CONTROLLATI).size).toBe(CONTROLLATI.length)
    for (const s of STRUMENTI_DELL_AMBIENTE) expect(s.pacchetto, s.nome).not.toBe('')
  })

  it('dentro `sh` non c’è niente da controllare: nessun interno della shell è nell’elenco (`command -v printf` direbbe «c’è» anche senza il binario)', () => {
    for (const interno of ['echo', 'printf', 'test', 'trap', 'true', 'exit', 'set', 'sh', 'ffmpeg', 'ffprobe']) {
      expect(CONTROLLATI, interno).not.toContain(interno)
    }
  })
})

describe('controlli dell’immagine · le funzioni pure di `controlli-ambiente.ts`', () => {
  it('`strumentiMancanti` legge SOLO le righe `MANCA <nome>`, senza doppioni, nell’ordine in cui sono scritte', () => {
    expect(strumentiMancanti('MANCA pkill\nMANCA awk\nMANCA pkill\n')).toEqual(['pkill', 'awk'])
    expect(strumentiMancanti('')).toEqual([])
    // L'uscita di un comando non è un dato di cui fidarsi: una riga che non ha la forma esatta non conta.
    expect(strumentiMancanti('manca pkill\nMANCA\nMANCA ; rm -rf /\nqualcosa MANCA grep\nMANCA  sed')).toEqual([])
    expect(strumentiMancanti(undefined as unknown as string)).toEqual([])
  })

  it('`scriptControlloStrumenti` rifiuta un nome che non sia un nome di comando: finisce in una riga di shell', () => {
    for (const nome of ['', 'a b', 'awk; rm -rf /', '$(id)', '-rf', 'x`y`', 'a\nb']) {
      expect(() => scriptControlloStrumenti([{ nome, pacchetto: 'x' }]), JSON.stringify(nome)).toThrow(TypeError)
    }
    expect(() => scriptControlloStrumenti([{ nome: 'sha256sum', pacchetto: 'coreutils' }, { nome: 'g++', pacchetto: 'g++' }])).not.toThrow()
  })

  it('il comando degli strumenti nomina TUTTI gli strumenti, e nient’altro che `command -v` e la riga `MANCA`', () => {
    const script = scriptControlloStrumenti()

    for (const { nome } of STRUMENTI_DELL_AMBIENTE) expect(script, nome).toContain(nome)
    expect(script).toContain('command -v')
    // Non installa niente e non scarica niente: controlla (`curl` compare solo come NOME nell'elenco, accanto agli altri).
    for (const vietato of ['apt', 'sudo', 'wget', 'dnf', 'install', 'http']) expect(script, vietato).not.toContain(vietato)
    expect(script.match(/\bcurl\b/g)).toHaveLength(1)
  })

  it('il messaggio dice QUALE strumento manca, con il pacchetto che lo porta, e dove si aggiunge', () => {
    const messaggio = messaggioStrumentiMancanti(['pkill', 'awk'])

    expect(messaggio).toContain('pkill (pacchetto procps)')
    expect(messaggio).toContain('awk (pacchetto mawk o gawk)')
    expect(messaggio).toContain('apt-get')
    // Un nome che l'elenco non conosce si dice com'è, senza inventare un pacchetto.
    expect(messaggioStrumentiMancanti(['sconosciuto'])).toContain('sconosciuto')
    expect(messaggioStrumentiMancanti(['sconosciuto'])).not.toContain('sconosciuto (pacchetto')
  })

  it.each<[number, RegExp]>([
    [6, /DNS/],
    [7, /connessione/],
    [22, /URL firmato/],
    [28, /tempo scaduto/],
    [35, /TLS/],
    [60, /ca-certificates/],
    [77, /TLS/],
    [127, /curl non si trova/],
  ])('l’uscita %i di `curl` si spiega in parole', (uscita, atteso) => {
    expect(spiegaUscitaDellaRete(uscita)).toMatch(atteso)
  })

  it('un’uscita che non si conosce si dice com’è', () => {
    expect(spiegaUscitaDellaRete(99)).toBe('curl è uscito con 99')
  })

  it('il comando della rete è una HEAD con le opzioni dell’apparecchio, l’URL dall’AMBIENTE e mai fra gli argomenti', () => {
    const script = scriptControlloRete()

    expect(script).toContain('curl -fsSI --retry 3 --retry-all-errors')
    expect(script).toContain(`"$${ENV_URL_FFPROBE}"`)
    expect(script).toContain(`\${${ENV_URL_FFPROBE}:?}`)
    // Nessun indirizzo scritto qui dentro, e la risposta non si stampa.
    expect(script).not.toMatch(/https?:\/\//)
    expect(script).toContain('> /dev/null')
    // Esce con lo stato di curl, tale e quale: `spiegaUscitaDellaRete` lo legge.
    expect(script).toContain('|| exit $?')
  })
})

describe('controlli dell’immagine · i due comandi eseguiti da una `sh` VERA', () => {
  const SHELL = process.env.KV_SHELL_DI_PROVA ?? '/bin/sh'
  const cartelle: string[] = []

  afterEach(() => {
    for (const dir of cartelle.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Una cartella che è l'INTERO `PATH`: ci sono solo gli strumenti che si chiedono, ciascuno un eseguibile che non fa niente. */
  function pathCon(presenti: readonly string[], opzioni: { nonEseguibili?: readonly string[]; corpo?: string } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'kv-controlli-ambiente-'))
    cartelle.push(dir)
    for (const nome of presenti) {
      const file = join(dir, nome)
      writeFileSync(file, `#!/bin/sh\n${opzioni.corpo ?? 'exit 0'}\n`)
      chmodSync(file, 0o755)
    }
    for (const nome of opzioni.nonEseguibili ?? []) {
      const file = join(dir, nome)
      writeFileSync(file, '#!/bin/sh\nexit 0\n')
      chmodSync(file, 0o644)
    }
    return dir
  }

  function esegui(script: string, dir: string, env: Record<string, string> = {}) {
    // `PATH` è la sola cartella costruita; la shell si lancia per percorso assoluto, e `command` è un interno.
    return spawnSync(SHELL, ['-c', script], { env: { PATH: dir, NODE_ENV: 'test', ...env }, encoding: 'utf8', timeout: 20_000 })
  }

  const TUTTI = STRUMENTI_DELL_AMBIENTE.map((s) => s.nome)

  it('con TUTTI gli strumenti: esce 0 e non scrive niente', () => {
    const r = esegui(scriptControlloStrumenti(), pathCon(TUTTI))

    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('')
    expect(strumentiMancanti(r.stdout)).toEqual([])
  })

  it.each(TUTTI)('manca solo `%s`: esce 1 e scrive esattamente la sua riga «MANCA …»', (nome) => {
    const r = esegui(scriptControlloStrumenti(), pathCon(TUTTI.filter((t) => t !== nome)))

    expect(r.status, r.stderr).toBe(1)
    expect(r.stdout).toBe(`MANCA ${nome}\n`)
    expect(strumentiMancanti(r.stdout)).toEqual([nome])
  })

  it('manca più di uno strumento: li dice TUTTI, non solo il primo (chi costruisce ne installa tre insieme)', () => {
    const r = esegui(scriptControlloStrumenti(), pathCon(TUTTI.filter((t) => !['pkill', 'awk', 'xargs'].includes(t))))

    expect(r.status).toBe(1)
    expect(strumentiMancanti(r.stdout)).toEqual(['awk', 'pkill', 'xargs'])
  })

  it('un `PATH` vuoto: mancano tutti, nell’ordine dell’elenco', () => {
    const r = esegui(scriptControlloStrumenti(), pathCon([]))

    expect(r.status).toBe(1)
    expect(strumentiMancanti(r.stdout)).toEqual(TUTTI)
  })

  it('uno strumento che c’è ma NON è eseguibile non c’è: `command -v` non lo trova, e il runner non potrebbe lanciarlo', () => {
    const r = esegui(scriptControlloStrumenti(), pathCon(TUTTI.filter((t) => t !== 'grep'), { nonEseguibili: ['grep'] }))

    expect(r.status).toBe(1)
    expect(strumentiMancanti(r.stdout)).toEqual(['grep'])
  })

  it('la rete: l’uscita di `curl` arriva tale e quale, con l’URL dall’ambiente, e l’URL NON compare nell’uscita del comando', () => {
    const URL_FIRMATO = 'https://esempio.invalid/storage/v1/object/sign/video_build/x.gz?token=SEGRETO-DI-PROVA-0123'
    const registro = join(mkdtempSync(join(tmpdir(), 'kv-rete-registro-')), 'argomenti')
    cartelle.push(join(registro, '..'))
    // Un `curl` finto: scrive gli argomenti che ha ricevuto e esce col codice che gli si chiede.
    const dir = pathCon(['curl'], { corpo: `printf '%s\\n' "$@" > '${registro}'\nexit "\${KV_CURL_ESCE:-0}"` })

    for (const uscita of [0, 6, 22, 28, 60]) {
      const r = esegui(scriptControlloRete(), dir, { [ENV_URL_FFPROBE]: URL_FIRMATO, KV_CURL_ESCE: String(uscita) })

      expect(r.status, `curl esce ${uscita}`).toBe(uscita)
      expect(r.stdout + r.stderr).not.toContain('SEGRETO-DI-PROVA')
    }

    // Gli argomenti veri: una HEAD silenziosa che fallisce sugli errori HTTP, con i tentativi e i tetti dell'apparecchio, e l'URL per ultimo.
    const argomenti = readFileSync(registro, 'utf8').trim().split('\n')
    expect(argomenti.slice(0, -1)).toEqual(['-fsSI', '--retry', '3', '--retry-all-errors', '--connect-timeout', '10', '--max-time', '30'])
    expect(argomenti[argomenti.length - 1]).toBe(URL_FIRMATO)
  })

  it('senza l’indirizzo nell’ambiente il comando NON chiama `curl`, e fallisce', () => {
    const registro = join(mkdtempSync(join(tmpdir(), 'kv-rete-registro-')), 'chiamato')
    cartelle.push(join(registro, '..'))
    const dir = pathCon(['curl'], { corpo: `echo si > '${registro}'\nexit 0` })

    const r = esegui(scriptControlloRete(), dir)

    expect(r.status).not.toBe(0)
    expect(existsSync(registro)).toBe(false)
  })
})

describe('scripts/video-sandbox-ambiente.mjs · la costruzione con un Sandbox FINTO: nessuno snapshot se all’immagine manca qualcosa (secondario #166)', () => {
  const OPZIONI = { aSecco: false, regione: 'dub1', vcpus: 4 }
  const SEGRETO_FFMPEG = 'SEGRETO-FFMPEG-0123456789'
  const SEGRETO_FFPROBE = 'SEGRETO-FFPROBE-0123456789'
  const URL_FFMPEG = `https://esempio.invalid/storage/v1/object/sign/video_build/ffmpeg.gz?token=${SEGRETO_FFMPEG}`
  const URL_FFPROBE = `https://esempio.invalid/storage/v1/object/sign/video_build/ffprobe.gz?token=${SEGRETO_FFPROBE}`

  const elenco = (nomi: readonly string[], bandierine: string): string => nomi.map((nome) => ` ${bandierine} ${nome}   descrizione`).join('\n')
  /** L'inventario di una build COMPLETA, nella forma dell'uscita di `ffmpeg -filters/-decoders/-encoders`. */
  const INVENTARIO = [
    elenco(FILTRI_RICHIESTI, '..'),
    elenco(DECODER_RICHIESTI, 'V....D'),
    elenco(ENCODER_RICHIESTI, 'V....D'),
  ].join(`\n${SEPARATORE_INVENTARIO}\n`)

  interface ComandoDelSandbox {
    cmd: string
    args?: string[]
    env?: Record<string, string>
    sudo?: boolean
    timeoutMs?: number
  }

  interface Copione {
    /** Gli strumenti che il comando dice mancanti (`MANCA …`, uscita 1). */
    strumentiMancanti?: string[]
    /** Il comando degli strumenti, deciso per intero (per i casi che non somigliano a «manca uno strumento»). */
    controlloStrumenti?: { exitCode: number; stdout?: string }
    /** La rete: uscita e stderr del comando di `curl`. */
    rete?: { exitCode: number; stderr?: string }
  }

  /**
   * Un Sandbox che risponde ai comandi guardando CHE COSA gli si chiede: gli script del piano sono riconosciuti per uguaglianza
   * di testo (sono le stesse funzioni di `src/`, quindi se la costruzione ne eseguisse un altro lo si vedrebbe), tutto il
   * resto risponde «va bene». `eventi` è l'ORDINE dei passi che interessano, con `SNAPSHOT` e `STOP` dentro.
   */
  function costruzioneFinta(copione: Copione = {}) {
    const p = piano()
    const eseguiti: ComandoDelSandbox[] = []
    const eventi: string[] = []
    /** Come `eventi`, ma con `apt-get` e le FIRME dentro: serve a vedere QUANDO si firmano gli indirizzi (#179). */
    const cronologia: string[] = []
    const richiesteDiSnapshot: unknown[] = []
    const finito = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout: async () => stdout, stderr: async () => stderr })

    function rispondi(comando: ComandoDelSandbox) {
      const script = comando.cmd === 'sh' ? (comando.args?.[1] ?? '') : ''
      cronologia.push(comando.cmd === 'apt-get' ? `apt-get ${comando.args?.[0] ?? ''}` : script === p.controlloRete ? 'rete' : script === p.provvista ? 'provvista' : comando.cmd)
      if (script === p.controlloStrumenti) {
        eventi.push('strumenti')
        if (copione.controlloStrumenti) return finito(copione.controlloStrumenti.exitCode, copione.controlloStrumenti.stdout ?? '')
        const mancano = copione.strumentiMancanti ?? []
        return mancano.length > 0 ? finito(1, mancano.map((nome) => `MANCA ${nome}\n`).join('')) : finito(0)
      }
      if (script === p.controlloRete) {
        eventi.push('rete')
        return copione.rete ? finito(copione.rete.exitCode, '', copione.rete.stderr ?? '') : finito(0)
      }
      if (script === p.provvista) {
        eventi.push('provvista')
        return finito(0)
      }
      if (script === p.inventario) {
        eventi.push('inventario')
        return finito(0, INVENTARIO)
      }
      if (script === p.verifica) {
        eventi.push('verifica')
        return finito(0)
      }
      if (comando.cmd === 'sha256sum') {
        eventi.push('impronte')
        return finito(0, `${FFMPEG_SHA256}  ${p.cartella}/ffmpeg\n${FFPROBE_SHA256}  ${p.cartella}/ffprobe\n`)
      }
      if (comando.cmd === 'id') return finito(0, '1000\n')
      if (comando.cmd === 'curl') return finito(0, 'curl 8.99.0 (finto)\n')
      if (script.startsWith('. /etc/os-release')) return finito(0, 'Ubuntu 26.04 LTS x86_64\n')
      return finito(0)
    }

    const sandbox = {
      async runCommand(comando: ComandoDelSandbox) {
        eseguiti.push(comando)
        return rispondi(comando)
      },
      async snapshot(parametri: unknown) {
        eventi.push('SNAPSHOT')
        richiesteDiSnapshot.push(parametri)
        return { snapshotId: 'snap_FINTO0123456789', status: 'created', regions: ['dub1'], sizeBytes: 1234, expiresAt: undefined }
      },
      async stop() {
        eventi.push('STOP')
      },
    }
    const create = vi.fn(async (parametri: unknown) => {
      void parametri
      return sandbox
    })
    const supabase = {
      storage: {
        from: () => ({
          createSignedUrl: async (percorso: string) => {
            cronologia.push('firma')
            return {
              data: { signedUrl: percorso.endsWith('ffmpeg.gz') ? URL_FFMPEG : URL_FFPROBE },
              error: null,
            }
          },
        }),
      },
    }
    return {
      dipendenze: { credenziali: { token: 'FINTO-TOKEN-VERCEL-9876', projectId: 'prj_finto', teamId: 'team_finto' }, supabase, Sandbox: { create } },
      eseguiti,
      eventi,
      cronologia,
      create,
      richiesteDiSnapshot,
    }
  }

  /** Tutto ciò che la costruzione ha scritto, su stdout e su stderr. */
  let scritto: string[] = []
  beforeEach(() => {
    scritto = []
    vi.spyOn(process.stdout, 'write').mockImplementation((riga: unknown) => {
      scritto.push(String(riga))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((riga: unknown) => {
      scritto.push(String(riga))
      return true
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const tuttoCioCheHaScritto = (): string => scritto.join('')

  async function fallisce(promessa: Promise<unknown>): Promise<Error> {
    const errore = await promessa.then(
      () => null,
      (e: unknown) => e,
    )
    expect(errore, 'la costruzione doveva fallire').toBeInstanceOf(ErroreKO)
    return errore as Error
  }

  it('un’immagine sana: gli strumenti e la rete si controllano PRIMA della provvista, e lo snapshot è l’ultima cosa', async () => {
    const { dipendenze, eventi, create, richiesteDiSnapshot } = costruzioneFinta()

    const codice = await costruisci(OPZIONI, piano(), dipendenze)

    expect(codice).toBe(0)
    expect(eventi).toEqual(['strumenti', 'rete', 'provvista', 'inventario', 'verifica', 'impronte', 'SNAPSHOT'])
    expect(create).toHaveBeenCalledTimes(1)
    // Senza scadenza, e il Sandbox non si ferma da sé: è lo snapshot a spegnerlo.
    expect(richiesteDiSnapshot).toEqual([{ expiration: 0 }])
    expect(tuttoCioCheHaScritto()).toContain('VIDEO_SANDBOX_SNAPSHOT_ID=snap_FINTO0123456789')
    expect(tuttoCioCheHaScritto()).toContain(`${STRUMENTI_DELL_AMBIENTE.length} strumenti presenti`)
  })

  it('gli indirizzi (validi 10 minuti) si firmano DOPO `apt-get` e subito prima della rete e della provvista che li usano (secondario #179)', async () => {
    const { dipendenze, cronologia } = costruzioneFinta()

    await costruisci(OPZIONI, piano(), dipendenze)

    const primaFirma = cronologia.indexOf('firma')
    expect(primaFirma, 'nessuna firma').toBeGreaterThanOrEqual(0)
    expect(cronologia.lastIndexOf('apt-get install'), 'apt-get install dopo la firma').toBeLessThan(primaFirma)
    expect(cronologia.lastIndexOf('apt-get update'), 'apt-get update dopo la firma').toBeLessThan(primaFirma)
    // Fra la seconda firma e la rete non c'è nessun altro comando: il tempo che scorre è quello che serve.
    expect(cronologia.slice(primaFirma, primaFirma + 3)).toEqual(['firma', 'firma', 'rete'])
    expect(cronologia.indexOf('provvista')).toBeGreaterThan(primaFirma)
  })

  it('se all’immagine manca uno strumento NON si firma niente: nessun indirizzo nasce per una costruzione che si ferma', async () => {
    const { dipendenze, cronologia } = costruzioneFinta({ strumentiMancanti: ['pkill'] })

    await fallisce(costruisci(OPZIONI, piano(), dipendenze))

    expect(cronologia).not.toContain('firma')
  })

  it('il tetto della prova di rete sta sopra il caso peggiore di `curl` (4 × 30 s + 1 + 2 + 4 s), così si legge l’uscita di `curl` e non un 137 (secondario #178)', () => {
    const codice = readFileSync(join(process.cwd(), 'scripts/video-sandbox-ambiente.mjs'), 'utf8')
    const tetto = /const TETTO_RETE_MS = (\d+) \* 1000/.exec(codice)
    expect(tetto, 'TETTO_RETE_MS non trovato nella forma `N * 1000`').not.toBeNull()
    const rete = scriptControlloRete()
    const tentativi = Number(/--retry (\d+)/.exec(rete)?.[1]) + 1
    const perTentativo = Number(/--max-time (\d+)/.exec(rete)?.[1])
    expect(Number.isFinite(tentativi) && Number.isFinite(perTentativo)).toBe(true)
    // Le attese di `curl --retry` raddoppiano da 1 s: 1, 2, 4… fra un tentativo e l'altro.
    const attese = Array.from({ length: tentativi - 1 }, (_, i) => 2 ** i).reduce((a, b) => a + b, 0)
    expect(Number(tetto?.[1])).toBeGreaterThan(tentativi * perTentativo + attese)
  })

  it.each<[string, string[]]>([
    ['uno strumento (`pkill`)', ['pkill']],
    ['due strumenti (`pkill`, `awk`)', ['pkill', 'awk']],
  ])('manca %s: NESSUNO snapshot, il Sandbox si ferma, la provvista non parte, e il messaggio dice che cosa manca', async (_nome, mancano) => {
    const { dipendenze, eventi } = costruzioneFinta({ strumentiMancanti: mancano })

    const errore = await fallisce(costruisci(OPZIONI, piano(), dipendenze))

    // Né la rete, né la provvista da 134 MB, né lo snapshot: si ferma al primo controllo che non torna.
    expect(eventi).toEqual(['strumenti', 'STOP'])
    for (const nome of mancano) expect(errore.message).toContain(nome)
    expect(errore.message).toContain('pkill (pacchetto procps)')
    expect(errore.message).toContain('apt-get')
    expect(tuttoCioCheHaScritto()).toContain('KO  strumenti che gli script del runner chiamano: uscita 1')
  })

  it('un controllo degli strumenti che esce ≠ 0 senza dire quale manca NON passa lo stesso (fail-closed)', async () => {
    const { dipendenze, eventi } = costruzioneFinta({ controlloStrumenti: { exitCode: 2, stdout: '' } })

    const errore = await fallisce(costruisci(OPZIONI, piano(), dipendenze))

    expect(eventi).toEqual(['strumenti', 'STOP'])
    expect(errore.message).toContain('non è riuscito')
    expect(errore.message).toContain('uscita 2')
  })

  it('e uno che dice «MANCA grep» pur uscendo 0 non passa: conta ciò che dice, non solo l’uscita', async () => {
    const { dipendenze, eventi } = costruzioneFinta({ controlloStrumenti: { exitCode: 0, stdout: 'MANCA grep\n' } })

    const errore = await fallisce(costruisci(OPZIONI, piano(), dipendenze))

    expect(eventi).toEqual(['strumenti', 'STOP'])
    expect(errore.message).toContain('grep')
  })

  it.each<[number, RegExp]>([
    [6, /DNS/],
    [60, /TLS/],
    [22, /URL firmato/],
    [28, /tempo scaduto/],
  ])('la rete non funziona (`curl` esce %i): NESSUNO snapshot, il Sandbox si ferma, la provvista non parte, e il messaggio dice perché', async (uscita, atteso) => {
    const { dipendenze, eventi } = costruzioneFinta({ rete: { exitCode: uscita } })

    const errore = await fallisce(costruisci(OPZIONI, piano(), dipendenze))

    expect(eventi).toEqual(['strumenti', 'rete', 'STOP'])
    expect(errore.message).toMatch(atteso)
    expect(errore.message).toContain('la rete dell’immagine verso il bucket non funziona')
  })

  it('l’URL firmato della rete entra nell’AMBIENTE del comando e MAI negli argomenti; e non esce da nessun canale, nemmeno se il comando lo scrive su stderr', async () => {
    const { dipendenze, eseguiti } = costruzioneFinta({
      // Un client che, fallendo, scrive l'indirizzo che chiamava: è esattamente il caso che il filtro deve reggere.
      rete: { exitCode: 22, stderr: `curl: (22) The requested URL returned error: 403\n${URL_FFPROBE}\n` },
    })

    await fallisce(costruisci(OPZIONI, piano(), dipendenze))

    const rete = eseguiti.find((c) => c.cmd === 'sh' && c.args?.[1] === piano().controlloRete)
    expect(rete, 'il comando della rete non è stato eseguito').toBeDefined()
    expect(rete?.env).toEqual({ [ENV_URL_FFPROBE]: URL_FFPROBE })
    expect(rete?.args).toEqual(['-c', piano().controlloRete])
    for (const comando of eseguiti) {
      const testo = JSON.stringify(comando.args ?? [])
      for (const segreto of [SEGRETO_FFMPEG, SEGRETO_FFPROBE, 'esempio.invalid']) expect(testo, `${segreto} negli argomenti`).not.toContain(segreto)
    }
    // Il motivo del guasto si legge (è l'unica cosa che dice cosa riparare)…
    expect(tuttoCioCheHaScritto()).toContain('returned error: 403')
    // …e nessun segreto, nessun indirizzo.
    for (const segreto of [SEGRETO_FFMPEG, SEGRETO_FFPROBE, 'esempio.invalid', 'https://']) {
      expect(tuttoCioCheHaScritto(), `«${segreto}» è uscito dallo script`).not.toContain(segreto)
    }
  })

  it('nemmeno la provvista di un’immagine sana porta l’indirizzo fuori dall’ambiente: l’uscita intera della costruzione non ne contiene', async () => {
    const { dipendenze } = costruzioneFinta()

    await costruisci(OPZIONI, piano(), dipendenze)

    for (const segreto of [SEGRETO_FFMPEG, SEGRETO_FFPROBE, 'esempio.invalid', 'https://', 'FINTO-TOKEN-VERCEL']) {
      expect(tuttoCioCheHaScritto(), segreto).not.toContain(segreto)
    }
  })

  it('i comandi dei controlli sono QUELLI di `src/`: la costruzione esegue il testo di `scriptControlloStrumenti()` e `scriptControlloRete()`, non un altro', async () => {
    const { dipendenze, eseguiti } = costruzioneFinta()

    await costruisci(OPZIONI, piano(), dipendenze)

    const comandiSh = eseguiti.filter((c) => c.cmd === 'sh').map((c) => c.args?.[1])
    expect(comandiSh).toContain(scriptControlloStrumenti())
    expect(comandiSh).toContain(scriptControlloRete())
    // E nessuno dei due si esegue con `sudo`: a runtime il runner non ce l'ha.
    for (const comando of eseguiti.filter((c) => c.args?.[1] === scriptControlloStrumenti() || c.args?.[1] === scriptControlloRete())) {
      expect(comando.sudo, JSON.stringify(comando.args)).toBeUndefined()
    }
  })

  it('`main` passa le dipendenze a `costruisci` e restituisce il suo codice (il file importato non parte da solo)', async () => {
    const { dipendenze, eventi } = costruzioneFinta()
    const stato = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      // `as never`: il tipo che TypeScript ricava dallo script (JS) è quello dei SDK veri, e un doppio non lo soddisfa.
      expect(await mainDelloScript(['--regione', 'dub1', '--vcpus', '2'], (async () => dipendenze) as never)).toBe(0)
    } finally {
      if (stato) Object.defineProperty(process.stdin, 'isTTY', stato)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
    }

    expect(eventi[0]).toBe('strumenti')
    expect(eventi[eventi.length - 1]).toBe('SNAPSHOT')
  })
})

