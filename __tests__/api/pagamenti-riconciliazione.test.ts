import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  esistenti: [] as { hash_movimento: string }[],
  aperti: [] as Record<string, unknown>[],
  movimento: null as Record<string, unknown> | null,
  movimenti: [] as Record<string, unknown>[],
  pagamento: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> | Record<string, unknown>[] }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'riconciliazione_movimenti' ? h.movimento : table === 'pagamenti' ? h.pagamento : null,
        error: null,
      })
      b.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        h.inserts.push({ table, row })
        return {
          select: () => ({ single: async () => ({ data: { id: `${table}-new`, ...(Array.isArray(row) ? {} : row) }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
        }
      }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, row }); return b }
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data:
            table === 'riconciliazione_movimenti'
              ? (h.esistenti.length || h.movimenti.length ? (h.esistenti.length ? h.esistenti : h.movimenti) : [])
              : table === 'pagamenti' ? h.aperti
              : [],
          error: null,
        })
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/pagamenti/riconciliazione/route'
import { PATCH } from '@/app/api/pagamenti/riconciliazione/[id]/route'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/riconciliazione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/pagamenti/riconciliazione/${MID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: MID }) },
  )

const CSV = [
  'Data;Entrate;Descrizione',
  '05/09/2026;150,00;BONIFICO RETTA SETTEMBRE ROSSI MARIO',
  '06/09/2026;25,00;GITA ZOO BIANCHI LIA',
].join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.esistenti = []
  h.movimenti = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.aperti = [
    { id: PID, descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', tipo: 'singolo', stato: 'scaduto', alunni: { nome: 'Mario', cognome: 'Rossi' } },
  ]
  h.movimento = {
    id: MID, scuola_id: 'sc-1', importo: 150, data_operazione: '2026-09-05',
    causale: 'BONIFICO RETTA', stato: 'suggerito',
    suggerimenti: [{ pagamento_id: PID, score: 75 }],
  }
  h.pagamento = { id: PID, scuola_id: 'sc-1', stato: 'scaduto' }
})

describe('POST /api/pagamenti/riconciliazione (import CSV)', () => {
  it('importa gli accrediti con hash e suggerimenti calcolati', async () => {
    const res = await POST(post({ filename: 'estratto.csv', contenuto: CSV }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    const ins = h.inserts.find((i) => i.table === 'riconciliazione_movimenti')
    const rows = ins!.row as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows[0].hash_movimento).toBeTruthy()
    expect(rows[0].stato).toBe('suggerito') // importo esatto + nome in causale
  })

  it('i movimenti già visti (stesso hash) vengono saltati', async () => {
    const { parseCsv, hashMovimento } = await import('@/lib/pagamenti/riconciliazione')
    const primo = parseCsv(CSV).movimenti[0]
    h.esistenti = [{ hash_movimento: hashMovimento(primo) }]
    const res = await POST(post({ contenuto: CSV }))
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.duplicati).toBe(1)
  })

  it('400 se il CSV non ha colonne riconoscibili', async () => {
    expect((await POST(post({ contenuto: 'foo;bar\n1;2' }))).status).toBe(400)
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ contenuto: CSV }))).status).toBe(403)
  })
})

describe('PATCH /api/pagamenti/riconciliazione/[id]', () => {
  it('conferma → crea incasso bonifico e marca il movimento', async () => {
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(200)
    const inc = h.inserts.find((i) => i.table === 'incassi')
    expect(inc).toBeTruthy()
    expect((inc!.row as Record<string, unknown>).metodo).toBe('bonifico')
    expect((inc!.row as Record<string, unknown>).data_incasso).toBe('2026-09-05')
    const upd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(upd!.row.stato).toBe('confermato')
    expect(upd!.row.pagamento_id).toBe(PID)
  })

  it('conferma di un movimento già confermato → 409', async () => {
    h.movimento = { ...h.movimento!, stato: 'confermato' }
    expect((await patch({ azione: 'conferma' })).status).toBe(409)
  })

  it('ignora → stato ignorato senza incassi', async () => {
    const res = await patch({ azione: 'ignora' })
    expect(res.status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
    expect(h.updates.find((u) => u.table === 'riconciliazione_movimenti')!.row.stato).toBe('ignorato')
  })
})

describe('GET /api/pagamenti/riconciliazione', () => {
  it('lista movimenti (200)', async () => {
    h.movimenti = [{ id: MID, stato: 'suggerito' }]
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione?stato=suggerito') as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
  })
})
