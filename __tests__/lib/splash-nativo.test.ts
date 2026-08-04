import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * LO SPLASH NATIVO — quello che copre l'attesa della rete all'avvio dell'app.
 *
 * IL DIFETTO CHE HA FATTO NASCERE QUESTO CODICE (segnalato dal titolare, 2026-08-04):
 * «quando apre l'app, rimane per dei secondi schermo bianco». La shell Capacitor carica
 * l'app da `app.kidville.it` sulla rete, e fra la comparsa della WebView e il primo HTML
 * passano secondi in cui non c'è niente da dipingere. Il `PageLoader` non può coprirli:
 * fa parte della pagina che si sta ancora scaricando.
 *
 * COSA ASSERISCONO QUESTI TEST, e perché proprio questi tre.
 *
 *  1. SUL WEB NON SUCCEDE NIENTE. È l'asserzione negativa che tiene: la stessa funzione
 *     gira nel browser di un genitore, dove non esiste nessuno splash e importare un
 *     plugin nativo sarebbe un errore a runtime. Si asserisce che `hide` non venga
 *     chiamata — non un flag o un valore di ritorno, che non escluderebbero la chiamata.
 *
 *  2. SUL NATIVO SI NASCONDE DOPO CHE IL FRAME È STATO DIPINTO, non prima. È l'unico modo
 *     di rendere utile lo splash: `hide()` scopre la WebView nell'istante in cui viene
 *     invocata, e chiamarla appena parte il JavaScript rimetterebbe a schermo il lampo
 *     bianco che si voleva togliere — più corto e più fastidioso, perché dopo qualcosa di
 *     finito. Il test guida `requestAnimationFrame` a mano e verifica che PRIMA dei due
 *     frame `hide` non sia stata chiamata: senza quel controllo, un'implementazione che
 *     nasconde subito passerebbe.
 *
 *  3. SE `hide()` FALLISCE, LO SPLASH RESTA E QUALCUNO DEVE SAPERLO. Il caso non è
 *     teorico: se il plugin non è installato nella build nativa, l'import dinamico lancia,
 *     e l'utente si ritrova la schermata d'avvio fino al tetto di 6 s del plugin — un
 *     difetto che, senza log, è indistinguibile da «la rete era lenta» (regola 6 di
 *     AGENTS.md). Si asserisce anche che la funzione NON propaghi: un guasto
 *     dell'osservabilità dell'avvio non può diventare un avvio rotto.
 */

const hide = vi.hoisted(() => vi.fn(async () => undefined))
const logClient = vi.hoisted(() => vi.fn())
const isNativePlatform = vi.hoisted(() => vi.fn(() => false))

vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: { hide } }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform } }))
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : String(e)),
}))

/** Prende il controllo di `requestAnimationFrame`: i frame li consegna il test, uno per volta. */
function frameManuali() {
  const coda: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    coda.push(cb)
    return coda.length
  })
  return {
    /** Consegna un frame. Restituisce `false` se non ce n'erano di richiesti. */
    async consegna(): Promise<boolean> {
      const prossimo = coda.shift()
      if (!prossimo) return false
      prossimo(0)
      // Lascia girare la microtask queue: dopo il secondo frame la funzione fa `await import`.
      await Promise.resolve()
      await Promise.resolve()
      return true
    },
  }
}

async function caricaModulo() {
  vi.resetModules()
  return await import('@/lib/mobile/splash')
}

describe('nascondiSplashNativo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    isNativePlatform.mockReturnValue(false)
    hide.mockImplementation(async () => undefined)
  })

  it('sul web non tocca il plugin: non c’è nessuno splash da togliere', async () => {
    const frame = frameManuali()
    const { nascondiSplashNativo } = await caricaModulo()

    await nascondiSplashNativo()

    expect(hide).not.toHaveBeenCalled()
    // E nemmeno ha chiesto un frame: sul web esce prima di mettersi in attesa.
    expect(await frame.consegna()).toBe(false)
  })

  it('sul nativo nasconde lo splash SOLO dopo che un frame è stato dipinto', async () => {
    isNativePlatform.mockReturnValue(true)
    const frame = frameManuali()
    const { nascondiSplashNativo } = await caricaModulo()

    const inCorso = nascondiSplashNativo()
    await Promise.resolve()

    // Primo frame consegnato: la funzione ne aspetta un secondo (il doppio rAF è ciò che
    // garantisce che i pixel siano stati consegnati al compositore, non solo programmati).
    expect(await frame.consegna()).toBe(true)
    expect(hide).not.toHaveBeenCalled()

    expect(await frame.consegna()).toBe(true)
    await inCorso

    expect(hide).toHaveBeenCalledTimes(1)
    // La stessa durata di `launchFadeOutDuration`: due dissolvenze diverse si noterebbero
    // confrontando l'avvio normale con quello scaduto per timeout.
    expect(hide).toHaveBeenCalledWith({ fadeOutDuration: 250 })
    expect(logClient).not.toHaveBeenCalled()
  })

  it('se hide() fallisce lo dice, e non rompe l’avvio', async () => {
    isNativePlatform.mockReturnValue(true)
    hide.mockRejectedValue(Object.assign(new Error('plugin assente'), { name: 'PluginNonTrovato' }))
    const frame = frameManuali()
    const { nascondiSplashNativo } = await caricaModulo()

    const inCorso = nascondiSplashNativo()
    await Promise.resolve()
    await frame.consegna()
    await frame.consegna()

    // Non propaga: `setupNativeShell` la invoca senza await, e una promise rifiutata qui
    // diventerebbe un unhandledrejection a ogni avvio dell'app.
    await expect(inCorso).resolves.toBeUndefined()

    expect(logClient).toHaveBeenCalledTimes(1)
    const riga = logClient.mock.calls[0][0] as { livello: string; evento: string; messaggio: string }
    expect(riga.livello).toBe('error')
    expect(riga.evento).toBe('avvio')
    expect(riga.messaggio).toContain('splash-nativo-non-nascosto')
    expect(riga.messaggio).toContain('PluginNonTrovato')
  })
})
