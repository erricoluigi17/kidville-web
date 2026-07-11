import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  ricevute: [] as Record<string, unknown>[],
  selectErr: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: vi.fn(async () => ['sc-1']) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(h.selectErr ? { data: null, error: h.selectErr } : { data: h.ricevute, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/ricevute/route'

const req = (qs = '') => new Request(`http://localhost/api/pagamenti/ricevute?${qs}`) as unknown as import('next/server').NextRequest

describe('GET /api/pagamenti/ricevute — registro', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.selectErr = null
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.ricevute = [{ id: 'r1', numero: 1, anno: 2026, importo: 150, tracciabile: true, annullata_il: null, alunni: { nome: 'Mario', cognome: 'Rossi' } }]
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(req())).status).toBe(403)
  })

  it('200 con elenco', async () => {
    const res = await GET(req('anno=2026'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    expect(j.disponibile).not.toBe(false)
  })

  it('degrada se il registro non esiste (42P01) → lista vuota, disponibile:false', async () => {
    h.selectErr = { code: '42P01', message: 'relation does not exist' }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(j.disponibile).toBe(false)
  })
})
