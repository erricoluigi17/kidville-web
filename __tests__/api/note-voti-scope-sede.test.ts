import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Note disciplinari e valutazioni — il contenuto più delicato che un docente
// scrive su un bambino.
//
// Entrambe le route avevano `?alunnoId=` LIBERO, e **senza parametro**
// restituivano tutto di tutte le sedi. La POST scriveva su `alunnoIds` arbitrari
// e notificava i genitori.
//
// Qui si verifica anche la seconda regola decisa dal titolare il 2026-07-30:
// l'`educator` vede le SOLE sezioni assegnate, non tutte quelle del plesso.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'   // sede A, sezione assegnata
const ALU_A2 = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'  // sede A, sezione NON assegnata
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'   // sede B

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  enqueueNotifichePerAlunni: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: h.enqueueNotifichePerAlunni,
  notificaTitolariScrittura: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET as NOTE_GET, POST as NOTE_POST } from '@/app/api/notes/route'
import { GET as VOTI_GET, POST as VOTI_POST } from '@/app/api/grades/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)
const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a1', scuola_id: SEDE_A, name: '2 ANNI' },
    { id: 'sec-a2', scuola_id: SEDE_A, name: '3 ANNI' },
    { id: 'sec-b', scuola_id: SEDE_B, name: '2 ANNI' },
  ],
  utenti_scuole: [],
  // L'educator è assegnato SOLO a sec-a1.
  utenti_sezioni: [{ utente_id: 'ed1', section_id: 'sec-a1' }],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Assegnato', classe_sezione: '2 ANNI', section_id: 'sec-a1', scuola_id: SEDE_A },
    { id: ALU_A2, nome: 'Gamma', cognome: 'AltraClasse', classe_sezione: '3 ANNI', section_id: 'sec-a2', scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'AltraSede', classe_sezione: '2 ANNI', section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  note_disciplinari: [
    { id: 'n-a', alunno_id: ALU_A, testo: 'NOTA-ASSEGNATO', alunni: { nome: 'Alfa', cognome: 'Assegnato', classe_sezione: '2 ANNI', scuola_id: SEDE_A, section_id: 'sec-a1' } },
    { id: 'n-a2', alunno_id: ALU_A2, testo: 'NOTA-ALTRA-CLASSE', alunni: { nome: 'Gamma', cognome: 'AltraClasse', classe_sezione: '3 ANNI', scuola_id: SEDE_A, section_id: 'sec-a2' } },
    { id: 'n-b', alunno_id: ALU_B, testo: 'NOTA-ALTRA-SEDE', alunni: { nome: 'Beta', cognome: 'AltraSede', classe_sezione: '2 ANNI', scuola_id: SEDE_B, section_id: 'sec-b' } },
  ],
  valutazioni: [
    { id: 'v-a', alunno_id: ALU_A, materia: 'Italiano', giudizio_testo: 'VOTO-ASSEGNATO', alunni: { nome: 'Alfa', cognome: 'Assegnato', scuola_id: SEDE_A, section_id: 'sec-a1' } },
    { id: 'v-a2', alunno_id: ALU_A2, materia: 'Italiano', giudizio_testo: 'VOTO-ALTRA-CLASSE', alunni: { nome: 'Gamma', cognome: 'AltraClasse', scuola_id: SEDE_A, section_id: 'sec-a2' } },
    { id: 'v-b', alunno_id: ALU_B, materia: 'Italiano', giudizio_testo: 'VOTO-ALTRA-SEDE', alunni: { nome: 'Beta', cognome: 'AltraSede', scuola_id: SEDE_B, section_id: 'sec-b' } },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/notes — note disciplinari', () => {
  it('senza parametri: solo le note della propria sezione, non di tutte le sedi', async () => {
    const res = await NOTE_GET(req('/api/notes'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('NOTA-ASSEGNATO')
    expect(corpo).not.toContain('NOTA-ALTRA-SEDE')
    expect(corpo).not.toContain('NOTA-ALTRA-CLASSE')
  })

  it('?alunnoId di un\'altra sede: 403, senza leggere le note', async () => {
    const res = await NOTE_GET(req(`/api/notes?alunnoId=${ALU_B}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('note_disciplinari')
  })

  it('?alunnoId di una classe non assegnata, stessa sede: 403', async () => {
    const res = await NOTE_GET(req(`/api/notes?alunnoId=${ALU_A2}`))
    expect(res.status).toBe(403)
  })

  it('la segreteria vede tutte le classi del proprio plesso, ma non l\'altra sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await NOTE_GET(req('/api/notes'))
    const corpo = await res.text()
    expect(corpo).toContain('NOTA-ASSEGNATO')
    expect(corpo).toContain('NOTA-ALTRA-CLASSE')
    expect(corpo).not.toContain('NOTA-ALTRA-SEDE')
  })
})

describe('POST /api/notes — scrittura su un elenco di minori', () => {
  it('403 se anche UN SOLO alunno è fuori scope, e non scrive niente', async () => {
    const res = await NOTE_POST(post('/api/notes', {
      alunnoIds: [ALU_A, ALU_B], categoria: 'comportamento', testo: 'x',
    }))
    expect(res.status).toBe(403)
    expect(h.enqueueNotifichePerAlunni).not.toHaveBeenCalled()
  })
})

describe('GET /api/grades — valutazioni', () => {
  it('senza parametri: solo le valutazioni della propria sezione', async () => {
    const res = await VOTI_GET(req('/api/grades'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('VOTO-ASSEGNATO')
    expect(corpo).not.toContain('VOTO-ALTRA-SEDE')
    expect(corpo).not.toContain('VOTO-ALTRA-CLASSE')
  })

  it('?alunnoId di un\'altra sede: 403, senza leggere le valutazioni', async () => {
    const res = await VOTI_GET(req(`/api/grades?alunnoId=${ALU_B}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('valutazioni')
  })
})

describe('POST /api/grades — scrittura di una valutazione', () => {
  it('403 su un alunno di un\'altra sede', async () => {
    const res = await VOTI_POST(post('/api/grades', {
      alunnoId: ALU_B, materia: 'Italiano', giudizioTesto: 'manomesso',
    }))
    expect(res.status).toBe(403)
  })
})
