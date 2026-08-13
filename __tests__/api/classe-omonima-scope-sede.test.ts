import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Audit dello schema B1/B2 sulle route rimanenti (`grep "eq('classe_sezione'"`):
//
//  · register/lessons:GET — nessuno scope: argomenti, compiti e firme docenti
//    della classe OMONIMA di un'altra sede a chi ne indovina il nome.
//  · chat/contacts:GET    — la maestra risolve la PROPRIA sezione, ma gli alunni
//    venivano cercati per solo nome-classe: si portava dentro i bambini e i
//    GENITORI della classe omonima dell'altra sede, come contatti chat aperti.
//
// Il finto client applica davvero i filtri: se il `.in('scuola_id', …)` sparisce,
// questi test tornano rossi.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OMONIMA = '2 ANNI'
const SOLO_B = 'SOLO SEDE B'
const GIORNO = '2026-07-29'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET as GET_LESSONS } from '@/app/api/register/lessons/route'
import { GET as GET_CONTACTS } from '@/app/api/chat/contacts/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b2', scuola_id: SEDE_B, name: SOLO_B },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: 'sec-a', sections: { name: OMONIMA } }],
  registro_orario: [
    { id: 'lez-a', scuola_id: SEDE_A, classe_sezione: OMONIMA, data: GIORNO, ora_lezione: 1, materia: 'Italiano', argomento: 'ARG-SEDE-A', firme_docenti: [] },
    { id: 'lez-b', scuola_id: SEDE_B, classe_sezione: OMONIMA, data: GIORNO, ora_lezione: 1, materia: 'Italiano', argomento: 'ARG-SEDE-B', firme_docenti: [] },
  ],
  utenti: [
    { id: 'ed1', ruolo: 'educator', role: 'educator', nome: 'Maestra', cognome: 'Sede-A' },
    { id: 'gen-A', nome: 'Genitore', cognome: 'Sede-A', first_name: null, last_name: null },
    { id: 'gen-B', nome: 'Genitore', cognome: 'Sede-B', first_name: null, last_name: null },
  ],
  alunni: [
    // `stato` esplicito: dal 2026-08-13 la rubrica lato maestra legge i soli
    // bambini ancora a scuola, e una fixture che lo tace non descrive più due
    // bambini in classe — descrive due righe che nessuna rubrica raggiunge.
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, scuola_id: SEDE_A, stato: 'iscritto' },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, scuola_id: SEDE_B, stato: 'iscritto' },
  ],
  legame_genitori_alunni: [
    { alunno_id: ALU_A, genitore_id: 'gen-A' },
    { alunno_id: ALU_B, genitore_id: 'gen-B' },
  ],
  student_parents: [],
  parents: [],
  chat_threads: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
  h.requireUser.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/register/lessons — isolamento per sede', () => {
  const req = (classe: string) =>
    new NextRequest(`http://localhost/api/register/lessons?classeSezione=${encodeURIComponent(classe)}&data=${GIORNO}`)

  it('classi OMONIME: restituisce solo le lezioni della propria sede', async () => {
    const res = await GET_LESSONS(req(OMONIMA))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('ARG-SEDE-A')
    expect(corpo).not.toContain('ARG-SEDE-B')
  })

  it('403 su una classe di un\'altra sede, senza leggere il registro', async () => {
    const res = await GET_LESSONS(req(SOLO_B))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('registro_orario')
  })
})

describe('GET /api/chat/contacts — isolamento per sede (maestra)', () => {
  const req = () => new NextRequest('http://localhost/api/chat/contacts')

  it('classi OMONIME: nessun genitore della sede B fra i contatti', async () => {
    const res = await GET_CONTACTS(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.contacts.map((c: { user_id: string }) => c.user_id)).toEqual(['gen-A'])
    expect(j.contacts.map((c: { student_id: string }) => c.student_id)).not.toContain(ALU_B)
  })
})
