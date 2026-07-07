import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// doLogout(): chiude la sessione (endpoint + signOut), ripulisce l'identità
// applicativa in localStorage e riporta al login. Ogni passo è best-effort.

const signOut = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signOut } }),
}))

import { doLogout } from '@/lib/auth/logout'

const KV_KEYS = ['kv_user_id', 'kv_user_role', 'kv_parent_id', 'kv_student_id', 'kv_teacher_id']

describe('doLogout', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    signOut.mockClear()
    fetchMock = vi.fn(async () => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('location', { href: '' })
    for (const k of KV_KEYS) localStorage.setItem(k, 'x')
    localStorage.setItem('kv_altro', 'resta')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('chiama /api/auth/logout, signOut, pulisce le chiavi kv_* e reindirizza al login', async () => {
    await doLogout()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
    expect(signOut).toHaveBeenCalledTimes(1)
    for (const k of KV_KEYS) expect(localStorage.getItem(k)).toBeNull()
    // Non tocca chiavi non-identità.
    expect(localStorage.getItem('kv_altro')).toBe('resta')
    expect(location.href).toBe('/auth/login')
  })

  it('reindirizza al login anche se endpoint e signOut falliscono', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    signOut.mockRejectedValueOnce(new Error('boom'))
    await doLogout()
    expect(localStorage.getItem('kv_user_id')).toBeNull()
    expect(location.href).toBe('/auth/login')
  })
})
