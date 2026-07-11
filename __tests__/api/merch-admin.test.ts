import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Pattern schools-route.test.ts: hoisted state + mock auth/audit/scope/supabase.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  existing: null as Record<string, unknown> | null,
  rows: {} as Record<string, Record<string, unknown>[]>,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  deletes: [] as string[],
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
        resolve(b._op === 'delete' ? { data: null, error: null } : { data: h.rows[table] ?? [], error: null })
      return b
    },
  }),
}))

import { GET as ARTGET, POST as ARTPOST, PATCH as ARTPATCH, DELETE as ARTDELETE } from '@/app/api/admin/merch/articoli/route'
import { GET as ORDGET, PATCH as ORDPATCH } from '@/app/api/admin/merch/ordini/route'

const A_URL = 'http://localhost/api/admin/merch/articoli'
const O_URL = 'http://localhost/api/admin/merch/ordini'
const json = (url: string, body: unknown, method: string) =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.existing = { id: 'art-1', scuola_id: 'sc-1', stato: 'inviato' }
  h.rows = {
    divise_articoli: [{ id: 'art-1', scuola_id: 'sc-1', nome: 'Polo', taglie: ['S', 'M'], prezzo: 18, attivo: true }],
    divise_ordini: [{ id: 'ord-1', scuola_id: 'sc-1', stato: 'inviato', totale: 36, righe: [] }],
  }
  h.inserts = []; h.updates = []; h.deletes = []
})

describe('GET /api/admin/merch/articoli', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await ARTGET(new Request(A_URL))).status).toBe(403)
  })
  it('200 lista catalogo del plesso', async () => {
    const res = await ARTGET(new Request(A_URL))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data).toHaveLength(1)
  })
  it('200 lista vuota senza plessi', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await ARTGET(new Request(A_URL))
    const j = await res.json()
    expect(j.data).toEqual([])
  })
})

describe('POST /api/admin/merch/articoli', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await ARTPOST(json(A_URL, { nome: 'X', prezzo: 1 }, 'POST'))).status).toBe(403)
  })
  it('400 nome vuoto', async () => {
    expect((await ARTPOST(json(A_URL, { nome: '  ', prezzo: 10 }, 'POST'))).status).toBe(400)
  })
  it('400 prezzo negativo', async () => {
    expect((await ARTPOST(json(A_URL, { nome: 'Polo', prezzo: -3 }, 'POST'))).status).toBe(400)
  })
  it('201 crea articolo con prezzo/taglie + audit', async () => {
    const res = await ARTPOST(json(A_URL, { nome: '  Polo Kidville ', taglie: ['S', 'M', 'L'], prezzo: '18.50' }, 'POST'))
    expect(res.status).toBe(201)
    expect(h.inserts[0].row).toMatchObject({ scuola_id: 'sc-1', nome: 'Polo Kidville', prezzo: 18.5, taglie: ['S', 'M', 'L'] })
    // default categoria 'divisa' quando non specificata
    expect(h.inserts[0].row).toMatchObject({ categoria: 'divisa', fornitore_id: null, prezzo_acquisto: null })
    expect(h.logScrittura).toHaveBeenCalled()
  })
  it('201 persiste categoria/fornitore/prezzo_acquisto quando forniti', async () => {
    const FID = '33333333-3333-4333-8333-333333333333'
    const res = await ARTPOST(json(A_URL, { nome: 'Quaderno', prezzo: 2, categoria: 'materiale', fornitore_id: FID, prezzo_acquisto: '1.20' }, 'POST'))
    expect(res.status).toBe(201)
    expect(h.inserts[0].row).toMatchObject({ categoria: 'materiale', fornitore_id: FID, prezzo_acquisto: 1.2 })
  })
  it('400 categoria non valida', async () => {
    expect((await ARTPOST(json(A_URL, { nome: 'X', prezzo: 1, categoria: 'boh' }, 'POST'))).status).toBe(400)
  })
})

describe('PATCH /api/admin/merch/articoli', () => {
  it('404 articolo inesistente', async () => {
    h.existing = null
    expect((await ARTPATCH(json(A_URL, { id: '11111111-1111-4111-8111-111111111111', nome: 'X' }, 'PATCH'))).status).toBe(404)
  })
  it('403 articolo fuori dal plesso', async () => {
    h.existing = { id: 'art-1', scuola_id: 'sc-ALTRO' }
    expect((await ARTPATCH(json(A_URL, { id: '11111111-1111-4111-8111-111111111111', nome: 'X' }, 'PATCH'))).status).toBe(403)
  })
  it('200 aggiorna prezzo/attivo + audit', async () => {
    const res = await ARTPATCH(json(A_URL, { id: '11111111-1111-4111-8111-111111111111', prezzo: 22, attivo: false }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(h.updates[0].row).toMatchObject({ prezzo: 22, attivo: false })
    expect(h.logScrittura).toHaveBeenCalled()
  })
})

describe('DELETE /api/admin/merch/articoli', () => {
  it('404 articolo inesistente', async () => {
    h.existing = null
    expect((await ARTDELETE(new Request(`${A_URL}?id=11111111-1111-4111-8111-111111111111`, { method: 'DELETE' }))).status).toBe(404)
  })
  it('200 elimina articolo del plesso', async () => {
    const res = await ARTDELETE(new Request(`${A_URL}?id=11111111-1111-4111-8111-111111111111`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalled()
  })
})

describe('GET /api/admin/merch/ordini', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await ORDGET(new Request(O_URL))).status).toBe(403)
  })
  it('200 lista ordini del plesso', async () => {
    const res = await ORDGET(new Request(O_URL))
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data).toHaveLength(1)
  })
})

describe('PATCH /api/admin/merch/ordini', () => {
  it('400 stato non valido', async () => {
    expect((await ORDPATCH(json(O_URL, { id: '11111111-1111-4111-8111-111111111111', stato: 'boh' }, 'PATCH'))).status).toBe(400)
  })
  it('404 ordine inesistente', async () => {
    h.existing = null
    expect((await ORDPATCH(json(O_URL, { id: '11111111-1111-4111-8111-111111111111', stato: 'confermato' }, 'PATCH'))).status).toBe(404)
  })
  it('200 avanza stato + audit', async () => {
    const res = await ORDPATCH(json(O_URL, { id: '11111111-1111-4111-8111-111111111111', stato: 'consegnato' }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(h.updates[0].row).toMatchObject({ stato: 'consegnato' })
    expect(h.logScrittura).toHaveBeenCalled()
  })
})
