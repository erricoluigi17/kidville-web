import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// STEP 3 — archivio digest (lista + dettaglio) e generazione manuale.
//
// Invarianti sotto lock:
//  - genitore vede SOLO le edizioni INVIATE delle sedi dei propri figli.
//  - dettaglio di un'edizione fuori sede o non inviata → 404 (per il genitore).
//  - la lista NON espone il campo html (pesante); il dettaglio sì.
//  - /digest/genera: scuola_id NON accessibile → 403; happy path delega a
//    generaEInviaDigest (idempotenza garantita dalla lib, ON CONFLICT).
// =============================================================================

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  caricaFigliConTarget: vi.fn(),
  generaEInviaDigest: vi.fn(),
  edizioni: [] as Array<Record<string, unknown>>,
  edizioniError: null as unknown,
  edizione: null as Record<string, unknown> | null,
  calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
}))
vi.mock('@/lib/news/target', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, caricaFigliConTarget: (...a: unknown[]) => h.caricaFigliConTarget(...a) }
})
vi.mock('@/lib/news/digest', () => ({ generaEInviaDigest: (...a: unknown[]) => h.generaEInviaDigest(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
  createClient: async () => ({}),
}))

function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      const rec = (m: string) => (...args: unknown[]) => { h.calls.push({ table, m, args }); return b }
      for (const m of ['select', 'order', 'eq', 'in', 'is', 'not', 'limit']) b[m] = rec(m)
      b.maybeSingle = async () => ({ data: h.edizione, error: null })
      b.single = async () => ({ data: h.edizione, error: null })
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: h.edizioni, error: h.edizioniError }).then(onF, onR)
      return b
    },
  }
}

import { GET as digestGET } from '@/app/api/news/digest/route'
import { GET as digestIdGET } from '@/app/api/news/digest/[id]/route'
import { POST as generaPOST } from '@/app/api/news/digest/genera/route'

const ED_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const getReq = () => ({ url: 'http://test/api/news/digest', method: 'GET', headers: new Headers(), cookies: { get: () => undefined } }) as never
const idReq = () => ({ url: `http://test/api/news/digest/${ED_ID}`, method: 'GET', headers: new Headers(), cookies: { get: () => undefined } }) as never
const ctx = { params: Promise.resolve({ id: ED_ID }) }
const postReq = (body: unknown) => ({ url: 'http://test/api/news/digest/genera', method: 'POST', headers: new Headers(), json: async () => body, cookies: { get: () => undefined } }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.edizioni = []
  h.edizioniError = null
  h.edizione = null
  h.calls = []
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.caricaFigliConTarget.mockResolvedValue([{ scuola_id: 'sc-1', classe_sezione: '1A', grado: 'infanzia' }])
  h.generaEInviaDigest.mockResolvedValue({ edizioni: [] })
})

describe('GET /api/news/digest — lista', () => {
  it('401 quando anonimo', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await digestGET(getReq())
    expect(res.status).toBe(401)
  })

  it('genitore: filtra alle sole INVIATE (not inviata_il is null)', async () => {
    h.edizioni = [{ id: ED_ID, scuola_id: 'sc-1', anno: 2026, mese: 6, titolo: 'x', inviata_il: '2026-07-01', destinatari_count: 10, errori_count: 0 }]
    const res = await digestGET(getReq())
    expect(res.status).toBe(200)
    const notCall = h.calls.find((c) => c.table === 'news_digest_edizioni' && c.m === 'not')
    expect(notCall).toBeTruthy()
    expect(notCall!.args).toEqual(['inviata_il', 'is', null])
  })

  it('staff: NON filtra sulle inviate (vede anche le generate non inviate)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    await digestGET(getReq())
    const notCall = h.calls.find((c) => c.table === 'news_digest_edizioni' && c.m === 'not')
    expect(notCall).toBeUndefined()
  })

  it('genitore senza figli → lista vuota (fail-closed)', async () => {
    h.caricaFigliConTarget.mockResolvedValue([])
    const res = await digestGET(getReq())
    const j = (await res.json()) as { edizioni: unknown[] }
    expect(j.edizioni).toEqual([])
    expect(h.calls.some((c) => c.table === 'news_digest_edizioni')).toBe(false)
  })

  it('la lista NON seleziona il campo html', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    await digestGET(getReq())
    const sel = h.calls.find((c) => c.table === 'news_digest_edizioni' && c.m === 'select')
    expect(sel).toBeTruthy()
    expect(String(sel!.args[0])).not.toContain('html')
  })

  // C6 (lock zod-coverage gruppo news): la GET valida il query param opzionale
  // `userId` (uuid). Un valore malformato → 400, senza toccare il DB.
  it('400 su userId malformato in query (validazione zod)', async () => {
    const badReq = { url: 'http://test/api/news/digest?userId=non-uuid', method: 'GET', headers: new Headers(), cookies: { get: () => undefined } } as never
    const res = await digestGET(badReq)
    expect(res.status).toBe(400)
    expect(h.calls.some((c) => c.table === 'news_digest_edizioni')).toBe(false)
  })

  it('userId uuid valido in query → 200', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    const okReq = { url: `http://test/api/news/digest?userId=${ED_ID}`, method: 'GET', headers: new Headers(), cookies: { get: () => undefined } } as never
    const res = await digestGET(okReq)
    expect(res.status).toBe(200)
  })
})

describe('GET /api/news/digest/[id] — dettaglio', () => {
  it('genitore: edizione NON inviata → 404', async () => {
    h.edizione = { id: ED_ID, scuola_id: 'sc-1', anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: null }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })

  it('genitore: edizione di sede non dei figli → 404', async () => {
    h.edizione = { id: ED_ID, scuola_id: 'sc-2', anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: '2026-07-01' }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })

  it('genitore in sede + inviata → 200 con html', async () => {
    h.edizione = { id: ED_ID, scuola_id: 'sc-1', anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: '2026-07-01' }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { edizione: { html: string } }
    expect(j.edizione.html).toBe('<b>x</b>')
  })

  it('404 se l\'edizione non esiste', async () => {
    h.edizione = null
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/news/digest/genera', () => {
  it('scuola_id NON accessibile → 403, e generaEInviaDigest NON chiamata', async () => {
    h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
    const res = await generaPOST(postReq({ anno: 2026, mese: 2, scuola_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }))
    expect(res.status).toBe(403)
    expect(h.generaEInviaDigest).not.toHaveBeenCalled()
  })

  it('happy path: delega a generaEInviaDigest e ritorna le edizioni', async () => {
    h.generaEInviaDigest.mockResolvedValue({ edizioni: [{ scuola_id: 'sc-1', generata: true, inviata: true, destinatari_count: 3, errori_count: 0 }] })
    const res = await generaPOST(postReq({ anno: 2026, mese: 2 }))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { edizioni: Array<{ scuola_id: string }> }
    expect(j.edizioni).toHaveLength(1)
    expect(h.generaEInviaDigest).toHaveBeenCalledWith(expect.anything(), { anno: 2026, mese: 2, scuolaId: 'sc-1' })
  })

  it('body malformato (mese 13) → 400', async () => {
    const res = await generaPOST(postReq({ anno: 2026, mese: 13 }))
    expect(res.status).toBe(400)
    expect(h.generaEInviaDigest).not.toHaveBeenCalled()
  })
})
