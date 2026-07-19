import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// GET /api/pagamenti/pagante-comune?alunni=<uuid>,<uuid> → risolve il genitore
// pagante comune agli alunni riconosciuti per CF (per precompilare «Incasso unico»).

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sp: [] as { parent_id: string | null; student_id: string | null }[],
  spError: null as { code?: string } | null,
  defaults: [] as { id: string }[],
  defaultsError: null as { code?: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.in = () => b
      b.eq = () => b
      // student_parents: risolto via `.in(...).then`; parents (default) via `.eq(...).then`
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          table === 'student_parents'
            ? { data: h.spError ? null : h.sp, error: h.spError }
            : { data: h.defaultsError ? null : h.defaults, error: h.defaultsError },
        )
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/pagante-comune/route'

const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const MAMMA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const PAPA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

const get = (qs: string) => GET(new Request(`http://localhost/api/pagamenti/pagante-comune?${qs}`) as never)

beforeEach(() => {
  vi.clearAllMocks()
  h.sp = []
  h.spError = null
  h.defaults = []
  h.defaultsError = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('GET /api/pagamenti/pagante-comune', () => {
  it('risolve il genitore comune ai due alunni', async () => {
    h.sp = [
      { parent_id: MAMMA, student_id: A1 },
      { parent_id: MAMMA, student_id: A2 },
    ]
    const res = await get(`alunni=${A1},${A2}`)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.parent_id).toBe(MAMMA)
  })

  it('due comuni → vince l\'intestatario di default', async () => {
    h.sp = [
      { parent_id: MAMMA, student_id: A1 }, { parent_id: MAMMA, student_id: A2 },
      { parent_id: PAPA, student_id: A1 }, { parent_id: PAPA, student_id: A2 },
    ]
    h.defaults = [{ id: PAPA }]
    const res = await get(`alunni=${A1},${A2}`)
    const j = await res.json()
    expect(j.data.parent_id).toBe(PAPA)
  })

  it('nessun comune a tutti → parent_id null (degradazione)', async () => {
    h.sp = [{ parent_id: MAMMA, student_id: A1 }, { parent_id: PAPA, student_id: A2 }]
    const res = await get(`alunni=${A1},${A2}`)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.parent_id).toBeNull()
  })

  it('colonna intestatario_default assente (42703) → degrada a nessun default, non 500', async () => {
    h.sp = [{ parent_id: MAMMA, student_id: A1 }, { parent_id: MAMMA, student_id: A2 }]
    h.defaultsError = { code: '42703' }
    const res = await get(`alunni=${A1},${A2}`)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.parent_id).toBe(MAMMA)
  })

  it('errore DB su student_parents → 500', async () => {
    h.spError = { code: 'XX000' }
    const res = await get(`alunni=${A1},${A2}`)
    expect(res.status).toBe(500)
  })

  it('parametro alunni mancante → 400', async () => {
    expect((await get('')).status).toBe(400)
  })

  it('uuid non valido → 400', async () => {
    expect((await get('alunni=non-un-uuid')).status).toBe(400)
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await get(`alunni=${A1},${A2}`)).status).toBe(403)
  })
})
