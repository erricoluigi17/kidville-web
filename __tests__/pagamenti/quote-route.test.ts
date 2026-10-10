import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST/PATCH /api/pagamenti/quote — dal 2026-10-10 tutto in `aggiorna_quote_pagamento`
// (fase 5 robustezza). La logica è provata su Postgres vero in
// `__tests__/lib/aggiorna-quote-pagamento-sql.test.ts`; qui: parametri, status, e
// che la route non scriva mai `pagamenti_quote` da sé.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  rpc: vi.fn(),
  scritture: [] as { table: string; op: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertPagamentoInScope: async () => null }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (nome: string, args: unknown) => h.rpc(nome, args),
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        b[op] = () => { h.scritture.push({ table, op }); return b }
      }
      b.maybeSingle = async () => ({ data: null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
  }),
}))

import { POST, PATCH } from '@/app/api/pagamenti/quote/route'

const PID = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const req = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/pagamenti/quote', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const corpo = { pagamento_id: PID, quote: [{ adult_id: A, importo: 150 }, { adult_id: B, importo: '150', etichetta: 'papà' }] }

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.rpc.mockResolvedValue({ data: { esito: 'ok', quote: [{ id: 'q1' }, { id: 'q2' }], tolte: 0 }, error: null })
})

describe('quote — la route traduce la RPC', () => {
  it('ok → 200 con le quote; alla RPC pagamento, quote e operatore', async () => {
    const res = await POST(req(corpo))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([{ id: 'q1' }, { id: 'q2' }])
    const [nome, args] = h.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(nome).toBe('aggiorna_quote_pagamento')
    expect(args).toEqual({
      p_pagamento_id: PID,
      p_quote: [{ adult_id: A, importo: 150, etichetta: null }, { adult_id: B, importo: '150', etichetta: 'papà' }],
      p_utente_id: 'seg-1',
    })
  })

  it('PATCH fa la stessa cosa', async () => {
    expect((await PATCH(req(corpo, 'PATCH'))).status).toBe(200)
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it('esiti: somma_diversa 400, adulto_ripetuto 400, quota_con_incassi 409, non_trovato 404', async () => {
    h.rpc.mockResolvedValueOnce({ data: { esito: 'somma_diversa', somma: '200.00', importo: '300.00' }, error: null })
    const r1 = await POST(req(corpo))
    expect(r1.status).toBe(400)
    expect((await r1.json()).error).toContain('200')
    h.rpc.mockResolvedValueOnce({ data: { esito: 'adulto_ripetuto', adult_id: A }, error: null })
    expect((await POST(req(corpo))).status).toBe(400)
    h.rpc.mockResolvedValueOnce({ data: { esito: 'quota_con_incassi', quote: ['q9'] }, error: null })
    const r3 = await POST(req(corpo))
    expect(r3.status).toBe(409)
    expect((await r3.json()).codice).toBe('QUOTE_CON_INCASSI')
    h.rpc.mockResolvedValueOnce({ data: { esito: 'non_trovato' }, error: null })
    expect((await POST(req(corpo))).status).toBe(404)
  })

  it('errori della RPC: PGRST202 → 503, 23503 → 400, altro → 500', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } })
    expect((await POST(req(corpo))).status).toBe(503)
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '23503', message: 'x' } })
    expect((await POST(req(corpo))).status).toBe(400)
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'x' } })
    expect((await POST(req(corpo))).status).toBe(500)
  })

  it('una quota sola → 400 dallo schema, la RPC non parte', async () => {
    const res = await POST(req({ pagamento_id: PID, quote: [{ adult_id: A, importo: 300 }] }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la route non scrive mai pagamenti_quote né pagamenti da sé', async () => {
    await POST(req(corpo))
    expect(h.scritture).toEqual([])
  })
})
