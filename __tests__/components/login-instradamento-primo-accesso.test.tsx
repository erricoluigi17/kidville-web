import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { classificaFormaPassword } from '@/lib/auth/forma-password'

/**
 * L’INSTRADAMENTO DEL PRIMO ACCESSO — chi entra con la password dell’email va a
 * sceglierne una sua, chiunque altro no.
 *
 * ─── PERCHÉ È UN TEST A SÉ ──────────────────────────────────────────────────
 *
 * Perché l’unica cosa che può andare storta qui è la SELETTIVITÀ, e ha due modi di
 * sbagliare, opposti e ugualmente gravi:
 *
 *  · troppo largo — l’interstiziale si mette davanti a chi la password se l’è già
 *    scelta mesi fa. Cioè un ostacolo quotidiano fra una madre e il diario di suo
 *    figlio, su una schermata che non ha nemmeno un motivo da mostrare;
 *  · troppo stretto — non compare mai, e il lavoro sembra fatto mentre le 67
 *    famiglie che hanno in mano una temporanea continuano a usarla.
 *
 * E c’è un terzo caso che non si vede leggendo il codice: `?scegli=1`. Chi arriva
 * da lì è **già autenticato** (lo manda la guardia d’area) e non ha digitato nessuna
 * password: lo stato `password` vale la stringa vuota. Se l’instradamento non
 * distinguesse «vuota» da «temporanea», ogni doppio profilo che sceglie la propria
 * veste finirebbe su una schermata che gli chiede una password che non ha appena
 * scritto — e con `next` puntato alla sua dashboard, cioè un giro senza uscita.
 *
 * ─── E PERCHÉ SI MISURA LA NAVIGAZIONE, NON LA FUNZIONE ─────────────────────
 *
 * `destinazione()` si potrebbe collaudare da sola in tre righe. Ma il difetto storico
 * di questa pagina non è mai stato nella funzione: è nel numero di uscite che la
 * chiamano (quattro) e nel fatto che una di loro se ne dimentichi. Perciò si misura
 * `router.replace`, uscita per uscita — compreso il ramo di DEGRADO, che è l’unico a
 * non avere un ruolo e quindi l’unico che una funzione «per ruolo» dimenticherebbe.
 */

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
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (String(url).includes('/api/me')) {
    return { ok: true, status: 200, json: async () => h.me }
  }
  return { ok: false, status: 404, json: async () => null }
})

const DOCENTE = { id: 'u-1', role: 'educator', profili: [{ ruolo: 'educator', area: 'teacher' }] }
const DOPPIO = {
  id: 'u-1',
  role: 'educator',
  profili: [
    { ruolo: 'educator', area: 'teacher' },
    { ruolo: 'genitore', area: 'parent' },
  ],
}
/** Risposta ARRIVATA e valida da cui non si ricava nessun ruolo: il degrado vero. */
const SENZA_RUOLO = { id: 'u-1', role: null, profili: [] }

/** Il formato in vigore dal 2026-08-23 (`Xxxx-xxxx-xxxx-xxxx`, alfabeto Crockford). */
const TEMPORANEA = 'Adcf-hjk2-3n4p-5rt6'
/** Il formato spedito fino al 2026-08-22: 24 caratteri base64url più `Aa1!`. */
const TEMPORANEA_LEGACY = 'abcdefghijklmnopqrstuvwxAa1!'
/** Una password che una persona si è scelta da sé. */
const SUA = 'PasswordSegretissima42'

function renderLogin() {
  return render(
    <AccessibilityProvider initialHighContrast={false}>
      <LoginPage />
    </AccessibilityProvider>,
  )
}

function accedi(password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'doc@kidville.it' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Accedi' }))
}

const interstiziale = (dove: string) => `/auth/nuova-password?next=${encodeURIComponent(dove)}`

/** Quante navigazioni ha chiesto la pagina: `replace` e `refresh` sono due caricamenti. */
const navigazioni = () => mockRouter.replace.mock.calls.length + mockRouter.refresh.mock.calls.length

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockSearch = new URLSearchParams()
  h.me = { ...DOCENTE }
  vi.stubGlobal('fetch', fetchMock)
})

describe('login · le tre forme di password sono davvero tre (controllo del riconoscitore)', () => {
  it('la fixture temporanea è riconosciuta come tale, e quella scelta no', () => {
    // Senza questa prova, un test verde su «non instrada» significherebbe soltanto
    // che la fixture non somiglia a una temporanea — cioè niente.
    expect(classificaFormaPassword(TEMPORANEA)).toBe('temporanea')
    expect(classificaFormaPassword(TEMPORANEA_LEGACY)).toBe('temporanea-legacy')
    expect(classificaFormaPassword(SUA)).toBe('altra')
    expect(classificaFormaPassword('')).toBe('altra')
  })
})

describe('login · chi entra con la password ricevuta via email passa dall’interstiziale', () => {
  it('profilo singolo + temporanea → /auth/nuova-password con `next` alla propria home', async () => {
    renderLogin()
    accedi(TEMPORANEA)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(interstiziale('/teacher')))
    // Una sola navigazione: la seconda ne annullerebbe una (difetto S28).
    expect(navigazioni()).toBe(1)
  })

  it('anche il formato VECCHIO instrada: 67 famiglie ne hanno una in mano', async () => {
    renderLogin()
    accedi(TEMPORANEA_LEGACY)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(interstiziale('/teacher')))
  })

  it('`?next=` resta onorato DENTRO l’interstiziale: chi tornerà, tornerà dove voleva andare', async () => {
    mockSearch = new URLSearchParams('next=/teacher/diary')
    renderLogin()
    accedi(TEMPORANEA)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(interstiziale('/teacher/diary')))
  })

  it('doppio profilo: instrada anche la strada del PICKER, non solo quella diretta', async () => {
    h.me = { ...DOPPIO }
    renderLogin()
    accedi(TEMPORANEA)
    fireEvent.click(await screen.findByRole('button', { name: 'Genitore' }))
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(interstiziale('/parent')))
    expect(navigazioni()).toBe(1)
  })

  it('degrado senza ruolo: l’uscita che NON ha un ruolo è quella che si dimentica', async () => {
    h.me = { ...SENZA_RUOLO }
    renderLogin()
    accedi(TEMPORANEA)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(interstiziale('/')))
    expect(navigazioni()).toBe(1)
  })
})

describe('login · chi la password se l’è già scelta non incontra niente', () => {
  it('password propria → la dashboard, esattamente come prima', async () => {
    renderLogin()
    accedi(SUA)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
    expect(mockRouter.replace).not.toHaveBeenCalledWith(expect.stringContaining('/auth/nuova-password'))
    expect(navigazioni()).toBe(1)
  })

  it('`?next=` coerente col ruolo resta onorato tale e quale', async () => {
    mockSearch = new URLSearchParams('next=/teacher/diary')
    renderLogin()
    accedi(SUA)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher/diary'))
  })

  it('degrado senza ruolo e password propria → la radice, come prima', async () => {
    h.me = { ...SENZA_RUOLO }
    renderLogin()
    accedi(SUA)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'))
  })

  it('?scegli=1 (password MAI digitata) non instrada: quella stringa è vuota, non temporanea', async () => {
    // Chi arriva qui è già autenticato e non ha scritto nessuna password. Un
    // instradamento su «vuota» lo manderebbe a cambiare una password che non ha,
    // con `next` alla sua dashboard: un giro senza uscita.
    mockSearch = new URLSearchParams('scegli=1')
    renderLogin()
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
    expect(mockRouter.replace).not.toHaveBeenCalledWith(expect.stringContaining('/auth/nuova-password'))
    expect(navigazioni()).toBe(1)
  })

  it('?scegli=1 con doppio profilo: nemmeno il picker instrada, per la stessa ragione', async () => {
    mockSearch = new URLSearchParams('scegli=1')
    h.me = { ...DOPPIO }
    renderLogin()
    fireEvent.click(await screen.findByRole('button', { name: 'Genitore' }))
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/parent'))
    expect(mockRouter.replace).not.toHaveBeenCalledWith(expect.stringContaining('/auth/nuova-password'))
  })
})
