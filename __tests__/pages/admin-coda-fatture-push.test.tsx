import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

/**
 * Il pulsante della push nella pagina «Coda fatture» (consegna 2c, compito PUSH, T13).
 *
 * Gli avvisi della coda (fine del gruppo, errori, pausa, sospensione) arrivano sul
 * telefono a PC spento SOLO se il dispositivo di chi è dello staff è iscritto alla push:
 * senza questo pulsante nessuno dello staff lo è (0 su 14 al 24/09), e «la push arriva
 * entro 5 minuti» della decisione 21 sarebbe falsa. Il pulsante è `PushOptIn`, lo stesso
 * dei genitori, con testi propri passati da `etichette`: per i genitori non cambia niente.
 *
 * Tre cose verificate:
 *  1. con `etichette` il pulsante mostra quei testi, senza mostra quelli dei genitori;
 *  2. nella shell nativa il pulsante c'è subito, senza service worker;
 *  3. la pagina «Coda fatture» mostra il pulsante con i testi della coda.
 *
 * Browser finto: `navigator.serviceWorker` e `window.PushManager` (jsdom non li ha).
 */

const h = vi.hoisted(() => ({ nativa: false }))

vi.mock('@/lib/push/native-register', () => ({
  isNativeApp: () => h.nativa,
  registerNativePush: vi.fn(async () => ({ ok: true })),
  unregisterNativePush: vi.fn(async () => undefined),
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'segreteria', ready: true }),
}))
vi.mock('@/components/features/admin/pagamenti/CodaFatturePanel', () => ({
  CodaFatturePanel: () => <div data-testid="coda-panel">pannello coda</div>,
}))

import { PushOptIn } from '@/components/features/parent/pagamenti/PushOptIn'
import AdminCodaFatturePage from '@/app/(dashboard)/admin/coda-fatture/page'

const UTENTE = 'aaaaaaaa-1111-4000-8000-000000000001'

function browserConPush() {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => undefined },
  })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} })
}

function browserSenzaPush() {
  // `'serviceWorker' in navigator` deve tornare falso: si cancella la proprietà.
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
  delete (window as unknown as Record<string, unknown>).PushManager
}

describe('PushOptIn — etichette facoltative', () => {
  beforeEach(() => {
    h.nativa = false
    browserConPush()
  })
  afterEach(() => {
    cleanup()
    browserSenzaPush()
  })

  it('con `etichette` mostra il testo passato', async () => {
    render(<PushOptIn userId={UTENTE} etichette={{ attiva: 'A', attive: 'B' }} />)
    expect(await screen.findByRole('button', { name: 'A' })).toBeTruthy()
  })

  it('senza `etichette` resta il testo dei genitori', async () => {
    render(<PushOptIn userId={UTENTE} />)
    expect(await screen.findByRole('button', { name: 'Attiva promemoria pagamenti' })).toBeTruthy()
  })

  it('nella shell nativa il pulsante c’è subito, senza service worker', () => {
    browserSenzaPush()
    h.nativa = true
    render(<PushOptIn userId={UTENTE} etichette={{ attiva: 'A', attive: 'B' }} />)
    expect(screen.getByRole('button', { name: 'A' })).toBeTruthy()
  })
})

describe('Pagina «Coda fatture» — il pulsante della push', () => {
  beforeEach(() => {
    h.nativa = false
    browserConPush()
  })
  afterEach(() => {
    cleanup()
    browserSenzaPush()
  })

  it('mostra «Attiva le notifiche della coda su questo dispositivo»', async () => {
    render(<AdminCodaFatturePage />)
    expect(
      await screen.findByRole('button', { name: 'Attiva le notifiche della coda su questo dispositivo' }),
    ).toBeTruthy()
    expect(screen.getByTestId('coda-panel')).toBeTruthy()
  })
})
