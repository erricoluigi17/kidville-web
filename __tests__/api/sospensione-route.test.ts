import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logScrittura: vi.fn(),
  updates: [] as { row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: h.assertAlunnoInScope }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => ({ update: (row: Record<string, unknown>) => ({ eq: async () => { h.updates.push({ row }); return { error: null } } }) }),
  }),
}))

import { POST } from '@/app/api/admin/pagamenti/sospensione/route'

function post(body: unknown) {
  return new Request('http://localhost/api/admin/pagamenti/sospensione', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/pagamenti/sospensione', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updates.length = 0
    h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 's1' } })
    h.assertAlunnoInScope.mockResolvedValue(null)
  })

  it('è gated alla Direzione (requireStaff con allowlist admin/coordinator)', async () => {
    await POST(post({ alunno_id: 'a1', sospeso: true }))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })

  it('blocca se requireStaff nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(post({ alunno_id: 'a1', sospeso: true }))
    expect(res.status).toBe(403)
  })

  it('400 senza alunno_id', async () => {
    const res = await POST(post({ sospeso: true }))
    expect(res.status).toBe(400)
  })

  it('sospende: set sospeso=true + motivo + sospeso_da + audit', async () => {
    const res = await POST(post({ alunno_id: 'a1', sospeso: true, motivo: 'morosità 3 rate' }))
    expect(res.status).toBe(200)
    expect(h.updates[0].row.sospeso).toBe(true)
    expect(h.updates[0].row.sospeso_motivo).toBe('morosità 3 rate')
    expect(h.updates[0].row.sospeso_da).toBe('dir-1')
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })

  it('riattiva: set sospeso=false e azzera sospeso_il/motivo', async () => {
    const res = await POST(post({ alunno_id: 'a1', sospeso: false }))
    expect(res.status).toBe(200)
    expect(h.updates[0].row.sospeso).toBe(false)
    expect(h.updates[0].row.sospeso_il).toBeNull()
  })

  it('rispetta lo scope tenant (assertAlunnoInScope)', async () => {
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({}, { status: 404 }))
    const res = await POST(post({ alunno_id: 'a1', sospeso: true }))
    expect(res.status).toBe(404)
    expect(h.updates.length).toBe(0)
  })
})
