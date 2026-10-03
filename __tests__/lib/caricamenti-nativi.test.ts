import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  METODI_PLUGIN_CARICAMENTI,
  NOME_PLUGIN_CARICAMENTI,
  PROTOCOLLO_CARICAMENTI,
} from '@/lib/native/caricamenti-nativi-tipi'

/**
 * L'INVOLUCRO JS DEL PLUGIN `KidvilleCaricamenti` E LA RILEVAZIONE (app 1.2, spec 2026-10-03, §7.1) —
 * `src/lib/native/caricamenti-nativi.ts`.
 *
 * Cosa inchiodano questi test, e come diventerebbero rossi:
 *
 *  - LA RILEVAZIONE decide in cinque passi (app nativa, plugin noto al bridge, interruttore,
 *    intestazione con TUTTI i metodi, `info()` in tempo e del protocollo giusto). Ogni passo ha il
 *    suo test: togliere `isPluginAvailable`, l'interruttore, il controllo dei metodi, il tetto di
 *    `info()` o la rilettura della sua forma fa cadere quello del passo;
 *  - SULLE 1.0/1.1 L'ASSENZA È IL CASO NORMALE: `null` e NESSUNA riga di log, il plugin non si
 *    registra né si chiama. Scrivere una riga per ogni telefono non ancora aggiornato sommergerebbe
 *    la tabella di righe `error` che non sono un errore. Scrive `caricamenti-nativi-incompleti` (un
 *    difetto di build) un binario ≥ 1.2 SENZA il plugin, oppure COL plugin ma rotto: metodi che
 *    mancano, `info()` che non risponde o fuori forma, protocollo diverso;
 *  - L'INTERRUTTORE D'EMERGENZA (`NEXT_PUBLIC_CARICAMENTI_NATIVI=0`) spegne tutto con un deploy web:
 *    spento il plugin non si registra né si chiama, e una riga `caricamenti-nativi-spenti` dice che
 *    è stata una scelta;
 *  - IL PLUGIN È UN PROXY FEDELE a quello di `registerPlugin` (sul modello di
 *    `native-register-plugin-proxy.test.ts`): risponde a OGNI proprietà, `then` compreso, e chiamato
 *    come thenable non richiama mai `risolvi`. Una funzione `async` che restituisse il plugin,
 *    un `await plugin`, un `.then(() => plugin)` resterebbero appesi qui come sul telefono
 *    (#166 → #168). Un finto piatto sarebbe verde anche col difetto: il test «il finto è fedele» lo
 *    prova sul banco, e i test sotto guardano che `then` non sia MAI letto sul plugin;
 *  - LA RILETTURA CON ZOD, nei due versi: ogni RICHIESTA fuori forma è `PARAMETRI_NON_VALIDI` e il
 *    plugin non la vede (la più pericolosa: `massimoElementi: 0`, che PHPicker legge «senza limite»);
 *    ogni RISPOSTA fuori forma è `RISPOSTA_NON_VALIDA`, mai un oggetto a metà. Ogni rifiuto del ponte
 *    diventa un codice dell'elenco chiuso e il MESSAGGIO del ponte (che può contenere il nome di un
 *    file) non compare né nell'errore né in un log;
 *  - UNA RILEVAZIONE PER SESSIONE: la stessa promise, una sola `info()`, una sola riga;
 *  - IL TEMPO: `info()` e la lettura della versione corrono insieme, quindi il caso peggiore dura un
 *    tetto (`TIMEOUT_INFO_MS`) e non due: la Galleria non disegna l'area di scelta finché la
 *    rilevazione non risponde;
 *  - LA LIBRERIA VERA: l'ultimo blocco del file rifà i casi essenziali contro il VERO `@capacitor/core`
 *    (si finge solo il trasporto nativo), perché un finto scritto leggendo il sorgente di Capacitor può
 *    smettere di somigliargli senza che nessun test lo dica — ed è così che la #166 è passata.
 *
 * Il file è un banco, non un campione: `plugin` e `Capacitor` sono finti, `conTettoDiTempo` è il
 * vero (i test del tetto usano timer finti).
 */

/** I sette codici con cui il nativo rifiuta, scritti qui a mano: se la lista cambia, cade un test. */
const CODICI_DEL_PLUGIN = [
  'GIA_IN_CORSO',
  'SELETTORE_NON_DISPONIBILE',
  'PARAMETRI_NON_VALIDI',
  'ELEMENTO_ASSENTE',
  'ELEMENTO_DIVERSO',
  'HOST_NON_AMMESSO',
  'INTERNO',
]

/** Un pezzo di testo che nel mondo vero sarebbe un nome di file: non deve MAI arrivare in un log. */
const TESTO_DEL_PONTE = 'Impossibile leggere /private/var/Containers/Mario-Rossi-compleanno.mov'

const h = vi.hoisted(() => {
  const nativo = { valore: true }
  const piattaforma = { valore: 'ios' as 'ios' | 'android' }
  /** I nomi che il bridge considera «disponibili» (`Capacitor.isPluginAvailable`). */
  const disponibili = new Set<string>()
  /** `Capacitor.PluginHeaders`: quello che il nativo dichiara. `rotto` = il getter lancia. */
  const intestazioni: { valore: unknown; rotto: boolean } = { valore: undefined, rotto: false }
  /** `App.getInfo()`: la versione del binario. */
  const app: { getInfo: () => Promise<unknown> } = {
    getInfo: async () => ({ version: '1.2', build: '6' }),
  }
  /** Le proprietà lette sul proxy del plugin, in ordine: il test guarda che `then` non ci sia. */
  const letture: string[] = []
  /** I rifiuti «not implemented» del bridge, in ordine (la prova che `then` è stato chiamato). */
  const rifiutiBridge: string[] = []
  const banco: { silenziaRifiuti: boolean; addListenerRifiuta: string | undefined } = {
    silenziaRifiuti: false,
    addListenerRifiuta: undefined,
  }
  /** I nomi passati a `registerPlugin`: il bridge avvisa se lo stesso nome si registra due volte. */
  const registrazioni: string[] = []
  /** I metodi che il plugin nativo dichiara (l'equivalente del `PluginHeader`). */
  const metodi: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  const ascoltatori = new Map<string, Set<(dati: unknown) => void>>()
  const rimossi: string[] = []

  /** L'errore del bridge: un `Error` con le proprietà del JSON nativo copiate sopra (`code`, `message`). */
  class ErroreDelPonte extends Error {
    code?: string
    constructor(messaggio: string, code?: string) {
      super(messaggio)
      if (code !== undefined) this.code = code
    }
  }

  function registerPluginFinto(nomePlugin: string): unknown {
    registrazioni.push(nomePlugin)
    const addListener = async (evento: unknown, fn: unknown) => {
      if (banco.addListenerRifiuta !== undefined) throw new ErroreDelPonte('Impossibile agganciare /private/var/Containers/Mario-Rossi-compleanno.mov', banco.addListenerRifiuta)
      const nome = String(evento)
      if (!ascoltatori.has(nome)) ascoltatori.set(nome, new Set())
      ascoltatori.get(nome)!.add(fn as (dati: unknown) => void)
      return {
        remove: async () => {
          rimossi.push(nome)
          ascoltatori.get(nome)?.delete(fn as (dati: unknown) => void)
        },
      }
    }
    const createPluginMethodWrapper = (prop: string | symbol) => {
      const wrapper = (...args: unknown[]) => {
        const dichiarato = typeof prop === 'string' ? metodi[prop] : undefined
        if (dichiarato) return dichiarato(...args)
        const errore = new ErroreDelPonte(
          `"${nomePlugin}.${String(prop)}()" is not implemented on ${piattaforma.valore}`,
          'UNIMPLEMENTED',
        )
        rifiutiBridge.push(errore.message)
        const rifiuto = Promise.reject(errore)
        // Marcarlo gestito evita solo che vitest lo conti come errore del banco, dove il rifiuto è
        // proprio ciò che si vuole vedere (il test «il finto è fedele»).
        if (banco.silenziaRifiuti) rifiuto.catch(() => undefined)
        return rifiuto
      }
      wrapper.toString = () => `${String(prop)}() { [capacitor code] }`
      return wrapper
    }
    return new Proxy(
      {},
      {
        get(_, prop) {
          letture.push(String(prop))
          switch (prop) {
            case '$$typeof':
              return undefined
            case 'toJSON':
              return () => ({})
            case 'addListener':
              return addListener
            case 'removeListener':
              return createPluginMethodWrapper('removeListener')
            default:
              return createPluginMethodWrapper(prop)
          }
        },
      },
    )
  }

  return {
    nativo,
    piattaforma,
    disponibili,
    intestazioni,
    app,
    letture,
    rifiutiBridge,
    banco,
    registrazioni,
    metodi,
    ascoltatori,
    rimossi,
    ErroreDelPonte,
    registerPluginFinto,
    logClient: vi.fn(),
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => h.nativo.valore,
    getPlatform: () => h.piattaforma.valore,
    isPluginAvailable: (nome: string) => h.disponibili.has(nome),
    get PluginHeaders() {
      if (h.intestazioni.rotto) throw new TypeError('PluginHeaders illeggibile')
      return h.intestazioni.valore
    },
  },
  registerPlugin: (nome: string) => h.registerPluginFinto(nome),
}))

// `App` è un proxy fedele anche lui: chi lo facesse passare da una promise lo vedrebbe appeso.
vi.mock('@capacitor/app', () => ({
  App: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'getInfo') return () => h.app.getInfo()
        return () => new Promise(() => {})
      },
    },
  ),
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

// `confrontaVersioni` viene da qui: la lettura dei profili che il pop-up chiede non serve a questi test.
vi.mock('@/lib/auth/use-profili', () => ({ leggiProfili: vi.fn(async () => null) }))

type Modulo = typeof import('@/lib/native/caricamenti-nativi')
const carica = (): Promise<Modulo> => import('@/lib/native/caricamenti-nativi')

/* ─── fixture ─────────────────────────────────────────────────────────────── */

const INFO_IOS = { protocollo: PROTOCOLLO_CARICAMENTI, piattaforma: 'ios', motore: 'urlsession' }
const INFO_ANDROID = { protocollo: PROTOCOLLO_CARICAMENTI, piattaforma: 'android', motore: 'uidt' }

const UUID_JOB = '3f1c2b7e-8a4d-4c1e-9b52-6d0f7a1e2c34'
const UUID_INTENTO = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const UUID_UTENTE = '11111111-2222-4333-8444-555555555555'
const UUID_SEDE = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const SHA = 'ab'.repeat(32)

function caricamento(extra: Record<string, unknown> = {}) {
  return {
    jobId: UUID_JOB,
    intentId: UUID_INTENTO,
    utenteId: UUID_UTENTE,
    scuolaId: UUID_SEDE,
    nome: 'video-di-prova.mov',
    mime: 'video/quicktime',
    stato: 'in-invio',
    byteInviati: 1000,
    byteTotali: 5000,
    tentativi: 0,
    rinnovi: 0,
    codice: null,
    creatoIl: '2026-10-03T08:00:00.000Z',
    aggiornatoIl: '2026-10-03T08:00:05.000Z',
    ...extra,
  }
}

const OPZIONI_SCELTA = {
  sorgente: 'galleria',
  massimoElementi: 50,
  latoMassimoFoto: 1920,
  qualitaFoto: 0.85,
  byteMassimiVideo: 2_000_000_000,
  durataMassimaVideoSecondi: 300,
} as const

const RICHIESTA_ACCODA = {
  idElemento: 'e1',
  sha256: SHA,
  byteAttesi: 5000,
  jobId: UUID_JOB,
  intentId: UUID_INTENTO,
  utenteId: UUID_UTENTE,
  scuolaId: UUID_SEDE,
  caricamento: { url: 'https://progetto.supabase.co/storage/v1/object/upload/sign/b/p?token=t', contentType: 'video/quicktime', scadeIl: '2026-10-03T10:00:00.000Z' },
  // La forma del token del server (`kvr_` + 43 caratteri base64url): qui è una stringa palesemente finta.
  rinnovo: { url: 'https://app.kidville.it/api/video-uploads/rinnovo', token: `kvr_${'x'.repeat(43)}`, scadeIl: '2026-10-05T08:00:00.000Z' },
  registro: { url: 'https://app.kidville.it/api/logs' },
  testi: { titolo: 'Kidville', invio: 'Invio dei video in corso', attesaRete: 'In attesa di rete', pausa: 'Invio in pausa' },
}

/** L'intestazione che il nativo costruirebbe: i metodi del nostro plugin e quelli del bridge. */
function intestazioniCon(metodi: readonly string[]) {
  return [
    { name: 'App', methods: [{ name: 'getInfo', rtype: 'promise' }] },
    {
      name: NOME_PLUGIN_CARICAMENTI,
      methods: [...metodi, 'addListener', 'removeListener', 'removeAllListeners'].map((name) => ({ name, rtype: 'promise' })),
    },
  ]
}

/** Il rifiuto del ponte com'è: un `Error` col `code` messo dal nativo e il messaggio del sistema. */
const rifiuto = (code: string | undefined, messaggio = TESTO_DEL_PONTE) => new h.ErroreDelPonte(messaggio, code)

/* ─── lettura dei log ─────────────────────────────────────────────────────── */

type Riga = { livello: string; evento: string; messaggio: string; campi?: Record<string, unknown> }
const righe = () => h.logClient.mock.calls.map(([e]) => e as Riga)
const messaggi = () => righe().map((r) => r.messaggio)

/** Molto oltre il tempo reale di queste chiamate (microtask), molto sotto il timeout di vitest. */
const ATTESA_MAX_MS = 1_000
const SCADUTA = Symbol('scaduta')
function entro<T>(p: Promise<T>): Promise<T | typeof SCADUTA> {
  return Promise.race([p, new Promise<typeof SCADUTA>((r) => setTimeout(() => r(SCADUTA), ATTESA_MAX_MS))])
}

beforeEach(() => {
  vi.resetModules()
  h.nativo.valore = true
  h.piattaforma.valore = 'ios'
  h.disponibili.clear()
  h.disponibili.add(NOME_PLUGIN_CARICAMENTI)
  h.disponibili.add('App')
  h.intestazioni.valore = intestazioniCon(METODI_PLUGIN_CARICAMENTI)
  h.intestazioni.rotto = false
  h.app.getInfo = async () => ({ version: '1.2', build: '6' })
  h.letture.length = 0
  h.rifiutiBridge.length = 0
  h.banco.silenziaRifiuti = false
  h.banco.addListenerRifiuta = undefined
  h.registrazioni.length = 0
  for (const nome of Object.keys(h.metodi)) delete h.metodi[nome]
  h.metodi.info = async () => INFO_IOS
  h.ascoltatori.clear()
  h.rimossi.length = 0
  h.logClient.mockReset()
  delete process.env.NEXT_PUBLIC_CARICAMENTI_NATIVI
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Il banco
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('il finto è fedele a Capacitor (controllo del banco)', () => {
  it('una promise che si risolve CON il proxy non si chiude mai, e il bridge rifiuta `then`', async () => {
    // Se questo controllo cadesse, i test qui sotto sarebbero verdi anche con la funzione async che
    // restituisce il plugin.
    h.banco.silenziaRifiuti = true
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin('KidvilleCaricamenti')
    const esito = await entro(Promise.resolve().then(() => plugin))
    expect(esito).toBe(SCADUTA)
    expect(h.letture).toContain('then')
    expect(h.rifiutiBridge).toEqual(['"KidvilleCaricamenti.then()" is not implemented on ios'])
  })

  it('il nome del plugin è quello che il nativo registra', () => {
    expect(NOME_PLUGIN_CARICAMENTI).toBe('KidvilleCaricamenti')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * La rilevazione
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('caricamentiNativiDisponibili — dove il plugin NON c\'è (il caso normale)', () => {
  it('sul web: null, senza toccare il bridge e senza una riga di log', async () => {
    h.nativo.valore = false
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(h.registrazioni).toEqual([])
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it.each(['1.0', '1.1', '1.1.9', '0.9'])(
    'app %s (senza plugin): null e NESSUNA riga di log — è il caso normale',
    async (versione) => {
      h.disponibili.delete(NOME_PLUGIN_CARICAMENTI)
      h.app.getInfo = async () => ({ version: versione, build: '5' })
      const { caricamentiNativiDisponibili } = await carica()
      expect(await caricamentiNativiDisponibili()).toBeNull()
      expect(h.logClient).not.toHaveBeenCalled()
      // Il plugin non si registra e non si chiama: sulla 1.1 non c'è niente da interrogare.
      expect(h.registrazioni).toEqual([])
    },
  )

  it('app senza plugin e con la versione illeggibile (rifiuta, appesa, forma strana): null e nessuna riga', async () => {
    h.disponibili.delete(NOME_PLUGIN_CARICAMENTI)
    for (const getInfo of [
      async () => {
        throw new Error('getInfo')
      },
      async () => ({ version: 'Mario Rossi', build: '5' }),
      async () => ({}),
      async () => null,
    ]) {
      vi.resetModules()
      h.app.getInfo = getInfo
      const { caricamentiNativiDisponibili } = await carica()
      expect(await caricamentiNativiDisponibili()).toBeNull()
    }
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('app senza plugin e senza nemmeno `App`: null e nessuna riga', async () => {
    h.disponibili.clear()
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('la versione del binario che non risponde in tempo vale «non si sa»: null, nessuna riga', async () => {
    h.disponibili.delete(NOME_PLUGIN_CARICAMENTI)
    h.app.getInfo = () => new Promise(() => {})
    const { caricamentiNativiDisponibili, TIMEOUT_INFO_MS } = await carica()
    await import('@capacitor/app')
    vi.useFakeTimers()
    const esito = caricamentiNativiDisponibili()
    await vi.advanceTimersByTimeAsync(TIMEOUT_INFO_MS)
    expect(await esito).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

describe('caricamentiNativiDisponibili — un binario ≥ 1.2 senza il plugin è un difetto di build', () => {
  it.each(['1.2', '1.3', '1.10', '2.0', '1.2.1'])('app %s senza plugin: null + UNA riga error «plugin-assente»', async (versione) => {
    h.disponibili.delete(NOME_PLUGIN_CARICAMENTI)
    h.app.getInfo = async () => ({ version: versione, build: '6' })
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()).toEqual([
      { livello: 'error', evento: 'caricamento-nativo', messaggio: 'caricamenti-nativi-incompleti: plugin-assente' },
    ])
  })
})

describe('caricamentiNativiDisponibili — l\'interruttore d\'emergenza NEXT_PUBLIC_CARICAMENTI_NATIVI', () => {
  it('«0»: null, una riga warn «spenti», il plugin non si registra né si chiama', async () => {
    vi.stubEnv('NEXT_PUBLIC_CARICAMENTI_NATIVI', '0')
    const info = vi.fn(async () => INFO_IOS)
    h.metodi.info = info
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()).toEqual([{ livello: 'warn', evento: 'caricamento-nativo', messaggio: 'caricamenti-nativi-spenti' }])
    expect(info).not.toHaveBeenCalled()
    expect(h.registrazioni).toEqual([])
  })

  it.each([' 0', '0 ', ' 0\n'])('un valore con spazi attorno (%j) vale «0»: le variabili incollate su Vercel arrivano così', async (valore) => {
    vi.stubEnv('NEXT_PUBLIC_CARICAMENTI_NATIVI', valore)
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(messaggi()).toEqual(['caricamenti-nativi-spenti'])
  })

  it.each(['1', 'true', 'false', 'off', '00', 'no', ''])(
    'qualunque valore diverso da «0» (%j) lascia ACCESO',
    async (valore) => {
      vi.stubEnv('NEXT_PUBLIC_CARICAMENTI_NATIVI', valore)
      const { caricamentiNativiDisponibili } = await carica()
      expect(await caricamentiNativiDisponibili()).toEqual(INFO_IOS)
      expect(messaggi()).toEqual(['caricamenti-nativi-disponibili: ios 1.2 urlsession'])
    },
  )

  it('assente = acceso', async () => {
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toEqual(INFO_IOS)
  })

  it('spento su una 1.1 (il plugin non c\'è): nessuna riga — non c\'è niente da spegnere', async () => {
    vi.stubEnv('NEXT_PUBLIC_CARICAMENTI_NATIVI', '0')
    h.disponibili.delete(NOME_PLUGIN_CARICAMENTI)
    h.app.getInfo = async () => ({ version: '1.1', build: '5' })
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('spento sul web: nessuna riga e il bridge non si tocca', async () => {
    vi.stubEnv('NEXT_PUBLIC_CARICAMENTI_NATIVI', '0')
    h.nativo.valore = false
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

describe('caricamentiNativiDisponibili — l\'intestazione del plugin (Capacitor.PluginHeaders)', () => {
  it.each(METODI_PLUGIN_CARICAMENTI)('manca «%s»: null + error «metodi-mancanti», e info() non si chiama', async (mancante) => {
    h.intestazioni.valore = intestazioniCon(METODI_PLUGIN_CARICAMENTI.filter((m) => m !== mancante))
    const info = vi.fn(async () => INFO_IOS)
    h.metodi.info = info
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()).toEqual([
      {
        livello: 'error',
        evento: 'caricamento-nativo',
        messaggio: 'caricamenti-nativi-incompleti: metodi-mancanti',
        campi: { metodi_mancanti: 1 },
      },
    ])
    expect(info).not.toHaveBeenCalled()
    expect(h.registrazioni).toEqual([])
  })

  it('un metodo in PIÙ (creaElementoDiProva, solo nelle build Debug) non è un difetto', async () => {
    h.intestazioni.valore = intestazioniCon([...METODI_PLUGIN_CARICAMENTI, 'creaElementoDiProva'])
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toEqual(INFO_IOS)
  })

  it.each([
    ['assente', undefined],
    ['null', null],
    ['una stringa', 'x'],
    ['un oggetto', {}],
    ['un elenco vuoto', []],
    ['solo le intestazioni di altri plugin', [{ name: 'App', methods: [{ name: 'getInfo' }] }]],
    ['`methods` che non è un elenco', [{ name: NOME_PLUGIN_CARICAMENTI, methods: 'no' }]],
    ['`methods` con voci senza nome', [{ name: NOME_PLUGIN_CARICAMENTI, methods: [{}] }]],
    ['voci che non sono oggetti', [null, 4, 'x']],
  ])('intestazione illeggibile (%s): null + error «intestazione-illeggibile»', async (_nome, valore) => {
    h.intestazioni.valore = valore
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: intestazione-illeggibile'])
  })

  it('l\'intestazione MALFORMATA di un altro plugin non rompe la nostra: si guarda solo la sua', async () => {
    h.intestazioni.valore = [
      { name: 'Altro', methods: 'rotto' },
      null,
      ...intestazioniCon(METODI_PLUGIN_CARICAMENTI),
    ]
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toEqual(INFO_IOS)
  })

  it('un getter che LANCIA su PluginHeaders vale «incompleto», non un\'eccezione', async () => {
    h.intestazioni.rotto = true
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: intestazione-illeggibile'])
  })

  it('su un binario che dichiara di essere 1.0/1.1 un plugin rotto non scrive niente: il gate è «binario ≥ 1.2»', async () => {
    h.intestazioni.valore = []
    h.app.getInfo = async () => ({ version: '1.1', build: '5' })
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it.each([
    ['rifiuta', async () => { throw new Error('getInfo') }],
    ['porta un testo che non è una versione', async () => ({ version: 'Mario Rossi', build: '6' })],
    ['non risponde', () => new Promise(() => {})],
  ])('col plugin PRESENTE e la versione che %s il difetto si scrive lo stesso: il plugin ce l\'hanno solo i nostri binari', async (_nome, getInfo) => {
    // Sul plugin ASSENTE la versione illeggibile tace (l'assenza è quasi sempre la normalità); sul plugin
    // PRESENTE ma rotto non c'è niente da distinguere, e tacere sarebbe un difetto che nessuno vede mai.
    h.intestazioni.valore = intestazioniCon(METODI_PLUGIN_CARICAMENTI.filter((m) => m !== 'dimentica'))
    h.app.getInfo = getInfo as () => Promise<unknown>
    const { caricamentiNativiDisponibili, TIMEOUT_INFO_MS } = await carica()
    await import('@capacitor/app')
    vi.useFakeTimers()
    const esito = caricamentiNativiDisponibili()
    await vi.advanceTimersByTimeAsync(TIMEOUT_INFO_MS)
    expect(await esito).toBeNull()
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: metodi-mancanti'])
  })
})

describe('caricamentiNativiDisponibili — info()', () => {
  it.each([
    ['ios', INFO_IOS, 'urlsession'],
    ['android', INFO_ANDROID, 'uidt'],
    ['android', { ...INFO_ANDROID, motore: 'workmanager' }, 'workmanager'],
  ])('risposta valida su %s: le info e UNA riga warn «disponibili» con piattaforma, versione, motore (%s)', async (piattaforma, info, motore) => {
    h.metodi.info = async () => info
    h.app.getInfo = async () => ({ version: '1.2', build: '6' })
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toEqual(info)
    expect(righe()).toEqual([
      {
        livello: 'warn',
        evento: 'caricamento-nativo',
        messaggio: `caricamenti-nativi-disponibili: ${piattaforma} 1.2 ${motore}`,
      },
    ])
  })

  it('la versione sta nel MESSAGGIO (lezione della #175: l\'impronta di app_log non vede i campi)', async () => {
    h.app.getInfo = async () => ({ version: '1.3', build: '9' })
    const { caricamentiNativiDisponibili } = await carica()
    await caricamentiNativiDisponibili()
    expect(messaggi()).toEqual(['caricamenti-nativi-disponibili: ios 1.3 urlsession'])
  })

  it.each([
    ['rifiuta', async () => { throw new Error('getInfo') }],
    ['risponde senza `version`', async () => ({ build: '6' })],
    ['porta un testo che non è una versione', async () => ({ version: 'Mario Rossi 1.2', build: '6' })],
  ])('con la versione che %s il successo si scrive lo stesso, con «n-d» al posto del numero', async (_nome, getInfo) => {
    h.app.getInfo = getInfo
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toEqual(INFO_IOS)
    expect(messaggi()).toEqual(['caricamenti-nativi-disponibili: ios n-d urlsession'])
  })

  it('rifiutata dal ponte: null + error «info-rifiutata» col SOLO codice, mai il messaggio', async () => {
    h.metodi.info = async () => { throw rifiuto('INTERNO') }
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()).toEqual([
      {
        livello: 'error',
        evento: 'caricamento-nativo',
        messaggio: 'caricamenti-nativi-incompleti: info-rifiutata',
        campi: { error_code: 'INTERNO' },
      },
    ])
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Mario')
  })

  it('rifiutata con un codice che non conosciamo: «SCONOSCIUTO»', async () => {
    h.metodi.info = async () => { throw rifiuto('QUALCOSA_DI_NUOVO') }
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()[0].campi).toEqual({ error_code: 'SCONOSCIUTO' })
  })

  it('che non risponde entro TIMEOUT_INFO_MS: null + error «info-timeout» (e non un secondo prima)', async () => {
    h.metodi.info = () => new Promise(() => {})
    const { caricamentiNativiDisponibili, TIMEOUT_INFO_MS } = await carica()
    expect(TIMEOUT_INFO_MS).toBe(3000)
    await import('@capacitor/app')
    vi.useFakeTimers()
    const esito = caricamentiNativiDisponibili()
    await vi.advanceTimersByTimeAsync(TIMEOUT_INFO_MS - 1)
    expect(h.logClient).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await esito).toBeNull()
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: info-timeout'])
  })

  it('info() e la lettura della versione corrono INSIEME: il caso peggiore dura un tetto, non due in fila', async () => {
    // La Galleria non disegna l'area di scelta finché la rilevazione non risponde: con le due attese una
    // dopo l'altra il telefono più lento aspetterebbe il doppio. I timer sono finti, quindi se tornassero
    // in fila la promise non sarebbe ancora risolta dopo UN tetto (il secondo timer non è partito).
    h.metodi.info = () => new Promise(() => {})
    h.app.getInfo = () => new Promise(() => {})
    const { caricamentiNativiDisponibili, TIMEOUT_INFO_MS } = await carica()
    await import('@capacitor/app')
    vi.useFakeTimers()
    let risolta = false
    const esito = caricamentiNativiDisponibili().then((valore) => {
      risolta = true
      return valore
    })
    await vi.advanceTimersByTimeAsync(TIMEOUT_INFO_MS)
    expect(risolta, 'la rilevazione deve rispondere dopo UN tetto').toBe(true)
    expect(await esito).toBeNull()
    // Il plugin c'è e `info()` tace: è un difetto anche se la versione non si è letta.
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: info-timeout'])
  })

  it('con info() pronta e la versione che non risponde il successo si scrive dopo UN tetto, con «n-d»', async () => {
    h.app.getInfo = () => new Promise(() => {})
    const { caricamentiNativiDisponibili, TIMEOUT_INFO_MS } = await carica()
    await import('@capacitor/app')
    vi.useFakeTimers()
    const esito = caricamentiNativiDisponibili()
    await vi.advanceTimersByTimeAsync(TIMEOUT_INFO_MS)
    expect(await esito).toEqual(INFO_IOS)
    expect(messaggi()).toEqual(['caricamenti-nativi-disponibili: ios n-d urlsession'])
  })

  it.each([
    ['senza motore', { protocollo: PROTOCOLLO_CARICAMENTI, piattaforma: 'ios' }],
    ['senza piattaforma', { protocollo: PROTOCOLLO_CARICAMENTI, motore: 'urlsession' }],
    ['piattaforma che non esiste', { ...INFO_IOS, piattaforma: 'web' }],
    ['motore che non esiste', { ...INFO_IOS, motore: 'cron' }],
    ['protocollo che non è un numero', { ...INFO_IOS, protocollo: '1' }],
    ['null', null],
    ['una stringa', 'ciao'],
    ['un elenco', []],
  ])('risposta fuori forma (%s): null + error «info-fuori-forma»', async (_nome, risposta) => {
    h.metodi.info = async () => risposta
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: info-fuori-forma'])
  })

  it('protocollo di un\'altra versione: null + error «protocollo-diverso» col numero trovato', async () => {
    h.metodi.info = async () => ({ ...INFO_IOS, protocollo: PROTOCOLLO_CARICAMENTI + 1 })
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()).toEqual([
      {
        livello: 'error',
        evento: 'caricamento-nativo',
        messaggio: 'caricamenti-nativi-incompleti: protocollo-diverso',
        campi: { protocollo: PROTOCOLLO_CARICAMENTI + 1 },
      },
    ])
  })

  it('un guasto di `info` su un binario che dichiara di essere 1.1 non scrive niente (gate «binario ≥ 1.2»)', async () => {
    h.app.getInfo = async () => ({ version: '1.1', build: '5' })
    h.metodi.info = async () => { throw rifiuto('INTERNO') }
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

describe('caricamentiNativiDisponibili — un\'eccezione che nessun ramo ha previsto', () => {
  it('non esce: null + error «errore-imprevisto» col NOME della classe, sempre (senza il gate della versione)', async () => {
    h.disponibili.clear()
    h.disponibili.add(NOME_PLUGIN_CARICAMENTI)
    // Una `Capacitor.isPluginAvailable` che lancia sull'app nativa è un bridge rotto: non è l'assenza
    // normale del plugin, e non si nasconde dietro la versione.
    const { Capacitor } = await import('@capacitor/core')
    const originale = Capacitor.isPluginAvailable
    Capacitor.isPluginAvailable = () => {
      throw new TypeError('bridge rotto')
    }
    try {
      const { caricamentiNativiDisponibili } = await carica()
      expect(await caricamentiNativiDisponibili()).toBeNull()
      expect(righe()).toEqual([
        {
          livello: 'error',
          evento: 'caricamento-nativo',
          messaggio: 'caricamenti-nativi-incompleti: errore-imprevisto',
          campi: { error_code: 'TypeError' },
        },
      ])
    } finally {
      Capacitor.isPluginAvailable = originale
    }
  })
})

describe('caricamentiNativiDisponibili — una volta per sessione', () => {
  it('chiamata più volte (anche insieme) restituisce la STESSA promise: una info(), una riga', async () => {
    const info = vi.fn(async () => INFO_IOS)
    h.metodi.info = info
    const { caricamentiNativiDisponibili } = await carica()
    const a = caricamentiNativiDisponibili()
    const b = caricamentiNativiDisponibili()
    expect(b).toBe(a)
    const [x, y] = await Promise.all([a, b])
    expect(x).toBe(y)
    await caricamentiNativiDisponibili()
    expect(info).toHaveBeenCalledTimes(1)
    expect(messaggi()).toEqual(['caricamenti-nativi-disponibili: ios 1.2 urlsession'])
    expect(h.registrazioni).toEqual([NOME_PLUGIN_CARICAMENTI])
  })

  it('anche il «no» si ricorda: un fallimento non riprova a ogni chiamata e non scrive due volte', async () => {
    h.metodi.info = async () => { throw rifiuto('INTERNO') }
    const { caricamentiNativiDisponibili } = await carica()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(await caricamentiNativiDisponibili()).toBeNull()
    expect(righe()).toHaveLength(1)
  })

  it('il plugin si registra UNA volta sola, anche dopo le chiamate tipizzate', async () => {
    h.metodi.annullaScelta = async () => ({ annullata: true })
    const { caricamentiNativiDisponibili, annullaScelta } = await carica()
    await caricamentiNativiDisponibili()
    await annullaScelta()
    await annullaScelta()
    expect(h.registrazioni).toEqual([NOME_PLUGIN_CARICAMENTI])
  })
})

describe('il plugin è un PROXY: non passa mai da una risoluzione di promise', () => {
  it('la rilevazione arriva in fondo, e `then` non si legge mai sul plugin', async () => {
    const { caricamentiNativiDisponibili } = await carica()
    expect(await entro(caricamentiNativiDisponibili())).toEqual(INFO_IOS)
    expect(h.letture).toContain('info')
    expect(h.letture).not.toContain('then')
    expect(h.rifiutiBridge).toEqual([])
  })

  it('anche con ogni chiamata tipizzata e gli eventi: `then` non si legge mai', async () => {
    h.metodi.scegliMedia = async () => ({ annullato: true, elementi: [] })
    h.metodi.annullaScelta = async () => ({ annullata: false })
    h.metodi.scartaScelti = async () => ({ eliminati: 0 })
    h.metodi.elenco = async () => ({ caricamenti: [] })
    h.metodi.annulla = async () => ({ annullato: true })
    h.metodi.dimentica = async () => ({ dimenticati: 0 })
    const m = await carica()
    expect(await entro(m.scegliMedia(OPZIONI_SCELTA))).toEqual({ annullato: true, elementi: [] })
    expect(await entro(m.annullaScelta())).toEqual({ annullata: false })
    expect(await entro(m.scartaScelti({ ids: ['a'] }))).toEqual({ eliminati: 0 })
    expect(await entro(m.elenco({ utenteId: UUID_UTENTE }))).toEqual({ caricamenti: [] })
    expect(await entro(m.annulla({ jobId: UUID_JOB }))).toEqual({ annullato: true })
    expect(await entro(m.dimentica({ jobIds: [UUID_JOB] }))).toEqual({ dimenticati: 0 })
    const rimuovi = await entro(m.ascoltaCaricamenti(() => undefined))
    expect(typeof rimuovi).toBe('function')
    expect(h.letture).not.toContain('then')
    expect(h.rifiutiBridge).toEqual([])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Le chiamate tipizzate
 * ═══════════════════════════════════════════════════════════════════════════ */

type Caso = {
  nome: string
  metodo: string
  chiama: (m: Modulo) => Promise<unknown>
  argomento: unknown
  valida: unknown
  fuoriForma: unknown
}

const FOTO = { id: 'f1', tipo: 'foto', nome: 'IMG_0001.jpg', larghezza: 1920, altezza: 1080, byte: 400_000 }
const VIDEO = {
  id: 'v1',
  tipo: 'video',
  nome: 'video-di-prova.mov',
  byte: 5000,
  mime: 'video/quicktime',
  durataSecondi: 12.5,
  miniatura: 'data:image/jpeg;base64,/9j/4AAQ',
  sha256: SHA,
}
const RIFIUTATO = { id: 'r1', tipo: 'rifiutato', nome: 'enorme.mov', origine: 'video', motivo: 'troppo-grande' }

const CASI: Caso[] = [
  {
    nome: 'scegliMedia',
    metodo: 'scegliMedia',
    chiama: (m) => m.scegliMedia(OPZIONI_SCELTA),
    argomento: OPZIONI_SCELTA,
    valida: { annullato: false, elementi: [FOTO, VIDEO, RIFIUTATO] },
    fuoriForma: { annullato: false, elementi: [{ ...VIDEO, sha256: 'non-esadecimale' }] },
  },
  {
    nome: 'annullaScelta',
    metodo: 'annullaScelta',
    chiama: (m) => m.annullaScelta(),
    argomento: undefined,
    valida: { annullata: true },
    fuoriForma: { annullata: 'si' },
  },
  {
    nome: 'leggiFoto',
    metodo: 'leggiFoto',
    chiama: (m) => m.leggiFoto({ id: 'f1' }),
    argomento: { id: 'f1' },
    valida: { base64: '/9j/4AAQ', mime: 'image/jpeg', byte: 6, larghezza: 1920, altezza: 1080 },
    fuoriForma: { base64: 42, mime: 'image/jpeg', byte: 6, larghezza: 1920, altezza: 1080 },
  },
  {
    nome: 'scartaScelti',
    metodo: 'scartaScelti',
    chiama: (m) => m.scartaScelti({ ids: ['f1', 'v1'] }),
    argomento: { ids: ['f1', 'v1'] },
    valida: { eliminati: 2 },
    fuoriForma: { eliminati: -1 },
  },
  {
    nome: 'accodaVideo',
    metodo: 'accodaVideo',
    chiama: (m) => m.accodaVideo(RICHIESTA_ACCODA),
    argomento: RICHIESTA_ACCODA,
    valida: caricamento({ stato: 'in-coda', byteInviati: 0 }),
    fuoriForma: caricamento({ stato: 'volando' }),
  },
  {
    nome: 'elenco',
    metodo: 'elenco',
    chiama: (m) => m.elenco({ utenteId: UUID_UTENTE }),
    argomento: { utenteId: UUID_UTENTE },
    valida: { caricamenti: [caricamento(), caricamento({ stato: 'inviato' })] },
    fuoriForma: { caricamenti: [{ jobId: UUID_JOB }] },
  },
  {
    nome: 'annulla',
    metodo: 'annulla',
    chiama: (m) => m.annulla({ jobId: UUID_JOB }),
    argomento: { jobId: UUID_JOB },
    valida: { annullato: true },
    fuoriForma: { annullato: 'si' },
  },
  {
    nome: 'dimentica',
    metodo: 'dimentica',
    chiama: (m) => m.dimentica({ jobIds: [UUID_JOB] }),
    argomento: { jobIds: [UUID_JOB] },
    valida: { dimenticati: 1 },
    fuoriForma: { dimenticati: 'uno' },
  },
]

describe('le chiamate tipizzate — argomenti intatti, risposta riletta', () => {
  it.each(CASI)('$nome passa gli argomenti al plugin com\'è e restituisce la risposta valida', async (caso) => {
    const metodo = vi.fn(async () => caso.valida)
    h.metodi[caso.metodo] = metodo
    const m = await carica()
    expect(await caso.chiama(m)).toEqual(caso.valida)
    expect(metodo).toHaveBeenCalledTimes(1)
    if (caso.argomento === undefined) expect(metodo.mock.calls[0]).toEqual([])
    else expect(metodo.mock.calls[0]).toEqual([caso.argomento])
  })

  it.each(CASI)('$nome: una risposta FUORI FORMA è RISPOSTA_NON_VALIDA, mai un oggetto a metà', async (caso) => {
    h.metodi[caso.metodo] = async () => caso.fuoriForma
    const m = await carica()
    await expect(caso.chiama(m)).rejects.toMatchObject({ name: 'ErroreCaricamentiNativi', codice: 'RISPOSTA_NON_VALIDA' })
  })

  it.each(CASI)('$nome: una risposta che non è nemmeno un oggetto (null, testo) è RISPOSTA_NON_VALIDA', async (caso) => {
    const m = await carica()
    for (const risposta of [null, undefined, 'ok', 42]) {
      h.metodi[caso.metodo] = async () => risposta
      await expect(caso.chiama(m)).rejects.toMatchObject({ codice: 'RISPOSTA_NON_VALIDA' })
    }
  })

  it('la risposta che torna è quella RILETTA, non l\'oggetto del ponte (i campi che nessuno ha dichiarato non passano)', async () => {
    h.metodi.annullaScelta = async () => ({ annullata: true, percorso: '/private/var/Containers/x.mov' })
    const m = await carica()
    expect(await m.annullaScelta()).toEqual({ annullata: true })
  })
})

/**
 * Le richieste che il plugin non deve MAI vedere: ognuna rompe UNA regola dello schema della
 * richiesta (S1). La più pericolosa è la prima: `selectionLimit = 0` di PHPicker vale «senza limite»,
 * quindi un `massimoElementi` a zero spalancherebbe la scelta invece di chiuderla.
 */
const RICHIESTE_NON_VALIDE: { nome: string; metodo: string; chiama: (m: Modulo) => Promise<unknown> }[] = [
  { nome: 'scegliMedia con zero posti (PHPicker lo leggerebbe «senza limite»)', metodo: 'scegliMedia', chiama: (m) => m.scegliMedia({ ...OPZIONI_SCELTA, massimoElementi: 0 }) },
  { nome: 'scegliMedia da una sorgente che non esiste', metodo: 'scegliMedia', chiama: (m) => m.scegliMedia({ ...OPZIONI_SCELTA, sorgente: 'cloud' as never }) },
  { nome: 'scegliMedia con un peso oltre il tetto del video', metodo: 'scegliMedia', chiama: (m) => m.scegliMedia({ ...OPZIONI_SCELTA, byteMassimiVideo: OPZIONI_SCELTA.byteMassimiVideo + 1 }) },
  { nome: 'scegliMedia con una durata oltre il tetto', metodo: 'scegliMedia', chiama: (m) => m.scegliMedia({ ...OPZIONI_SCELTA, durataMassimaVideoSecondi: OPZIONI_SCELTA.durataMassimaVideoSecondi + 1 }) },
  { nome: 'scegliMedia con la qualità a zero', metodo: 'scegliMedia', chiama: (m) => m.scegliMedia({ ...OPZIONI_SCELTA, qualitaFoto: 0 }) },
  { nome: 'scegliMedia senza un campo', metodo: 'scegliMedia', chiama: (m) => m.scegliMedia({ sorgente: 'galleria', massimoElementi: 5 } as never) },
  { nome: 'leggiFoto con un id che esce dalla cartella', metodo: 'leggiFoto', chiama: (m) => m.leggiFoto({ id: '../../etc/passwd' }) },
  { nome: 'leggiFoto con un id vuoto', metodo: 'leggiFoto', chiama: (m) => m.leggiFoto({ id: '' }) },
  { nome: 'scartaScelti con un id con i separatori', metodo: 'scartaScelti', chiama: (m) => m.scartaScelti({ ids: ['a/b'] }) },
  { nome: 'accodaVideo con la PUT in chiaro (http)', metodo: 'accodaVideo', chiama: (m) => m.accodaVideo({ ...RICHIESTA_ACCODA, caricamento: { ...RICHIESTA_ACCODA.caricamento, url: 'http://progetto.supabase.co/storage/v1/object/upload/sign/b/p?token=t' } }) },
  { nome: 'accodaVideo con lo sha256 in maiuscolo', metodo: 'accodaVideo', chiama: (m) => m.accodaVideo({ ...RICHIESTA_ACCODA, sha256: SHA.toUpperCase() }) },
  { nome: 'accodaVideo con un token che non ha la forma del server', metodo: 'accodaVideo', chiama: (m) => m.accodaVideo({ ...RICHIESTA_ACCODA, rinnovo: { ...RICHIESTA_ACCODA.rinnovo, token: 'kvr_corto' } }) },
  { nome: 'accodaVideo con credenziali nell\'indirizzo del registro', metodo: 'accodaVideo', chiama: (m) => m.accodaVideo({ ...RICHIESTA_ACCODA, registro: { url: 'https://utente@app.kidville.it/api/logs' } }) },
  { nome: 'accodaVideo con un jobId che non è un uuid', metodo: 'accodaVideo', chiama: (m) => m.accodaVideo({ ...RICHIESTA_ACCODA, jobId: 'x' }) },
  { nome: 'accodaVideo con un testo di notifica vuoto', metodo: 'accodaVideo', chiama: (m) => m.accodaVideo({ ...RICHIESTA_ACCODA, testi: { ...RICHIESTA_ACCODA.testi, titolo: '' } }) },
  { nome: 'elenco con un utenteId che non è un uuid', metodo: 'elenco', chiama: (m) => m.elenco({ utenteId: 'NON-UN-UUID' }) },
  { nome: 'elenco con un uuid in maiuscolo (il nativo confronta stringhe)', metodo: 'elenco', chiama: (m) => m.elenco({ utenteId: UUID_JOB.toUpperCase() }) },
  { nome: 'annulla con un jobId che non è un uuid', metodo: 'annulla', chiama: (m) => m.annulla({ jobId: 'x' }) },
  { nome: 'dimentica con un elemento che non è un uuid', metodo: 'dimentica', chiama: (m) => m.dimentica({ jobIds: [UUID_JOB, 'x'] }) },
]

describe('le chiamate tipizzate — la RICHIESTA si rilegge prima di partire', () => {
  it.each(RICHIESTE_NON_VALIDE)('$nome: PARAMETRI_NON_VALIDI, e il plugin non vede niente', async (caso) => {
    const metodo = vi.fn(async () => ({}))
    h.metodi[caso.metodo] = metodo
    const m = await carica()
    await expect(caso.chiama(m)).rejects.toMatchObject({ name: 'ErroreCaricamentiNativi', codice: 'PARAMETRI_NON_VALIDI' })
    expect(metodo).not.toHaveBeenCalled()
  })

  it('al ponte arriva la forma RILETTA: un campo che nessuno ha dichiarato non parte', async () => {
    const scartaScelti = vi.fn(async () => ({ eliminati: 1 }))
    h.metodi.scartaScelti = scartaScelti
    const m = await carica()
    await m.scartaScelti({ ids: ['f1'], percorso: '/private/var/Containers/x.mov' } as never)
    expect(scartaScelti.mock.calls).toEqual([[{ ids: ['f1'] }]])
  })

  it('la forma Debug degli indirizzi di rinnovo e di registro (collaudo dell\'app vera) passa', async () => {
    const accodaVideo = vi.fn(async () => caricamento({ stato: 'in-coda', byteInviati: 0 }))
    h.metodi.accodaVideo = accodaVideo
    const m = await carica()
    const richiesta = {
      ...RICHIESTA_ACCODA,
      rinnovo: { ...RICHIESTA_ACCODA.rinnovo, url: 'http://10.0.2.2:3101/api/video-uploads/rinnovo' },
      registro: { url: 'http://localhost:3101/api/logs' },
    }
    await expect(m.accodaVideo(richiesta)).resolves.toMatchObject({ stato: 'in-coda' })
    expect(accodaVideo.mock.calls[0]).toEqual([richiesta])
  })
})

describe('le chiamate tipizzate — il rifiuto del ponte è un CODICE, mai il messaggio', () => {
  it.each(CODICI_DEL_PLUGIN)('«%s» arriva com\'è', async (codice) => {
    h.metodi.annullaScelta = async () => { throw rifiuto(codice) }
    const m = await carica()
    await expect(m.annullaScelta()).rejects.toMatchObject({ name: 'ErroreCaricamentiNativi', codice })
  })

  it.each(['UNIMPLEMENTED', 'UNAVAILABLE'])('«%s» (il binario non ha il metodo) vale NON_DISPONIBILE', async (codice) => {
    h.metodi.annullaScelta = async () => { throw rifiuto(codice) }
    const m = await carica()
    await expect(m.annullaScelta()).rejects.toMatchObject({ codice: 'NON_DISPONIBILE' })
  })

  it.each([
    ['un codice che non conosciamo', rifiuto('SPAZIO_FINITO')],
    ['un codice in minuscolo', rifiuto('interno')],
    ['nessun codice', rifiuto(undefined)],
    ['un codice che non è una stringa', Object.assign(new Error(TESTO_DEL_PONTE), { code: 7 })],
    ['una stringa', TESTO_DEL_PONTE],
    ['null', null],
    ['un oggetto senza codice', { message: TESTO_DEL_PONTE }],
    ['un getter che lancia', { get code(): string { throw new Error(TESTO_DEL_PONTE) } }],
  ])('%s vale SCONOSCIUTO', async (_nome, errore) => {
    h.metodi.annullaScelta = async () => { throw errore }
    const m = await carica()
    await expect(m.annullaScelta()).rejects.toMatchObject({ codice: 'SCONOSCIUTO' })
  })

  it('il messaggio del ponte non compare né nell\'errore né da nessun\'altra parte', async () => {
    h.metodi.leggiFoto = async () => { throw rifiuto('ELEMENTO_ASSENTE') }
    const m = await carica()
    let preso: unknown
    try {
      await m.leggiFoto({ id: 'f1' })
    } catch (e) {
      preso = e
    }
    expect(preso).toBeInstanceOf(Error)
    const errore = preso as Error
    expect(errore.message).toBe('ELEMENTO_ASSENTE')
    expect(String(errore)).not.toContain('Mario')
    expect(JSON.stringify(errore)).not.toContain('Mario')
    expect(errore.stack ?? '').not.toContain('Mario')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Mario')
  })

  it('codiceDelPonte legge anche un errore già tradotto e non lo cambia', async () => {
    const { codiceDelPonte, ErroreCaricamentiNativi } = await carica()
    expect(codiceDelPonte(new ErroreCaricamentiNativi('HOST_NON_AMMESSO'))).toBe('HOST_NON_AMMESSO')
    expect(codiceDelPonte(rifiuto('GIA_IN_CORSO'))).toBe('GIA_IN_CORSO')
  })

  it('CODICI_PONTE è l\'elenco chiuso: i sette del plugin più i tre dell\'involucro', async () => {
    const { CODICI_PONTE } = await carica()
    expect([...CODICI_PONTE]).toEqual([...CODICI_DEL_PLUGIN, 'NON_DISPONIBILE', 'RISPOSTA_NON_VALIDA', 'SCONOSCIUTO'])
  })
})

describe('le chiamate tipizzate — dove il plugin NON c\'è l\'involucro risponde «non disponibile»', () => {
  const SCENARI: [string, () => void][] = [
    ['sul web', () => { h.nativo.valore = false }],
    ['su un\'app 1.1 (il plugin non c\'è)', () => {
      h.disponibili.delete(NOME_PLUGIN_CARICAMENTI)
      h.app.getInfo = async () => ({ version: '1.1', build: '5' })
    }],
    ['con l\'interruttore spento', () => { vi.stubEnv('NEXT_PUBLIC_CARICAMENTI_NATIVI', '0') }],
    ['con un metodo che manca nell\'intestazione', () => {
      h.intestazioni.valore = intestazioniCon(METODI_PLUGIN_CARICAMENTI.filter((x) => x !== 'accodaVideo'))
    }],
    ['con un protocollo di un\'altra versione', () => {
      h.metodi.info = async () => ({ ...INFO_IOS, protocollo: PROTOCOLLO_CARICAMENTI + 1 })
    }],
  ]

  for (const [nome, prepara] of SCENARI) {
    it.each(CASI)(`${nome}: $nome risponde NON_DISPONIBILE e non tocca il plugin`, async (caso) => {
      prepara()
      const chiamato = vi.fn(async () => caso.valida)
      h.metodi[caso.metodo] = chiamato
      const m = await carica()
      await expect(caso.chiama(m)).rejects.toMatchObject({ name: 'ErroreCaricamentiNativi', codice: 'NON_DISPONIBILE' })
      expect(chiamato).not.toHaveBeenCalled()
    })
  }

  it.each(['ascoltaPreparazione', 'ascoltaCaricamenti'] as const)('%s risponde NON_DISPONIBILE sul web', async (nome) => {
    h.nativo.valore = false
    const m = await carica()
    await expect(m[nome](() => undefined)).rejects.toMatchObject({ codice: 'NON_DISPONIBILE' })
    expect(h.registrazioni).toEqual([])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Gli eventi
 * ═══════════════════════════════════════════════════════════════════════════ */

const emetti = (evento: string, dati: unknown) => {
  for (const fn of h.ascoltatori.get(evento) ?? []) fn(dati)
}

describe('gli eventi del plugin', () => {
  it('ascoltaCaricamenti: il payload valido arriva a callback, riletto', async () => {
    const m = await carica()
    const visti: unknown[] = []
    await m.ascoltaCaricamenti((c) => visti.push(c))
    emetti('caricamento', { ...caricamento({ stato: 'inviato' }), extra: 'non dichiarato' })
    expect(visti).toEqual([caricamento({ stato: 'inviato' })])
  })

  it('ascoltaPreparazione: il payload valido arriva a callback', async () => {
    const m = await carica()
    const visti: unknown[] = []
    await m.ascoltaPreparazione((p) => visti.push(p))
    emetti('preparazione', { fatti: 1, totali: 3, byteCopiati: 100, byteTotali: null })
    expect(visti).toEqual([{ fatti: 1, totali: 3, byteCopiati: 100, byteTotali: null }])
  })

  it('un payload fuori forma NON arriva a callback e lascia UNA riga warn per evento, non una per payload', async () => {
    const m = await carica()
    const visti: unknown[] = []
    await m.ascoltaCaricamenti((c) => visti.push(c))
    await m.ascoltaPreparazione((p) => visti.push(p))
    h.logClient.mockClear()
    for (let i = 0; i < 5; i++) emetti('caricamento', caricamento({ stato: 'volando' }))
    for (let i = 0; i < 5; i++) emetti('preparazione', { fatti: 'uno' })
    emetti('caricamento', null)
    expect(visti).toEqual([])
    expect(righe()).toEqual([
      { livello: 'warn', evento: 'caricamento-nativo', messaggio: 'evento-nativo-fuori-forma: caricamento' },
      { livello: 'warn', evento: 'caricamento-nativo', messaggio: 'evento-nativo-fuori-forma: preparazione' },
    ])
  })

  it('se il bridge rifiuta l\'ascolto: il CODICE, mai il messaggio', async () => {
    h.banco.addListenerRifiuta = 'INTERNO'
    const m = await carica()
    let preso: unknown
    try {
      await m.ascoltaCaricamenti(() => undefined)
    } catch (e) {
      preso = e
    }
    expect(preso).toMatchObject({ name: 'ErroreCaricamentiNativi', codice: 'INTERNO' })
    expect(String(preso)).not.toContain('Mario')
  })

  it('la funzione restituita toglie l\'ascolto', async () => {
    const m = await carica()
    const visti: unknown[] = []
    const togli = await m.ascoltaCaricamenti((c) => visti.push(c))
    expect(h.ascoltatori.get('caricamento')?.size).toBe(1)
    await togli()
    expect(h.rimossi).toEqual(['caricamento'])
    emetti('caricamento', caricamento())
    expect(visti).toEqual([])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Il sorgente
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('il sorgente del modulo', () => {
  const SORGENTE = fs.readFileSync(path.join(process.cwd(), 'src/lib/native/caricamenti-nativi.ts'), 'utf8')
  // Senza i commenti: un test che legge un file come TESTO legge anche la propria spiegazione.
  const CODICE = SORGENTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('legge l\'interruttore come `process.env.NEXT_PUBLIC_CARICAMENTI_NATIVI` LETTERALE (Next cuce nel bundle solo quella forma)', () => {
    expect(CODICE).toContain('process.env.NEXT_PUBLIC_CARICAMENTI_NATIVI')
    // Né per nome in una variabile né con la parentesi quadra né a pezzi.
    expect(CODICE).not.toMatch(/process\.env\s*\[/)
    expect(CODICE).not.toMatch(/const\s*\{[^}]*NEXT_PUBLIC_CARICAMENTI_NATIVI[^}]*\}\s*=\s*process\.env/)
    expect(CODICE.match(/NEXT_PUBLIC_CARICAMENTI_NATIVI/g)).toHaveLength(1)
  })

  it('il banco guarda il file giusto: il modulo registra il plugin col nome della costante', () => {
    expect(CODICE).toContain('registerPlugin<KidvilleCaricamentiPlugin>(NOME_PLUGIN_CARICAMENTI)')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Con il VERO @capacitor/core
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Il finto di sopra è scritto a mano leggendo `registerPlugin`; qui lo stesso codice gira contro la
 * libreria VERA, perché la lezione della #166 è proprio che un finto infedele è verde anche col difetto.
 * Si finge SOLO il trasporto nativo (`nativePromise` e `nativeCallback`, che il bridge di iOS e di
 * Android inietta nella pagina): il `Proxy` di `registerPlugin`, `isPluginAvailable` e la lettura di
 * `PluginHeaders` sono quelli di `node_modules`. È anche la prova che `PluginHeaders` — un'API INTERNA di
 * Capacitor — ha ancora la forma che la rilevazione si aspetta: se un aggiornamento la cambia, cade qui e
 * non sul telefono. L'intestazione è quella che il nativo costruisce davvero (`JSExport.swift`): i metodi
 * del bridge (`addListener` senza `rtype`, i permessi) più i nostri, tutti `promise`.
 *
 * ⚠️ L'ORDINE CONTA, e non è un vezzo. `@capacitor/core` è un modulo esterno: si carica UNA volta per
 * file, e `registeredPlugins` (dentro `createCapacitor`) ricorda il plugin appena lo si registra, dopo di
 * che `isPluginAvailable` risponde sì anche se l'intestazione sparisce. Perciò i casi che non registrano
 * mai niente («il plugin non c'è», «è incompleto») vanno PRIMA, e quello «completo» per ultimo.
 */
describe('con il VERO @capacitor/core (si finge solo il trasporto nativo)', () => {
  type ChiamataNativa = { plugin: string; metodo: string; opzioni: unknown }
  const chiamateNative: ChiamataNativa[] = []
  const risposteNative = new Map<string, (opzioni: unknown) => unknown>()
  type PaginaConBridge = { androidBridge?: unknown; Capacitor?: { PluginHeaders?: unknown } & Record<string, unknown> }
  const pagina = () => window as unknown as PaginaConBridge

  /** L'intestazione che costruisce `JSExport.swift`: il bridge più i metodi del plugin (`rtype: 'promise'`). */
  const intestazioneVera = (metodi: readonly string[]) => [
    { name: 'App', methods: [{ name: 'getInfo', rtype: 'promise' }] },
    {
      name: NOME_PLUGIN_CARICAMENTI,
      methods: [
        { name: 'addListener' },
        { name: 'removeListener' },
        { name: 'removeAllListeners', rtype: 'promise' },
        { name: 'checkPermissions', rtype: 'promise' },
        { name: 'requestPermissions', rtype: 'promise' },
        ...metodi.map((name) => ({ name, rtype: 'promise' })),
      ],
    },
  ]

  beforeAll(() => {
    // Da qui `@capacitor/core` e `@capacitor/app` sono quelli veri. Il trasporto nativo lo inietta il
    // bridge PRIMA che il core si carichi: `createCapacitor` riusa l'oggetto `window.Capacitor` che
    // trova, e questo test lo prepara.
    vi.doUnmock('@capacitor/core')
    vi.doUnmock('@capacitor/app')
    pagina().androidBridge = { postMessage: () => undefined }
    pagina().Capacitor = {
      PluginHeaders: [],
      nativePromise: (plugin: string, metodo: string, opzioni: unknown) => {
        chiamateNative.push({ plugin, metodo, opzioni })
        const risposta = risposteNative.get(`${plugin}.${metodo}`)
        if (!risposta) return Promise.reject(Object.assign(new Error('non implementato'), { code: 'UNIMPLEMENTED' }))
        try {
          return Promise.resolve(risposta(opzioni))
        } catch (e) {
          return Promise.reject(e)
        }
      },
      nativeCallback: (plugin: string, metodo: string, opzioni: unknown) => {
        chiamateNative.push({ plugin, metodo, opzioni })
        return 'id-callback'
      },
    }
  })

  afterAll(() => {
    delete pagina().androidBridge
    delete pagina().Capacitor
  })

  beforeEach(() => {
    chiamateNative.length = 0
    risposteNative.clear()
    risposteNative.set('App.getInfo', () => ({ version: '1.2', build: '6', name: 'Kidville', id: 'it.kidville.app' }))
    risposteNative.set(`${NOME_PLUGIN_CARICAMENTI}.info`, () => INFO_ANDROID)
  })

  const nostre = () => chiamateNative.filter((c) => c.plugin === NOME_PLUGIN_CARICAMENTI)

  it('app 1.1: il plugin non è nell\'intestazione, `isPluginAvailable` vero risponde no e non si chiama niente di nostro', async () => {
    pagina().Capacitor!.PluginHeaders = [{ name: 'App', methods: [{ name: 'getInfo', rtype: 'promise' }] }]
    risposteNative.set('App.getInfo', () => ({ version: '1.1', build: '5' }))
    const { caricamentiNativiDisponibili } = await carica()
    expect(await entro(caricamentiNativiDisponibili())).toBeNull()
    expect(nostre()).toEqual([])
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('intestazione senza un metodo: null + «metodi-mancanti», e il Proxy vero non si registra né si chiama', async () => {
    pagina().Capacitor!.PluginHeaders = intestazioneVera(METODI_PLUGIN_CARICAMENTI.filter((m) => m !== 'dimentica'))
    const { caricamentiNativiDisponibili } = await carica()
    expect(await entro(caricamentiNativiDisponibili())).toBeNull()
    expect(nostre()).toEqual([])
    expect(messaggi()).toEqual(['caricamenti-nativi-incompleti: metodi-mancanti'])
  })

  it('intestazione che non è un elenco (forma cambiata da un aggiornamento di Capacitor): la libreria lancia da sé e la rilevazione non esce', async () => {
    // `isPluginAvailable` vero fa `PluginHeaders.find(…)` e su un oggetto lancia un TypeError PRIMA che la
    // nostra lettura difensiva arrivi a guardare: il risultato è «errore-imprevisto» col nome della classe,
    // sempre scritto, e la Galleria ripiega sul TUS. Il caso che quella lettura difende (un elenco che c'è
    // ma con voci che non tornano) è provato dal finto, sopra.
    pagina().Capacitor!.PluginHeaders = { [NOME_PLUGIN_CARICAMENTI]: { methods: ['info'] } }
    const { caricamentiNativiDisponibili } = await carica()
    expect(await entro(caricamentiNativiDisponibili())).toBeNull()
    expect(righe()).toEqual([
      {
        livello: 'error',
        evento: 'caricamento-nativo',
        messaggio: 'caricamenti-nativi-incompleti: errore-imprevisto',
        campi: { error_code: 'TypeError' },
      },
    ])
  })

  it('intestazione completa: la rilevazione passa dal Proxy vero fino al trasporto e risponde (nessuna promise appesa)', async () => {
    pagina().Capacitor!.PluginHeaders = intestazioneVera(METODI_PLUGIN_CARICAMENTI)
    const { caricamentiNativiDisponibili } = await carica()
    expect(await entro(caricamentiNativiDisponibili())).toEqual(INFO_ANDROID)
    expect(nostre().map((c) => c.metodo)).toEqual(['info'])
    expect(messaggi()).toEqual(['caricamenti-nativi-disponibili: android 1.2 uidt'])
  })

  it('una chiamata tipizzata fa il giro completo: richiesta riletta, trasporto, risposta riletta', async () => {
    risposteNative.set(`${NOME_PLUGIN_CARICAMENTI}.scartaScelti`, (o) => ({ eliminati: (o as { ids: string[] }).ids.length }))
    const m = await carica()
    expect(await entro(m.scartaScelti({ ids: ['a1', 'b2'], percorso: '/private/var/x' } as never))).toEqual({ eliminati: 2 })
    expect(nostre().find((c) => c.metodo === 'scartaScelti')?.opzioni).toEqual({ ids: ['a1', 'b2'] })
    // Un metodo che il nativo non implementa: il ponte vero rifiuta con `UNIMPLEMENTED`, che vale NON_DISPONIBILE.
    await expect(entro(m.elenco({ utenteId: UUID_UTENTE }))).rejects.toMatchObject({ codice: 'NON_DISPONIBILE' })
  })

  it('il rifiuto del ponte vero porta il suo `code` (un Error con le proprietà copiate sopra) e non il messaggio', async () => {
    risposteNative.set(`${NOME_PLUGIN_CARICAMENTI}.leggiFoto`, () => {
      throw Object.assign(new Error(TESTO_DEL_PONTE), { code: 'ELEMENTO_ASSENTE' })
    })
    const m = await carica()
    let preso: unknown
    try {
      await entro(m.leggiFoto({ id: 'f1' }))
    } catch (e) {
      preso = e
    }
    expect(preso).toMatchObject({ name: 'ErroreCaricamentiNativi', codice: 'ELEMENTO_ASSENTE', message: 'ELEMENTO_ASSENTE' })
  })

  it('l\'ascolto di un evento col `addListener` vero (con intestazione) risolve con una funzione e non si appende', async () => {
    const m = await carica()
    const togli = await entro(m.ascoltaCaricamenti(() => undefined))
    expect(typeof togli).toBe('function')
    expect(nostre().some((c) => c.metodo === 'addListener')).toBe(true)
  })
})
