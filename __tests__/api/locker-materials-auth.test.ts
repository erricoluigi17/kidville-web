import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// m1 — GET /api/locker/materials enumerava la configurazione materiali in modo
// anonimo. Ora: requireUser (i genitori autenticati leggono comunque).
const h = vi.hoisted(() => {
  const fromSpy = vi.fn(() => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.order = () => qb
    ;(qb as { then: unknown }).then = (res: (v: { data: unknown; error: null }) => unknown) =>
      res({ data: [{ id: 'c1', nome: 'Pannolini', attivo: true, ordine: 1 }], error: null })
    return qb
  })
  return { requireUser: vi.fn(), requireDocente: vi.fn(), fromSpy }
})

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({ assertClasseNomeInScope: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { GET } from '@/app/api/locker/materials/route'
import { NextRequest } from 'next/server'

const req = (qs = '') => new NextRequest(`http://localhost/api/locker/materials${qs ? '?' + qs : ''}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
})

describe('GET /api/locker/materials — gate utente autenticato (m1)', () => {
  it('401 anonimo: niente enumerazione della configurazione', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req('classe_sezione=Girasoli'))
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200 per l\'utente autenticato', async () => {
    const res = await GET(req('classe_sezione=Girasoli'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(Array.isArray(j)).toBe(true)
    expect(j.length).toBeGreaterThan(0)
    expect(h.requireUser).toHaveBeenCalled()
  })
})
