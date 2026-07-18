import { it, expect, vi, beforeEach, describe } from 'vitest'

// GET /api/pagamenti/transazioni — registro + degradazione (slice S4).
//  (e) tabella pagamenti_transazioni assente (42P01/PGRST205) → { data: [], disponibile:false }.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  listResult: { data: [] as unknown, error: null as { code?: string } | null },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.in = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = async () => h.listResult
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/transazioni/route'

const SC = '22222222-2222-4222-8222-222222222222'
const get = () => new Request('http://localhost/api/pagamenti/transazioni', { headers: { 'x-user-id': 'seg-1' } })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
})

describe('GET transazioni — degradazione', () => {
  it('(e) tabella assente (42P01) → { data: [], disponibile:false }', async () => {
    h.listResult = { data: null, error: { code: '42P01' } }
    const res = await GET(get() as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(j.disponibile).toBe(false)
  })

  it('(e-bis) tabella assente (PGRST205) → degrada', async () => {
    h.listResult = { data: null, error: { code: 'PGRST205' } }
    const res = await GET(get() as never)
    const j = await res.json()
    expect(j.disponibile).toBe(false)
  })

  it('tabella presente → data e disponibile:true', async () => {
    h.listResult = { data: [{ id: 'tx-1', importo_totale: 100 }], error: null }
    const res = await GET(get() as never)
    const j = await res.json()
    expect(j.disponibile).toBe(true)
    expect(j.data).toHaveLength(1)
  })
})
