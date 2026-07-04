import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  updateCapture: null as null | { table: string; payload: unknown; ids: string[] },
}))
vi.mock('@/lib/auth/require-staff', async (orig) => ({ ...(await orig() as object), requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.in = (_col: string, ids: string[]) => {
        if (h.updateCapture) h.updateCapture.ids = ids
        return { select: async () => ({ data: ids.map((id) => ({ id })), error: null }) }
      }
      q.update = (payload: unknown) => {
        h.updateCapture = { table, payload, ids: [] }
        return q
      }
      q.insert = (row: Record<string, unknown>) => ({ select: () => ({ single: async () => ({ data: { id: 'gm-new', ...row }, error: null }) }) })
      q.then = (r: (v: { data: unknown; error: null }) => unknown) => r({ data: [], error: null })
      return q
    },
  }),
}))

import { PATCH } from '@/app/api/admin/students/route'
import { GET as GM_GET, POST as GM_POST } from '@/app/api/admin/gruppi-mensa/route'

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never
const patchReq = (body: unknown) =>
  new Request('http://localhost/api/admin/students', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.updateCapture = null
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: 'sc1' } })
})

describe('PATCH /api/admin/students — bulk gruppo mensa', () => {
  it('assegna il gruppo mensa a tutti gli id e audita per alunno', async () => {
    const res = await PATCH(patchReq({ ids: ['a1', 'a2'], gruppo_mensa_id: 'gm1' }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.updated).toBe(2)
    expect(h.updateCapture?.payload).toEqual({ gruppo_mensa_id: 'gm1' })
    expect(h.logScrittura).toHaveBeenCalledTimes(2)
  })

  it('accetta gruppo_mensa_id null (rimozione dal gruppo)', async () => {
    const res = await PATCH(patchReq({ ids: ['a1'], gruppo_mensa_id: null }) as never)
    expect(res.status).toBe(200)
    expect(h.updateCapture?.payload).toEqual({ gruppo_mensa_id: null })
  })

  it('la bulk classe_sezione continua a funzionare (regressione)', async () => {
    const res = await PATCH(patchReq({ ids: ['a1'], classe_sezione: 'Girasoli' }) as never)
    expect(res.status).toBe(200)
    expect(h.updateCapture?.payload).toEqual({ classe_sezione: 'Girasoli' })
  })
})

describe('/api/admin/gruppi-mensa — gate', () => {
  it('GET 403 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await GM_GET(new Request('http://localhost/api/admin/gruppi-mensa') as never)
    expect(res.status).toBe(403)
  })

  it('POST crea un gruppo per lo staff', async () => {
    const res = await GM_POST(
      new Request('http://localhost/api/admin/gruppi-mensa', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'Turno 1', scuola_id: 'sc1' }) }) as never
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.nome).toBe('Turno 1')
  })
})
