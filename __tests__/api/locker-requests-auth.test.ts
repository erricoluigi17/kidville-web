import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M9 — PATCH /api/locker/requests (CAMBIO STATO = scuola) mutava lo stato di
// qualsiasi richiesta senza gate. Ora: requireDocente + scope di sezione.
const h = vi.hoisted(() => {
  const rowResult = { current: { data: { id: 'req1', alunno_id: 'a1' }, error: null } as { data: unknown; error: unknown } }
  const fromSpy = vi.fn(() => {
    const qb: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update', 'order', 'in']) qb[m] = () => qb
    qb.maybeSingle = () => Promise.resolve(rowResult.current)
    qb.single = () => Promise.resolve({ data: { id: 'req1', stato: 'acknowledged' }, error: null })
    return qb
  })
  return { requireDocente: vi.fn(), assertAlunnoInScope: vi.fn(), fromSpy, rowResult }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  scuoleDiUtente: vi.fn().mockResolvedValue(['sc1']),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { PATCH } from '@/app/api/locker/requests/route'

function req(body: unknown) {
  return new Request('http://localhost/api/locker/requests', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const validBody = { id: '22222222-2222-2222-2222-222222222222', stato: 'acknowledged' }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc1' } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.rowResult.current = { data: { id: 'req1', alunno_id: 'a1' }, error: null }
})

describe('PATCH /api/locker/requests — gate docente + scope (M9)', () => {
  it('401 anonimo: nessuna mutazione', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await PATCH(req(validBody) as never)
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('403 genitore: il cambio stato è riservato alla scuola', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await PATCH(req(validBody) as never)
    expect(res.status).toBe(403)
  })

  it('403 docente fuori scope (alunno di altra sezione/plesso)', async () => {
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({ error: 'fuori scope' }, { status: 403 }))
    const res = await PATCH(req(validBody) as never)
    expect(res.status).toBe(403)
  })

  it('200 docente in scope', async () => {
    const res = await PATCH(req(validBody) as never)
    expect(res.status).toBe(200)
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'a1')
  })

  it('tabella assente → degrada pulito (ok:true, degraded:true)', async () => {
    h.rowResult.current = { data: null, error: { code: '42P01', message: 'does not exist' } }
    const res = await PATCH(req(validBody) as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ ok: true, degraded: true })
  })
})
