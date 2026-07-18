import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// S5 — sospensione a granularità FAMIGLIA: `parent_account_id` sospende TUTTI i
// figli dell'unione legami; `causa` scritta in `sospeso_causa` (best-effort).
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logScrittura: vi.fn(),
  getFigli: vi.fn(),
  notificaEvento: vi.fn(),
  updates: [] as { row: Record<string, unknown>; id: unknown }[],
  // Se true, l'update CON sospeso_causa fallisce PGRST204 (DB non migrato).
  failCausa: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: h.assertAlunnoInScope }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: h.getFigli }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: { scuola_id: 's1' }, error: null })
      b.update = (row: Record<string, unknown>) => ({
        eq: async (_c: string, v: unknown) => {
          if (h.failCausa && 'sospeso_causa' in row && row.sospeso_causa != null) {
            return { error: { code: 'PGRST204' } }
          }
          h.updates.push({ row, id: v })
          return { error: null }
        },
      })
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/pagamenti/sospensione/route'

const G1 = 'cccccccc-1111-4111-8111-111111111111'
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const A2 = 'aaaaaaaa-2222-4222-8222-222222222222'

function post(body: unknown) {
  return new Request('http://localhost/api/admin/pagamenti/sospensione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.updates = []
  h.failCausa = false
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 's1' } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.getFigli.mockResolvedValue([A1, A2])
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST sospensione — modalità FAMIGLIA (parent_account_id)', () => {
  it('sospende TUTTI i figli dell\'unione con causa morosita', async () => {
    const res = await POST(post({ parent_account_id: G1, sospeso: true, causa: 'morosita', motivo: '3 rate' }))
    expect(res.status).toBe(200)
    expect(h.getFigli).toHaveBeenCalledWith(expect.anything(), G1)
    expect(h.updates).toHaveLength(2)
    const ids = h.updates.map((u) => u.id).sort()
    expect(ids).toEqual([A1, A2].sort())
    for (const u of h.updates) {
      expect(u.row.sospeso).toBe(true)
      expect(u.row.sospeso_causa).toBe('morosita')
    }
    expect(h.notificaEvento).toHaveBeenCalled()
  })

  it('causa default = morosita quando omessa', async () => {
    await POST(post({ parent_account_id: G1, sospeso: true }))
    expect(h.updates[0].row.sospeso_causa).toBe('morosita')
  })

  it('best-effort PGRST204: colonna sospeso_causa assente → retry senza causa, applica comunque', async () => {
    h.failCausa = true
    h.getFigli.mockResolvedValue([A1])
    const res = await POST(post({ parent_account_id: G1, sospeso: true, causa: 'altro' }))
    expect(res.status).toBe(200)
    // Ha scritto (retry senza causa): sospeso applicato, senza la colonna nuova.
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].row.sospeso).toBe(true)
    expect(h.updates[0].row.sospeso_causa).toBeUndefined()
  })

  it('400 se manca sia alunno_id sia parent_account_id', async () => {
    const res = await POST(post({ sospeso: true }))
    expect(res.status).toBe(400)
  })

  it('403 se requireStaff nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(post({ parent_account_id: G1, sospeso: true }))
    expect(res.status).toBe(403)
  })
})
