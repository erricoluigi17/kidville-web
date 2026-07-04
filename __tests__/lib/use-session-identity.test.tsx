import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// Mock next/navigation controllabile per-test. NB: il router deve essere un
// riferimento STABILE (come il vero useRouter), altrimenti l'effect del hook
// (che lo ha nelle deps) va in loop di re-render.
const mockReplace = vi.fn()
const mockRouter = { replace: mockReplace, refresh: vi.fn() }
let mockSearch = new URLSearchParams()
let mockPathname = '/parent'

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => mockPathname,
}))

import { useSessionIdentity } from '@/lib/auth/use-session-identity'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockSearch = new URLSearchParams()
  mockPathname = '/parent'
  vi.stubGlobal('fetch', fetchMock)
})

describe('useSessionIdentity — precedenza URL → localStorage → /api/me → login', () => {
  it('1) usa ?userId= dalla URL, lo persiste e NON chiama /api/me', async () => {
    mockSearch = new URLSearchParams('userId=abc-123')
    const { result } = renderHook(() => useSessionIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.userId).toBe('abc-123')
    expect(window.localStorage.getItem('kv_user_id')).toBe('abc-123')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('2) senza URL usa localStorage (id e ruolo cached), senza chiamare /api/me', async () => {
    window.localStorage.setItem('kv_user_id', 'stored-9')
    window.localStorage.setItem('kv_user_role', 'educator')
    const { result } = renderHook(() => useSessionIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.userId).toBe('stored-9')
    expect(result.current.role).toBe('educator')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('3) senza URL né localStorage risolve da GET /api/me e persiste id+ruolo', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'me-42', role: 'genitore' }),
    })
    const { result } = renderHook(() => useSessionIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(fetchMock).toHaveBeenCalledWith('/api/me')
    expect(result.current.userId).toBe('me-42')
    expect(result.current.role).toBe('genitore')
    expect(window.localStorage.getItem('kv_user_id')).toBe('me-42')
    expect(window.localStorage.getItem('kv_user_role')).toBe('genitore')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('4) se /api/me risponde 401: userId null, ready true, redirect al login con next=', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Non autenticato' }) })
    mockPathname = '/parent/avvisi'
    const { result } = renderHook(() => useSessionIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.userId).toBeNull()
    expect(result.current.role).toBeNull()
    expect(mockReplace).toHaveBeenCalledWith('/auth/login?next=%2Fparent%2Favvisi')
  })

  it('5) errore di rete su /api/me: nessun crash, userId null + redirect (zero fallback demo)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderHook(() => useSessionIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.userId).toBeNull()
    expect(mockReplace).toHaveBeenCalledWith('/auth/login?next=%2Fparent')
  })

  it('6) prima della risoluzione ready è false', () => {
    fetchMock.mockReturnValueOnce(new Promise(() => { /* mai risolta */ }))
    const { result } = renderHook(() => useSessionIdentity())
    expect(result.current.ready).toBe(false)
    expect(result.current.userId).toBeNull()
  })
})
