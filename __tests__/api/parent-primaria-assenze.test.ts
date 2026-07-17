import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Vista genitore delle presenze primaria: lista dei soli stati negativi ──────
// (assenze/ritardi/uscite) + RIEPILOGO con COUNT per stato (incluso `presente`),
// così un bambino presente non è più indistinguibile da un appello non fatto.
// Auth via requireParentOfStudent (IDOR-safe); lettura service-role su `presenze`.
//
// Il mock distingue la query-lista (`.in('stato', [...])`) dalle query-conteggio
// (`.select('id', { count:'exact', head:true }).eq('stato', X)`) e ritorna il
// count per lo stato filtrato — così l'asserzione non dipende dall'ordine di call.

const h = vi.hoisted(() => {
  const state = {
    listResult: { data: null as unknown, error: null as unknown },
    counts: {} as Record<string, number>,
    countError: null as unknown,
  }
  function makeClient() {
    return {
      from(table: string) {
        const ctx: { head: boolean; stato?: string } = { head: false }
        const qb: Record<string, unknown> = {}
        qb.select = (_cols: string, opts?: { head?: boolean; count?: string }) => {
          if (opts?.head) ctx.head = true
          return qb
        }
        qb.eq = (col: string, val: string) => {
          if (col === 'stato') ctx.stato = val
          return qb
        }
        for (const m of ['in', 'order', 'limit', 'gte', 'lte']) qb[m] = () => qb
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (table !== 'presenze') return Promise.resolve({ data: null, count: null, error: null }).then(res, rej)
          const out = ctx.head
            ? { data: null, count: state.counts[ctx.stato ?? ''] ?? null, error: state.countError }
            : state.listResult
          return Promise.resolve(out).then(res, rej)
        }
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const auth = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: auth.requireParentOfStudent }))

import { GET } from '@/app/api/parent/primaria/assenze/route'
import { NextRequest, NextResponse } from 'next/server'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/parent/primaria/assenze${qs}`, {
    headers: { 'x-user-id': 'u-1' },
  })
}

const NEG = [
  { id: 'p1', data: '2026-05-10', stato: 'assente', orario_entrata: null, orario_uscita: null, giustificata: false, giustificazione_testo: null, giustificata_il: null, note_appello: null },
  { id: 'p2', data: '2026-05-08', stato: 'ritardo', orario_entrata: '2026-05-08T08:40:00Z', orario_uscita: null, giustificata: true, giustificazione_testo: 'traffico', giustificata_il: '2026-05-08T10:00:00Z', note_appello: null },
  { id: 'p3', data: '2026-05-02', stato: 'uscita_anticipata', orario_entrata: null, orario_uscita: '2026-05-02T12:30:00Z', giustificata: false, giustificazione_testo: null, giustificata_il: null, note_appello: 'visita medica' },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.state.listResult = { data: [], error: null }
  h.state.counts = {}
  h.state.countError = null
  auth.requireParentOfStudent.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' }, response: null })
})

describe('GET /api/parent/primaria/assenze', () => {
  it('401 senza sessione', async () => {
    auth.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await GET(req('?studentId=a-1'))
    expect(res.status).toBe(401)
  })

  it('403 se il figlio non è del genitore (IDOR)', async () => {
    auth.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })
    const res = await GET(req('?studentId=a-2'))
    expect(res.status).toBe(403)
  })

  it('400 senza studentId', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(400)
  })

  it('riepilogo: conta presente/assente/ritardo/uscita con COUNT per stato', async () => {
    h.state.counts = { presente: 152, assente: 4, ritardo: 2, uscita_anticipata: 1 }
    h.state.listResult = { data: NEG, error: null }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.riepilogo).toEqual({ presente: 152, assente: 4, ritardo: 2, uscita_anticipata: 1 })
  })

  it('la lista dei negativi resta invariata nel contenuto', async () => {
    h.state.counts = { presente: 100, assente: 1, ritardo: 1, uscita_anticipata: 1 }
    h.state.listResult = { data: NEG, error: null }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(body.data).toEqual(NEG)
  })

  it('degrada a 0/[] se le query falliscono (E2E DB non migrato)', async () => {
    h.state.listResult = { data: null, error: { code: '42P01', message: 'relation "presenze" does not exist' } }
    h.state.countError = { code: '42P01' }
    h.state.counts = {}
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.riepilogo).toEqual({ presente: 0, assente: 0, ritardo: 0, uscita_anticipata: 0 })
  })
})
