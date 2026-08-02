import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// W3-A — `/api/educator-sections` restituisce un'IDENTITÀ, non una stringa.
//
// Difetto chiuso qui (R106): il ramo «manager» faceva
// `.select('name, school_type')` — né `id` né `scuola_id` — e rispondeva
// `sectionNames` piatto. Per l'admin sulle tre sedi l'elenco conteneva «2 ANNI»
// due volte, identiche e indistinguibili: la home docente ne disegnava due chip
// con la STESSA chiave React, che si accendevano insieme, e da lì partivano
// `attendance/daily`, `diary/students` (che restituisce `note_mediche`) e la
// POST dell'agenda — tutte con un nome che vale per due plessi.
//
// Secondo difetto (R111): il «Metodo 2» leggeva `eventi_diario.sezione` e
// `.teacher_id`, due colonne che NON ESISTONO. PostgREST rispondeva 42703,
// nessuno leggeva `{ error }`, e il ramo restituiva sempre `[]`: una rete di
// sicurezza che non c'era. Qui si verifica che quella query non parta più.
//
// Terzo difetto, trovato scrivendo il test: il «Metodo 0» (canonico,
// `utenti_sezioni`) NON era filtrato per sede — `nomiSezioniDiUtente` non
// conosce i plessi — mentre il ramo manager sì. Le chip di un docente legato a
// due sedi ignoravano il SedeSelector.
//
// Finto client che filtra davvero: si asserisce il contenuto esatto della
// risposta e QUALI tabelle sono state lette.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_A_2ANNI = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_B_2ANNI = 'bbbb2222-0000-4000-8000-0000000000b2'
const SEC_A_3ANNI = 'aaaa3333-0000-4000-8000-0000000000a3'
const ALUNNO_A = 'a1a1a1a1-0000-4000-8000-0000000000a1'
const ALUNNO_B = 'b1b1b1b1-0000-4000-8000-0000000000b1'

const OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET } from '@/app/api/educator-sections/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A_2ANNI, scuola_id: SEDE_A, name: OMONIMA, school_type: 'nido' },
    { id: SEC_B_2ANNI, scuola_id: SEDE_B, name: OMONIMA, school_type: 'nido' },
    { id: SEC_A_3ANNI, scuola_id: SEDE_A, name: '3 ANNI A', school_type: 'infanzia' },
  ],
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  utenti: [
    { id: ID_ADMIN, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    { id: ID_DOCENTE, ruolo: 'maestra', role: 'educator', scuola_id: SEDE_A },
  ],
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [
    { utente_id: ID_DOCENTE, section_id: SEC_A_2ANNI },
    { utente_id: ID_DOCENTE, section_id: SEC_B_2ANNI },
  ],
  galleria_media_v2: [],
  alunni: [],
})

function richiesta(qs = '', cookie?: string): NextRequest {
  return {
    url: `http://localhost/api/educator-sections${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

interface SezioneEsposta {
  id: string
  name: string
  scuolaId: string
  scuolaNome: string
  school_type: string | null
}

const corpo = async (res: Response): Promise<{
  sectionNames: string[]
  sections: SezioneEsposta[]
  role: string
}> => await res.json()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/educator-sections — ramo manager: due sedi, due identità', () => {
  it('sezioni omonime di sedi diverse ⇒ due voci con id e sede distinti', async () => {
    const res = await GET(richiesta())

    expect(res.status).toBe(200)
    const j = await corpo(res)
    const omonime = j.sections.filter((s) => s.name === OMONIMA)
    expect(omonime).toHaveLength(2)
    expect(omonime.map((s) => s.id).sort()).toEqual([SEC_A_2ANNI, SEC_B_2ANNI].sort())
    expect(omonime.map((s) => s.scuolaId).sort()).toEqual([SEDE_A, SEDE_B].sort())
    expect(omonime.map((s) => s.scuolaNome).sort()).toEqual([NOME_SEDE_A, NOME_SEDE_B].sort())
    expect(omonime.every((s) => s.school_type === 'nido')).toBe(true)
  })

  it('`sectionNames` resta per i consumer legacy, ma senza il doppione', async () => {
    const j = await corpo(await GET(richiesta()))

    expect(j.sectionNames).toEqual([OMONIMA, '3 ANNI A'])
    expect(j.role).toBe('admin')
  })

  it('SedeSelector su una sola sede ⇒ solo le sezioni di quella sede', async () => {
    const j = await corpo(await GET(richiesta('', SEDE_B)))

    expect(j.sections).toEqual([
      { id: SEC_B_2ANNI, name: OMONIMA, scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B, school_type: 'nido' },
    ])
  })

  it('scope vuoto (cookie su sede non accessibile) ⇒ nessuna sezione e nessuna lettura', async () => {
    const j = await corpo(await GET(richiesta('', SEDE_C)))

    expect(j.sections).toEqual([])
    expect(j.sectionNames).toEqual([])
    expect(h.tabelle).not.toContain('sections')
  })
})

describe('GET /api/educator-sections — ramo educator: identità e sede', () => {
  it('il docente vede solo le sezioni assegnate DENTRO i suoi plessi', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: ID_DOCENTE, role: 'educator', scuola_id: SEDE_A } })

    const j = await corpo(await GET(richiesta()))

    // È assegnato anche alla «2 ANNI» di SEDE_B, che non è un suo plesso.
    expect(j.sections).toEqual([
      { id: SEC_A_2ANNI, name: OMONIMA, scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, school_type: 'nido' },
    ])
    expect(j.role).toBe('educator')
  })

  it('admin che guarda un docente (?userId=) ⇒ il SedeSelector filtra anche il Metodo 0', async () => {
    const j = await corpo(await GET(richiesta(`userId=${ID_DOCENTE}`, SEDE_B)))

    expect(j.sections).toEqual([
      { id: SEC_B_2ANNI, name: OMONIMA, scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B, school_type: 'nido' },
    ])
    expect(j.role).toBe('educator')
  })

  it('il «Metodo 2» è sparito: `eventi_diario` non viene più interrogata', async () => {
    h.db.utenti_sezioni = []
    h.requireDocente.mockResolvedValue({ user: { id: ID_DOCENTE, role: 'educator', scuola_id: SEDE_A } })

    const j = await corpo(await GET(richiesta()))

    expect(j.sections).toEqual([])
    expect(j.sectionNames).toEqual([])
    expect(h.tabelle).not.toContain('eventi_diario')
  })

  it('euristica sui media taggati: identità della sezione, mai quella dell\'altra sede', async () => {
    h.db.utenti_sezioni = []
    h.db.galleria_media_v2 = [
      { id: 'm1', uploaded_by: ID_DOCENTE, tag_students: [ALUNNO_A, ALUNNO_B] },
    ]
    h.db.alunni = [
      { id: ALUNNO_A, scuola_id: SEDE_A, section_id: SEC_A_3ANNI, classe_sezione: '3 ANNI A' },
      { id: ALUNNO_B, scuola_id: SEDE_B, section_id: SEC_B_2ANNI, classe_sezione: OMONIMA },
    ]
    h.requireDocente.mockResolvedValue({ user: { id: ID_DOCENTE, role: 'educator', scuola_id: SEDE_A } })

    const j = await corpo(await GET(richiesta()))

    expect(j.sections).toEqual([
      { id: SEC_A_3ANNI, name: '3 ANNI A', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, school_type: 'infanzia' },
    ])
  })
})
