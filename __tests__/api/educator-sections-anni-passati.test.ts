import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Lotto 6 · L6-1 — il docente apre in SOLA LETTURA le classi assegnate degli anni passati (decisione 14, §4.10).
//
// `?passati=1` porta, dopo la classe dell'anno in corso, quelle `in_chiusura` e `chiuso` con `solaLettura`, l'etichetta dell'anno
// e il suo stato. Senza il parametro la risposta è quella di sempre. Sul DB non migrato (la funzione dell'anno manca) vale il
// ripiego: tutte scrivibili, anno ignoto, e nessuna lettura di `anno_id`.
// =============================================================================

const ID_DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2'
const SEC_CHIUSA = 'aaaa1111-0000-4000-8000-0000000000a3'
const ANNO_NUOVO = 'a0000000-0000-4000-8000-000000000027'
const ANNO_VECCHIO = 'a0000000-0000-4000-8000-000000000026'
const ANNO_CHIUSO = 'a0000000-0000-4000-8000-000000000025'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  rpcVisibili: null as null | (() => { data: unknown; error: unknown }),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const rpc = {
    // l'anno ATTIVO della sede è il nuovo: senza `passati` il filtro d'anno lascia solo la sua classe
    anno_attivo: () => ({ data: 'b0000000-0000-4000-8000-000000000027', error: null }),
    sezioni_visibili_docente: () =>
      h.rpcVisibili ? h.rpcVisibili() : { data: null, error: { code: 'PGRST202', message: 'assente' } },
  }
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { rpc }) }
})

import { GET } from '@/app/api/educator-sections/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_NUOVA, scuola_id: SEDE_A, name: 'TEST Infanzia', school_type: 'infanzia', anno_id: ANNO_NUOVO },
    { id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia', school_type: 'infanzia', anno_id: ANNO_VECCHIO },
    { id: SEC_CHIUSA, scuola_id: SEDE_A, name: 'TEST Infanzia', school_type: 'infanzia', anno_id: ANNO_CHIUSO },
  ],
  schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
  utenti: [{ id: ID_DOCENTE, ruolo: 'maestra', role: 'educator', scuola_id: SEDE_A }],
  utenti_scuole: [],
  utenti_sezioni: [
    { utente_id: ID_DOCENTE, section_id: SEC_NUOVA },
    { utente_id: ID_DOCENTE, section_id: SEC_VECCHIA },
    { utente_id: ID_DOCENTE, section_id: SEC_CHIUSA },
  ],
  anni_scolastici: [
    { id: ANNO_NUOVO, etichetta_breve: '2027/28' },
    { id: ANNO_VECCHIO, etichetta_breve: '2026/27' },
    { id: ANNO_CHIUSO, etichetta_breve: '2025/26' },
  ],
  anni_sede: [
    { id: 'b0000000-0000-4000-8000-000000000027', anno_id: ANNO_NUOVO, scuola_id: SEDE_A, stato: 'corrente' },
    { id: 'b0000000-0000-4000-8000-000000000026', anno_id: ANNO_VECCHIO, scuola_id: SEDE_A, stato: 'in_chiusura' },
    { id: 'b0000000-0000-4000-8000-000000000025', anno_id: ANNO_CHIUSO, scuola_id: SEDE_A, stato: 'chiuso' },
  ],
  galleria_media_v2: [],
  alunni: [],
})

function richiesta(qs = ''): NextRequest {
  return {
    url: `http://localhost/api/educator-sections${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

interface Sez { id: string; name: string; solaLettura: boolean; annoEtichetta: string | null; annoStato: string | null }
const sezioni = async (res: Response): Promise<Sez[]> => (await res.json()).sections

const tutteVisibili = () => ({
  data: [
    { section_id: SEC_NUOVA, sola_lettura: false },
    { section_id: SEC_VECCHIA, sola_lettura: true },
    { section_id: SEC_CHIUSA, sola_lettura: true },
  ],
  error: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.rpcVisibili = tutteVisibili
  h.requireDocente.mockResolvedValue({ user: { id: ID_DOCENTE, role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/educator-sections?passati=1 — le classi degli anni passati, in sola lettura', () => {
  it('prima la classe scrivibile, poi quelle di sola lettura, ciascuna con anno e stato', async () => {
    const j = await sezioni(await GET(richiesta('passati=1')))
    expect(j.map((s) => [s.id, s.solaLettura, s.annoEtichetta, s.annoStato])).toEqual([
      [SEC_NUOVA, false, '2027/28', 'corrente'],
      [SEC_VECCHIA, true, '2026/27', 'in_chiusura'],
      [SEC_CHIUSA, true, '2025/26', 'chiuso'],
    ])
  })

  it('senza `passati` resta la sola classe dell\u2019anno in corso, com\u2019è sempre stato', async () => {
    const j = await sezioni(await GET(richiesta()))
    expect(j.map((s) => [s.id, s.solaLettura, s.annoEtichetta])).toEqual([[SEC_NUOVA, false, '2027/28']])
  })

  it('senza `passati` non c\u2019è la lettura in più delle sezioni senza filtro d\u2019anno (le pagine che scrivono non cambiano)', async () => {
    await GET(richiesta())
    const senza = h.tabelle.filter((x) => x === 'sections').length
    h.tabelle.length = 0
    await GET(richiesta('passati=1'))
    // con `passati=1`: la sola lettura in più, senza filtro d anno (le etichette si leggono in entrambi i casi)
    expect(h.tabelle.filter((x) => x === 'sections').length).toBe(senza + 1)
  })

  it('ripiego sul DB non migrato (funzione dell\u2019anno assente): tutte scrivibili, anno ignoto, `anno_id` mai letto', async () => {
    h.rpcVisibili = null
    h.db.sections = h.db.sections.slice(0, 1)
    const j = await sezioni(await GET(richiesta('passati=1')))
    expect(j).toHaveLength(1)
    expect(j[0]).toMatchObject({ id: SEC_NUOVA, solaLettura: false, annoEtichetta: null, annoStato: null })
    expect(h.tabelle).not.toContain('anni_scolastici')
  })
})
