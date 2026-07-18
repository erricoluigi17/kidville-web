import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/[id]/sconto — sconto su singola voce (slice S3):
//  409 se sconto > importo o se importo − sconto < già incassato;
//  UPDATE + ricalcolo stato; PGRST204 (colonna assente) → 503 pulito.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  pag: {} as Record<string, unknown>,
  updates: [] as { table: string; row: unknown }[],
  updateErr: null as { code: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => (table === 'pagamenti' ? { data: h.pag, error: null } : { data: null, error: null })
      b.single = async () => (h.updateErr ? { data: null, error: h.updateErr } : { data: { id: 'p-1', ...h.pag }, error: null })
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.insert = () => { b._op = 'insert'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve(h.updateErr && b._op === 'update' ? { data: null, error: h.updateErr } : { data: null, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/[id]/sconto/route'

const PID = '11111111-1111-4111-8111-111111111111'
const ctx = { params: Promise.resolve({ id: PID }) }
const post = (body: unknown) =>
  new Request(`http://localhost/api/pagamenti/${PID}/sconto`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.pag = { id: PID, importo: 100, importo_pagato: 40, tipo: 'singolo' }
  h.updates = []; h.updateErr = null
})

describe('POST sconto', () => {
  it('sconto negativo → 400 (zod min 0)', async () => {
    const res = await POST(post({ sconto: -5, sconto_motivo: 'errore' }), ctx)
    expect(res.status).toBe(400)
  })

  it('motivo mancante → 400', async () => {
    const res = await POST(post({ sconto: 10 }), ctx)
    expect(res.status).toBe(400)
  })

  it('sconto > importo → 409', async () => {
    const res = await POST(post({ sconto: 120, sconto_motivo: 'sconto fratelli' }), ctx)
    expect(res.status).toBe(409)
  })

  it('importo − sconto sotto l\'incassato (40) → 409', async () => {
    const res = await POST(post({ sconto: 70, sconto_motivo: 'sconto fratelli' }), ctx)
    expect(res.status).toBe(409) // 100 − 70 = 30 < 40
  })

  it('sconto valido → 200 e update con sconto/sconto_motivo', async () => {
    const res = await POST(post({ sconto: 30, sconto_motivo: 'sconto fratelli' }), ctx)
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'pagamenti')!.row as { sconto: number; sconto_motivo: string }
    expect(upd.sconto).toBe(30)
    expect(upd.sconto_motivo).toBe('sconto fratelli')
  })

  it('(g) colonna sconto assente (PGRST204) → 503 pulito', async () => {
    h.updateErr = { code: 'PGRST204' }
    const res = await POST(post({ sconto: 30, sconto_motivo: 'sconto fratelli' }), ctx)
    expect(res.status).toBe(503)
  })
})
