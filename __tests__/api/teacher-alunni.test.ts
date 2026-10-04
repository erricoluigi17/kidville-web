import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  opzioni: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, h.opzioni as OpzioniFinto) }
})

import * as rotta from '@/app/api/teacher/alunni/route'

const riga = (id: string, nome: string, cognome: string, section_id: string, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, nome, cognome, section_id, scuola_id,
  stato: 'iscritto', anonimizzato_il: null, gender: 'F', data_nascita: '2021-03-04',
  allergies: null, allergeni: [], is_bes_dsa: false, usa_pannolino: false,
  consenso_foto_sito: true, consenso_foto_social: true,
  note_mediche: 'NOTA-RISERVATA', codice_fiscale: 'TSTCFX21C44Z999Q', importo_retta_mensile: 987,
  ...extra,
})

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: 'Girasoli', school_type: 'infanzia' },
    { id: SEZ_MATERIA, scuola_id: SEDE_A, name: '3A', school_type: 'primaria' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: 'Tulipani', school_type: 'infanzia' },
    { id: SEZ_B, scuola_id: SEDE_B, name: 'Girasoli', school_type: 'infanzia' },
  ],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_sezioni_materie: [{ utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' }],
  utenti_scuole: [],
  alunni: [
    riga('a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', 'Alfa', 'Zeta', SEZ_MIA, SEDE_A),
    riga('a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa', 'Beta', 'Alfieri', SEZ_MATERIA, SEDE_A, { allergeni: ['latte'] }),
    riga('a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa', 'Gamma', 'Altrui', SEZ_ALTRUI, SEDE_A),
    riga('b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb', 'Delta', 'Sedeb', SEZ_B, SEDE_B),
    riga('a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa', 'Eta', 'Ritirato', SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
    riga('a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa', 'Teta', 'Anonimo', SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
  ],
})

const chiama = () => rotta.GET(new NextRequest('http://localhost/api/teacher/alunni'))

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.opzioni = {}
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/alunni', () => {
  it('educator: solo i bambini iscritti delle sue sezioni (dirette e per materia), in ordine di cognome', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const corpo = await res.json()
    expect(corpo.alunni.map((a: { cognome: string }) => a.cognome)).toEqual(['Alfieri', 'Zeta'])
    expect(corpo.sezioni.map((s: { id: string }) => s.id).sort()).toEqual([SEZ_MIA, SEZ_MATERIA].sort())
    expect(corpo.alunni[0]).toMatchObject({ grado: 'primaria', allergeni: ['latte'], haAllergie: true })
  })

  it('niente testo sanitario, codice fiscale o economia nell’elenco', async () => {
    const testo = await (await chiama()).text()
    for (const v of ['NOTA-RISERVATA', 'TSTCFX', '987']) expect(testo).not.toContain(v)
  })

  it('educator senza assegnazioni: elenco vuoto SENZA interrogare gli alunni', async () => {
    h.db.utenti_sezioni = []
    h.db.utenti_sezioni_materie = []
    const res = await chiama()
    expect(await res.json()).toEqual({ sezioni: [], alunni: [] })
    expect(h.tabelle).not.toContain('alunni')
  })

  it('segreteria: tutti gli iscritti della propria sede, nessuno dell’altra', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const corpo = await (await chiama()).json()
    expect(corpo.alunni.map((a: { cognome: string }) => a.cognome)).toEqual(['Alfieri', 'Altrui', 'Zeta'])
  })

  it('il rifiuto del gate di ruolo passa intatto e non legge niente', async () => {
    h.requireDocente.mockResolvedValue({ response: new Response('{}', { status: 403 }) })
    expect((await chiama()).status).toBe(403)
    expect(h.tabelle).toEqual([])
  })

  it('500 se gli alunni non si leggono', async () => {
    h.opzioni = { errori: { alunni: { code: '57P01' } } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ANAGRAFICA_ELENCO_NON_LETTO')
  })

  it('500 se le assegnazioni non si leggono, senza toccare gli alunni', async () => {
    h.opzioni = { errori: { utenti_sezioni: { code: '57P01' } } }
    expect((await chiama()).status).toBe(500)
    expect(h.tabelle).not.toContain('alunni')
  })

  it('sola lettura: il modulo esporta SOLO `GET`', () => {
    const metodi = Object.keys(rotta).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    expect(metodi).toEqual(['GET'])
  })
})
