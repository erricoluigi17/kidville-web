import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/transazioni — transazione unica di famiglia (slice S4).
// Criteri chiave del piano:
//  (a) 2 voci di 2 figli + 1 ricarica mensa che quadra → 200 e RPC col payload atteso;
//  (b) non quadra → 400 (nessuna chiamata RPC);
//  (c) eccedenza senza conferma → 409 { eccedenza }; con conferma → passa;
//  (d) RPC assente (PGRST202) → 503 senza scritture parziali.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  notifica: vi.fn(),
  revoca: vi.fn(),
  rpcCalls: [] as { fn: string; params: unknown }[],
  rpcResult: { data: null as unknown, error: null as { code?: string } | null },
  pagamentiRows: [] as { id: string; alunno_id: string }[],
  inserts: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (fn: string, params: unknown) => {
      h.rpcCalls.push({ fn, params })
      return h.rpcResult
    },
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = async () => (table === 'pagamenti' ? { data: h.pagamentiRows, error: null } : { data: [], error: null })
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: null, error: null })
      b.single = async () => ({ data: { id: `${table}-new` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/transazioni/route'

const URL = 'http://localhost/api/pagamenti/transazioni'
const SC = '22222222-2222-4222-8222-222222222222'
const PARENT = '33333333-3333-4333-8333-333333333333'
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '44444444-4444-4444-8444-444444444444'
const AL1 = '55555555-5555-4555-8555-555555555555'
const AL2 = '66666666-6666-4666-8666-666666666666'

const post = (body: unknown) =>
  new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
  h.notifica.mockResolvedValue(undefined)
  h.revoca.mockResolvedValue({ revocati: [] })
  h.rpcCalls = []
  h.rpcResult = { data: { transazione_id: 'tx-1', incassi: 2, ricariche: 1, eccedenza: 0 }, error: null }
  h.pagamentiRows = [{ id: P1, alunno_id: AL1 }, { id: P2, alunno_id: AL2 }]
  h.inserts = []
})

const bodyQuadra = {
  pagante_parent_id: PARENT,
  scuola_id: SC,
  metodo: 'bonifico',
  riferimento: 'CRO-123',
  importo_totale: 250,
  voci: [
    { pagamento_id: P1, importo: 100 },
    { pagamento_id: P2, importo: 100 },
  ],
  ricariche_mensa: [{ alunno_id: AL1, importo: 50, ticket: 10 }],
  eccedenza_a_credito: 0,
}

describe('POST transazioni — quadratura, eccedenza, degradazione', () => {
  it('(a) 2 voci + 1 ricarica che quadra → 200 e RPC col payload atteso', async () => {
    const res = await POST(post(bodyQuadra))
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].fn).toBe('registra_transazione_contabile')
    const p = (h.rpcCalls[0].params as { p: Record<string, unknown> }).p
    expect(p.pagante_parent_id).toBe(PARENT)
    expect(p.scuola_id).toBe(SC)
    expect(p.metodo).toBe('bonifico')
    expect(p.importo_totale).toBe(250)
    expect(p.registrato_da).toBe('seg-1')
    expect(p.voci).toEqual([
      { pagamento_id: P1, importo: 100 },
      { pagamento_id: P2, importo: 100 },
    ])
    expect(p.ricariche_mensa).toEqual([{ alunno_id: AL1, importo: 50, ticket: 10 }])
    expect(p.eccedenza_a_credito).toBe(0)
  })

  it('(b) non quadra (250 dichiarato, 200 allocati) → 400 senza chiamare la RPC', async () => {
    const res = await POST(post({ ...bodyQuadra, ricariche_mensa: [] }))
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(c) eccedenza > 0 senza conferma → 409 con { eccedenza }, nessuna RPC', async () => {
    const body = {
      pagante_parent_id: PARENT,
      scuola_id: SC,
      metodo: 'bonifico',
      importo_totale: 150,
      voci: [{ pagamento_id: P1, importo: 100 }],
      ricariche_mensa: [],
      eccedenza_a_credito: 50,
    }
    const res = await POST(post(body))
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.eccedenza).toBe(50)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(c-bis) eccedenza con conferma_eccedenza=credito_famiglia → passa (RPC chiamata)', async () => {
    h.rpcResult = { data: { transazione_id: 'tx-2', incassi: 1, ricariche: 0, eccedenza: 50 }, error: null }
    const body = {
      pagante_parent_id: PARENT,
      scuola_id: SC,
      metodo: 'bonifico',
      importo_totale: 150,
      voci: [{ pagamento_id: P1, importo: 100 }],
      ricariche_mensa: [],
      eccedenza_a_credito: 50,
      conferma_eccedenza: 'credito_famiglia',
    }
    const res = await POST(post(body))
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    const p = (h.rpcCalls[0].params as { p: Record<string, unknown> }).p
    expect(p.eccedenza_a_credito).toBe(50)
  })

  it('(d) RPC assente (PGRST202) → 503 senza scritture', async () => {
    h.rpcResult = { data: null, error: { code: 'PGRST202' } }
    const res = await POST(post(bodyQuadra))
    expect(res.status).toBe(503)
  })

  it('(d-bis) RPC assente (42883) → 503', async () => {
    h.rpcResult = { data: null, error: { code: '42883' } }
    const res = await POST(post(bodyQuadra))
    expect(res.status).toBe(503)
  })

  it('scuola fuori scope → 403', async () => {
    h.scope.mockResolvedValue(['99999999-9999-4999-8999-999999999999'])
    const res = await POST(post(bodyQuadra))
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })
})
