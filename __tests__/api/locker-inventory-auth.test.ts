import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M9 — POST /api/locker/inventory (CARICO = genitore che porta materiale)
// accettava qualsiasi alunno_id senza gate. Ora: requireParentOfStudent + audit.
const h = vi.hoisted(() => {
  const fromSpy = vi.fn((table: string) => {
    const qb: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update', 'insert', 'order', 'in', 'gte', 'lte']) qb[m] = () => qb
    qb.single = () =>
      Promise.resolve({ data: { id: 'r1', materiale: 'Pannolini', quantita: 3 }, error: null })
    qb.maybeSingle = () =>
      Promise.resolve(
        table === 'alunni'
          ? { data: { section_id: 'sec1', scuola_id: 'sc1' }, error: null }
          : { data: null, error: null }, // armadietto: nessun record esistente → insert
      )
    ;(qb as { then: unknown }).then = (res: (v: { data: unknown; error: null }) => unknown) =>
      res({ data: [], error: null })
    return qb
  })
  return { requireParentOfStudent: vi.fn(), logScrittura: vi.fn(), fromSpy }
})

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
  createClient: async () => ({ from: h.fromSpy, auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

import { POST } from '@/app/api/locker/inventory/route'

const ALUNNO = '11111111-1111-1111-1111-111111111111'
function req(body: unknown) {
  return new Request('http://localhost/api/locker/inventory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const validBody = { alunno_id: ALUNNO, materiale: 'Pannolini', quantita: 3 }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'p1', role: 'genitore', scuola_id: 'sc1' } })
})

describe('POST /api/locker/inventory — gate genitore↔alunno (M9)', () => {
  it('401 anonimo: nessuna scrittura', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      response: NextResponse.json({ error: 'x' }, { status: 401 }),
    })
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('403 IDOR: genitore che carica su un figlio non suo', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(403)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200 per il genitore legittimo + audit (logScrittura)', async () => {
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(h.requireParentOfStudent).toHaveBeenCalledWith(expect.anything(), ALUNNO)
    expect(h.logScrittura).toHaveBeenCalled()
  })
})
