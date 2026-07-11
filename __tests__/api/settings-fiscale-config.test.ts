import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  upserted: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.upsert = (row: Record<string, unknown>) => {
        h.upserted = row
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/settings/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

describe('PATCH /api/admin/settings — fiscale_config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.upserted = null
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('accetta fiscale_config e lo salva in shallow-merge con l\'esistente', async () => {
    h.existing = { fiscale_config: { denominazione: 'Kidville Giugliano' } }
    const res = await PATCH(req({ scuola_id: '11111111-1111-4111-8111-111111111111', fiscale_config: { piva: '01234567890' } }))
    expect(res.status).toBe(200)
    expect(h.upserted?.fiscale_config).toEqual({ denominazione: 'Kidville Giugliano', piva: '01234567890' })
  })

  it('accetta solleciti_config e lo salva in shallow-merge con l\'esistente', async () => {
    h.existing = { solleciti_config: { enabled: false } }
    const res = await PATCH(req({ scuola_id: '11111111-1111-4111-8111-111111111111', solleciti_config: { cadenza_min_giorni: 10 } }))
    expect(res.status).toBe(200)
    expect(h.upserted?.solleciti_config).toEqual({ enabled: false, cadenza_min_giorni: 10 })
  })
})
