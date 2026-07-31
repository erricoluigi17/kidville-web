import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

/**
 * IL DIFETTO CHE QUESTO TEST BLOCCA (audit 2026-07-31).
 *
 * Su Android il tasto Indietro fisico navigava indietro nella cronologia ANCHE con una
 * modale aperta: con «Nuovo avviso» a schermo, un Indietro distratto portava via la pagina
 * e con lei l'avviso che si stava scrivendo. È il contrario della convenzione della
 * piattaforma: Indietro chiude prima il livello più alto dell'interfaccia (modale,
 * bottom-sheet, pannello) e solo quando non ce n'è nessuno torna indietro.
 *
 * COSA ASSERISCE, e perché così. Le asserzioni che contano sono sulla MUTAZIONE, non sullo
 * stato: `window.history.back` e `App.exitApp` NON devono essere invocati. Uno status o un
 * flag «overlay chiuso» non escluderebbero che la navigazione sia comunque avvenuta.
 * Ogni asserzione negativa ha accanto il suo controllo positivo — l'overlay che si chiude
 * davvero, e il caso «nessun overlay» in cui la navigazione DEVE avvenire: senza, un
 * gestore che non fa più niente del tutto passerebbe il test.
 */

const addListener = vi.hoisted(() => vi.fn())
const exitApp = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@capacitor/app', () => ({ App: { addListener, exitApp } }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}))
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setStyle: vi.fn(async () => undefined),
    setOverlaysWebView: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  },
  Style: { Dark: 'DARK' },
}))
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { addListener: vi.fn() },
}))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({ logClient, nomeErrore: (e: unknown) => (e as Error).name }))

import { setupNativeShell } from '@/lib/mobile/native-shell'
import { useOverlayIndietro } from '@/lib/mobile/overlay-indietro'

type GestoreIndietro = (evento: { canGoBack: boolean }) => void

const navigate = vi.fn()
let back: ReturnType<typeof vi.spyOn>

/** Monta la shell nativa e restituisce il gestore del tasto Indietro che ha registrato. */
async function montaShell(): Promise<GestoreIndietro> {
  await setupNativeShell(navigate)
  const call = addListener.mock.calls.find(([evento]) => evento === 'backButton')
  if (!call) throw new Error('setupNativeShell non ha registrato nessun listener backButton')
  return call[1] as GestoreIndietro
}

/** Un overlay che si iscrive al registro esattamente come farà una modale vera. */
function montaOverlay(onChiudi: () => void, aperto = true) {
  return renderHook(
    ({ aperto, onChiudi }: { aperto: boolean; onChiudi: () => void }) =>
      useOverlayIndietro(aperto, onChiudi),
    { initialProps: { aperto, onChiudi } },
  )
}

describe('tasto Indietro Android: prima chiude l’overlay, poi naviga', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined)
  })

  afterEach(() => {
    back.mockRestore()
  })

  it('senza overlay aperti naviga davvero indietro (controllo positivo)', async () => {
    const gestore = await montaShell()

    gestore({ canGoBack: true })

    expect(back).toHaveBeenCalledTimes(1)
    expect(exitApp).not.toHaveBeenCalled()
  })

  it('senza overlay e senza cronologia esce dall’app (controllo positivo)', async () => {
    const gestore = await montaShell()

    gestore({ canGoBack: false })

    expect(exitApp).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
  })

  it('con un overlay aperto lo chiude e NON naviga', async () => {
    const gestore = await montaShell()
    const chiudi = vi.fn()
    const overlay = montaOverlay(chiudi)

    gestore({ canGoBack: true })

    // Controllo positivo: l'overlay si è chiuso davvero.
    expect(chiudi).toHaveBeenCalledTimes(1)
    // Asserzioni sulla MUTAZIONE: nessuna navigazione è avvenuta.
    expect(back).not.toHaveBeenCalled()
    expect(exitApp).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()

    overlay.unmount()
  })

  it('con un overlay aperto non esce dall’app nemmeno senza cronologia', async () => {
    const gestore = await montaShell()
    const chiudi = vi.fn()
    const overlay = montaOverlay(chiudi)

    gestore({ canGoBack: false })

    expect(chiudi).toHaveBeenCalledTimes(1)
    expect(exitApp).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()

    overlay.unmount()
  })

  it('con due overlay sovrapposti chiude quello IN CIMA, non l’altro', async () => {
    const gestore = await montaShell()
    const chiudiSotto = vi.fn()
    const chiudiSopra = vi.fn()
    const sotto = montaOverlay(chiudiSotto)
    const sopra = montaOverlay(chiudiSopra)

    gestore({ canGoBack: true })

    expect(chiudiSopra).toHaveBeenCalledTimes(1)
    expect(chiudiSotto).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()

    // L'overlay in cima si chiude davvero → esce dal registro.
    sopra.rerender({ aperto: false, onChiudi: chiudiSopra })

    gestore({ canGoBack: true })

    expect(chiudiSotto).toHaveBeenCalledTimes(1)
    expect(chiudiSopra).toHaveBeenCalledTimes(1) // non richiamato: non è più nel registro
    expect(back).not.toHaveBeenCalled()

    // Chiuso anche l'ultimo, il registro è vuoto: adesso Indietro DEVE navigare.
    sotto.rerender({ aperto: false, onChiudi: chiudiSotto })

    gestore({ canGoBack: true })

    expect(back).toHaveBeenCalledTimes(1)

    sopra.unmount()
    sotto.unmount()
  })

  it('un overlay smontato senza essere chiuso esce comunque dal registro', async () => {
    const gestore = await montaShell()
    const chiudi = vi.fn()
    const overlay = montaOverlay(chiudi)

    overlay.unmount()
    gestore({ canGoBack: true })

    expect(chiudi).not.toHaveBeenCalled()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('un overlay che non è mai stato aperto non blocca il tasto Indietro', async () => {
    const gestore = await montaShell()
    const chiudi = vi.fn()
    const overlay = montaOverlay(chiudi, false)

    gestore({ canGoBack: true })

    expect(chiudi).not.toHaveBeenCalled()
    expect(back).toHaveBeenCalledTimes(1)

    overlay.unmount()
  })

  it('usa SEMPRE l’ultima onChiudi, non quella del primo render', async () => {
    // Un handler inline (`onChiudi={() => setAperto(false)}`) è un oggetto nuovo a ogni
    // render: se il registro tenesse la prima, chiuderebbe usando uno stato vecchio.
    const gestore = await montaShell()
    const vecchia = vi.fn()
    const nuova = vi.fn()
    const overlay = montaOverlay(vecchia)

    overlay.rerender({ aperto: true, onChiudi: nuova })
    gestore({ canGoBack: true })

    expect(nuova).toHaveBeenCalledTimes(1)
    expect(vecchia).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()

    overlay.unmount()
  })

  it('se la chiusura lancia, l’evento è comunque consumato e il guasto è LOGGATO', async () => {
    const gestore = await montaShell()
    const chiudi = vi.fn(() => {
      throw new Error('stato incoerente')
    })
    const overlay = montaOverlay(chiudi)

    expect(() => gestore({ canGoBack: true })).not.toThrow()

    expect(chiudi).toHaveBeenCalledTimes(1)
    // Non si ripiega sulla navigazione: si perderebbe la bozza, che è il difetto originale.
    expect(back).not.toHaveBeenCalled()
    expect(exitApp).not.toHaveBeenCalled()
    // Un catch che non logga è un bug (AGENTS.md).
    expect(logClient).toHaveBeenCalledTimes(1)
    expect(logClient.mock.calls[0][0]).toMatchObject({ livello: 'warn', evento: 'js' })

    overlay.unmount()
  })
})
