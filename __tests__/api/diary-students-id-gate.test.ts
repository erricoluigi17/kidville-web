import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `GET /api/diary/students?id=<uuid>` — il ramo per id NON AVEVA ALCUN GATE.
//
// `requireDocente` era invocato solo DOPO il `return` di quel ramo, quindi
// bastava conoscere (o indovinare) un uuid per ottenere, SENZA CREDENZIALI:
// nome, cognome, classe, `note_mediche` (dato sanitario di un minore) e
// nome/cognome/email dei suoi genitori. Verificato in produzione il 2026-07-30:
// rispondeva 200 a una richiesta anonima.
//
// Qui si mette a contratto il triplo presidio: identità obbligatoria, legame
// genitore↔figlio per il genitore, plesso/sezioni per lo staff. Il ramo per
// sezione (già protetto) deve continuare a funzionare identico.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  getGenitoriDiAlunno: vi.fn(),
  getGenitoriDiAlunni: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

// `requireParentOfStudent` NON è mockato: è il gate che si sta verificando. Sono
// mockati i suoi due ingredienti (identità e legame), così il test prova la
// composizione vera, non una finzione.
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: h.genitoreHasFiglio,
  getGenitoriDiAlunno: h.getGenitoriDiAlunno,
  getGenitoriDiAlunni: h.getGenitoriDiAlunni,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET } from '@/app/api/diary/students/route'

const reqPerId = (id: string) =>
  new NextRequest(`http://localhost/api/diary/students?id=${id}`)

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: 'sec-a' }],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', note_mediche: 'ALLERGIA-A', classe_sezione: OMONIMA, section_id: 'sec-a', scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', note_mediche: 'ALLERGIA-B', classe_sezione: OMONIMA, section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  utenti: [
    { id: 'gen-b', nome: 'Genitore', cognome: 'Sede-B', email: 'gen.b@example.invalid' },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.getGenitoriDiAlunno.mockResolvedValue(['gen-b'])
  h.getGenitoriDiAlunni.mockResolvedValue(new Map())
  h.genitoreHasFiglio.mockResolvedValue(false)
})

describe('GET /api/diary/students?id= — identità obbligatoria', () => {
  it('anonimo: 401 e NON legge gli alunni', async () => {
    h.requireUser.mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Non autenticato' }), { status: 401 }),
    })
    const res = await GET(reqPerId(ALU_B))
    expect(res.status).toBe(401)
    // La prova che conta: la lettura non è nemmeno partita. Un 401 restituito
    // DOPO aver letto il dato non sarebbe una correzione.
    expect(h.tabelle).not.toContain('alunni')
  })
})

describe('GET /api/diary/students?id= — genitore', () => {
  it('genitore NON collegato: 403, nessuna nota medica in risposta', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-a', role: 'genitore', scuola_id: SEDE_A } })
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await GET(reqPerId(ALU_B))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('ALLERGIA-B')
    expect(h.tabelle).not.toContain('alunni')
  })

  it('genitore collegato: legge il proprio figlio', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-b', role: 'genitore', scuola_id: SEDE_B } })
    h.genitoreHasFiglio.mockResolvedValue(true)
    const res = await GET(reqPerId(ALU_B))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.id).toBe(ALU_B)
    expect(j.note_mediche).toBe('ALLERGIA-B')
  })
})

describe('GET /api/diary/students?id= — staff e isolamento per sede', () => {
  it('educator della sede A: 403 su un alunno della sede B', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET(reqPerId(ALU_B))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('ALLERGIA-B')
  })

  it('educator della sede A: legge un alunno della propria sezione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET(reqPerId(ALU_A))
    expect(res.status).toBe(200)
    expect((await res.json()).note_mediche).toBe('ALLERGIA-A')
  })

  it('segreteria della sede A: 403 su un alunno della sede B (vede tutte le CLASSI, non tutte le SEDI)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GET(reqPerId(ALU_B))
    expect(res.status).toBe(403)
  })

  it('cuoca: 403 anche nella propria sede (nessuna sezione assegnata, nessun legame)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'cuoca1', role: 'cuoca', scuola_id: SEDE_A } })
    const res = await GET(reqPerId(ALU_A))
    expect(res.status).toBe(403)
  })
})

describe('GET /api/diary/students?sezione= — il ramo già protetto non cambia', () => {
  it('classi OMONIME: solo gli alunni della propria sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET(
      new NextRequest(`http://localhost/api/diary/students?sezione=${encodeURIComponent(OMONIMA)}`),
    )
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('Alfa')
    expect(corpo).not.toContain('Beta')
    expect(corpo).not.toContain('ALLERGIA-B')
  })
})
