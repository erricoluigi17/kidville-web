import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  staff: [] as Record<string, unknown>[],
  updates: [] as { id: unknown; row: Record<string, unknown> }[],
  sezioniDeleted: [] as unknown[],
  sezioniInserted: [] as Record<string, unknown>[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.neq = () => b
      b.order = () => b
      b.then = (res: (v: unknown) => void) => res({ data: table === 'utenti' ? h.staff : [], error: null })
      b.update = (row: Record<string, unknown>) => ({ eq: async (_c: string, v: unknown) => { h.updates.push({ id: v, row }); return { error: null } } })
      b.delete = () => ({ eq: async (_c: string, v: unknown) => { h.sezioniDeleted.push(v); return { error: null } } })
      b.insert = async (rows: Record<string, unknown>[]) => { h.sezioniInserted.push(rows); return { error: null } }
      return b
    },
  }),
}))

import { GET, PATCH } from '@/app/api/admin/staff/route'

function patchReq(body: unknown) {
  return new Request('http://localhost/api/admin/staff', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('/api/admin/staff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updates = []; h.sezioniDeleted = []; h.sezioniInserted = []
    h.staff = [{ id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', nome: 'Anna', ruolo: 'educator' }]
    h.requireStaff.mockResolvedValue({ user: { id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', role: 'admin', scuola_id: 's1' } })
  })

  it('GET è gated alla Direzione (admin/coordinator)', async () => {
    await GET(new Request('http://localhost/api/admin/staff'))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })

  it('PATCH gated: blocca se requireStaff nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await PATCH(patchReq({ id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', ruolo: 'segreteria' }))).status).toBe(403)
  })

  it('PATCH 400 con ruolo non assegnabile (es. genitore)', async () => {
    expect((await PATCH(patchReq({ id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', ruolo: 'genitore' }))).status).toBe(400)
  })

  it('PATCH 403 se la Direzione tenta di cambiare il PROPRIO ruolo (self-lockout guard)', async () => {
    const res = await PATCH(patchReq({ id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', ruolo: 'educator' }))
    expect(res.status).toBe(403)
    expect(h.updates).toHaveLength(0)
  })

  it('PATCH: aggiorna ruolo/sede, rimpiazza le classi e traccia audit', async () => {
    const res = await PATCH(patchReq({ id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', ruolo: 'segreteria', scuola_id: '52525252-5252-4525-8525-525252525252', section_ids: ['sec-1', 'sec-2'] }))
    expect(res.status).toBe(200)
    expect(h.updates[0].row.ruolo).toBe('segreteria')
    expect(h.updates[0].row.scuola_id).toBe('52525252-5252-4525-8525-525252525252')
    expect(h.sezioniDeleted).toContain('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1')
    expect(h.sezioniInserted[0]).toHaveLength(2)
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })
})
