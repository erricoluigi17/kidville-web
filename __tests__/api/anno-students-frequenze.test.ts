import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// PR 3 · COMPITO 3.7-2 · le route `admin/students` collegate a `scriviFrequenza` (fase A, §4.19).
//
// Regola provata sito per sito: `alunni` scritto con successo E patch che tocca una colonna copiata →
// `scriviFrequenza` UNA volta, con i campi tradotti e l'anno attivo della sede giusta; `alunni` in errore → ZERO
// chiamate; patch senza colonne copiate → ZERO chiamate. La risposta della route non cambia se la frequenza fallisce.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_A2 = '11111111-1111-4111-8111-aaaaaaaaaaa2'
const ALU_B = '11111111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_R = '11111111-1111-4111-8111-cccccccccccc'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEC_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scriviFrequenza: vi.fn(),
  annoAttivoDiSede: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
  annoAttivoDiSede: h.annoAttivoDiSede,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const opzioni = () => ({ scritture: h.scritture as Scrittura[], errori: h.errori })
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
  }
})

import { POST as CREA, PATCH } from '@/app/api/admin/students/route'
import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { POST as RIATTIVA } from '@/app/api/admin/students/riattiva/route'

const req = (metodo: string, percorso: string) => (body: unknown) =>
  new NextRequest(`http://localhost${percorso}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const crea = req('POST', '/api/admin/students')
const patch = req('PATCH', '/api/admin/students')
const archivia = req('POST', '/api/admin/students/archivia')
const riattiva = req('POST', '/api/admin/students/riattiva')

const alunno = (id: string, sede: string, sezione: string) => ({
  id, nome: 'Prova', cognome: 'Finto', scuola_id: sede, section_id: sezione, classe_sezione: '2 ANNI',
  stato: 'iscritto', archiviato_il: null, gruppo_mensa_id: null, usa_pannolino: false,
})

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: 'Sede A' }, { id: SEDE_B, nome: 'Sede B' }],
  scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
  utenti_scuole: [{ utente_id: 'adm-1', scuola_id: SEDE_A }, { utente_id: 'adm-1', scuola_id: SEDE_B }],
  utenti_sezioni: [],
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' },
    { id: SEC_B, scuola_id: SEDE_B, name: '2 ANNI' },
  ],
  gruppi_mensa: [],
  alunni: [
    alunno(ALU_A, SEDE_A, SEC_A),
    alunno(ALU_A2, SEDE_A, SEC_A),
    alunno(ALU_B, SEDE_B, SEC_B),
    {
      ...alunno(ALU_R, SEDE_A, SEC_A), section_id: null, classe_sezione: null, stato: 'ritirato',
      archiviato_il: '2026-08-01T10:00:00.000Z', archiviato_da: 'adm-1', archiviato_motivo: 'ritiro',
      archiviato_section_id: SEC_A, archiviato_classe_sezione: '2 ANNI', spazio_liberato_il: null,
    },
  ],
  parents: [],
  student_parents: [],
  legame_genitori_alunni: [],
  utenti: [],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
  h.annoAttivoDiSede.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? `anno-di-${sede}` : null))
  h.scriviFrequenza.mockResolvedValue({ ok: true })
})

describe('POST /api/admin/students — creazione', () => {
  const corpo = { nome: 'Prova', cognome: 'Finto', data_nascita: '2023-05-01', scuola_id: SEDE_A, usa_pannolino: true, giorno_scadenza_pagamenti: 10 }

  it('scrive la frequenza dell’anno attivo della sede, una volta, coi campi tradotti', async () => {
    const res = await CREA(crea(corpo))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: id,
      annoSedeId: `anno-di-${SEDE_A}`,
      campi: { usa_pannolino: true, giorno_scadenza_pagamenti: 10 },
    })
  })

  it('alunni in errore: 500 e zero chiamate', async () => {
    h.errori = { 'alunni:insert': { code: '23514', message: 'no' } }
    const res = await CREA(crea(corpo))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('scriviFrequenza fallita: la risposta resta 201', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SEZIONE_DI_ALTRO_ANNO' })
    expect((await CREA(crea(corpo))).status).toBe(201)
  })
})

describe('PATCH /api/admin/students — bulk', () => {
  it('gruppo mensa: una chiamata per alunno, con l’anno della sua sede', async () => {
    const res = await PATCH(patch({ ids: [ALU_A, ALU_B], gruppo_mensa_id: null }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(2)
    const chiamate = h.scriviFrequenza.mock.calls.map((c) => c[1])
    expect(chiamate).toContainEqual({ alunnoId: ALU_A, annoSedeId: `anno-di-${SEDE_A}`, campi: { gruppo_mensa_id: null } })
    expect(chiamate).toContainEqual({ alunnoId: ALU_B, annoSedeId: `anno-di-${SEDE_B}`, campi: { gruppo_mensa_id: null } })
  })

  it('gruppo mensa con alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23503', message: 'no' } }
    const res = await PATCH(patch({ ids: [ALU_A], gruppo_mensa_id: null }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('classe_sezione: la patch non nomina colonne copiate, zero chiamate', async () => {
    const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], classe_sezione: '2 ANNI' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/admin/students — singolo', () => {
  it('una colonna copiata: una chiamata con i campi tradotti', async () => {
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU_A, annoSedeId: `anno-di-${SEDE_A}`, campi: { usa_pannolino: true },
    })
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('patch senza colonne copiate (nome): zero chiamate', async () => {
    const res = await PATCH(patch({ id: ALU_A, nome: 'Altro' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('trasferimento: l’anno è quello della sede NUOVA, con sezione e gruppo mensa azzerati', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU_A, annoSedeId: `anno-di-${SEDE_B}`, campi: { section_id: null, gruppo_mensa_id: null },
    })
  })

  it('scriviFrequenza fallita: la risposta resta 200', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect((await PATCH(patch({ id: ALU_A, usa_pannolino: true }))).status).toBe(200)
  })
})

describe('POST /api/admin/students/archivia', () => {
  it('una chiamata: ritirato, uscita, sezione e gruppo mensa azzerati', async () => {
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2, motivo: 'ritiro' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    const arg = h.scriviFrequenza.mock.calls[0][1]
    expect(arg.alunnoId).toBe(ALU_A2)
    expect(arg.annoSedeId).toBe(`anno-di-${SEDE_A}`)
    expect(arg.campi).toMatchObject({ stato: 'ritirato', section_id: null, gruppo_mensa_id: null })
    expect(arg.campi.data_uscita).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/students/riattiva', () => {
  it('una chiamata: iscritto, senza uscita', async () => {
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU_R, annoSedeId: `anno-di-${SEDE_A}`, campi: { stato: 'iscritto', data_uscita: null },
    })
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})
