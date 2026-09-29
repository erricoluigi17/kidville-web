import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import sharedIt from '../../messages/it/shared.json'

/**
 * Il pop-up «Aggiorna l'app» (spec 2026-09-29), montato in `RootProviders` dentro il gate
 * biometrico. Chi deve aggiornare lo decide `@/lib/native/aggiornamento-app` (verificato in
 * `__tests__/lib/aggiornamento-app.test.ts`); qui si guarda CIÒ CHE SI VEDE e CIÒ CHE SI TOCCA:
 *  - compare SOLO sul binario sotto la minima (1.0): mai sul web, mai sulla 1.1;
 *  - «Aggiorna ora» porta alla scheda dello store della piattaforma; «Più tardi» (ed Esc, e
 *    Indietro su Android) chiude;
 *  - «a ogni apertura»: chiuso, ricompare al ritorno in primo piano dopo ≥ 30 minuti in
 *    background, non dopo un passaggio lampo a un'altra app;
 *  - non si apre mentre il gate biometrico blocca (la `Modal` renderebbe inerte lo sblocco);
 *  - StrictMode e rimontaggi non raddoppiano la comparsa né il log.
 *
 * La decisione è di SESSIONE, cioè di modulo: ogni test ricarica il modulo (`vi.resetModules`).
 */

const stato = vi.hoisted(() => ({
  nativo: true,
  piattaforma: 'android' as string,
  versione: '1.0',
  bloccato: false,
  visibilita: 'visible' as DocumentVisibilityState,
  ora: Date.UTC(2026, 8, 29, 8, 0, 0),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => stato.nativo,
    getPlatform: () => stato.piattaforma,
    isPluginAvailable: (nome: string) => nome === 'App',
  },
}))

const getInfo = vi.hoisted(() => vi.fn(async () => ({ version: stato.versione, build: '1' })))
vi.mock('@capacitor/app', () => ({ App: { getInfo, addListener: vi.fn(async () => ({ remove: vi.fn() })) } }))

vi.mock('@/components/providers/BiometricGate', () => ({ useBloccoBiometrico: () => stato.bloccato }))

// La navigazione vera (`window.location.assign`) in jsdom non si osserva: si passa alla funzione
// VERA un apri-url spia, così URL e piattaforma restano quelli del codice di produzione.
const apriUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/native/aggiornamento-app', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/native/aggiornamento-app')>()
  return { ...vero, apriSchedaStore: () => vero.apriSchedaStore(apriUrl) }
})

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

const T = sharedIt as Record<string, string>
const MINUTO = 60_000

type Componente = typeof import('@/components/providers/AvvisoAggiornamentoApp').AvvisoAggiornamentoApp

function albero(Avviso: Componente, strict = false) {
  const a = (
    <NextIntlClientProvider locale="it" messages={{ shared: sharedIt }}>
      <Avviso />
    </NextIntlClientProvider>
  )
  return strict ? <StrictMode>{a}</StrictMode> : a
}

async function monta(strict = false) {
  vi.resetModules()
  const { AvvisoAggiornamentoApp } = await import('@/components/providers/AvvisoAggiornamentoApp')
  return { ...render(albero(AvvisoAggiornamentoApp, strict)), Avviso: AvvisoAggiornamentoApp }
}

/** Lascia risolvere la decisione (getInfo è asincrono) e applicare lo stato che ne segue. */
async function lasciaDecidere() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function cambiaVisibilita(v: DocumentVisibilityState) {
  stato.visibilita = v
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function messaggiLog(): string[] {
  return logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)
}

const dialogo = () => screen.queryByRole('dialog')

beforeEach(() => {
  stato.nativo = true
  stato.piattaforma = 'android'
  stato.versione = '1.0'
  stato.bloccato = false
  stato.visibilita = 'visible'
  stato.ora = Date.UTC(2026, 8, 29, 8, 0, 0)
  getInfo.mockClear()
  apriUrl.mockReset()
  logClient.mockReset()
  vi.spyOn(Date, 'now').mockImplementation(() => stato.ora)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => stato.visibilita })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AvvisoAggiornamentoApp — a chi compare', () => {
  it('sul web non rende niente, non chiede la versione e non logga', async () => {
    stato.nativo = false
    const { container } = await monta()
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(getInfo).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })

  it.each(['1.1', '1.2'])('binario %s: niente pop-up', async (versione) => {
    stato.versione = versione
    const { container } = await monta()
    // Si aspetta la PRESENZA di un fatto (la versione è stata letta), non un'assenza.
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(logClient).not.toHaveBeenCalled()
  })

  it.each([
    ['ios', 'https://apps.apple.com/it/app/kidville/id6794883055'],
    ['android', 'https://play.google.com/store/apps/details?id=it.kidville.app'],
  ])('binario 1.0 su %s: «Aggiorna ora» porta alla scheda dello store e chiude', async (piattaforma, url) => {
    stato.piattaforma = piattaforma
    await monta()
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(screen.getByText(T.avvisoAggiornaCorpo)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: T.avvisoAggiornaBottone }))
    expect(apriUrl).toHaveBeenCalledWith(url)
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-mostrato', 'avviso-aggiorna-app-tocco-store'])
    expect(logClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        livello: 'warn',
        evento: 'avvio',
        campi: { piattaforma, esito: 'navigazione-richiesta' },
      }),
    )
  })

  it('«Più tardi» chiude e lo registra; non si naviga', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    expect(dialogo()).toBeNull()
    expect(apriUrl).not.toHaveBeenCalled()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-mostrato', 'avviso-aggiorna-app-rimandato'])
    expect(logClient).toHaveBeenLastCalledWith(expect.objectContaining({ campi: { piattaforma: 'android' } }))
  })

  it('Esc vale «Più tardi»', async () => {
    await monta()
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).toContain('avviso-aggiorna-app-rimandato')
  })

  it('non si chiude toccando fuori: si sceglie uno dei due bottoni', async () => {
    await monta()
    const d = await screen.findByRole('dialog')
    fireEvent.mouseDown(d.parentElement as HTMLElement)
    expect(dialogo()).not.toBeNull()
  })
})

describe('AvvisoAggiornamentoApp — «a ogni apertura»', () => {
  it('rimandato, ricompare tornando in primo piano dopo 30 minuti in background', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    expect(dialogo()).toBeNull()

    cambiaVisibilita('hidden')
    stato.ora += 30 * MINUTO
    cambiaVisibilita('visible')
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(messaggiLog().filter((m) => m === 'avviso-aggiorna-app-mostrato')).toHaveLength(2)
  })

  it('un passaggio lampo a un\'altra app (5 minuti) non lo ripropone', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))

    cambiaVisibilita('hidden')
    stato.ora += 5 * MINUTO
    cambiaVisibilita('visible')
    await lasciaDecidere()
    expect(dialogo()).toBeNull()
    expect(messaggiLog().filter((m) => m === 'avviso-aggiorna-app-mostrato')).toHaveLength(1)
  })

  it('anche dopo «Aggiorna ora» senza aggiornare, al ritorno dopo 30 minuti ricompare', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaBottone }))
    cambiaVisibilita('hidden')
    stato.ora += 45 * MINUTO
    cambiaVisibilita('visible')
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('sulla 1.1 il ritorno in primo piano non fa comparire niente', async () => {
    stato.versione = '1.1'
    const { container } = await monta()
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    cambiaVisibilita('hidden')
    stato.ora += 60 * MINUTO
    cambiaVisibilita('visible')
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
  })

  it('mai chiuso, il ritorno dopo 30 minuti non conta una seconda comparsa (nemmeno a un rimontaggio)', async () => {
    const { Avviso, unmount } = await monta()
    await screen.findByRole('dialog')
    cambiaVisibilita('hidden')
    stato.ora += 40 * MINUTO
    cambiaVisibilita('visible')
    await lasciaDecidere()
    unmount()
    render(albero(Avviso))
    await lasciaDecidere()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(messaggiLog().filter((m) => m === 'avviso-aggiorna-app-mostrato')).toHaveLength(1)
  })

  it('rimandato, smontato e rimontato nella stessa sessione non ricompare', async () => {
    const { Avviso, unmount } = await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    unmount()
    const { container } = render(albero(Avviso))
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(getInfo).toHaveBeenCalledTimes(1)
  })
})

describe('AvvisoAggiornamentoApp — gate biometrico e doppio montaggio', () => {
  it('col gate bloccato resta chiuso; allo sblocco compare, e il log «mostrato» parte allora', async () => {
    stato.bloccato = true
    const { Avviso, rerender } = await monta()
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).not.toContain('avviso-aggiorna-app-mostrato')

    stato.bloccato = false
    rerender(albero(Avviso))
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-mostrato'])
  })

  it('StrictMode: la versione si legge una volta, il pop-up compare, un solo log «mostrato»', async () => {
    await monta(true)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await lasciaDecidere()
    expect(getInfo).toHaveBeenCalledTimes(1)
    expect(messaggiLog().filter((m) => m === 'avviso-aggiorna-app-mostrato')).toHaveLength(1)
  })
})
