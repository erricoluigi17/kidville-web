import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Presenze lato genitore per la HOME (badge "A scuola" + riepilogo 30gg). ──
// GET parent-scoped read-only su `presenze`; auth via getRequestUserId.

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
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

import { GET } from '@/app/api/parent/presenze/route'
import { NextRequest, NextResponse } from 'next/server'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/parent/presenze${qs}`, { headers: { 'x-user-id': 'u-1' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  auth.requireParentOfStudent.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' }, response: null })
})

describe('GET /api/parent/presenze', () => {
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

  it('404 se alunno non trovato', async () => {
    h.state.queues = { alunni: [{ data: null, error: null }] }
    const res = await GET(req('?studentId=a-1'))
    expect(res.status).toBe(404)
  })

  it('200 infanzia: stato di oggi + conteggi ultimi 30gg (niente ore)', async () => {
    h.state.queues = {
      alunni: [{ data: { id: 'a-1', section_id: 'sez-1', scuola_id: 's-1' }, error: null }],
      sections: [{ data: { school_type: 'infanzia' }, error: null }],
      presenze: [
        // oggi
        { data: { stato: 'presente', orario_entrata: '08:30:00', orario_uscita: null }, error: null },
        // periodo (30gg)
        {
          data: [
            { stato: 'presente' },
            { stato: 'presente' },
            { stato: 'assente' },
            { stato: 'ritardo' },
          ],
          error: null,
        },
      ],
    }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.schoolType).toBe('infanzia')
    expect(body.data.oggi.stato).toBe('presente')
    expect(body.data.oggi.orario_entrata).toBe('08:30:00')
    expect(body.data.riepilogo).toMatchObject({ presenze: 2, assenze: 1, ritardi: 1, uscite: 0 })
    expect(body.data.riepilogo.ore).toBeUndefined()
  })

  it('200 con oggi=null se appello non registrato', async () => {
    h.state.queues = {
      alunni: [{ data: { id: 'a-1', section_id: null, scuola_id: 's-1' }, error: null }],
      presenze: [
        { data: null, error: null }, // oggi assente dal DB
        { data: [], error: null }, // nessuna presenza nei 30gg
      ],
    }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.schoolType).toBeNull()
    expect(body.data.oggi.stato).toBeNull()
    expect(body.data.riepilogo).toMatchObject({ presenze: 0, assenze: 0, ritardi: 0, uscite: 0 })
  })

  it('200 primaria: include monte ore perse dal registro', async () => {
    h.state.queues = {
      alunni: [{ data: { id: 'a-1', section_id: 'sez-2', scuola_id: 's-1' }, error: null }],
      sections: [{ data: { school_type: 'primaria' }, error: null }],
      presenze: [
        { data: { stato: 'assente', orario_entrata: null, orario_uscita: null }, error: null },
        { data: [{ stato: 'assente', orario_entrata: null, orario_uscita: null }], error: null },
      ],
      campanelle: [
        {
          data: [
            { ora_inizio: '08:00:00', ora_fine: '13:00:00', tipo: 'lezione' },
          ],
          error: null,
        },
      ],
    }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.schoolType).toBe('primaria')
    expect(body.data.oggi.stato).toBe('assente')
    expect(body.data.riepilogo.ore).toBeDefined()
    expect(body.data.riepilogo.ore.oreTotali).toBeGreaterThan(0)
  })
})
