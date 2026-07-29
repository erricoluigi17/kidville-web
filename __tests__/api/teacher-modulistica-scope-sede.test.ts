import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// B2 — GET /api/teacher/modulistica esponeva nome e cognome dei minori di
// QUALSIASI sede: il commento diceva che «il gap auth è stato chiuso in M9», ma
// era stato chiuso sul RUOLO (`requireDocente`, che ammette anche `educator`),
// non sullo SCOPE. La query era `.eq('classe_sezione', className)` — nessun
// `scuola_id`, nessuna verifica che la sezione fosse fra quelle assegnate.
//
// Con tre sedi e sezioni omonime («2 ANNI» ad Aversa e a Cesa) bastava chiedere
// il nome giusto. Qui il finto Supabase applica DAVVERO i filtri: il 403 da solo
// non proverebbe che le righe non sono state lette.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ALU_A_ALTRA = 'a2a2a2a2-1111-4111-8111-aaaaaaaaaaaa'
const OMONIMA = '2 ANNI'
const ALTRA_DI_A = '5 ANNI'
const SOLO_B = 'SOLO SEDE B'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET } from '@/app/api/teacher/modulistica/route'

const req = (classe: string) =>
  new NextRequest(
    `http://localhost/api/teacher/modulistica?form_id=f1&class_name=${encodeURIComponent(classe)}`,
  )

const dbBase = (): DBFinto => ({
  forms_submissions: [],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-a2', scuola_id: SEDE_A, name: ALTRA_DI_A },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b2', scuola_id: SEDE_B, name: SOLO_B },
  ],
  // Il docente `ed1` è assegnato SOLO a «2 ANNI» della sede A.
  utenti_sezioni: [{ utente_id: 'ed1', section_id: 'sec-a' }],
  utenti_scuole: [],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, scuola_id: SEDE_B },
    { id: ALU_A_ALTRA, nome: 'Delta', cognome: 'Sede-A', classe_sezione: ALTRA_DI_A, scuola_id: SEDE_A },
    { id: 'b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb', nome: 'Gamma', cognome: 'Sede-B', classe_sezione: SOLO_B, scuola_id: SEDE_B },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/modulistica — isolamento per sede (B2)', () => {
  it('403 se la classe è di un\'altra sede, e gli alunni non vengono nemmeno letti', async () => {
    const res = await GET(req(SOLO_B))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('alunni')
    expect(await res.text()).not.toContain('Gamma')
  })

  it('classi OMONIME: il docente della sede A vede solo i propri alunni', async () => {
    const res = await GET(req(OMONIMA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.map((r: { student_id: string }) => r.student_id)).toEqual([ALU_A])
    expect(JSON.stringify(j)).not.toContain('Beta')
  })

  it('403 su una classe della PROPRIA sede ma non assegnata al docente', async () => {
    const res = await GET(req(ALTRA_DI_A))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('alunni')
  })

  it('la segreteria vede TUTTE le classi del proprio plesso (nessuna regressione)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GET(req(ALTRA_DI_A))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.map((r: { student_id: string }) => r.student_id)).toEqual([ALU_A_ALTRA])
  })

  it('la segreteria della sede A resta comunque fuori dalle classi della sede B', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GET(req(SOLO_B))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('alunni')
  })

  it('401 anonimo: nessun accesso al DB (gate di ruolo invariato)', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req(OMONIMA))
    expect(res.status).toBe(401)
    expect(h.tabelle).toHaveLength(0)
  })
})
