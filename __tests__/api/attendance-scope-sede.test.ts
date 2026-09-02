import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Stesso schema di B1/B2 su altre due route trovate dall'audit
// (`grep "eq('classe_sezione'" src/app/api`): il filtro è il NOME della classe,
// che con tre sedi non è più una chiave univoca («2 ANNI» sta ad Aversa e a
// Cesa). Entrambe girano in service-role, quindi la RLS non copre nulla.
//
//  · attendance/daily:GET     — nessuno scope: nomi + presenze dei minori di
//                               un'altra sede a chi ne indovina il nome-classe.
//  · attendance/delegates:GET — il gate `assertClasseNomeInScope` c'era già, ma
//                               la query no: chi ha una classe OMONIMA nella
//                               propria sede si portava dietro i delegati al
//                               ritiro dell'altra sede (nome + n. documento).
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
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET as GET_DAILY } from '@/app/api/attendance/daily/route'
import { GET as GET_DELEGATES } from '@/app/api/attendance/delegates/route'

const reqDaily = (sezione: string) =>
  new NextRequest(`http://localhost/api/attendance/daily?data=${GIORNO}&sezione=${encodeURIComponent(sezione)}`)
const reqDelegates = (sezione: string) =>
  new NextRequest(`http://localhost/api/attendance/delegates?sezione=${encodeURIComponent(sezione)}`)

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b2', scuola_id: SEDE_B, name: SOLO_B },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: 'sec-a' }],
  presenze: [
    { id: 'pre-a', alunno_id: ALU_A, data: GIORNO, stato: 'presente', alunni: { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', section_id: 'sec-a', classe_sezione: OMONIMA, scuola_id: SEDE_A } },
    { id: 'pre-b', alunno_id: ALU_B, data: GIORNO, stato: 'assente', alunni: { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', section_id: 'sec-b', classe_sezione: OMONIMA, scuola_id: SEDE_B } },
  ],
  delegates: [
    { id: 'del-a', student_id: ALU_A, first_name: 'Nonna', last_name: 'Sede-A', document_number: 'DOC-A', alunni: { section_id: 'sec-a', classe_sezione: OMONIMA, scuola_id: SEDE_A } },
    { id: 'del-b', student_id: ALU_B, first_name: 'Nonno', last_name: 'Sede-B', document_number: 'DOC-B', alunni: { section_id: 'sec-b', classe_sezione: OMONIMA, scuola_id: SEDE_B } },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/attendance/daily — isolamento per sede', () => {
  it('classi OMONIME: restituisce solo le presenze della propria sede', async () => {
    const res = await GET_DAILY(reqDaily(OMONIMA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.map((r: { id: string }) => r.id)).toEqual(['pre-a'])
    expect(JSON.stringify(j)).not.toContain('Beta')
  })

  it('403 su una classe di un\'altra sede, senza leggere le presenze', async () => {
    const res = await GET_DAILY(reqDaily(SOLO_B))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('presenze')
  })

  it('sezione assente: risposta vuota, nessun 400 (comportamento invariato)', async () => {
    const res = await GET_DAILY(new NextRequest(`http://localhost/api/attendance/daily?data=${GIORNO}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(h.tabelle).not.toContain('presenze')
  })
})

describe('GET /api/attendance/delegates — isolamento per sede', () => {
  it('classi OMONIME: nessun delegato (né numero di documento) dell\'altra sede', async () => {
    const res = await GET_DELEGATES(reqDelegates(OMONIMA))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('Nonna Sede-A')
    expect(corpo).not.toContain('Nonno Sede-B')
  })

  it('403 su una classe di un\'altra sede, senza leggere i delegati', async () => {
    const res = await GET_DELEGATES(reqDelegates(SOLO_B))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('delegates')
  })
})
