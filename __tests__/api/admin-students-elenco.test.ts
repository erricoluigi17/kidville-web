import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

const h = vi.hoisted(() => ({ requireStaff: vi.fn(), db: {} as Record<string, Record<string, unknown>[]> }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const c = () => creaFintoSupabase(h.db as DBFinto)
  return { createAdminClient: async () => c(), createClient: async () => c() }
})

import { GET } from '@/app/api/admin/students/route'

const riga = (id: string, stato: string, section_id: string | null, anonimizzato_il: string | null = null) => ({
  id, scuola_id: SEDE_A, nome: 'N', cognome: id, data_nascita: null, codice_fiscale: null,
  classe_sezione: section_id ? 'SEZ' : null, stato, section_id, note_mediche: null, allergies: null, allergeni: null,
  archiviato_il: null, archiviato_classe_sezione: null, spazio_liberato_il: null, anonimizzato_il,
})

beforeEach(() => {
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.db = {
    utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SEDE_A }],
    utenti_scuole: [],
    alunni: [
      riga('a-frequenta', 'iscritto', 'sez-1'),
      riga('b-sospeso', 'sospeso', 'sez-1'),
      riga('c-senza-sezione', 'iscritto', null),
      riga('d-ritirato', 'ritirato', null),
      riga('e-anonimizzato', 'ritirato', null, '2026-09-01T00:00:00Z'),
    ],
  }
})

const ids = async (qs: string) => {
  const res = await GET(new Request(`http://localhost/api/admin/students?${qs}`) as never)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: string }[]).map((r) => r.id).sort()
}

describe('GET /api/admin/students?elenco=…', () => {
  it('frequentanti = iscritti e sospesi CON sezione', async () => {
    expect(await ids('elenco=frequentanti')).toEqual(['a-frequenta', 'b-sospeso'])
  })
  it('non_iscritti = ritirati e senza sezione, anonimizzati esclusi', async () => {
    expect(await ids('elenco=non_iscritti')).toEqual(['c-senza-sezione', 'd-ritirato'])
  })
  it('senza parametro nulla cambia: tutta la sede', async () => {
    expect((await ids('')).length).toBe(5)
  })
  it('un valore sconosciuto è un 400, non «tutto»', async () => {
    const res = await GET(new Request('http://localhost/api/admin/students?elenco=tutti') as never)
    expect(res.status).toBe(400)
  })
})
