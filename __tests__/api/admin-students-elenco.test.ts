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

const riga = (id: string, stato: string | null, section_id: string | null, anonimizzato_il: string | null = null) => ({
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
      riga('f-ritirato-con-sezione', 'ritirato', 'sez-1'),
      riga('g-stato-null-con-sezione', null, 'sez-1'),
      riga('h-stato-null-senza-sezione', null, null),
      riga('i-trasferito-con-sezione', 'trasferito', 'sez-1'),
      riga('l-sospeso-senza-sezione', 'sospeso', null),
      riga('m-iscritto-anonimizzato', 'iscritto', 'sez-1', '2026-09-01T00:00:00Z'),
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
    expect(await ids('elenco=frequentanti')).toEqual(['a-frequenta', 'b-sospeso', 'g-stato-null-con-sezione', 'i-trasferito-con-sezione'])
  })
  it('non_iscritti = ritirati e senza sezione, anonimizzati esclusi', async () => {
    expect(await ids('elenco=non_iscritti')).toEqual([
      'c-senza-sezione', 'd-ritirato', 'f-ritirato-con-sezione', 'h-stato-null-senza-sezione', 'l-sospeso-senza-sezione',
    ])
  })
  it('senza parametro nulla cambia: tutta la sede', async () => {
    expect((await ids('')).length).toBe(11)
  })
  it('le due linguette sono una PARTIZIONE delle schede non anonimizzate', async () => {
    const f = await ids('elenco=frequentanti')
    const n = await ids('elenco=non_iscritti')
    expect(f.filter((x) => n.includes(x))).toEqual([])
    const attese = h.db.alunni.filter((r) => r.anonimizzato_il === null).map((r) => r.id as string).sort()
    expect([...f, ...n].sort()).toEqual(attese)
  })
  it('un valore sconosciuto è un 400, non «tutto»', async () => {
    const res = await GET(new Request('http://localhost/api/admin/students?elenco=tutti') as never)
    expect(res.status).toBe(400)
  })
})
