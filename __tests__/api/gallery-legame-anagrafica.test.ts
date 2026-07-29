import { describe, it, expect, vi, beforeEach } from 'vitest'

// A2 — Il gate `?parentId=` della galleria leggeva SOLO `legame_genitori_alunni`
// (spazio-id account). I genitori importati dal form pubblico hanno il legame
// SOLO in `student_parents` (spazio-id anagrafica): rispondeva 403 sul PROPRIO
// figlio. Qui si verifica l'unione delle due sorgenti in entrambi i versi.

const STUDENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  righe: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['sc-1'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.or = chain; b.not = chain
      b.gte = chain; b.lte = chain; b.order = chain; b.limit = chain
      b.range = async () => ({ data: righe(), count: righe().length, error: null })
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: righe(), error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/gallery/route'

const getReq = (qs: string) => new Request(`http://localhost/api/gallery?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore', scuola_id: null } })
  h.righe = {
    legame_genitori_alunni: [], // nessun legame runtime: è il caso reale post-import
    parents: [{ id: 'p1' }],
    student_parents: [{ student_id: STUDENT_ID }],
    alunni: [{ id: STUDENT_ID, scuola_id: 'sc-1' }],
    galleria_media_v2: [],
    utenti: [],
  }
})

describe('GET /api/gallery — legame solo anagrafico (student_parents)', () => {
  it('NON risponde 403 al genitore legato solo via student_parents', async () => {
    const res = await GET(getReq(`studentId=${STUDENT_ID}&parentId=gen1`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ media: [], total: 0 })
  })

  it('risponde 403 quando il legame non esiste in NESSUNA delle due sorgenti', async () => {
    h.righe.student_parents = []
    const res = await GET(getReq(`studentId=${STUDENT_ID}&parentId=gen1`))
    expect(res.status).toBe(403)
  })

  it('resta 200 col solo legame runtime (semantica storica preservata)', async () => {
    h.righe.legame_genitori_alunni = [{ genitore_id: 'gen1', alunno_id: STUDENT_ID }]
    h.righe.parents = []
    h.righe.student_parents = []
    const res = await GET(getReq(`studentId=${STUDENT_ID}&parentId=gen1`))
    expect(res.status).toBe(200)
  })
})
