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

/**
 * ⚠️ `/api/me` QUI RISPONDE SEMPRE 200, ED È UNA SCELTA.
 *
 * Fino al 2026-08-03 questa riga era `{ ok: Boolean(h.me), status: h.me ? 200 : 500 }`: **un
 * interruttore solo per due grandezze diverse** — il corpo della risposta e la sua riuscita. Dopo
 * la correzione W8-bis nessun test mette più `h.me = null` (nemmeno il degrado, che ora usa
 * `SENZA_RUOLO`), quindi quel ramo 500 era codice morto: dava a chi leggeva l'apparenza di
 * coprire «/api/me giù» senza coprirlo, e sarebbe tornato vivo per sbaglio al primo `h.me = null`
 * scritto per tutt'altro motivo. «/api/me giù» è un guasto dichiarato e si misura dove esiste una
 * fixture apposta per lui: `login-errori-servizio.test.tsx` (`meStato`, `meRifiuta`, `corpoRotto`,
 * `corpoMuto`). Qui si misura la NAVIGAZIONE, e serve solo che il profilo arrivi.
 */
const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('/api/auth/active-role')) {
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (String(url).includes('/api/me')) {
    return { ok: true, status: 200, json: async () => h.me }
  }
  return { ok: false, status: 404, json: async () => null }
})

const DOCENTE = {
  id: 'u-1',
  role: 'educator',
  profili: [{ ruolo: 'educator', area: 'teacher' }],
}
/**
 * La risposta ARRIVATA e VALIDA da cui però non si ricava nessun ruolo: è il vero degrado
 * graceful, ed è la sola cosa che manda al `replace` di fondo funzione. Non va confusa con
 * «/api/me giù», che dal 2026-08-03 è un guasto dichiarato e NON naviga affatto
 * (`login-errori-servizio.test.tsx`): confonderle era il difetto: un 500 dopo un accesso
 * riuscito finiva su `/`, la guardia d'area rispediva al login, e il giro non finiva mai.
 */
const SENZA_RUOLO = { id: 'u-1', role: null, profili: [] }
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

  it('degrado (profilo senza ruolo): replace verso la radice e nient’altro', async () => {
    h.me = { ...SENZA_RUOLO }
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
