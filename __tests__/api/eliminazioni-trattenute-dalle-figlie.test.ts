import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * FASE 7 DELLA ROADMAP DI ROBUSTEZZA · LE CANCELLAZIONI CHE LE FIGLIE TRATTENGONO.
 *
 * Tre route admin cancellavano un padre e lasciavano alla CASCADE i documenti appesi:
 *  · un PERIODO di scrutinio si portava via scrutini, pagelle, giudizi e ricevute (i giudizi
 *    descrittivi del periodo no: sono configurazione e restano CASCADE);
 *  · una MATERIA i giudizi di scrutinio (voti e registro la trattenevano già, ma la route
 *    rispondeva 500 con il messaggio grezzo di Postgres);
 *  · un MODULO le sue compilazioni firmate.
 * Dalla PR 2 della fase 7 quelle FK sono RESTRICT. Qui si prova che le route lo dicono
 * PRIMA, con un 409 e senza scrivere niente, e che un rifiuto del database arrivato fra la
 * guardia e la DELETE (23503 su Postgres 17, 23001 dal 18) è un 409 e non un 500.
 *
 * Si guarda lo STATO del finto database, non la forma delle chiamate. Solo dati finti.
 */

const SEZ_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const MAT_A = '44444444-1111-4111-8111-aaaaaaaaaaaa'
const PER_A = '55555555-1111-4111-8111-aaaaaaaaaaaa'
const PER_B = '55555555-2222-4222-8222-bbbbbbbbbbbb'
const MOD_A = '66666666-1111-4111-8111-aaaaaaaaaaaa'
const MOD_B = '66666666-2222-4222-8222-bbbbbbbbbbbb'
const ADMIN = '88888888-1111-4111-8111-aaaaaaaaaaaa'
const FRENO = (code: string) => ({ code, message: 'update or delete violates foreign key constraint' })

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: undefined as Record<string, { code: string; message: string }> | undefined,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireDocente: h.requireDocente }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<object>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, [], { scritture: h.scritture as never, ...(h.errori ? { errori: h.errori } : {}) })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { DELETE as PERIODI_DELETE } from '@/app/api/admin/primaria/scrutinio-periodi/route'
import { DELETE as MATERIE_DELETE } from '@/app/api/admin/primaria/materie/route'
import { DELETE as MODULI_DELETE } from '@/app/api/admin/forms/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`, { method: 'DELETE' })
const conCorpo = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/forms', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const cancellazioni = (tabella: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === 'delete')
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
    sections: [
      { id: SEZ_A, scuola_id: SEDE_A, name: '1 A' },
      { id: SEZ_B, scuola_id: SEDE_B, name: '1 A' },
    ],
    utenti_scuole: [],
    utenti_sezioni: [],
    utenti: [{ id: ADMIN, scuola_id: SEDE_A, ruolo: 'admin', nome: 'Dir', cognome: 'Uno' }],
    scrutinio_periodi: [
      { id: PER_A, scuola_id: SEDE_A, anno_scolastico: '2025/2026', nome: 'Primo quadrimestre', ordine: 1 },
      { id: PER_B, scuola_id: SEDE_B, anno_scolastico: '2025/2026', nome: 'Primo quadrimestre', ordine: 1 },
    ],
    scrutini: [],
    scrutinio_giudizio_descrittivo: [],
    materie: [{ id: MAT_A, section_id: SEZ_A, scuola_id: SEDE_A, nome: 'Italiano', codice: 'ITA', ordine: 1 }],
    scrutinio_giudizi: [],
    forms_templates: [
      { id: MOD_A, scuola_id: SEDE_A, title: 'Uscita didattica' },
      { id: MOD_B, scuola_id: SEDE_B, title: 'Uscita didattica' },
    ],
    forms_submissions: [],
  } as DBFinto
  h.scritture = []
  h.errori = undefined
  const admin = { id: ADMIN, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A }
  h.requireStaff.mockResolvedValue({ user: admin })
  h.requireDocente.mockResolvedValue({ user: admin })
})

describe('DELETE scrutinio-periodi — gli scrutini trattengono il periodo', () => {
  it('🔴 periodo con uno scrutinio → 409 PERIODO_CON_SCRUTINI, niente cancellato (prima: scrutinio e pagelle via in cascata)', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: PER_A, section_id: SEZ_A }]
    const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_A}`))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PERIODO_CON_SCRUTINI')
    expect(cancellazioni('scrutinio_periodi')).toEqual([])
    expect(h.db.scrutinio_periodi.map((p) => p.id)).toContain(PER_A)
  })

  it('un periodo con soli giudizi descrittivi (configurazione della sede, non documenti) si elimina', async () => {
    // Restano CASCADE di proposito: sono la tabella dei livelli, non il giudizio di un alunno.
    h.db.scrutinio_giudizio_descrittivo = [{ id: 'g1', periodo_id: PER_A }]
    const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_A}`))
    expect(res.status).toBe(200)
    expect(h.db.scrutinio_periodi.map((p) => p.id)).not.toContain(PER_A)
  })

  it('un periodo di un altro plesso, anche con scrutini, resta 404: il 409 non diventa un oracolo', async () => {
    h.db.scrutini = [{ id: 'sc2', periodo_id: PER_B, section_id: SEZ_B }]
    const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_B}`))
    expect(res.status).toBe(404)
    expect(cancellazioni('scrutinio_periodi')).toEqual([])
  })

  for (const code of ['23503', '23001']) {
    it(`🔴 il freno del database rifiuta (${code}) → 409, non 500 col messaggio di Postgres`, async () => {
      h.errori = { 'scrutinio_periodi:delete': FRENO(code) }
      const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_A}`))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('PERIODO_CON_SCRUTINI')
    })
  }

  it('periodo vuoto del proprio plesso → 200, cancellato e registrato nel log', async () => {
    const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_A}`))
    expect(res.status).toBe(200)
    expect(h.db.scrutinio_periodi.map((p) => p.id)).not.toContain(PER_A)
    expect(eventi('periodo-eliminato')).toHaveLength(1)
  })
})

describe('DELETE materie — giudizi, voti e registro trattengono la materia', () => {
  it('🔴 materia con un giudizio di scrutinio → 409 MATERIA_IN_USO, niente cancellato', async () => {
    h.db.scrutinio_giudizi = [{ id: 'sg1', materia_id: MAT_A }]
    const res = await MATERIE_DELETE(req(`/api/admin/primaria/materie?id=${MAT_A}`))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('MATERIA_IN_USO')
    expect(cancellazioni('materie')).toEqual([])
  })

  for (const code of ['23503', '23001']) {
    it(`🔴 voti o registro (${code} dal database) → 409, non più 500 col messaggio grezzo`, async () => {
      h.errori = { 'materie:delete': FRENO(code) }
      const res = await MATERIE_DELETE(req(`/api/admin/primaria/materie?id=${MAT_A}`))
      expect(res.status).toBe(409)
      const corpo = await res.json()
      expect(corpo.codice).toBe('MATERIA_IN_USO')
      expect(JSON.stringify(corpo)).not.toContain('foreign key')
    })
  }

  it('materia senza dati → 200 e la riga sparisce', async () => {
    const res = await MATERIE_DELETE(req(`/api/admin/primaria/materie?id=${MAT_A}`))
    expect(res.status).toBe(200)
    expect(h.db.materie).toHaveLength(0)
  })
})

describe('DELETE moduli — le compilazioni trattengono il modulo', () => {
  it('🔴 modulo con una compilazione → 409 MODULO_CON_COMPILAZIONI (prima: compilazioni firmate via in cascata)', async () => {
    h.db.forms_submissions = [{ id: 'fs1', form_id: MOD_A }]
    const res = await MODULI_DELETE(conCorpo({ id: MOD_A }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('MODULO_CON_COMPILAZIONI')
    expect(cancellazioni('forms_templates')).toEqual([])
    expect(h.db.forms_submissions).toHaveLength(1)
  })

  it('un modulo di un\'altra sede, anche compilato, resta 404', async () => {
    h.db.forms_submissions = [{ id: 'fs2', form_id: MOD_B }]
    const res = await MODULI_DELETE(conCorpo({ id: MOD_B }))
    expect(res.status).toBe(404)
    // La DELETE filtrata per sede parte e non trova righe: il modulo altrui è ancora lì.
    expect(h.db.forms_templates.map((m) => m.id)).toContain(MOD_B)
    expect(h.db.forms_submissions).toHaveLength(1)
  })

  for (const code of ['23503', '23001']) {
    it(`🔴 il freno del database rifiuta (${code}) → 409`, async () => {
      h.errori = { 'forms_templates:delete': FRENO(code) }
      const res = await MODULI_DELETE(conCorpo({ id: MOD_A }))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('MODULO_CON_COMPILAZIONI')
    })
  }

  it('modulo mai compilato → 200 e la riga sparisce', async () => {
    const res = await MODULI_DELETE(conCorpo({ id: MOD_A }))
    expect(res.status).toBe(200)
    expect(h.db.forms_templates.map((m) => m.id)).not.toContain(MOD_A)
  })
})
