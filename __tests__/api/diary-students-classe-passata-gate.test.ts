import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// Lotto 6 · N5 — il GATE VERO (`risolviSezione`, non mockato) davanti a `dellAnno=1`: una classe passata che NON è del docente
// risponde 403 e non legge né `frequenze` né `alunni`. Il test accanto (`diary-students-classe-passata`) mocka `risolviSezione`
// e prova il secondo livello; questo prova il primo.

const DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_SUA = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_ALTRUI = 'aaaa1111-0000-4000-8000-0000000000a2'
const ANNO_VECCHIO = 'a0000000-0000-4000-8000-000000000026'

const h = vi.hoisted(() => ({ requireDocente: vi.fn(), db: {} as DBFinto, tabelle: [] as string[] }))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE_A],
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn(), verificaLegameGenitore: vi.fn(), getGenitoriDiAlunno: vi.fn(),
  getGenitoriDiAlunni: async () => new Map(),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = async () => creaFintoSupabase(h.db, h.tabelle, { rpc: { sezioni_visibili_docente: () => ({ data: [], error: null }) } })
  return { createAdminClient: crea, createClient: crea }
})

import { GET } from '@/app/api/diary/students/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.db = {
    sections: [
      { id: SEC_SUA, scuola_id: SEDE_A, name: 'Sua', anno_id: 'a0000000-0000-4000-8000-000000000027' },
      { id: SEC_ALTRUI, scuola_id: SEDE_A, name: 'Altrui', anno_id: ANNO_VECCHIO },
    ],
    anni_sede: [{ id: 'b1', anno_id: ANNO_VECCHIO, scuola_id: SEDE_A, stato: 'chiuso' }],
    alunni: [{ id: 'c1', nome: 'Uno', cognome: 'Alfa', note_mediche: 'NOTA', classe_sezione: 'Altrui', section_id: SEC_ALTRUI, scuola_id: SEDE_A, anonimizzato_il: null }],
    frequenze: [{ id: 'f1', alunno_id: 'c1', anno_id: ANNO_VECCHIO, section_id: SEC_ALTRUI, stato: 'iscritto' }],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: SEC_SUA }],
    utenti_scuole: [],
    utenti: [],
  }
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/diary/students?dellAnno=1 — il gate vero', () => {
  it('🔴 una classe passata NON assegnata al docente: 403, e nessun bambino né frequenza letti', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/diary/students?sectionId=${SEC_ALTRUI}&dellAnno=1`))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('NOTA')
    expect(h.tabelle).not.toContain('frequenze')
    expect(h.tabelle).not.toContain('alunni')
  })
})
