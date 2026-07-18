import { it, expect, vi, beforeEach, describe } from 'vitest'

// PATCH /api/pagamenti/[id] — validazioni Contabilità v2 (slice S3):
//  (a) importo negativo → 400 (zod min 0, zero ammesso per le esenzioni);
//  (b) nuovo importo − sconto sotto l'incassato → 409 «storna prima».
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuole: vi.fn(),
  notifica: vi.fn(),
  annulla: vi.fn(),
  pag: {} as Record<string, unknown>,
  pagErr: null as { code: string } | null,
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireStaff,
}))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scuole(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/pagamenti/ricevute', () => ({ annullaRicevutaAttiva: (...a: unknown[]) => h.annulla(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.limit = () => b
      b.maybeSingle = async () => (table === 'pagamenti' ? { data: h.pag, error: h.pagErr } : { data: null, error: null })
      b.single = async () => ({ data: { id: 'p-1', tipo: 'singolo', ...h.pag }, error: null })
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.insert = () => b
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/pagamenti/[id]/route'

const PID = '11111111-1111-4111-8111-111111111111'
const ctx = { params: Promise.resolve({ id: PID }) }
const patch = (body: unknown) =>
  new Request(`http://localhost/api/pagamenti/${PID}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuole.mockResolvedValue(['sc-1'])
  h.notifica.mockResolvedValue(undefined)
  h.annulla.mockResolvedValue(undefined)
  h.pag = { scuola_id: 'sc-1', stato: 'parziale', alunno_id: 'al-1', descrizione: 'Retta', importo_pagato: 80, sconto: 0, tipo: 'singolo' }
  h.pagErr = null
  h.updates = []
})

describe('PATCH pagamento — guardie importo', () => {
  it('(a) importo −5 → 400 (zod min 0)', async () => {
    const res = await PATCH(patch({ importo: -5 }), ctx)
    expect(res.status).toBe(400)
  })

  it('importo 0 è ammesso (esenzione)', async () => {
    // 0 − sconto(0) = 0 < importo_pagato(80) → 409 per la guardia, NON 400 dallo zod.
    const res = await PATCH(patch({ importo: 0 }), ctx)
    expect(res.status).not.toBe(400)
  })

  it('(b) nuovo importo 50 sotto l\'incassato 80 → 409', async () => {
    const res = await PATCH(patch({ importo: 50 }), ctx)
    expect(res.status).toBe(409)
    expect(h.updates.find((u) => u.table === 'pagamenti')).toBeUndefined()
  })

  it('nuovo importo 200 sopra l\'incassato → 200 e update applicato', async () => {
    const res = await PATCH(patch({ importo: 200 }), ctx)
    expect(res.status).toBe(200)
    expect(h.updates.find((u) => u.table === 'pagamenti')).toBeDefined()
  })

  it('scadenza in formato errato → 400', async () => {
    const res = await PATCH(patch({ scadenza: '15/09/2026' }), ctx)
    expect(res.status).toBe(400)
  })
})
