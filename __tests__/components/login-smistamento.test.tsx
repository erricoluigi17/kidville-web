import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'

// M4B.5 (smoke) — login unico con smistamento per ruolo (M4B.3):
// docente → /teacher; ?next= onorato solo se coerente; utente doppio → picker
// inline nella stessa card; ?scegli=1 (dalla guardia) → picker senza credenziali.

// NB: il router deve essere un riferimento STABILE (come il vero useRouter).
const mockRouter = { replace: vi.fn(), refresh: vi.fn() }
let mockSearch = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
}))

const h = vi.hoisted(() => ({
  signIn: vi.fn(async () => ({ error: null })),
  me: null as Record<string, unknown> | null,
  activeRoleOk: true,
  activeRoleBodies: [] as unknown[],
}))

vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signInWithPassword: h.signIn } }),
}))

import LoginPage from '@/app/auth/login/page'

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).includes('/api/auth/active-role')) {
    h.activeRoleBodies.push(JSON.parse(String(init?.body ?? 'null')))
    return { ok: h.activeRoleOk, json: async () => ({ ok: h.activeRoleOk }) }
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
  fireEvent.click(screen.getByRole('button', { name: 'Entra' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockSearch = new URLSearchParams()
  h.me = { ...DOCENTE }
  h.activeRoleOk = true
  h.activeRoleBodies = []
  vi.stubGlobal('fetch', fetchMock)
})

describe('SMOKE M4B — login docente → /teacher', () => {
  it('profilo singolo: cookie ruolo attivo + identità persistita + redirect /teacher', async () => {
    renderLogin()
    submitCredenziali()
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
    expect(h.activeRoleBodies).toEqual([{ ruolo: 'educator' }])
    expect(window.localStorage.getItem('kv_user_id')).toBe('u-1')
    expect(window.localStorage.getItem('kv_user_role')).toBe('educator')
  })

  it('?next= coerente col ruolo è onorato', async () => {
    mockSearch = new URLSearchParams('next=/teacher/registro')
    renderLogin()
    submitCredenziali()
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher/registro'))
  })

  it('?next= NON coerente (docente → /admin) viene ignorato: si atterra su /teacher', async () => {
    mockSearch = new URLSearchParams('next=/admin')
    renderLogin()
    submitCredenziali()
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
  })

  it('degrado (/api/me giù): next con URL esterno NON viene onorato (open redirect)', async () => {
    h.me = null
    mockSearch = new URLSearchParams('next=https://evil.com')
    renderLogin()
    submitCredenziali()
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'))
  })

  it('degrado (/api/me giù): next interno a un\'area resta onorato', async () => {
    h.me = null
    mockSearch = new URLSearchParams('next=/teacher/registro')
    renderLogin()
    submitCredenziali()
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher/registro'))
  })
})

describe('SMOKE M4B — utente doppio → picker', () => {
  it('≥2 profili: step inline di scelta; la scelta setta il ruolo e reindirizza', async () => {
    h.me = { ...DOPPIO }
    renderLogin()
    submitCredenziali()
    const bottoneGenitore = await screen.findByRole('button', { name: 'Genitore' })
    expect(screen.getByRole('button', { name: 'Docente' })).toBeInTheDocument()
    expect(mockRouter.replace).not.toHaveBeenCalled()

    fireEvent.click(bottoneGenitore)
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/parent'))
    expect(h.activeRoleBodies).toEqual([{ ruolo: 'genitore' }])
    expect(window.localStorage.getItem('kv_user_role')).toBe('genitore')
  })

  it('?scegli=1 (arrivo dalla guardia, già autenticato): picker senza credenziali', async () => {
    h.me = { ...DOPPIO }
    mockSearch = new URLSearchParams('scegli=1&next=/parent')
    renderLogin()
    await screen.findByRole('button', { name: 'Docente' })
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Docente' }))
    // next=/parent non è coerente col ruolo docente → home del ruolo
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teacher'))
  })

  it('se il set del ruolo fallisce, il doppio profilo resta sul picker con errore', async () => {
    h.me = { ...DOPPIO }
    h.activeRoleOk = false
    renderLogin()
    submitCredenziali()
    fireEvent.click(await screen.findByRole('button', { name: 'Docente' }))
    await screen.findByRole('alert')
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })
})
