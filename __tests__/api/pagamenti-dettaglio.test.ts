import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  pag: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
  incassi: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.maybeSingle = async () => ({
        data: table === 'pagamenti' ? h.pag : table === 'legame_genitori_alunni' ? h.legame : null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'incassi' ? h.incassi : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/[id]/route'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ctx = { params: Promise.resolve({ id: PID }) }
const req = () => new Request(`http://localhost/api/pagamenti/${PID}`)

describe('GET /api/pagamenti/[id] — ruoli staff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.pag = { id: PID, alunno_id: 'al-1', tipo: 'singolo', visibile_dal: null, importo: 150, stato: 'pagato' }
    h.legame = null // nessun legame genitore: lo staff NON deve passare da lì
    h.incassi = [{ id: 'i1', importo: 150, metodo: 'bonifico', data_incasso: '2026-09-03' }]
  })

  it('la SEGRETERIA vede il dettaglio senza passare dal ramo genitore (niente 403)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.incassi).toHaveLength(1)
  })

  it('admin ok (regressione)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'staff-2', role: 'admin' } })
    expect((await GET(req(), ctx)).status).toBe(200)
  })

  it('genitore senza legame → 403 (regressione)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' } })
    const res = await GET(req(), ctx)
    expect(res.status).toBe(403)
  })

  it('401 senza sessione', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req(), ctx)).status).toBe(401)
  })
})
