import { it, expect, vi, beforeEach, describe } from 'vitest'

// GET/POST /api/pagamenti/credito — credito famiglia (slice S4).
//  (g) utilizzo oltre il saldo → 409 pulito (nessuna RPC);
//  utilizzo valido → RPC utilizza_credito_famiglia + verificaRevoca;
//  RPC assente (PGRST202) → 503; GET → saldo + movimenti.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  saldo: vi.fn(),
  revoca: vi.fn(),
  rpcCalls: [] as { fn: string; params: unknown }[],
  rpcResult: { data: null as unknown, error: null as { code?: string } | null },
  movimenti: { data: [] as unknown, error: null as { code?: string } | null },
  pagamento: { alunno_id: 'al-1' } as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/pagamenti/credito', () => ({ saldoCredito: (...a: unknown[]) => h.saldo(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (fn: string, params: unknown) => { h.rpcCalls.push({ fn, params }); return h.rpcResult },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => (table === 'pagamenti' ? { data: h.pagamento, error: null } : { data: null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve(table === 'crediti_famiglia' ? h.movimenti : { data: [], error: null })
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/pagamenti/credito/route'

const PARENT = '33333333-3333-4333-8333-333333333333'
const PID = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/credito', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })
const get = (qs: string) => new Request(`http://localhost/api/pagamenti/credito?${qs}`, { headers: { 'x-user-id': 'seg-1' } })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.saldo.mockResolvedValue(100)
  h.revoca.mockResolvedValue({ revocati: [] })
  h.rpcCalls = []
  h.rpcResult = { data: { incasso_id: 'inc-1', importo: 40, saldo: 60 }, error: null }
  h.movimenti = { data: [{ id: 'cf-1', causale: 'eccedenza', importo: 100, saldo_dopo: 100 }], error: null }
  h.pagamento = { alunno_id: 'al-1' }
})

describe('POST credito — utilizzo su voce', () => {
  it('(g) importo oltre il saldo → 409 pulito, nessuna RPC', async () => {
    h.saldo.mockResolvedValue(10)
    const res = await POST(post({ parent_id: PARENT, pagamento_id: PID, importo: 50 }))
    expect(res.status).toBe(409)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('utilizzo valido → RPC utilizza_credito_famiglia + verificaRevoca', async () => {
    const res = await POST(post({ parent_id: PARENT, pagamento_id: PID, importo: 40 }))
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].fn).toBe('utilizza_credito_famiglia')
    const p = (h.rpcCalls[0].params as { p: Record<string, unknown> }).p
    expect(p).toMatchObject({ parent_id: PARENT, pagamento_id: PID, importo: 40, registrato_da: 'seg-1' })
    expect(h.revoca).toHaveBeenCalledTimes(1)
  })

  it('RPC assente (PGRST202) → 503', async () => {
    h.rpcResult = { data: null, error: { code: 'PGRST202' } }
    const res = await POST(post({ parent_id: PARENT, pagamento_id: PID, importo: 40 }))
    expect(res.status).toBe(503)
  })

  it('RPC raise (credito insufficiente race, P0001) → 409', async () => {
    h.rpcResult = { data: null, error: { code: 'P0001' } as { code: string } }
    const res = await POST(post({ parent_id: PARENT, pagamento_id: PID, importo: 40 }))
    expect(res.status).toBe(409)
  })

  it('importo non positivo → 400', async () => {
    const res = await POST(post({ parent_id: PARENT, pagamento_id: PID, importo: 0 }))
    expect(res.status).toBe(400)
  })
})

describe('GET credito — saldo e movimenti', () => {
  it('ritorna saldo + movimenti', async () => {
    const res = await GET(get(`parent_id=${PARENT}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.saldo).toBe(100)
    expect(j.data.movimenti).toHaveLength(1)
  })

  it('parent_id mancante → 400', async () => {
    const res = await GET(get(''))
    expect(res.status).toBe(400)
  })
})
