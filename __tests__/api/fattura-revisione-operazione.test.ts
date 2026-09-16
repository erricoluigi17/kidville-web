import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const SCUOLA = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = '20000000-0000-4000-8000-000000000002'
const FATTURA = '30000000-0000-4000-8000-000000000003'
const PAGAMENTO = '40000000-0000-4000-8000-000000000004'
const PARENT = '50000000-0000-4000-8000-000000000005'
const ATTORE = '60000000-0000-4000-8000-000000000006'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
  auth: {} as Riga,
  scuola: {} as Riga,
  fattura: null as Riga | null,
  erroreFattura: null as Riga | null,
  scope: null as Response | null,
  rpcData: { finalizzata: false } as unknown,
  rpcError: null as Riga | null,
  rpcCalls: [] as { funzione: string; parametri: Record<string, unknown> }[],
  letture: [] as string[],
}))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

vi.mock('@/lib/logging/logger', () => log)
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => h.auth),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: vi.fn(async () => h.scuola),
  assertPagamentoInScope: vi.fn(async () => h.scope),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      h.letture.push(table)
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = () => query
      query.maybeSingle = async () => ({ data: h.fattura, error: h.erroreFattura })
      return query
    },
    rpc: async (funzione: string, parametri: Record<string, unknown>) => {
      h.rpcCalls.push({ funzione, parametri })
      return { data: h.rpcData, error: h.rpcError }
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/fattura/revisione/operazione/route'

function richiesta(body: unknown) {
  return POST(new Request('http://test/api/pagamenti/fattura/revisione/operazione', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

const salva = (extra: Riga = {}) => ({
  azione: 'salva',
  scuola_id: SCUOLA,
  fattura_id: FATTURA,
  modalita: 'quote_separate',
  parent_registry_id: PARENT,
  ...extra,
})

const attiva = (extra: Riga = {}) => ({
  azione: 'attiva',
  scuola_id: SCUOLA,
  irrisolte_previste: [FATTURA],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.auth = { user: { id: ATTORE, role: 'segreteria', scuola_id: SCUOLA } }
  h.scuola = { scuolaId: SCUOLA }
  h.fattura = { id: FATTURA, pagamento_id: PAGAMENTO, scuola_id: SCUOLA }
  h.erroreFattura = null
  h.scope = null
  h.rpcData = { finalizzata: false }
  h.rpcError = null
  h.rpcCalls = []
  h.letture = []
})

describe('POST fattura/revisione/operazione', () => {
  it('salva usando sempre l’attore di sessione dopo scope pagamento e sede fattura', async () => {
    const res = await richiesta(salva())

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ success: true, data: { finalizzata: false } })
    expect(h.rpcCalls).toEqual([{
      funzione: 'fatture_visibilita_salva_revisione',
      parametri: {
        p_scuola_id: SCUOLA,
        p_fattura_id: FATTURA,
        p_modalita: 'quote_separate',
        p_parent_registry_id: PARENT,
        p_verificata_da: ATTORE,
      },
    }])
  })

  it('attiva con la sede esplicita autorizzata e logga solo conteggi, non l’array di fatture', async () => {
    h.rpcData = { finalizzate: 2, irrisolte: 1 }
    const res = await richiesta(attiva())

    expect(res.status).toBe(200)
    expect(h.letture).toEqual([])
    expect(h.rpcCalls).toEqual([{
      funzione: 'fatture_visibilita_attiva',
      parametri: {
        p_scuola_id: SCUOLA,
        p_irrisolte_previste: [FATTURA],
        p_verificata_da: ATTORE,
      },
    }])
    const successo = log.logEvento.mock.calls.find((call) => call[0] === 'fattura' && call[1] === 'info')
    expect(successo?.[2]).toMatchObject({
      operazione: 'pagamenti/fattura/revisione/operazione:POST',
      esito: 'visibilita-attivata',
      scuola_id: SCUOLA,
      irrisolte_previste: 1,
      finalizzate: 2,
      irrisolte: 1,
    })
    expect(JSON.stringify(successo)).not.toContain(FATTURA)
  })

  it('il gate genitore ferma tutto prima di letture e RPC', async () => {
    h.auth = { response: NextResponse.json({ error: 'negato' }, { status: 403 }) }
    const res = await richiesta(salva())
    expect(res.status).toBe(403)
    expect(h.letture).toEqual([])
    expect(h.rpcCalls).toEqual([])
  })

  it('una sede fuori scope ferma tutto prima della lettura della fattura', async () => {
    h.scuola = { response: NextResponse.json({ error: 'sede negata' }, { status: 403 }) }
    const res = await richiesta(salva({ scuola_id: ALTRA_SEDE }))
    expect(res.status).toBe(403)
    expect(h.letture).toEqual([])
    expect(h.rpcCalls).toEqual([])
  })

  it('una fattura di un’altra sede è indistinguibile da una assente e non invoca la RPC', async () => {
    h.fattura = { id: FATTURA, pagamento_id: PAGAMENTO, scuola_id: ALTRA_SEDE }
    const res = await richiesta(salva())
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.rpcCalls).toEqual([])
  })

  it('un pagamento fuori scope ferma la scrittura', async () => {
    h.scope = NextResponse.json({ error: 'negato' }, { status: 403 })
    const res = await richiesta(salva())
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toEqual([])
  })

  it('rifiuta un attore forgiato e una quota senza genitore prima di ogni I/O', async () => {
    expect((await richiesta(salva({ verificata_da: PARENT }))).status).toBe(400)
    expect((await richiesta(salva({ parent_registry_id: null }))).status).toBe(400)
    expect(h.letture).toEqual([])
    expect(h.rpcCalls).toEqual([])
  })

  it('lo schema assente in preflight risponde 503 senza esporre la prosa PostgREST', async () => {
    h.erroreFattura = { code: '42703', message: 'column privata does not exist' }
    const res = await richiesta(salva())
    expect(res.status).toBe(503)
    const testo = await res.text()
    expect(testo).not.toContain('privata')
    expect(JSON.parse(testo).codice).toBe('LETTURA_FALLITA')
    expect(h.rpcCalls).toEqual([])
  })

  it.each([
    ['fattura già finalizzata', 'FATTURA_REVISIONE_IMMUTABILE'],
    ['anteprima irrisolte cambiata', 'FATTURA_ANTEPRIMA_CAMBIATA'],
    ['esistono fatture NULL senza revisione verificata', 'FATTURA_REVISIONI_INCOMPLETE'],
  ])('mappa il conflitto RPC “%s” in un 409 catalogato', async (message, codice) => {
    h.rpcError = { code: 'P0001', message }
    const res = await richiesta(message.includes('fattura già') ? salva() : attiva())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe(codice)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('lo schema RPC assente è 503 e un altro guasto DB è 500, sempre con corpo controllato', async () => {
    h.rpcError = { code: 'PGRST202', message: 'Could not find function con dettagli interni' }
    const schema = await richiesta(attiva())
    expect(schema.status).toBe(503)
    expect(await schema.text()).not.toContain('dettagli interni')

    h.rpcError = { code: 'XX000', message: 'dato personale inatteso' }
    const guasto = await richiesta(attiva())
    expect(guasto.status).toBe(500)
    expect(await guasto.text()).not.toContain('dato personale')
  })
})
