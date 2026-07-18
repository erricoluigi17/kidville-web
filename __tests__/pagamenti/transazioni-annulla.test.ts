import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/transazioni/[id]/annulla — annullo ATOMICO via RPC (ciclo 2).
//  L'annullo non enumera più a mano incassi/credito (che dimenticava le RICARICHE
//  MENSA): delega tutto alla RPC `annulla_transazione_contabile`, che storna in una
//  sola transazione incassi + ricariche mensa (saldo ticket) + eccedenza a credito.
//  Contratto verificato:
//   (a) annullo con ricarica mensa → chiama la RPC; payload = { transazione_id, motivo }
//   (b) RPC assente (PGRST202/42883) → 503 pulito, senza storni parziali
//   (c) motivo mancante/troppo corto → 400
//   (d) doppio annullo → 409 (sia pre-check sia EXCEPTION KV409 della RPC)
//   + credito eccedenza già speso (KV410) → 409; transazione non trovata → 404.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  revoca: vi.fn(),
  annullaRic: vi.fn(),
  rpc: vi.fn(),
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  tx: null as Record<string, unknown> | null,
  txErr: null as { code: string } | null,
  incassiRevoca: [] as Record<string, unknown>[],
  pagamentiRevoca: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
vi.mock('@/lib/pagamenti/ricevute', () => ({ annullaRicevutaTransazioneAttiva: (...a: unknown[]) => h.annullaRic(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.maybeSingle = async () =>
        table === 'pagamenti_transazioni' ? { data: h.tx, error: h.txErr } : { data: null, error: null }
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); return { then: (res: (v: unknown) => unknown) => res({ data: null, error: null }) } }
      b.update = (row: unknown) => { h.updates.push({ table, row }); return { eq: () => ({ then: (res: (v: unknown) => unknown) => res({ data: null, error: null }) }) } }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'incassi') return resolve({ data: h.incassiRevoca, error: null })
        if (table === 'pagamenti') return resolve({ data: h.pagamentiRevoca, error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      return h.rpc(name, args)
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/transazioni/[id]/annulla/route'

const SC = '22222222-2222-4222-8222-222222222222'
const PARENT = '33333333-3333-4333-8333-333333333333'
const TX = '77777777-7777-4777-8777-777777777777'
const ctx = { params: Promise.resolve({ id: TX }) }
const post = (body: unknown) =>
  new Request(`http://localhost/api/pagamenti/transazioni/${TX}/annulla`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
  h.revoca.mockResolvedValue({ revocati: [] })
  h.annullaRic.mockResolvedValue(undefined)
  h.rpc.mockResolvedValue({ data: { incassi_stornati: 2, ricariche_stornate: 1, credito_stornato: 0, ticket_gia_consumati: false }, error: null })
  h.tx = { id: TX, scuola_id: SC, pagante_parent_id: PARENT, importo_totale: 200, annullata_il: null }
  h.txErr = null
  h.incassiRevoca = [{ pagamento_id: 'pag-1' }]
  h.pagamentiRevoca = [{ alunno_id: 'alu-1' }]
  h.inserts = []; h.updates = []; h.rpcCalls = []
})

describe('POST annulla transazione — via RPC atomica', () => {
  it('(c) senza motivo → 400 (RPC non chiamata)', async () => {
    const res = await POST(post({}), ctx)
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(c) motivo troppo corto → 400', async () => {
    const res = await POST(post({ motivo: 'x' }), ctx)
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(a) annullo con ricarica mensa → chiama la RPC; payload include transazione_id+motivo', async () => {
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].name).toBe('annulla_transazione_contabile')
    const payload = h.rpcCalls[0].args.p as Record<string, unknown>
    expect(payload.transazione_id).toBe(TX)
    expect(payload.motivo).toBe('errore di registrazione')
    // i conteggi della RPC (incl. ricariche mensa stornate) tornano al chiamante
    const body = await res.json()
    expect(body.data.ricariche_stornate).toBe(1)
    expect(body.data.incassi_stornati).toBe(2)
    // ricevuta famiglia annullata come oggi
    expect(h.annullaRic).toHaveBeenCalledTimes(1)
  })

  it('(b) RPC assente (PGRST202) → 503 pulito senza storni parziali', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(503)
    expect(h.annullaRic).not.toHaveBeenCalled()
  })

  it('(b bis) RPC assente (42883) → 503', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'undefined function' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(503)
  })

  it('(d) doppio annullo (tx già annullata, pre-check) → 409, RPC non chiamata', async () => {
    h.tx = { id: TX, scuola_id: SC, pagante_parent_id: PARENT, importo_totale: 200, annullata_il: '2026-07-18T10:00:00Z' }
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(d bis) doppio annullo in gara (RPC KV409) → 409', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'KV409', message: 'transazione già annullata' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
  })

  it('credito eccedenza già speso (RPC KV410) → 409 senza annullare la ricevuta', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'KV410', message: 'credito già utilizzato' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
    expect(h.annullaRic).not.toHaveBeenCalled()
  })

  it('transazione non trovata → 404 (RPC non chiamata)', async () => {
    h.tx = null
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('scope di sede diverso → 404', async () => {
    h.scope.mockResolvedValue(['99999999-9999-4999-8999-999999999999'])
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })
})
