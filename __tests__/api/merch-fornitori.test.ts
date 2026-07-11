import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  existing: null as Record<string, unknown> | null,
  rows: {} as Record<string, Record<string, unknown>[]>,
  selectError: null as { code?: string; message: string } | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _last?: Record<string, unknown>; _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.single = async () => ({ data: b._last ?? { id: `${table}-x` }, error: null })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push({ table, row }); b._last = { id: `${table}-new`, ...row }; return b }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, row }); b._last = { id: `${table}-upd`, ...row }; return b }
      b.delete = () => { b._op = 'delete'; return b }
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(b._op === 'delete' ? { data: null, error: null } : { data: h.rows[table] ?? [], error: h.selectError })
      return b
    },
  }),
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/admin/merch/fornitori/route'

const URL = 'http://localhost/api/admin/merch/fornitori'
const json = (body: unknown, method: string) =>
  new Request(URL, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.existing = { id: 'f-1', scuola_id: 'sc-1' }
  h.rows = { merch_fornitori: [{ id: 'f-1', scuola_id: 'sc-1', nome: 'ForniTop', attivo: true }] }
  h.selectError = null
  h.inserts = []; h.updates = []
})

describe('GET /api/admin/merch/fornitori', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(new Request(URL))).status).toBe(403)
  })
  it('200 lista anagrafica', async () => {
    const j = await (await GET(new Request(URL))).json()
    expect(j.success).toBe(true)
    expect(j.data).toHaveLength(1)
  })
  it('200 lista vuota (degrade tabella mancante 42P01)', async () => {
    h.selectError = { code: '42P01', message: 'relation does not exist' }
    const j = await (await GET(new Request(URL))).json()
    expect(j.data).toEqual([])
  })
})

describe('POST /api/admin/merch/fornitori', () => {
  it('400 nome vuoto', async () => {
    expect((await POST(json({ nome: '  ' }, 'POST'))).status).toBe(400)
  })
  it('400 email non valida', async () => {
    expect((await POST(json({ nome: 'X', email: 'non-una-email' }, 'POST'))).status).toBe(400)
  })
  it('201 crea fornitore + audit', async () => {
    const res = await POST(json({ nome: '  ForniTop  ', referente: 'Mario', email: 'a@b.it', telefono: '  ' }, 'POST'))
    expect(res.status).toBe(201)
    expect(h.inserts[0].row).toMatchObject({ scuola_id: 'sc-1', nome: 'ForniTop', referente: 'Mario', email: 'a@b.it', attivo: true, creato_da: 'seg-1' })
    expect(h.inserts[0].row).toMatchObject({ telefono: null }) // stringa vuota → null
    expect(h.logScrittura).toHaveBeenCalled()
  })
})

describe('PATCH /api/admin/merch/fornitori', () => {
  it('404 inesistente', async () => {
    h.existing = null
    expect((await PATCH(json({ id: ID, nome: 'X' }, 'PATCH'))).status).toBe(404)
  })
  it('403 fuori dal plesso', async () => {
    h.existing = { id: 'f-1', scuola_id: 'sc-ALTRO' }
    expect((await PATCH(json({ id: ID, nome: 'X' }, 'PATCH'))).status).toBe(403)
  })
  it('200 aggiorna + audit', async () => {
    const res = await PATCH(json({ id: ID, attivo: false, note: 'chiuso' }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(h.updates[0].row).toMatchObject({ attivo: false, note: 'chiuso' })
    expect(h.logScrittura).toHaveBeenCalled()
  })
})

describe('DELETE /api/admin/merch/fornitori', () => {
  it('404 inesistente', async () => {
    h.existing = null
    expect((await DELETE(new Request(`${URL}?id=${ID}`, { method: 'DELETE' }))).status).toBe(404)
  })
  it('200 elimina + audit', async () => {
    const res = await DELETE(new Request(`${URL}?id=${ID}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalled()
  })
})
