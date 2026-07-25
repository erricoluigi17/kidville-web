import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// doLogout(): chiude la sessione (endpoint + signOut), azzera il badge, spegne
// l'opt-in biometrico, svuota la cache di lettura offline, ripulisce l'identità
// applicativa in localStorage e riporta al login. Ogni passo è best-effort.

const signOut = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signOut } }),
}))

const impostaBadgeNonLette = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/native/badge', () => ({ impostaBadgeNonLette }))

const svuotaCacheLocale = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/offline/pulizia-cache', () => ({ svuotaCacheLocale }))

import { doLogout } from '@/lib/auth/logout'

const KV_KEYS = ['kv_user_id', 'kv_user_role', 'kv_parent_id', 'kv_student_id', 'kv_teacher_id']

describe('doLogout', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
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

  // ── I tre difetti trovati sul telefono ──────────────────────────────────────

  it('SPEGNE l’opt-in biometrico: altrimenti il gate blocca la schermata di LOGIN', async () => {
    // È il difetto che chiudeva l'utente fuori dall'app: il flag sopravviveva al
    // logout, e al riavvio l'overlay copriva il login. «Esci» non lo spegneva,
    // quindi il recupero era solo la disinstallazione.
    localStorage.setItem('kv_biometric_optin', '1')
    await doLogout()
    expect(localStorage.getItem('kv_biometric_optin')).toBeNull()
  })

  it('azzera il badge dell’icona PRIMA del redirect', async () => {
    await doLogout()
    expect(impostaBadgeNonLette).toHaveBeenCalledWith(0)
    // L'ordine conta: dopo `location.href` la hard navigation cancella qualunque
    // lavoro in volo, e il badge resterebbe quello dell'utente precedente.
    const ordineBadge = impostaBadgeNonLette.mock.invocationCallOrder[0]
    const ordineFetch = fetchMock.mock.invocationCallOrder[0]
    expect(ordineBadge).toBeGreaterThan(ordineFetch)
    expect(location.href).toBe('/auth/login')
  })

  it('svuota la cache di lettura offline: sono dati di minori sul dispositivo', async () => {
    await doLogout()
    expect(svuotaCacheLocale).toHaveBeenCalledTimes(1)
  })

  it('esce comunque se badge o pulizia cache falliscono', async () => {
    impostaBadgeNonLette.mockRejectedValueOnce(new Error('plugin assente'))
    svuotaCacheLocale.mockRejectedValueOnce(new Error('indexeddb ko'))
    await doLogout()
    expect(location.href).toBe('/auth/login')
  })
})
