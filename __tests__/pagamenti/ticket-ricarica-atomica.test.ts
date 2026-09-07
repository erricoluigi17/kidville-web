import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/ticket — le tre falle che stanno SOTTO la guardia sul duplicato.
//
// Misurato il 2026-09-07 leggendo la route: il saldo autoritativo veniva letto e
// riscritto per valore assoluto (`cur + pezzi`), mentre la strada gemella del
// wizard lo incrementa in modo atomico (`registra_transazione_contabile`:
// `ON CONFLICT DO UPDATE SET saldo_ticket = saldo_ticket + v_tick`). Due scritture
// concorrenti — due click, o un click e una transazione — non davano «saldo
// doppio»: davano **saldo singolo e incasso doppio**, che è il caso peggiore,
// perché la cassa non quadra e il saldo sembra a posto.
//
// E l'insert in `incassi` non guardava `{ error }` (regola 7 di AGENTS.md:
// «PostgREST non lancia»). Se falliva, il saldo era già salito, il pagamento
// restava `da_pagare`, la famiglia compariva fra i morosi e il pannello festeggiava.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  notifica: vi.fn(),
  rpcCalls: [] as { fn: string; params: Record<string, unknown> }[],
  // per nome di funzione: `null` = la RPC risponde col saldo, altrimenti l'errore
  rpcErrore: null as { code?: string; message?: string } | null,
  rpcSaldo: 0,
  inserts: [] as { table: string; row: unknown }[],
  upserts: [] as { table: string; row: unknown }[],
  erroreInsert: {} as Record<string, { code?: string; message?: string }>,
  saldoLetto: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: async () => true }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (fn: string, params: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, params })
      if (h.rpcErrore) return { data: null, error: h.rpcErrore }
      return { data: h.rpcSaldo, error: null }
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'alunni') return { data: { scuola_id: SC }, error: null }
        if (table === 'ticket_mensa') return { data: { saldo_ticket: h.saldoLetto }, error: null }
        if (table === 'payment_categories') return { data: { id: 'cat-mensa' }, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: { id: `${table}-new` }, error: h.erroreInsert[table] ?? null })
      b.insert = (row: unknown) => {
        h.inserts.push({ table, row })
        return b
      }
      b.upsert = (row: unknown) => {
        h.upserts.push({ table, row })
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: h.erroreInsert[table] ?? null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/ticket/route'

const URL = 'http://localhost/api/pagamenti/ticket'
const SC = '22222222-2222-4222-8222-222222222222'
const AL = '55555555-5555-4555-8555-555555555555'

const post = (body: unknown) =>
  new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' },
    body: JSON.stringify(body),
  })

const CORPO = { alunno_id: AL, pezzi: 10, costo: 50, metodo: 'contanti' }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue(null)
  h.notifica.mockResolvedValue(undefined)
  h.rpcCalls = []
  h.rpcErrore = null
  h.rpcSaldo = 12
  h.inserts = []
  h.upserts = []
  h.erroreInsert = {}
  h.saldoLetto = 2
})

describe('il saldo si incrementa in modo atomico, non si riscrive per valore assoluto', () => {
  it('chiama la RPC di variazione col delta, e NON riscrive il saldo letto', async () => {
    const res = await POST(post(CORPO))
    expect(res.status).toBe(201)

    const variazioni = h.rpcCalls.filter((c) => c.fn === 'varia_saldo_ticket')
    expect(variazioni).toHaveLength(1)
    expect(variazioni[0].params).toMatchObject({ p_alunno_id: AL, p_delta: 10 })

    // È QUESTA l'asserzione che oggi non può passare: la route riscrive
    // `ticket_mensa` con la somma calcolata in JS. Un upsert su quella tabella
    // significa che il read-modify-write è ancora lì.
    expect(h.upserts.filter((u) => u.table === 'ticket_mensa')).toEqual([])
  })

  it('il saldo che torna al client è quello della RPC, non quello calcolato in JS', async () => {
    h.saldoLetto = 2 // + 10 = 12 in JS, ma la RPC dice 99: vince la RPC
    h.rpcSaldo = 99
    const res = await POST(post(CORPO))
    const j = (await res.json()) as { data: { saldo_ticket: number } }
    expect(j.data.saldo_ticket).toBe(99)
  })

  it('se il pagamento non nasce, il saldo si RIPORTA INDIETRO con un decremento, non con una scrittura assoluta', async () => {
    h.erroreInsert.pagamenti = { code: '23505', message: 'duplicato' }
    const res = await POST(post(CORPO))
    expect(res.status).toBe(500)
    const variazioni = h.rpcCalls.filter((c) => c.fn === 'varia_saldo_ticket')
    expect(variazioni).toHaveLength(2)
    expect(variazioni[1].params).toMatchObject({ p_alunno_id: AL, p_delta: -10 })
    expect(h.upserts.filter((u) => u.table === 'ticket_mensa')).toEqual([])
  })
})

describe('degrado pulito dove la RPC non esiste (DB E2E della CI, non migrato)', () => {
  it('PGRST202 → si ricade sul percorso storico e la ricarica RIESCE lo stesso', async () => {
    h.rpcErrore = { code: 'PGRST202', message: 'function not found' }
    const res = await POST(post(CORPO))
    expect(res.status).toBe(201)
    // il fallback è il percorso storico: qui l'upsert ci DEVE essere
    expect(h.upserts.filter((u) => u.table === 'ticket_mensa').length).toBeGreaterThan(0)
    const j = (await res.json()) as { data: { saldo_ticket: number } }
    expect(j.data.saldo_ticket).toBe(12) // 2 letti + 10
  })

  it('42883 (funzione assente lato Postgres) degrada allo stesso modo', async () => {
    h.rpcErrore = { code: '42883', message: 'function does not exist' }
    const res = await POST(post(CORPO))
    expect(res.status).toBe(201)
  })

  it('un errore VERO della RPC non degrada in silenzio: risponde 500', async () => {
    h.rpcErrore = { code: '40001', message: 'serialization failure' }
    const res = await POST(post(CORPO))
    expect(res.status).toBe(500)
    expect(h.inserts.filter((i) => i.table === 'pagamenti')).toEqual([])
  })
})

describe("l'incasso che non si registra non passa sotto silenzio", () => {
  it('se `incassi` fallisce, la risposta lo DICHIARA invece di essere identica al successo', async () => {
    h.erroreInsert.incassi = { code: '23503', message: 'foreign key' }
    const res = await POST(post(CORPO))
    const j = (await res.json()) as { data: { incasso_registrato?: boolean } }
    // oggi la risposta è indistinguibile da quella di un incasso andato a buon fine
    expect(j.data.incasso_registrato).toBe(false)
  })

  it('quando `incassi` va a buon fine la risposta lo dice, così i due casi si distinguono', async () => {
    const res = await POST(post(CORPO))
    const j = (await res.json()) as { data: { incasso_registrato?: boolean } }
    expect(j.data.incasso_registrato).toBe(true)
  })

  it('con costo 0 non si inserisce nessun incasso e il campo non mente', async () => {
    const res = await POST(post({ ...CORPO, costo: 0 }))
    const j = (await res.json()) as { data: { incasso_registrato?: boolean | null } }
    expect(h.inserts.filter((i) => i.table === 'incassi')).toEqual([])
    expect(j.data.incasso_registrato).toBe(null)
  })
})
