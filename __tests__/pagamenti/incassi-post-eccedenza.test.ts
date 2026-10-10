import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/incassi — dal 2026-10-10 il residuo lo decide la RPC
// `registra_incasso_voce` con la riga del pagamento bloccata (fase 5 robustezza).
// La logica (residuo, eccedenza, credito, abbuono) è provata su Postgres vero in
// `__tests__/lib/registra-incasso-voce-sql.test.ts`; qui si prova che la route
//  (a) passa alla RPC i parametri giusti, e il pagante SOLO se confermato;
//  (b) traduce ogni esito nello status giusto (409, 404, 400, 503, 201);
//  (c) non scrive MAI incassi, crediti o sconti da sé.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  spill: vi.fn(),
  notifica: vi.fn(),
  disponibile: vi.fn(),
  resolveParent: vi.fn(),
  rpc: vi.fn(),
  pag: {} as Record<string, unknown> | null,
  scritture: [] as { table: string; op: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/pagamenti/spill', () => ({ applyOverpaymentSpill: (...a: unknown[]) => h.spill(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: async () => undefined }))
vi.mock('@/lib/pagamenti/credito', () => ({
  creditoDisponibile: (...a: unknown[]) => h.disponibile(...a),
}))
vi.mock('@/lib/pagamenti/intestatari', () => ({ resolveParentRegistry: (...a: unknown[]) => h.resolveParent(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (nome: string, args: unknown) => h.rpc(nome, args),
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'pagamenti') return { data: h.pag, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        b[op] = () => { h.scritture.push({ table, op }); return b }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
  }),
}))
// il gate di sede ha i suoi test: qui lo si lascia passare
vi.mock('@/lib/auth/scope', () => ({ assertPagamentoInScope: async () => null }))

import { POST } from '@/app/api/pagamenti/incassi/route'

const URL = 'http://localhost/api/pagamenti/incassi'
const PID = '11111111-1111-4111-8111-111111111111'
const PARENT = '33333333-3333-4333-8333-333333333333'
const PARENT_CANONICO = '44444444-4444-4444-8444-444444444444'
const post = (body: unknown) =>
  new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })

const ok = (extra: Record<string, unknown> = {}) => ({
  data: {
    esito: 'ok', residuo_prima: 100, incasso: { id: 'inc-1' }, importo_incassato: 80,
    eccedenza: 0, credito: null, sconto_dopo: null, ...extra,
  },
  error: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.spill.mockResolvedValue([])
  h.notifica.mockResolvedValue(undefined)
  h.disponibile.mockResolvedValue(true)
  h.resolveParent.mockResolvedValue({ id: PARENT_CANONICO })
  h.rpc.mockResolvedValue(ok())
  h.pag = { id: PID, parent_payment_id: null, alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta' }
  h.scritture = []
})

const argsRpc = () => {
  const call = h.rpc.mock.calls.find((c) => c[0] === 'registra_incasso_voce')
  expect(call, 'la route non ha chiamato registra_incasso_voce').toBeDefined()
  return call![1] as Record<string, unknown>
}

describe('POST incassi — la route traduce la RPC', () => {
  it('incasso semplice → RPC con importo, operatore e nessun pagante; 201', async () => {
    const res = await POST(post({ pagamento_id: PID, importo: '80', metodo: 'pos', note: 'n' }))
    expect(res.status).toBe(201)
    const a = argsRpc()
    expect(a).toMatchObject({
      p_pagamento_id: PID, p_importo: 80, p_registrato_da: 'seg-1', p_metodo: 'pos', p_note: 'n',
      p_eccedenza_parent_id: null, p_abbuono_motivo: null,
    })
    const j = await res.json()
    expect(j.data.incasso).toEqual({ id: 'inc-1' })
    expect(h.resolveParent).not.toHaveBeenCalled()
  })

  it('(d) la RPC rifiuta l\'eccedenza → 409 con l\'eccedenza, nessuna notifica', async () => {
    h.rpc.mockResolvedValue({ data: { esito: 'eccedenza', eccedenza: '50.00', residuo: '100.00' }, error: null })
    const res = await POST(post({ pagamento_id: PID, importo: 150 }))
    expect(res.status).toBe(409)
    expect((await res.json()).eccedenza).toBe(50)
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('(e) conferma + pagante → il pagante CANONICO va alla RPC; il credito torna nella risposta', async () => {
    h.rpc.mockResolvedValue(ok({ importo_incassato: 100, eccedenza: 50, credito: { id: 'cf-1', saldo_dopo: '50.00' } }))
    const res = await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia', pagante_parent_id: PARENT }))
    expect(res.status).toBe(201)
    expect(h.resolveParent).toHaveBeenCalledWith(expect.anything(), PARENT)
    expect(argsRpc().p_eccedenza_parent_id).toBe(PARENT_CANONICO)
    expect((await res.json()).data.credito).toEqual({ saldoDopo: 50, id: 'cf-1' })
  })

  it('conferma senza pagante → nessun pagante alla RPC (che risponderà «eccedenza»)', async () => {
    await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia' }))
    expect(argsRpc().p_eccedenza_parent_id).toBeNull()
  })

  it('pagante non risolvibile → 400 e la RPC non parte', async () => {
    h.resolveParent.mockResolvedValue(null)
    const res = await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia', pagante_parent_id: PARENT }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('(e-bis) credito non disponibile su questo DB → 503 e la RPC non parte', async () => {
    h.disponibile.mockResolvedValue(false)
    const res = await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia', pagante_parent_id: PARENT }))
    expect(res.status).toBe(503)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('(f) abbuono → il motivo va alla RPC; lo sconto torna come evento, non come UPDATE della route', async () => {
    h.rpc.mockResolvedValue(ok({ importo_incassato: 70, sconto_dopo: '30.00' }))
    const res = await POST(post({ pagamento_id: PID, importo: 70, abbuono: { motivo: 'Sconto famiglia' } }))
    expect(res.status).toBe(201)
    expect(argsRpc().p_abbuono_motivo).toBe('Sconto famiglia')
  })

  it('funzione assente (PGRST202, DB non migrato) → 503', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await POST(post({ pagamento_id: PID, importo: 10 }))
    expect(res.status).toBe(503)
  })

  it('metodo fuori elenco (22P02) → 400, errore dell\'input e non del server', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '22P02', message: 'invalid input value for enum' } })
    const res = await POST(post({ pagamento_id: PID, importo: 10, metodo: 'baratto' }))
    expect(res.status).toBe(400)
  })

  it('errore qualunque della RPC → 500', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } })
    const res = await POST(post({ pagamento_id: PID, importo: 10 }))
    expect(res.status).toBe(500)
  })

  it('esiti non_trovato e quota_estranea → 404 e 400', async () => {
    h.rpc.mockResolvedValue({ data: { esito: 'non_trovato' }, error: null })
    expect((await POST(post({ pagamento_id: PID, importo: 10 }))).status).toBe(404)
    h.rpc.mockResolvedValue({ data: { esito: 'quota_estranea' }, error: null })
    expect((await POST(post({ pagamento_id: PID, importo: 10, quota_id: PARENT }))).status).toBe(400)
  })

  it('pagamento inesistente già alla lettura → 404 senza RPC', async () => {
    h.pag = null
    const res = await POST(post({ pagamento_id: PID, importo: 10 }))
    expect(res.status).toBe(404)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('(c) in nessun caso la route scrive incassi, crediti o pagamenti da sé', async () => {
    h.rpc.mockResolvedValue(ok({ importo_incassato: 100, eccedenza: 50, credito: { id: 'cf-1', saldo_dopo: 50 }, sconto_dopo: 5 }))
    await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia', pagante_parent_id: PARENT }))
    const vietate = h.scritture.filter((s) => ['incassi', 'crediti_famiglia', 'pagamenti', 'registro_modifiche'].includes(s.table))
    expect(vietate).toEqual([])
  })

  it('una rata incassata → lo spill parte; una voce normale no', async () => {
    await POST(post({ pagamento_id: PID, importo: 80 }))
    expect(h.spill).not.toHaveBeenCalled()
    h.pag = { ...h.pag, parent_payment_id: '55555555-5555-4555-8555-555555555555' }
    await POST(post({ pagamento_id: PID, importo: 80 }))
    expect(h.spill).toHaveBeenCalledTimes(1)
  })
})
