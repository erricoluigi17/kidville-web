import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// B1 — GET /api/admin/documents-merge esponeva nome, cognome e CODICE FISCALE
// dei minori di QUALSIASI sede: il gate `requireStaff` verifica il ruolo, non lo
// scope, e la query era `.eq('classe_sezione', className)` senza `scuola_id`.
// Con la route su service-role (RLS bypassata) il gate applicativo è l'unico
// presidio — e da quando le sedi sono tre esistono sezioni OMONIME («2 ANNI» ad
// Aversa e a Cesa), quindi il nome-classe non è più una chiave univoca.
//
// Qui il finto Supabase applica DAVVERO i filtri: «403» non basta, si verifica
// che gli alunni dell'altra sede non vengano nemmeno letti.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const FORM = '11111111-1111-4111-8111-111111111111'
const FORM_B = '55555555-5555-4555-8555-555555555555'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OMONIMA = '2 ANNI'
const SOLO_B = 'SOLO SEDE B'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET } from '@/app/api/admin/documents-merge/route'

const req = (classe: string, cookie?: string, form = FORM) =>
  new NextRequest(
    `http://localhost/api/admin/documents-merge?form_id=${form}&class_name=${encodeURIComponent(classe)}`,
    cookie ? { headers: { cookie } } : undefined,
  )

const dbBase = (): DBFinto => ({
  forms_templates: [
    { id: FORM, scuola_id: SEDE_A, title: 'Autorizzazione uscita', description: '', fields: [] },
    { id: FORM_B, scuola_id: SEDE_B, title: 'MODELLO-SOLO-SEDE-B', description: '', fields: [] },
  ],
  forms_submissions: [],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b2', scuola_id: SEDE_B, name: SOLO_B },
  ],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', codice_fiscale: 'CF-FINTO-A', section_id: 'sec-a', classe_sezione: OMONIMA, scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', codice_fiscale: 'CF-FINTO-B', section_id: 'sec-b', classe_sezione: OMONIMA, scuola_id: SEDE_B },
    { id: 'b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb', nome: 'Gamma', cognome: 'Sede-B', codice_fiscale: 'CF-FINTO-B2', section_id: 'sec-b2', classe_sezione: SOLO_B, scuola_id: SEDE_B },
  ],
  utenti_scuole: [],
  utenti_sezioni: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/admin/documents-merge — isolamento per sede (B1)', () => {
  it('403 se la classe è di un\'altra sede, e gli alunni non vengono nemmeno letti', async () => {
    const res = await GET(req(SOLO_B))
    expect(res.status).toBe(403)
    // Non basta il 403: nessuna lettura di anagrafica minori deve essere partita.
    expect(h.tabelle).not.toContain('alunni')
    const corpo = await res.text()
    expect(corpo).not.toContain('CF-FINTO-B2')
  })

  it('200 sulla PROPRIA sede: restituisce i propri alunni', async () => {
    const res = await GET(req(OMONIMA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results.map((r: { student_id: string }) => r.student_id)).toEqual([ALU_A])
    expect(j.results[0].codice_fiscale_alunno).toBe('CF-FINTO-A')
  })

  it('classi OMONIME in due sedi: nessun codice fiscale dell\'altra sede nel corpo', async () => {
    const res = await GET(req(OMONIMA))
    // Lo stato esatto va asserito sempre: un corpo che «non contiene» il dato
    // dell'altra sede è vero anche per un 500 (regola trasversale del piano
    // 2026-07-31 sui test d'isolamento).
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('CF-FINTO-A')
    expect(corpo).not.toContain('CF-FINTO-B')
  })

  it('admin multi-plesso: con il SedeSelector su A non vede gli alunni di B', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'adm1', role: 'admin', scuola_id: SEDE_A } })
    h.db.utenti_scuole = [
      { utente_id: 'adm1', scuola_id: SEDE_A },
      { utente_id: 'adm1', scuola_id: SEDE_B },
    ]
    const res = await GET(req(OMONIMA, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results.map((r: { student_id: string }) => r.student_id)).toEqual([ALU_A])
  })

  it('404 se il MODELLO di modulo è di un\'altra sede: gli alunni non vengono nemmeno letti', async () => {
    // `forms_templates.scuola_id` è NOT NULL: il gate sulla CLASSE non basta,
    // perché si può abbinare il modulo di un altro plesso alla propria classe e
    // portarsene fuori la struttura (titolo, descrizione, campi).
    const res = await GET(req(OMONIMA, undefined, FORM_B))
    expect(res.status).toBe(404)
    expect(h.tabelle).not.toContain('alunni')
    const corpo = await res.text()
    expect(corpo).not.toContain('MODELLO-SOLO-SEDE-B')
  })

  it('401 anonimo: nessun accesso al DB (gate di ruolo invariato)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req(OMONIMA))
    expect(res.status).toBe(401)
    expect(h.tabelle).toHaveLength(0)
  })
})
