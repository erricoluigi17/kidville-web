import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRUI = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const ALU_MATERIA = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'
const ALU_B = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ALU_RITIRATO = 'a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa'
const ALU_ANONIMO = 'a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa'
const CF_MIO = 'TSTMIO21C44Z999Q'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: undefined as Record<string, { code: string }> | undefined,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture } as OpzioniFinto),
  }
})

import * as rotta from '@/app/api/teacher/alunni/[id]/route'

const alunno = (id: string, section_id: string, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, section_id, scuola_id, nome: 'Alfa', cognome: 'Prova-E2E', stato: 'iscritto', anonimizzato_il: null,
  gender: 'F', data_nascita: '2021-03-04', codice_fiscale: `tst${id.slice(0, 4)}21c44z999q`,
  allergies: null, allergeni: [], note_mediche: null, is_bes_dsa: false, usa_pannolino: false,
  consenso_privacy: true, consenso_foto_sito: true, consenso_foto_social: false,
  importo_retta_mensile: 987, intestatario_fatture: 'INTESTATARIO-FINTO', documento_path: 'doc/ALUNNO-FINTO.pdf',
  ...extra,
})

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: 'Girasoli', school_type: 'infanzia' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: 'Tulipani', school_type: 'infanzia' },
    { id: SEZ_MATERIA, scuola_id: SEDE_A, name: '3A', school_type: 'primaria' },
    { id: SEZ_B, scuola_id: SEDE_B, name: 'Girasoli', school_type: 'infanzia' },
  ],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_sezioni_materie: [{ utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' }],
  utenti_scuole: [],
  alunni: [
    alunno(ALU_MIO, SEZ_MIA, SEDE_A, { codice_fiscale: CF_MIO.toLowerCase(), allergies: 'latte, fragole', allergeni: ['latte'] }),
    alunno(ALU_ALTRUI, SEZ_ALTRUI, SEDE_A),
    alunno(ALU_MATERIA, SEZ_MATERIA, SEDE_A),
    alunno(ALU_B, SEZ_B, SEDE_B),
    alunno(ALU_RITIRATO, SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
    alunno(ALU_ANONIMO, SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
  ],
  student_parents: [
    {
      student_id: ALU_MIO, relation_type: 'mother', is_primary: true,
      parents: { first_name: 'Mamma', last_name: 'Prova-E2E', phone_numbers: ['333 000 0000'], emails: ['mamma@example.test'], fiscal_code: 'tstmmm80a41z999q', anonimizzato_il: null, document_number: 'DOC-GENITORE-FINTO', documento_path: 'doc/GENITORE-FINTO.pdf' },
    },
    { student_id: ALU_MIO, relation_type: 'father', is_primary: false, parents: { first_name: 'Ex', last_name: 'Anonimo', anonimizzato_il: '2026-01-01T00:00:00Z' } },
    { student_id: ALU_ALTRUI, relation_type: 'mother', is_primary: true, parents: { first_name: 'Altra', last_name: 'Mamma', anonimizzato_il: null } },
  ],
  delegates: [
    { id: 'd1', student_id: ALU_MIO, first_name: 'Nonna', last_name: 'Prova-E2E', relation: 'Nonna', document_number: 'DOC-DELEGATO-FINTO', document_url: 'u', created_at: '2026-09-01T00:00:00Z' },
  ],
  fascicolo_accessi_audit: [],
})

const chiama = (id: string) =>
  rotta.GET(new NextRequest(`http://localhost/api/teacher/alunni/${id}`), { params: Promise.resolve({ id }) })

const audit = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'fascicolo_accessi_audit')

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = undefined
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/alunni/[id] — si apre', () => {
  it('educator della sezione: scheda completa, senza economia né documenti, e una riga di audit', async () => {
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const testo = await res.text()
    for (const v of ['987', 'INTESTATARIO-FINTO', 'ALUNNO-FINTO', 'DOC-GENITORE-FINTO', 'GENITORE-FINTO', 'DOC-DELEGATO-FINTO', 'Anonimo']) {
      expect(testo).not.toContain(v)
    }
    const scheda = JSON.parse(testo)
    expect(scheda.codiceFiscale).toBe(CF_MIO)
    expect(scheda.sezione).toEqual({ id: SEZ_MIA, nome: 'Girasoli', grado: 'infanzia' })
    expect(scheda.salute).toMatchObject({ allergeni: ['latte'], allergieAltro: 'fragole', haAllergie: true })
    expect(scheda.genitori).toEqual([
      { nome: 'Mamma', cognome: 'Prova-E2E', parentela: 'madre', principale: true, telefoni: ['333 000 0000'], email: ['mamma@example.test'], codiceFiscale: 'TSTMMM80A41Z999Q' },
    ])
    expect(scheda.delegati).toEqual([{ nome: 'Nonna', cognome: 'Prova-E2E', parentela: 'Nonna' }])

    expect(audit()).toHaveLength(1)
    expect(audit()[0].valori[0]).toMatchObject({ alunno_id: ALU_MIO, utente_id: 'ed1', azione: 'view', finalita: 'anagrafica-docente' })
  })

  it('educator assegnato per sola materia', async () => {
    expect((await chiama(ALU_MATERIA)).status).toBe(200)
  })

  it('segreteria: ogni bambino della propria sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    expect((await chiama(ALU_ALTRUI)).status).toBe(200)
  })

  it('se l’audit fallisce la scheda si mostra lo stesso, e il guasto va nei log', async () => {
    h.errori = { 'fascicolo_accessi_audit:insert': { code: '57P01' } }
    expect((await chiama(ALU_MIO)).status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('fascicolo', 'error', expect.objectContaining({ esito: 'audit-non-registrato', alunno_id: ALU_MIO }), expect.anything())
  })
})

describe('GET /api/teacher/alunni/[id] — non si apre', () => {
  it('403 su un bambino di un’altra sezione, SENZA leggerne l’anagrafica', async () => {
    const res = await chiama(ALU_ALTRUI)
    expect(res.status).toBe(403)
    expect(h.tabelle.filter((t) => t === 'alunni')).toHaveLength(1)
    expect(h.tabelle).not.toContain('student_parents')
    expect(h.tabelle).not.toContain('delegates')
    expect(audit()).toHaveLength(0)
    const testo = await res.text()
    expect(testo).not.toContain('tsta2a2')
    expect(testo).not.toContain('Altra')
  })

  it('403 su un bambino di un’altra sede', async () => {
    const res = await chiama(ALU_B)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('ANAGRAFICA_FUORI_SEDE')
  })

  it('404 per non iscritto, anonimizzato, inesistente', async () => {
    for (const id of [ALU_RITIRATO, ALU_ANONIMO, 'c0c0c0c0-0000-4000-8000-cccccccccccc']) {
      expect((await chiama(id)).status).toBe(404)
    }
    expect(h.tabelle).not.toContain('student_parents')
  })

  it('400 per un id che non è un uuid, senza toccare il database', async () => {
    expect((await chiama('non-un-uuid')).status).toBe(400)
    expect(h.tabelle).toEqual([])
  })

  it('il rifiuto del gate di ruolo passa intatto e non legge niente', async () => {
    h.requireDocente.mockResolvedValue({ response: new Response('{}', { status: 401 }) })
    expect((await chiama(ALU_MIO)).status).toBe(401)
    expect(h.tabelle).toEqual([])
  })

  it('500 se genitori o delegati non si leggono, e nessuna riga di audit', async () => {
    h.errori = { 'student_parents:select': { code: '57P01' } }
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ANAGRAFICA_NON_LETTA')
    expect(audit()).toHaveLength(0)
  })

  it('sola lettura: il modulo esporta SOLO `GET`', () => {
    const metodi = Object.keys(rotta).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    expect(metodi).toEqual(['GET'])
  })
})
