import { describe, it, expect, vi, beforeEach } from 'vitest'

// A2 — /api/diary/students elenca i GENITORI di un bambino (verso inverso) e
// leggeva solo `legame_genitori_alunni`: per i bambini importati dal form
// pubblico la maestra vedeva "nessun genitore" — nessuno da chiamare, nessuno
// a cui scrivere. Qui si verifica l'unione con l'anagrafica.

const ALUNNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  scuoleDiUtente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  righe: {} as Record<string, Record<string, unknown>[]>,
}))

// `requireUser` e `assertAlunnoInScope` servono da quando il ramo `?id=` ha un
// gate (prima non ne aveva alcuno: rispondeva a chiunque con le note mediche del
// minore). Qui sono concessivi di proposito — l'oggetto di QUESTO test è
// l'unione dei legami genitore↔figlio, non l'autorizzazione: quella sta in
// `__tests__/api/diary-students-id-gate.test.ts`.
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/auth/scope', () => ({
  scuoleDiUtente: h.scuoleDiUtente,
  assertAlunnoInScope: h.assertAlunnoInScope,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: righe(), error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/diary/students/route'

const req = (qs: string) =>
  ({ url: `http://localhost/api/diary/students?${qs}`, nextUrl: new URL(`http://localhost/api/diary/students?${qs}`), headers: new Headers() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'doc1', role: 'educator', scuola_id: 'sc-1' } })
  h.requireUser.mockResolvedValue({ user: { id: 'doc1', role: 'educator', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.righe = {
    alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Rossi', classe_sezione: 'Girasoli', note_mediche: null, consenso_privacy: true }],
    legame_genitori_alunni: [],
    student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
    parents: [{ id: 'p1', auth_user_id: 'gen1' }],
    utenti: [{ id: 'gen1', nome: 'Anna', cognome: 'Bianchi', email: 'anna@example.test' }],
  }
})

describe('GET /api/diary/students — genitori dall\'unione runtime+anagrafica', () => {
  it('?id=: elenca il genitore legato SOLO via student_parents', async () => {
    const res = await GET(req(`id=${ALUNNO}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.parents).toHaveLength(1)
    expect(j.parents[0]).toMatchObject({ id: 'gen1' })
  })

  it('?id=: nessun genitore quando il parents non ha account', async () => {
    h.righe.parents = [{ id: 'p1', auth_user_id: null }]
    const j = await (await GET(req(`id=${ALUNNO}`))).json()
    expect(j.parents).toEqual([])
  })

  it('?sezione=: la lista classe porta i genitori anche dall\'anagrafica', async () => {
    const res = await GET(req('sezione=Girasoli'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toHaveLength(1)
    expect(j[0].parents).toHaveLength(1)
    expect(j[0].parents[0]).toMatchObject({ id: 'gen1', nome: 'Anna' })
  })

  it('?id=: il legame runtime da solo continua a funzionare', async () => {
    h.righe.legame_genitori_alunni = [{ alunno_id: ALUNNO, genitore_id: 'gen1' }]
    h.righe.student_parents = []
    h.righe.parents = []
    const j = await (await GET(req(`id=${ALUNNO}`))).json()
    expect(j.parents).toHaveLength(1)
    expect(j.parents[0]).toMatchObject({ id: 'gen1' })
  })
})
