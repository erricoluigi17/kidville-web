import { describe, it, expect, vi, beforeEach } from 'vitest'

// A2 — /api/chat/contacts risolveva i legami leggendo SOLO
// `legame_genitori_alunni`, in ENTRAMBI i versi: la maestra non vedeva i
// genitori dei bambini importati dal form pubblico, e quei genitori non
// vedevano nessuna maestra. Nessun errore, nessun 403: una lista vuota.

const ALUNNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  righe: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.or = chain; b.not = chain; b.limit = chain
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: righe(), error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/chat/contacts/route'

const req = () => new Request('http://localhost/api/chat/contacts')

beforeEach(() => {
  vi.clearAllMocks()
  h.righe = {}
})

describe('GET /api/chat/contacts — unione runtime+anagrafica', () => {
  it('maestra: vede il genitore legato SOLO via student_parents', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'doc1', role: 'educator' } })
    h.righe = {
      utenti: [
        { id: 'doc1', ruolo: 'maestra', role: 'educator' },
        { id: 'gen1', nome: 'Anna', cognome: 'Bianchi', first_name: null, last_name: null },
      ],
      utenti_sezioni: [{ sections: { name: 'Girasoli' } }],
      alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Rossi', classe_sezione: 'Girasoli' }],
      legame_genitori_alunni: [],
      student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'gen1' }],
      chat_threads: [],
    }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.contacts).toHaveLength(1)
    expect(j.contacts[0]).toMatchObject({ user_id: 'gen1', user_role: 'genitore', student_id: ALUNNO })
  })

  it('maestra: il parents SENZA account non compare tra i contatti', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'doc1', role: 'educator' } })
    h.righe = {
      utenti: [{ id: 'doc1', ruolo: 'maestra', role: 'educator' }],
      utenti_sezioni: [{ sections: { name: 'Girasoli' } }],
      alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Rossi', classe_sezione: 'Girasoli' }],
      legame_genitori_alunni: [],
      student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: null }],
      chat_threads: [],
    }
    const j = await (await GET(req())).json()
    expect(j.contacts).toHaveLength(0)
  })

  it('genitore: vede la maestra del figlio legato SOLO via student_parents', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen1', role: 'genitore' } })
    h.righe = {
      utenti: [
        { id: 'gen1', ruolo: 'genitore', role: 'genitore' },
        { id: 'doc1', nome: 'Maria', cognome: 'Verdi', first_name: null, last_name: null },
      ],
      legame_genitori_alunni: [],
      parents: [{ id: 'p1', auth_user_id: 'gen1' }],
      student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
      alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Rossi', classe_sezione: 'Girasoli', section_id: 'sec1' }],
      utenti_sezioni: [{ section_id: 'sec1', utente_id: 'doc1' }],
      chat_threads: [],
    }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.contacts.map((c: { user_id: string }) => c.user_id)).toContain('doc1')
  })
})
