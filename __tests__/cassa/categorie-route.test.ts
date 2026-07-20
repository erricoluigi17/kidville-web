import { it, expect, vi, beforeEach, describe } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'

// ── Categorie cassa (E2.6) ────────────────────────────────────────────────────
// GET consentito a tutto lo staff (serve il select del form uscita); scritture solo
// admin (403 per segreteria); slug generato server-side; is_sistema non eliminabile
// (409); degradazione schema assente → { disponibile:false, categorie:[] }.

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  scuola: vi.fn(),
  scuoleAttive: vi.fn(),
  // risultati per operazione sul mock supabase
  list: { data: null as unknown, error: null as unknown },
  insert: { data: null as unknown, error: null as unknown },
  update: { data: null as unknown, error: null as unknown },
  del: { data: null as unknown, error: null as unknown },
  cat: null as Record<string, unknown> | null, // riga letta prima di PATCH/DELETE
  inserts: [] as unknown[],
  updates: [] as Record<string, unknown>[],
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

const SC = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, allowed: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!allowed.includes(h.role)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: 'u1', role: h.role, scuola_id: SC } })
  },
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: (...a: unknown[]) => h.scuola(...a),
  resolveScuoleAttive: (...a: unknown[]) => h.scuoleAttive(...a),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.or = () => b
      b.is = () => b
      b.order = () => b
      b.eq = () => b
      b.insert = (row: unknown) => { h.inserts.push(row); b._op = 'insert'; return b }
      b.update = (row: Record<string, unknown>) => { h.updates.push(row); b._op = 'update'; return b }
      b.delete = () => { b._op = 'delete'; return b }
      b.maybeSingle = async () => ({ data: h.cat, error: null })
      b.single = async () => (b._op === 'insert' ? h.insert : h.update)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(b._op === 'delete' ? h.del : h.list)
      return b
    },
  }),
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/pagamenti/cassa/categorie/route'

const CAT = '11111111-1111-4111-8111-111111111111'
const get = () => new NextRequest(`http://localhost/api/pagamenti/cassa/categorie?scuola_id=${SC}`, { headers: { 'x-user-id': 'u1' } })
const post = (body: unknown) => new NextRequest('http://localhost/api/pagamenti/cassa/categorie', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'u1' }, body: JSON.stringify(body) })
const patch = (body: unknown) => new NextRequest('http://localhost/api/pagamenti/cassa/categorie', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-user-id': 'u1' }, body: JSON.stringify(body) })
const del = (id: string) => new NextRequest(`http://localhost/api/pagamenti/cassa/categorie?id=${id}`, { method: 'DELETE', headers: { 'x-user-id': 'u1' } })

beforeEach(() => {
  vi.clearAllMocks()
  h.role = 'admin'
  h.scuola.mockResolvedValue({ scuolaId: SC })
  h.scuoleAttive.mockResolvedValue([SC])
  h.list = { data: [], error: null }
  h.insert = { data: { id: CAT }, error: null }
  h.update = { data: { id: CAT }, error: null }
  h.del = { data: null, error: null }
  h.cat = null
  h.inserts = []
  h.updates = []
})

describe('GET /api/pagamenti/cassa/categorie', () => {
  it('consentito alla segreteria (serve al form uscita)', async () => {
    h.role = 'segreteria'
    h.list = { data: [{ id: CAT, nome: 'Pulizie', slug: 'pulizie', is_sistema: false }], error: null }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(true)
    expect(body.categorie).toHaveLength(1)
  })

  it('schema assente (42P01) → 200 { disponibile:false, categorie:[] }', async () => {
    h.list = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
    expect(body.categorie).toEqual([])
  })
})

describe('scritture — gate solo admin', () => {
  it('POST come segreteria → 403', async () => {
    h.role = 'segreteria'
    const res = await POST(post({ nome: 'Nuova' }))
    expect(res.status).toBe(403)
  })
  it('PATCH come segreteria → 403', async () => {
    h.role = 'segreteria'
    const res = await PATCH(patch({ id: CAT, nome: 'Rinomina' }))
    expect(res.status).toBe(403)
  })
  it('DELETE come segreteria → 403', async () => {
    h.role = 'segreteria'
    const res = await DELETE(del(CAT))
    expect(res.status).toBe(403)
  })
})

describe('POST — slug generato server-side', () => {
  it('genera lo slug dal nome (admin)', async () => {
    const res = await POST(post({ nome: 'Forniture Didattiche & Varie' }))
    expect(res.status).toBe(201)
    const row = h.inserts[0] as { nome: string; slug: string; is_sistema: boolean }
    expect(row.slug).toBe('forniture-didattiche-varie')
    expect(row.is_sistema).toBe(false)
  })
})

describe('DELETE', () => {
  it('409 se la categoria è di sistema', async () => {
    h.cat = { scuola_id: null, is_sistema: true }
    const res = await DELETE(del(CAT))
    expect(res.status).toBe(409)
  })
  it('404 se non esiste', async () => {
    h.cat = null
    const res = await DELETE(del(CAT))
    expect(res.status).toBe(404)
  })
  it('200 su categoria personalizzata della propria sede', async () => {
    h.cat = { scuola_id: SC, is_sistema: false }
    const res = await DELETE(del(CAT))
    expect(res.status).toBe(200)
  })
  it('200 su categoria GLOBALE (scuola_id null) — gestibile da qualunque admin', async () => {
    h.cat = { scuola_id: null, is_sistema: false }
    const res = await DELETE(del(CAT))
    expect(res.status).toBe(200)
  })

  // RC2 — scope di sede: una categoria DI SEDE altrui non è eliminabile.
  it('RC2 — categoria di una sede FUORI scope → 403, nessuna cancellazione', async () => {
    h.cat = { scuola_id: 'e2e00000-0000-4000-8000-000000000001', is_sistema: false }
    h.scuoleAttive.mockResolvedValue([SC])
    const res = await DELETE(del(CAT))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Sede non accessibile')
  })
})

// RC2 — PATCH: scope di sede + guard is_sistema + rigenerazione slug + 23505→409.
describe('PATCH — scope di sede, is_sistema, slug (RC2)', () => {
  it('404 se la categoria non esiste', async () => {
    h.cat = null
    const res = await PATCH(patch({ id: CAT, nome: 'X' }))
    expect(res.status).toBe(404)
    expect(h.updates).toHaveLength(0)
  })

  it('categoria di una sede FUORI scope → 403, nessun update', async () => {
    h.cat = { scuola_id: 'e2e00000-0000-4000-8000-000000000001', is_sistema: false }
    h.scuoleAttive.mockResolvedValue([SC])
    const res = await PATCH(patch({ id: CAT, nome: 'Rinomina' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Sede non accessibile')
    expect(h.updates).toHaveLength(0)
  })

  it('categoria di SISTEMA → 409 (stesso guard del DELETE), nessun update', async () => {
    h.cat = { scuola_id: null, is_sistema: true }
    const res = await PATCH(patch({ id: CAT, nome: 'Rinomina' }))
    expect(res.status).toBe(409)
    expect(h.updates).toHaveLength(0)
  })

  it('categoria GLOBALE (scuola_id null) → consentita a qualunque admin, con rigenerazione slug', async () => {
    h.cat = { scuola_id: null, is_sistema: false }
    const res = await PATCH(patch({ id: CAT, nome: 'Nuovo Nome & Co' }))
    expect(res.status).toBe(200)
    expect(h.updates[0].slug).toBe('nuovo-nome-co')
  })

  it('rinomina di categoria della propria sede → rigenera lo slug server-side', async () => {
    h.cat = { scuola_id: SC, is_sistema: false }
    const res = await PATCH(patch({ id: CAT, nome: 'Caffè & Tè' }))
    expect(res.status).toBe(200)
    expect(h.updates[0].nome).toBe('Caffè & Tè')
    expect(h.updates[0].slug).toBe('caffe-te')
  })

  it('PATCH che NON cambia il nome non tocca lo slug', async () => {
    h.cat = { scuola_id: SC, is_sistema: false }
    const res = await PATCH(patch({ id: CAT, attivo: false }))
    expect(res.status).toBe(200)
    expect('slug' in h.updates[0]).toBe(false)
  })

  it('violazione unique sullo slug (23505) → 409', async () => {
    h.cat = { scuola_id: SC, is_sistema: false }
    h.update = { data: null, error: { code: '23505', message: 'duplicate key' } }
    const res = await PATCH(patch({ id: CAT, nome: 'Duplicato' }))
    expect(res.status).toBe(409)
  })
})
