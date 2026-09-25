import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * LA SHELL NATIVA NON SI ARRENDE A UN FILE CHE NON È ARRIVATO (PC2, 2026-09-25).
 *
 * L'app carica il sito: `import('@capacitor/app')` è un file scaricato al momento. Con la rete assente
 * all'avvio arriva un `ChunkLoadError`, e fino a oggi la shell si arrendeva per tutta la sessione —
 * Indietro usciva dall'app, deep link e tocco sulle push non aprivano niente. Qui:
 *  · un `ChunkLoadError` lascia armato un ritentativo, che parte al ritorno della rete o in primo piano;
 *  · un errore che NON è di rete (il plugin assente dal binario) resta com'era: un warn, nessun ritentativo;
 *  · il ritentativo ha un tetto, e non raddoppia gli ascoltatori;
 *  · la versione del binario (`App.getInfo`) arriva al logger, e un suo guasto non spegne Indietro.
 *
 * Il plugin «che non arriva» è un getter che lancia per le prime N letture: `const { App } = await
 * import(…)` legge la proprietà a ogni tentativo, come il runtime vero rifà l'`import()`.
 *
 * Sul codice di prima i casi «si riprova» sono ROSSI: il primo errore finiva in `plugineMancante` e basta.
 */

const h = vi.hoisted(() => {
  const chunkError = () => Object.assign(new Error('Loading chunk 4821 failed.'), { name: 'ChunkLoadError' })
  return {
    chunkError,
    /** Quante letture del plugin falliscono ancora, e con che errore. */
    falliscono: { App: 0, StatusBar: 0, PushNotifications: 0 } as Record<string, number>,
    errore: { App: chunkError, StatusBar: chunkError, PushNotifications: chunkError } as Record<string, () => Error>,
    appAddListener: vi.fn(),
    pushAddListener: vi.fn(),
    setOverlaysWebView: vi.fn(async () => undefined),
    getInfo: vi.fn(async () => ({ version: '1.1', build: '5', id: 'x', name: 'x' })),
    logClient: vi.fn(),
    impostaVersioneApp: vi.fn(),
    applicaStiloStatusBar: vi.fn(async () => undefined),
  }
})

function plugin<T>(nome: string, valore: T): T {
  if (h.falliscono[nome] > 0) {
    h.falliscono[nome]--
    throw h.errore[nome]()
  }
  return valore
}

vi.mock('@capacitor/app', () => ({
  get App() {
    return plugin('App', { addListener: h.appAddListener, exitApp: vi.fn(), getInfo: h.getInfo })
  },
}))
vi.mock('@capacitor/push-notifications', () => ({
  get PushNotifications() {
    return plugin('PushNotifications', { addListener: h.pushAddListener })
  },
}))
vi.mock('@capacitor/status-bar', () => ({
  get StatusBar() {
    return plugin('StatusBar', { setOverlaysWebView: h.setOverlaysWebView, setBackgroundColor: vi.fn(async () => undefined) })
  },
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}))
vi.mock('@/lib/mobile/splash', () => ({ nascondiSplashNativo: vi.fn(async () => undefined) }))
vi.mock('@/lib/mobile/status-bar', () => ({ applicaStiloStatusBar: h.applicaStiloStatusBar }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e as Error).name,
  impostaVersioneApp: h.impostaVersioneApp,
}))

import { RITENTATIVI_PLUGIN_MAX, eCaricamentoMancato, setupNativeShell } from '@/lib/mobile/native-shell'

async function scorri() {
  for (let k = 0; k < 20; k++) await Promise.resolve()
}

async function reteTornata() {
  window.dispatchEvent(new Event('online'))
  await scorri()
}

let visibilita: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilita })

async function primoPiano(stato: DocumentVisibilityState) {
  visibilita = stato
  document.dispatchEvent(new Event('visibilitychange'))
  await scorri()
}

function messaggi(): string[] {
  return h.logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)
}

const nonCaricato = (p: string) => `native-shell: plugin ${p} non caricato (rete) — si riprova al ritorno della rete o in primo piano`
const caricatoDopo = (p: string) => `native-shell: plugin ${p} caricato al ritorno della rete o in primo piano`
const eventiBack = () => h.appAddListener.mock.calls.filter(([e]) => e === 'backButton').length

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` non svuota le code `…Once`: una coda non consumata passerebbe al test successivo.
  h.applicaStiloStatusBar.mockReset()
  h.applicaStiloStatusBar.mockResolvedValue(undefined)
  h.falliscono = { App: 0, StatusBar: 0, PushNotifications: 0 }
  h.errore = { App: h.chunkError, StatusBar: h.chunkError, PushNotifications: h.chunkError }
  visibilita = 'visible'
})

describe('eCaricamentoMancato — riconosce il file che non è arrivato, e solo quello', () => {
  it.each([
    Object.assign(new Error('Loading chunk 12 failed.'), { name: 'ChunkLoadError' }),
    Object.assign(new Error('Failed to load chunk static/chunks/x.js from module 1'), { name: 'ChunkLoadError' }),
    new TypeError('Failed to fetch dynamically imported module: https://app/_next/static/chunks/x.js'),
    new TypeError('Importing a module script failed.'),
  ])('%s → sì', (e) => {
    expect(eCaricamentoMancato(e)).toBe(true)
  })

  it.each([
    new TypeError('Failed to fetch'),
    new Error('"App" plugin is not implemented on android'),
    'Loading chunk 12 failed',
    null,
  ])('%s → no', (e) => {
    expect(eCaricamentoMancato(e)).toBe(false)
    // Un «no» classificato non è un guasto: nessuna riga.
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('un Error col getter `message` che lancia → no, e una riga di warn (il catch non è muto)', () => {
    const ostile = new Error('x')
    Object.defineProperty(ostile, 'message', {
      get() {
        throw new Error('getter ostile')
      },
    })
    expect(eCaricamentoMancato(ostile)).toBe(false)
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient.mock.calls[0][0]).toEqual({
      livello: 'warn',
      evento: 'avvio',
      messaggio: 'native-shell: errore di caricamento non classificabile — non si ritenta',
    })
  })
})

describe('setupNativeShell — un plugin non arrivato si riprova alla ripresa', () => {
  it('StatusBar non arriva: UN warn «si riprova», poi al ritorno della rete si applica, e si scrive', async () => {
    h.falliscono.StatusBar = 1
    await setupNativeShell(vi.fn())
    expect(h.setOverlaysWebView).not.toHaveBeenCalled()
    // La prima applicazione dello stile parte comunque (e nel runtime vero fallisce col suo import).
    expect(h.applicaStiloStatusBar).toHaveBeenCalledTimes(1)
    expect(messaggi()).toEqual([nonCaricato('StatusBar')])
    expect(h.logClient.mock.calls[0][0]).toMatchObject({ livello: 'warn', evento: 'avvio', campi: { error_code: 'ChunkLoadError' } })

    await reteTornata()
    expect(h.setOverlaysWebView).toHaveBeenCalledTimes(1)
    // Il recupero RIFÀ lo stile: senza, le icone restano sbagliate sulla login fino al cambio di percorso.
    expect(h.applicaStiloStatusBar).toHaveBeenCalledTimes(2)
    expect(messaggi()).toEqual([nonCaricato('StatusBar'), caricatoDopo('StatusBar')])
    expect(h.logClient.mock.calls[1][0]).toMatchObject({ campi: { tentativi: 2 } })

    // Recuperato: un'altra ripresa non rifà niente.
    await reteTornata()
    expect(h.setOverlaysWebView).toHaveBeenCalledTimes(1)
    expect(h.applicaStiloStatusBar).toHaveBeenCalledTimes(2)
  })

  it('StatusBar arriva al primo colpo: lo stile si applica UNA volta sola', async () => {
    await setupNativeShell(vi.fn())
    await reteTornata()
    expect(h.setOverlaysWebView).toHaveBeenCalledTimes(1)
    expect(h.applicaStiloStatusBar).toHaveBeenCalledTimes(1)
  })

  it('un guasto del passo dopo il recupero è una riga di warn, non un «plugin non disponibile»', async () => {
    h.falliscono.StatusBar = 1
    h.applicaStiloStatusBar.mockResolvedValueOnce(undefined)
    h.applicaStiloStatusBar.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'CapacitorException' }))
    await setupNativeShell(vi.fn())
    await reteTornata()
    expect(h.applicaStiloStatusBar).toHaveBeenCalledTimes(2)
    expect(messaggi()).toEqual([
      nonCaricato('StatusBar'),
      caricatoDopo('StatusBar'),
      'native-shell: plugin StatusBar recuperato, ma il passo successivo al recupero è fallito',
    ])
    expect(h.logClient.mock.calls[2][0]).toMatchObject({ livello: 'warn', campi: { error_code: 'CapacitorException' } })
  })

  it('App non arriva: al ritorno in primo piano Indietro e deep link si agganciano UNA volta, e la versione arriva ai log', async () => {
    h.falliscono.App = 2
    await setupNativeShell(vi.fn())
    expect(eventiBack()).toBe(0)
    expect(h.impostaVersioneApp).not.toHaveBeenCalled()

    // Andare in background non è un segnale di ripresa.
    await primoPiano('hidden')
    expect(eventiBack()).toBe(0)

    await primoPiano('visible') // secondo fallimento: si riarma
    expect(eventiBack()).toBe(0)
    await reteTornata()
    expect(eventiBack()).toBe(1)
    expect(h.appAddListener.mock.calls.filter(([e]) => e === 'appUrlOpen')).toHaveLength(1)
    expect(h.impostaVersioneApp).toHaveBeenCalledWith('1.1', '5')

    // Le due fonti di ripresa insieme non duplicano gli ascoltatori.
    await reteTornata()
    await primoPiano('visible')
    expect(eventiBack()).toBe(1)
    expect(messaggi()).toEqual([nonCaricato('App'), caricatoDopo('App')])
  })

  it('PushNotifications non arriva: il tocco sulle push si aggancia alla ripresa', async () => {
    h.falliscono.PushNotifications = 1
    await setupNativeShell(vi.fn())
    expect(h.pushAddListener).not.toHaveBeenCalled()
    await reteTornata()
    expect(h.pushAddListener).toHaveBeenCalledTimes(1)
    expect(h.pushAddListener).toHaveBeenCalledWith('pushNotificationActionPerformed', expect.any(Function))
  })

  it('un errore che NON è di rete (plugin assente dal binario) non si ritenta: il warn di sempre', async () => {
    h.falliscono.App = 1
    h.errore.App = () => new Error('"App" plugin is not implemented on android')
    await setupNativeShell(vi.fn())
    expect(messaggi()).toEqual([
      'native-shell: plugin App non disponibile — il tasto Indietro e i deep link kidville:// non rispondono (Error)',
    ])
    await reteTornata()
    await primoPiano('visible')
    expect(eventiBack()).toBe(0)
    expect(messaggi()).toHaveLength(1)
  })

  it(`al massimo ${RITENTATIVI_PLUGIN_MAX} ritentativi, poi il warn di sempre e basta`, async () => {
    h.falliscono.StatusBar = 1_000
    await setupNativeShell(vi.fn())
    for (let i = 0; i < RITENTATIVI_PLUGIN_MAX + 3; i++) await reteTornata()

    // Il primo tentativo più RITENTATIVI_PLUGIN_MAX ritentativi: il resto delle letture non c'è stato.
    expect(1_000 - h.falliscono.StatusBar).toBe(1 + RITENTATIVI_PLUGIN_MAX)
    expect(messaggi()).toEqual([
      nonCaricato('StatusBar'),
      'native-shell: plugin StatusBar non disponibile — la barra di stato resta al default di sistema (ChunkLoadError)',
    ])
    expect(h.logClient.mock.calls[1][0]).toMatchObject({ campi: { tentativi: 1 + RITENTATIVI_PLUGIN_MAX } })
    expect(h.setOverlaysWebView).not.toHaveBeenCalled()
    // Mai recuperato: lo stile resta alla sola prima applicazione.
    expect(h.applicaStiloStatusBar).toHaveBeenCalledTimes(1)
  })
})

describe('setupNativeShell — la versione del binario nei log', () => {
  it('App.getInfo → impostaVersioneApp(versione, build), senza log', async () => {
    await setupNativeShell(vi.fn())
    await scorri()
    expect(h.getInfo).toHaveBeenCalledTimes(1)
    expect(h.impostaVersioneApp).toHaveBeenCalledWith('1.1', '5')
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('getInfo che fallisce: un warn col nome dell’errore, e Indietro resta agganciato', async () => {
    h.getInfo.mockRejectedValueOnce(Object.assign(new Error('bridge'), { name: 'CapacitorException' }))
    await setupNativeShell(vi.fn())
    await scorri()
    expect(eventiBack()).toBe(1)
    expect(h.impostaVersioneApp).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient.mock.calls[0][0]).toMatchObject({
      livello: 'warn',
      evento: 'avvio',
      campi: { error_code: 'CapacitorException' },
    })
    expect(messaggi()[0]).not.toContain('non disponibile')
  })
})
