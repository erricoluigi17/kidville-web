import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  updated: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
  assertAlunnoInScope: async () => null,
  assertAlunniInSezione: async () => null,
  assertSezioneInScope: async () => null,
  scuoleDiUtente: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.maybeSingle = async () => ({ data: { id: 'al-1', scuola_id: 'sc-1' }, error: null })
      b.update = (row: Record<string, unknown>) => { h.updated = row; return b }
      b.single = async () => ({ data: { id: 'al-1', scuola_id: 'sc-1' }, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/students/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

describe('PATCH /api/admin/students — opposizione_ade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updated = null
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  })

  it('accetta e persiste opposizione_ade sull\'alunno', async () => {
    const res = await PATCH(req({ id: '22222222-2222-4222-8222-222222222222', opposizione_ade: true }) as never)
    expect(res.status).toBe(200)
    expect(h.updated?.opposizione_ade).toBe(true)
  })
})
