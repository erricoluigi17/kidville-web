import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/ticket — dal 2026-10-10 una sola RPC, `ricarica_ticket_mensa`
// (fase 5 robustezza). Saldo, pagamento, incasso, movimento e guardia del duplicato
// sono provati su Postgres vero in `__tests__/lib/ricarica-ticket-mensa-sql.test.ts`.
// Questo file sostituisce `ticket-ricarica-atomica` e `ticket-ricarica-duplicata`,
// che provavano le quattro scritture separate di prima. Qui:
//  (a) i parametri alla RPC (confini del giorno CIVILE, conferma nominata);
//  (b) ogni esito nello status giusto, col 409 del duplicato senza dati personali;
//  (c) la route non scrive MAI da sé saldo, pagamenti, incassi o movimenti.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  notifica: vi.fn(),
  rpc: vi.fn(),
  scritture: [] as { table: string; op: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: async () => true }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (fn: string, params: Record<string, unknown>) => h.rpc(fn, params),
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'gte', 'lte', 'order', 'limit']) b[m] = () => b
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        b[op] = () => { h.scritture.push({ table, op }); return b }
      }
      b.maybeSingle = async () => ({ data: null, error: null })
      b.single = async () => ({ data: null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/ticket/route'

const SC = '22222222-2222-4222-8222-222222222222'
const AL = '55555555-5555-4555-8555-555555555555'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' },
    body: JSON.stringify(body),
  })
const CORPO = { alunno_id: AL, pezzi: 10, costo: 50, metodo: 'contanti' }
const OK = { data: { esito: 'ok', saldo: 12, scuola_id: SC, pagamento_id: 'pag-1', incasso_id: 'inc-1' }, error: null }

const params = () => {
  const c = h.rpc.mock.calls.find((x) => x[0] === 'ricarica_ticket_mensa')
  expect(c, 'la route non ha chiamato ricarica_ticket_mensa').toBeDefined()
  return c![1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue(null)
  h.notifica.mockResolvedValue(undefined)
  h.rpc.mockResolvedValue(OK)
  h.scritture = []
})

describe('ricarica ticket — la route traduce la RPC', () => {
  it('ricarica → 201 col saldo della RPC; alla RPC pezzi, costo, operatore e i confini del giorno civile', async () => {
    const res = await POST(post(CORPO))
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({ saldo_ticket: 12, pagamento_id: 'pag-1', incasso_registrato: true })
    const p = params()
    expect(p).toMatchObject({ p_alunno_id: AL, p_pezzi: 10, p_costo: 50, p_operatore: 'seg-1', p_metodo: 'contanti', p_conferma_duplicato: false })
    // confini del giorno CIVILE come istanti: 24 h (o 23/25 al cambio d'ora) meno un millesimo
    const dalle = Date.parse(String(p.p_giorno_dalle))
    const alle = Date.parse(String(p.p_giorno_alle))
    expect(Number.isFinite(dalle) && Number.isFinite(alle)).toBe(true)
    expect(alle - dalle).toBeGreaterThan(22 * 3_600_000)
    expect(alle - dalle).toBeLessThan(26 * 3_600_000)
    expect(h.notifica).toHaveBeenCalledTimes(1)
  })

  it('duplicato → 409 col codice e la ricarica precedente, senza dati personali; nessuna notifica', async () => {
    h.rpc.mockResolvedValue({ data: { esito: 'duplicato', precedente: { creato_il: '2026-09-07T09:30:00Z', pezzi: 10, importo: '50.00' } }, error: null })
    const res = await POST(post(CORPO))
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.codice).toBe('TICKET_RICARICA_DUPLICATA')
    expect(j.precedente).toEqual({ creato_il: '2026-09-07T09:30:00Z', pezzi: 10, importo: 50 })
    expect(Object.keys(j).sort()).toEqual(['codice', 'error', 'precedente'])
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('la ricarica dal wizard ha importo ignoto: null, non zero', async () => {
    h.rpc.mockResolvedValue({ data: { esito: 'duplicato', precedente: { creato_il: 'x', pezzi: 4, importo: null } }, error: null })
    expect((await (await POST(post(CORPO))).json()).precedente.importo).toBeNull()
  })

  it('conferma esplicita → passa alla RPC; un valore inventato → 400 e la RPC non parte', async () => {
    await POST(post({ ...CORPO, conferma_duplicato: 'gia_ricaricato_oggi' }))
    expect(params().p_conferma_duplicato).toBe(true)
    h.rpc.mockClear()
    const res = await POST(post({ ...CORPO, conferma_duplicato: true }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('pezzi non interi → 400 dallo schema, la RPC non parte', async () => {
    expect((await POST(post({ ...CORPO, pezzi: 2.5 }))).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('costo 0 → incasso_registrato null (nessun incasso dovuto), non false', async () => {
    h.rpc.mockResolvedValue({ data: { ...OK.data, incasso_id: null }, error: null })
    expect((await (await POST(post({ ...CORPO, costo: 0 }))).json()).data.incasso_registrato).toBeNull()
  })

  it("l'alunno fuori dal proprio plesso è 403 PRIMA della RPC (nessun 409 rivela niente)", async () => {
    const { NextResponse } = await import('next/server')
    h.scope.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 403 }))
    expect((await POST(post(CORPO))).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('errori: PGRST202 → 503, 22P02 → 400, non_trovato → 404, altro → 500', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } })
    expect((await POST(post(CORPO))).status).toBe(503)
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '22P02', message: 'x' } })
    expect((await POST(post(CORPO))).status).toBe(400)
    h.rpc.mockResolvedValueOnce({ data: { esito: 'non_trovato' }, error: null })
    expect((await POST(post(CORPO))).status).toBe(404)
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'x' } })
    expect((await POST(post(CORPO))).status).toBe(500)
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('(c) la route non scrive mai da sé', async () => {
    await POST(post(CORPO))
    expect(h.scritture).toEqual([])
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['ricarica_ticket_mensa'])
  })
})
