import { describe, it, expect, vi, beforeEach } from 'vitest'

// M4B.2 — POST /api/auth/active-role: setta server-side il cookie
// `kv-active-role` SOLO se il ruolo richiesto appartiene davvero all'utente
// (profili dalla sessione; percorso legacy: ruolo della riga utenti).

const h = vi.hoisted(() => ({
  identity: { userId: 'u-1', source: 'session' } as { userId: string | null; source: string | null },
  profili: [{ ruolo: 'educator', area: 'teacher' }] as { ruolo: string; area: string }[] | null,
  appUser: { id: 'u-1', role: 'educator' } as { id: string; role: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  resolveIdentity: vi.fn(async () => h.identity),
  loadAppUser: vi.fn(async () => h.appUser),
}))

vi.mock('@/lib/auth/profili', () => ({
  getSessionProfili: vi.fn(async () =>
    h.profili ? { authUid: 'u-1', profili: h.profili } : null
  ),
}))

import { POST } from '@/app/api/auth/active-role/route'

function req(body: unknown) {
  return new Request('http://localhost/api/auth/active-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  h.identity = { userId: 'u-1', source: 'session' }
  h.profili = [{ ruolo: 'educator', area: 'teacher' }]
  h.appUser = { id: 'u-1', role: 'educator' }
})

describe('POST /api/auth/active-role', () => {
  it('401 senza identità', async () => {
    h.identity = { userId: null, source: null }
    const res = await POST(req({ ruolo: 'educator' }))
    expect(res.status).toBe(401)
  })

  it('400 su ruolo non valido (zod)', async () => {
    const res = await POST(req({ ruolo: 'superadmin' }))
    expect(res.status).toBe(400)
  })

  it('403 se il ruolo non è tra i profili dell\'utente', async () => {
    const res = await POST(req({ ruolo: 'genitore' }))
    expect(res.status).toBe(403)
  })

  it('200 setta il cookie kv-active-role (HttpOnly) e ritorna l\'area', async () => {
    const res = await POST(req({ ruolo: 'educator' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ ok: true, ruolo: 'educator', area: 'teacher' })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('kv-active-role=educator')
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('path=/')
  })

  it('doppio profilo: entrambi i ruoli sono settabili', async () => {
    h.profili = [
      { ruolo: 'educator', area: 'teacher' },
      { ruolo: 'genitore', area: 'parent' },
    ]
    const r1 = await POST(req({ ruolo: 'educator' }))
    const r2 = await POST(req({ ruolo: 'genitore' }))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })

  it('percorso legacy senza sessione: ammesso solo il ruolo della riga utenti', async () => {
    h.profili = null
    const ok = await POST(req({ ruolo: 'educator' }))
    expect(ok.status).toBe(200)
    const ko = await POST(req({ ruolo: 'genitore' }))
    expect(ko.status).toBe(403)
  })
})
