import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// /api/news/categorie (GET+POST+PATCH+DELETE) — clone del pattern
// pagamenti/cassa/categorie: GET requireDocente (globali + sede), le mutazioni
// requireStaff con slugify server-side, guard is_sistema → 409, collisione slug
// 23505 → 409, scope RC2 di sede prima di ogni scrittura, degrado schema-assente.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  cat: null as Record<string, unknown> | null,
  cats: [] as Array<Record<string, unknown>>,
  errCatLoad: null as string | null,
  errList: null as string | null,
  errInsert: null as string | null,
  errUpdate: null as string | null,
  errDelete: null as string | null,
  lastInsert: null as Record<string, unknown> | null,
  lastUpdate: null as Record<string, unknown> | null,
  deleted: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
}))

function resolveResult(st: { table: string; op: string; filters: Record<string, unknown>; payload: Record<string, unknown> | null }, mode: string) {
  const errObj = (code: string | null) => (code ? { code, message: `err ${code}` } : null)
  if (st.table === 'news_categorie') {
    if (st.op === 'insert') return { data: h.errInsert ? null : { id: 'new-cat', ...(st.payload ?? {}) }, error: errObj(h.errInsert) }
    if (st.op === 'update') return { data: h.errUpdate ? null : { id: (st.filters.id as string) ?? 'cat-x', ...(h.cat ?? {}), ...(st.payload ?? {}) }, error: errObj(h.errUpdate) }
    if (st.op === 'delete') return { data: null, error: errObj(h.errDelete) }
    if (mode === 'maybeSingle') return { data: h.cat, error: errObj(h.errCatLoad) }
    return { data: h.cats, error: errObj(h.errList) }
  }
  return { data: null, error: null }
}

function makeClient() {
  return {
    from(table: string) {
      const st = { table, op: 'select', filters: {} as Record<string, unknown>, payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.in = () => b
      b.or = () => b
      b.is = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.insert = (rec: Record<string, unknown>) => { st.op = 'insert'; st.payload = rec; h.lastInsert = rec; return b }
      b.update = (rec: Record<string, unknown>) => { st.op = 'update'; st.payload = rec; h.lastUpdate = rec; return b }
      b.delete = () => { st.op = 'delete'; h.deleted = true; return b }
      b.single = async () => resolveResult(st, 'single')
      b.maybeSingle = async () => resolveResult(st, 'maybeSingle')
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(resolveResult(st, 'list')).then(onF, onR)
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import { GET, POST, PATCH, DELETE } from '@/app/api/news/categorie/route'

const CAT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const req = (opts: { qs?: string; body?: unknown; method?: string }) => ({
  url: `http://test/api/news/categorie${opts.qs ? `?${opts.qs}` : ''}`,
  method: opts.method ?? 'GET',
  headers: new Headers(),
  json: async () => opts.body,
  cookies: { get: () => undefined },
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.cat = null
  h.cats = []
  h.errCatLoad = null
  h.errList = null
  h.errInsert = null
  h.errUpdate = null
  h.errDelete = null
  h.lastInsert = null
  h.lastUpdate = null
  h.deleted = false
  h.requireDocente.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
})

describe('GET /api/news/categorie', () => {
  it('401 quando requireDocente nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req({}))
    expect(res.status).toBe(401)
  })

  it('elenca le categorie', async () => {
    h.cats = [{ id: 'c1', nome: 'Eventi', slug: 'eventi', is_sistema: true, attivo: true, scuola_id: null }]
    const res = await GET(req({}))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.disponibile).toBe(true)
    expect(j.categorie.length).toBe(1)
  })

  it('degrado schema-assente → {disponibile:false, categorie:[]}', async () => {
    h.errList = 'PGRST205'
    const res = await GET(req({}))
    const j = await res.json()
    expect(j.disponibile).toBe(false)
    expect(j.categorie).toEqual([])
  })
})

describe('POST /api/news/categorie', () => {
  it('403 quando requireStaff nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await POST(req({ body: { nome: 'Sport' }, method: 'POST' }))
    expect(res.status).toBe(403)
  })

  it('400 quando manca il nome', async () => {
    const res = await POST(req({ body: {}, method: 'POST' }))
    expect(res.status).toBe(400)
  })

  it('crea con slug generato server-side', async () => {
    const res = await POST(req({ body: { nome: 'Feste di Città' }, method: 'POST' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.slug).toBe('feste-di-citta')
    expect(h.lastInsert?.is_sistema).toBe(false)
  })
})

describe('PATCH /api/news/categorie', () => {
  it('409 su categoria di sistema', async () => {
    h.cat = { id: CAT_ID, scuola_id: null, is_sistema: true }
    const res = await PATCH(req({ body: { id: CAT_ID, nome: 'X' }, method: 'PATCH' }))
    expect(res.status).toBe(409)
    expect(h.lastUpdate).toBeNull()
  })

  it('rinomina rigenera lo slug', async () => {
    h.cat = { id: CAT_ID, scuola_id: 'sc-1', is_sistema: false }
    const res = await PATCH(req({ body: { id: CAT_ID, nome: 'Nuovo Nome' }, method: 'PATCH' }))
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.slug).toBe('nuovo-nome')
  })

  it('collisione slug (23505) → 409', async () => {
    h.cat = { id: CAT_ID, scuola_id: 'sc-1', is_sistema: false }
    h.errUpdate = '23505'
    const res = await PATCH(req({ body: { id: CAT_ID, nome: 'Duplicato' }, method: 'PATCH' }))
    expect(res.status).toBe(409)
  })

  it('scope: categoria di altra sede → 403', async () => {
    h.cat = { id: CAT_ID, scuola_id: 'sc-altra', is_sistema: false }
    h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
    const res = await PATCH(req({ body: { id: CAT_ID, nome: 'X' }, method: 'PATCH' }))
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/news/categorie', () => {
  it('409 su is_sistema', async () => {
    h.cat = { id: CAT_ID, scuola_id: null, is_sistema: true }
    const res = await DELETE(req({ qs: `id=${CAT_ID}`, method: 'DELETE' }))
    expect(res.status).toBe(409)
    expect(h.deleted).toBe(false)
  })

  it('elimina una categoria personalizzata', async () => {
    h.cat = { id: CAT_ID, scuola_id: 'sc-1', is_sistema: false }
    const res = await DELETE(req({ qs: `id=${CAT_ID}`, method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.deleted).toBe(true)
  })
})
