import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  retteAperte: [] as Record<string, unknown>[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
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
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.is = () => b
      b.gte = () => b
      b.maybeSingle = async () => ({
        data:
          table === 'alunni' ? { id: 'al-1', scuola_id: 'sc-1' }
          : table === 'payment_categories' ? { id: 'cat-retta' }
          : table === 'admin_settings' ? { retta_giorno_scadenza: 5 }
          : null,
        error: null,
      })
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, row }); return b }
      b.single = async () => ({ data: { id: 'al-1', scuola_id: 'sc-1' }, error: null })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'pagamenti' ? h.retteAperte : [], error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/students/route'

const AID = '22222222-2222-4222-8222-222222222222'
const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.updates = []
  h.retteAperte = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('PATCH /api/admin/students — data_iscrizione e giorno di paga', () => {
  it('persiste data_iscrizione e giorno_scadenza_pagamenti', async () => {
    const res = await PATCH(req({ id: AID, data_iscrizione: '2026-11-03', giorno_scadenza_pagamenti: 15 }) as never)
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'alunni')
    expect(upd?.row.data_iscrizione).toBe('2026-11-03')
    expect(upd?.row.giorno_scadenza_pagamenti).toBe(15)
  })

  it('al cambio del giorno riallinea le scadenze delle rette aperte future', async () => {
    h.retteAperte = [
      { id: 'r1', periodo_competenza: '2026-12-01', stato: 'da_pagare', importo_pagato: 0 },
      { id: 'r2', periodo_competenza: '2027-01-01', stato: 'parziale', importo_pagato: 50 },
    ]
    const res = await PATCH(req({ id: AID, giorno_scadenza_pagamenti: 15 }) as never)
    expect(res.status).toBe(200)
    const scadenze = h.updates.filter((u) => u.table === 'pagamenti').map((u) => u.row.scadenza)
    expect(scadenze).toContain('2026-12-15')
    expect(scadenze).toContain('2027-01-15')
  })

  it('giorno rimesso a NULL → riallinea sul default di scuola (5)', async () => {
    h.retteAperte = [{ id: 'r1', periodo_competenza: '2026-12-01', stato: 'da_pagare', importo_pagato: 0 }]
    const res = await PATCH(req({ id: AID, giorno_scadenza_pagamenti: null }) as never)
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'pagamenti')
    expect(upd?.row.scadenza).toBe('2026-12-05')
  })

  it('se il giorno NON cambia, le rette non vengono toccate', async () => {
    h.retteAperte = [{ id: 'r1', periodo_competenza: '2026-12-01', stato: 'da_pagare', importo_pagato: 0 }]
    await PATCH(req({ id: AID, data_iscrizione: '2026-01-01' }) as never)
    expect(h.updates.filter((u) => u.table === 'pagamenti')).toHaveLength(0)
  })
})
