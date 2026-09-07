import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/ticket — la guardia sul duplicato.
//
// Criterio scelto dal titolare: QUALUNQUE ricarica allo stesso bambino già
// avvenuta oggi fa fermare la registrazione e chiedere conferma, anche con pezzi
// e importo diversi. La conferma è esplicita e nominata (`conferma_duplicato`),
// non un booleano: un client che mandasse `true` di default disattiverebbe la
// guardia senza che nessuno se ne accorga in revisione.
//
// L'asserzione che conta è `inserts === []` sul 409: dice che NON è stato scritto
// niente. Un test che guardasse solo lo stato resterebbe verde anche con una
// route che risponde 409 dopo aver già registrato il pagamento.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  notifica: vi.fn(),
  rpcCalls: [] as { fn: string; params: Record<string, unknown> }[],
  inserts: [] as { table: string; row: unknown }[],
  // ciò che il ledger risponde alla guardia
  ricaricheOggi: [] as unknown[],
  erroreLedger: null as { code?: string; message?: string } | null,
  // ogni catena di filtri costruita, per provare COME la guardia interroga
  queries: [] as { table: string; metodo: string; args: unknown[] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: async () => true }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (fn: string, params: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, params })
      return { data: 12, error: null }
    },
    from: (table: string) => {
      const reg = (metodo: string, ...args: unknown[]) => { h.queries.push({ table, metodo, args }) }
      const b: Record<string, unknown> = {}
      b.select = (...a: unknown[]) => { reg('select', ...a); return b }
      b.eq = (...a: unknown[]) => { reg('eq', ...a); return b }
      b.is = () => b
      b.gte = (...a: unknown[]) => { reg('gte', ...a); return b }
      b.lte = (...a: unknown[]) => { reg('lte', ...a); return b }
      b.order = (...a: unknown[]) => { reg('order', ...a); return b }
      b.limit = (...a: unknown[]) => { reg('limit', ...a); return b }
      b.maybeSingle = async () => {
        if (table === 'alunni') return { data: { scuola_id: SC }, error: null }
        if (table === 'payment_categories') return { data: { id: 'cat-mensa' }, error: null }
        if (table === 'ticket_mensa') return { data: { saldo_ticket: 2 }, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: { id: `${table}-new` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); return b }
      b.upsert = (row: unknown) => { h.inserts.push({ table: `${table}:upsert`, row }); return b }
      // SOLO il ledger risponde righe: un mock che rispondesse lo stesso a ogni
      // tabella sarebbe piatto, e resterebbe verde con e senza la guardia.
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          table === 'mensa_ticket_movimenti'
            ? { data: h.erroreLedger ? null : h.ricaricheOggi, error: h.erroreLedger }
            : { data: null, error: null },
        )
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
const PRECEDENTE = {
  creato_il: '2026-09-07T09:30:00.000Z',
  delta: 10,
  pagamenti: { importo: 50 },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue(null)
  h.notifica.mockResolvedValue(undefined)
  h.rpcCalls = []
  h.inserts = []
  h.queries = []
  h.ricaricheOggi = []
  h.erroreLedger = null
})

describe('una seconda ricarica nello stesso giorno si ferma e chiede conferma', () => {
  it('409 col codice, con la ricarica precedente nel corpo, e NIENTE scritto', async () => {
    h.ricaricheOggi = [PRECEDENTE]
    const res = await POST(post(CORPO))
    expect(res.status).toBe(409)
    const j = (await res.json()) as { codice: string; precedente: { creato_il: string; pezzi: number; importo: number | null } }
    expect(j.codice).toBe('TICKET_RICARICA_DUPLICATA')
    expect(j.precedente).toMatchObject({ creato_il: PRECEDENTE.creato_il, pezzi: 10, importo: 50 })

    // Il cuore del test: nessuna scrittura, di nessun genere.
    expect(h.inserts).toEqual([])
    expect(h.rpcCalls).toEqual([])
  })

  it('interroga il ledger sui CONFINI DEL GIORNO CIVILE, non sulla colonna `data`', async () => {
    h.ricaricheOggi = [PRECEDENTE]
    await POST(post(CORPO))
    const delLedger = h.queries.filter((q) => q.table === 'mensa_ticket_movimenti')
    // `data` ha DEFAULT CURRENT_DATE e dipende dal fuso della sessione Postgres:
    // filtrarci sopra sbaglierebbe il giorno fra mezzanotte e le due italiane.
    expect(delLedger.some((q) => q.metodo === 'gte' && q.args[0] === 'creato_il')).toBe(true)
    expect(delLedger.some((q) => q.metodo === 'lte' && q.args[0] === 'creato_il')).toBe(true)
    expect(delLedger.some((q) => q.args[0] === 'data')).toBe(false)
    expect(delLedger.some((q) => q.metodo === 'eq' && q.args[0] === 'tipo' && q.args[1] === 'ricarica')).toBe(true)
  })

  it('nel corpo non finisce nessun dato personale', async () => {
    h.ricaricheOggi = [{ ...PRECEDENTE, note: 'pagato dalla nonna', creato_da: 'utente-1', origine: 'segreteria' }]
    const res = await POST(post(CORPO))
    const testo = JSON.stringify(await res.json())
    expect(testo).not.toMatch(/nonna|note|creato_da|origine/i)
  })

  it('la ricarica arrivata dal wizard ha importo ignoto, e non lo si spaccia per zero', async () => {
    h.ricaricheOggi = [{ creato_il: '2026-09-07T08:00:00.000Z', delta: 5, pagamenti: null }]
    const res = await POST(post(CORPO))
    const j = (await res.json()) as { precedente: { importo: number | null; pezzi: number } }
    expect(j.precedente.importo).toBe(null)
    expect(j.precedente.pezzi).toBe(5)
  })

  it('nessuna ricarica oggi → 201, e la ricarica si registra davvero', async () => {
    h.ricaricheOggi = []
    const res = await POST(post(CORPO))
    expect(res.status).toBe(201)
    expect(h.inserts.some((i) => i.table === 'pagamenti')).toBe(true)
    expect(h.inserts.some((i) => i.table === 'incassi')).toBe(true)
  })
})

describe('la conferma esplicita passa, e non fa nemmeno la domanda', () => {
  it('con `conferma_duplicato` si registra, e il ledger non viene interrogato', async () => {
    h.ricaricheOggi = [PRECEDENTE]
    const res = await POST(post({ ...CORPO, conferma_duplicato: 'gia_ricaricato_oggi' }))
    expect(res.status).toBe(201)
    // chiedere di nuovo al ledger sarebbe una lettura inutile su una domanda già chiusa
    const letture = h.queries.filter((q) => q.table === 'mensa_ticket_movimenti' && q.metodo === 'select')
    expect(letture).toEqual([])
  })

  it('un valore di conferma inventato non passa: 400, e niente scritto', async () => {
    h.ricaricheOggi = [PRECEDENTE]
    const res = await POST(post({ ...CORPO, conferma_duplicato: 'true' }))
    expect(res.status).toBe(400)
    expect(h.inserts).toEqual([])
  })
})

describe('la guardia non blocca mai una ricarica vera per un guasto suo', () => {
  it('ledger in errore → 201 (fail-open): il denaro è la ricarica', async () => {
    h.erroreLedger = { code: '42P01', message: 'relation does not exist' }
    const res = await POST(post(CORPO))
    expect(res.status).toBe(201)
  })

  it("l'alunno fuori dal proprio plesso è 403 PRIMA della guardia", async () => {
    // altrimenti il 409 rivelerebbe a uno staff di un altro plesso che quel
    // bambino ha ricaricato oggi
    h.scope.mockResolvedValue(new Response(JSON.stringify({ error: 'Accesso negato' }), { status: 403 }))
    h.ricaricheOggi = [PRECEDENTE]
    const res = await POST(post(CORPO))
    expect(res.status).toBe(403)
    expect(h.queries.filter((q) => q.table === 'mensa_ticket_movimenti')).toEqual([])
  })
})
