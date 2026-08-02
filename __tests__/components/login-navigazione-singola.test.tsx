import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'

/**
 * S28 — «annullare non è essere offline».
 *
 * Difetto misurato sul simulatore iOS (collaudo 2026-07-31, rilievo mobile-ios F3):
 * dopo un login ANDATO A BUON FINE compariva «KIDVILLE NON È RAGGIUNGIBILE», 1 volta
 * su 6. Nel log di WebKit:
 *
 *   DocumentLoader::setMainDocumentError: (type=3, code=-999)
 *   Failed provisional load (isCancellation = 1, errorCode = -999)
 *
 * `-999` è `NSURLErrorCancelled`: la navigazione non era fallita, era stata ANNULLATA
 * da una seconda partita 28 ms dopo. Le due navigazioni nascono qui: ogni percorso di
 * uscita del login faceva `router.replace(...)` e SUBITO DOPO `router.refresh()`.
 * Quando il router App Router degrada a navigazione hard (WebView, Turbopack), le due
 * diventano due caricamenti veri e il secondo uccide il primo.
 *
 * Il `refresh()` non serviva: il `replace` verso una destinazione mai visitata da questa
 * istanza di router va comunque a prendere il payload RSC, e lo fa con i cookie appena
 * scritti (sessione Supabase + ruolo attivo di /api/auth/active-role).
 *
 * Questo test blinda la MUTAZIONE, non lo status: **una sola navigazione per percorso**.
 * Ogni asserzione negativa (`refresh` mai chiamato) è accompagnata dalla positiva
 * (`replace` chiamato UNA volta con la destinazione giusta), così il test non può
 * diventare verde perché «non è successo niente».
 */

// Riferimento STABILE, come il vero useRouter.
const mockRouter = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }
let mockSearch = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
}))

const h = vi.hoisted(() => ({
  signIn: vi.fn(async () => ({ error: null })),
  me: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signInWithPassword: h.signIn } }),
}))

import LoginPage from '@/app/auth/login/page'

const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('/api/auth/active-role')) {
    return { ok: true, json: async () => ({ ok: true }) }
  }
  if (String(url).includes('/api/me')) {
    return { ok: Boolean(h.me), json: async () => h.me }
  }
  return { ok: false, json: async () => null }
})

const DOCENTE = {
  id: 'u-1',
  role: 'educator',
  profili: [{ ruolo: 'educator', area: 'teacher' }],
}
const DOPPIO = {
  id: 'u-1',
  role: 'educator',
  profili: [
    { ruolo: 'educator', area: 'teacher' },
    { ruolo: 'genitore', area: 'parent' },
  ],
}

function renderLogin() {
  return render(
    <AccessibilityProvider initialHighContrast={false}>
      <LoginPage />
    </AccessibilityProvider>
  )
}

function submitCredenziali() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'doc@kidville.it' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Accedi' }))
}

/**
 * Il conto che conta: quante navigazioni ha chiesto la pagina.
 * `replace` e `refresh` sono DUE caricamenti quando il router degrada.
 */
function navigazioni(): number {
  return mockRouter.replace.mock.calls.length + mockRouter.refresh.mock.calls.length
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockSearch = new URLSearchParams()
  h.me = { ...DOCENTE }
  vi.stubGlobal('fetch', fetchMock)
})

describe('S28 — dopo il login parte UNA sola navigazione', () => {
  it('profilo singolo: replace verso /teacher e nient’altro', async () => {
    renderLogin()
    submitCredenziali()

    // positiva: si è davvero navigato, e verso la destinazione giusta
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
    expect(mockRouter.replace).toHaveBeenCalledTimes(1)

    // negativa: nessuna seconda navigazione che uccida la prima
    expect(mockRouter.refresh).not.toHaveBeenCalled()
    expect(navigazioni()).toBe(1)
  })

  it('scelta del ruolo (doppio profilo): replace verso /parent e nient’altro', async () => {
    h.me = { ...DOPPIO }
    renderLogin()
    submitCredenziali()

    fireEvent.click(await screen.findByRole('button', { name: 'Genitore' }))

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/parent'))
    expect(mockRouter.replace).toHaveBeenCalledTimes(1)
    expect(mockRouter.refresh).not.toHaveBeenCalled()
    expect(navigazioni()).toBe(1)
  })

  it('?scegli=1 con un profilo solo (auto-riparazione): replace e nient’altro', async () => {
    mockSearch = new URLSearchParams('scegli=1')
    renderLogin()

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
    expect(mockRouter.replace).toHaveBeenCalledTimes(1)
    expect(mockRouter.refresh).not.toHaveBeenCalled()
    expect(navigazioni()).toBe(1)
  })

  it('degrado (/api/me giù): replace verso la radice e nient’altro', async () => {
    h.me = null
    renderLogin()
    submitCredenziali()

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'))
    expect(mockRouter.replace).toHaveBeenCalledTimes(1)
    expect(mockRouter.refresh).not.toHaveBeenCalled()
    expect(navigazioni()).toBe(1)
  })
})

describe('S28 — controllo positivo del rilevatore', () => {
  it('se qualcuno rimettesse il refresh, il conto lo vedrebbe', () => {
    // Prova che `navigazioni()` non è un fantoccio che dice sempre 1: con le due
    // chiamate messe a mano il conto sale a 2, che è esattamente lo scenario che
    // faceva comparire «KIDVILLE NON È RAGGIUNGIBILE».
    mockRouter.replace('/teacher')
    mockRouter.refresh()
    expect(navigazioni()).toBe(2)
  })
})
