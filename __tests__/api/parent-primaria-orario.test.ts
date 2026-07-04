import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── P2/Slice 3 — Orario settimanale visibile ai genitori. ──
// GET parent-scoped che ricalca la lettura docente (/api/primaria/orario) per la
// sezione del figlio (campanelle + griglia). Read-only.

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
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
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
const auth = vi.hoisted(() => ({ getRequestUserId: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ getRequestUserId: auth.getRequestUserId }))

import { GET } from '@/app/api/parent/primaria/orario/route'
import { NextRequest } from 'next/server'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/parent/primaria/orario${qs}`, { headers: { 'x-user-id': 'u-1' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  auth.getRequestUserId.mockReturnValue('u-1')
})

describe('GET /api/parent/primaria/orario', () => {
  it('401 senza userId', async () => {
    auth.getRequestUserId.mockReturnValue(null)
    const res = await GET(req('?studentId=a-1'))
    expect(res.status).toBe(401)
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

  it('200 con arrays vuoti se alunno senza sezione', async () => {
    h.state.queues = { alunni: [{ data: { id: 'a-1', section_id: null }, error: null }] }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ campanelle: [], orario: [] })
  })

  it('200 con campanelle + orario della sezione del figlio', async () => {
    h.state.queues = {
      alunni: [{ data: { id: 'a-1', section_id: 'sez-1' }, error: null }],
      campanelle: [{ data: [{ id: 'c-1', giorno_settimana: 1, ordine: 1 }], error: null }],
      orario_settimanale: [{ data: [{ id: 'o-1', giorno_settimana: 1, campanella_id: 'c-1', materia_id: 'm-1' }], error: null }],
    }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.campanelle).toHaveLength(1)
    expect(body.data.orario).toHaveLength(1)
  })
})
