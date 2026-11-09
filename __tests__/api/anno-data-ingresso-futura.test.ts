import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// PR 4.5 · COMPITO 4.5.11 · una data d'ingresso FUTURA è un avviso, non un errore.
//
// `risolviDataIngresso` (POST e PATCH di `admin/students`): data dopo oggi (giorno di ROMA) ma dentro l'anno → la scheda si salva
// e la risposta porta `avviso: 'data-ingresso-futura'`. Data passata → nessun avviso. Oltre la fine dell'anno → resta 422.
// L'orologio è fissato sulla mezzanotte di Roma: alle 23:30 del 31/08 il 1° settembre è "domani", alle 00:30 del 1° è "oggi".
// Alle 22:30 UTC del 31/08 (= 00:30 a Roma) un confronto col giorno UTC direbbe ancora "31/08": è la prova che il giorno è di Roma.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const ANNO_A = `anno-di-${SEDE_A}`

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scriviFrequenza: vi.fn(),
  annoAttivoDiSede: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
  annoAttivoDiSede: h.annoAttivoDiSede,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/pagamenti/scadenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/pagamenti/scadenze')>()),
  riallineaImportoRetteFuture: vi.fn(async () => undefined),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const opzioni = () => ({ scritture: h.scritture as Scrittura[] })
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, [], opzioni()),
    createClient: async () => creaFintoSupabase(h.db, [], opzioni()),
  }
})

import { POST as CREA, PATCH } from '@/app/api/admin/students/route'

const req = (metodo: string) => (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students', {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const crea = req('POST')
const patch = req('PATCH')

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: 'Sede A' }],
  scuole: [{ id: SEDE_A, attiva: true }],
  utenti_scuole: [{ utente_id: 'adm-1', scuola_id: SEDE_A }],
  utenti_sezioni: [],
  sections: [{ id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI', anno_id: 'y1' }],
  anni_sede: [{ id: ANNO_A, scuola_id: SEDE_A, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' }],
  gruppi_mensa: [],
  alunni: [{
    id: ALU_A, nome: 'Prova', cognome: 'Finto', scuola_id: SEDE_A, section_id: SEC_A, classe_sezione: '2 ANNI',
    stato: 'iscritto', archiviato_il: null, gruppo_mensa_id: null, usa_pannolino: false, data_iscrizione: '2026-09-01',
  }],
  parents: [],
  student_parents: [],
  legame_genitori_alunni: [],
  utenti: [],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

/** Solo `Date` è finto: i timer veri servono a `await` e al finto client. */
const alle = (istanteIso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(istanteIso))
}

const corpoNuovo = (data: string) => ({ nome: 'Prova', cognome: 'Finto', data_nascita: '2023-05-01', scuola_id: SEDE_A, data_iscrizione: data })

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
  h.annoAttivoDiSede.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? `anno-di-${sede}` : null))
  h.scriviFrequenza.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/admin/students — data d’ingresso futura', () => {
  it('data futura dentro l’anno: la scheda si salva (201) e la risposta porta l’avviso', async () => {
    alle('2026-08-20T10:00:00.000Z')
    const res = await CREA(crea(corpoNuovo('2026-10-15')))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.avviso).toBe('data-ingresso-futura')
    // salvata davvero: la frequenza riceve la data scelta e `alunni` ha la riga
    expect(h.scriviFrequenza.mock.calls[0][1].campi).toMatchObject({ data_ingresso: '2026-10-15' })
    expect(h.db.alunni).toHaveLength(2)
  })

  it('data passata: nessun avviso, e la risposta ha la forma di sempre', async () => {
    alle('2026-10-20T10:00:00.000Z')
    const res = await CREA(crea(corpoNuovo('2026-10-15')))
    expect(res.status).toBe(201)
    expect('avviso' in (await res.json())).toBe(false)
  })

  it('data oltre la fine dell’anno: resta 422 ANNO_NON_COERENTE e niente si scrive', async () => {
    alle('2026-08-20T10:00:00.000Z')
    const res = await CREA(crea(corpoNuovo('2027-09-02')))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_COERENTE')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
    expect(h.db.alunni).toHaveLength(1)
  })

  it('il giorno è quello di ROMA: 23:30 del 31/08 il 1° settembre è futuro', async () => {
    alle('2026-08-31T21:30:00.000Z') // 23:30 a Roma (CEST)
    const res = await CREA(crea(corpoNuovo('2026-09-01')))
    expect((await res.json()).avviso).toBe('data-ingresso-futura')
  })

  it('il giorno è quello di ROMA: 00:30 del 01/09 il 1° settembre è oggi, nessun avviso', async () => {
    alle('2026-08-31T22:30:00.000Z') // 00:30 a Roma: in UTC è ancora il 31/08
    const res = await CREA(crea(corpoNuovo('2026-09-01')))
    expect(res.status).toBe(201)
    expect('avviso' in (await res.json())).toBe(false)
  })

  it('una data prima dell’inizio che l’adattamento porta a un inizio futuro resta futura', async () => {
    alle('2026-08-20T10:00:00.000Z')
    const res = await CREA(crea(corpoNuovo('2025-03-10')))
    expect(res.status).toBe(201)
    expect((await res.json()).avviso).toBe('data-ingresso-futura')
    expect(h.scriviFrequenza.mock.calls[0][1].campi).toMatchObject({ data_ingresso: '2026-09-01' })
  })

  it('log `info` dell’avviso senza la data', async () => {
    alle('2026-08-20T10:00:00.000Z')
    await CREA(crea(corpoNuovo('2026-10-15')))
    const righe = h.logEvento.mock.calls.filter((c) => (c[2] as { tipo?: string })?.tipo === 'data-ingresso-futura')
    expect(righe).toHaveLength(1)
    expect(righe[0][0]).toBe('anno-scolastico')
    expect(righe[0][1]).toBe('info')
    expect(JSON.stringify(righe[0])).not.toContain('2026-10-15')
  })

  it('senza anno attivo (schema indietro) non c’è niente da avvisare', async () => {
    alle('2026-08-20T10:00:00.000Z')
    h.annoAttivoDiSede.mockResolvedValue(null)
    const res = await CREA(crea(corpoNuovo('2026-10-15')))
    expect(res.status).toBe(201)
    expect('avviso' in (await res.json())).toBe(false)
  })
})

describe('PATCH /api/admin/students — data d’ingresso futura', () => {
  it('data cambiata in una futura: 200 con l’avviso, e la frequenza riceve la data', async () => {
    alle('2026-09-10T10:00:00.000Z')
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-10-05' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.avviso).toBe('data-ingresso-futura')
    expect(j.id).toBe(ALU_A)
    expect(h.scriviFrequenza.mock.calls[0][1].campi).toMatchObject({ data_ingresso: '2026-10-05' })
  })

  it('data cambiata in una passata: nessun avviso', async () => {
    alle('2026-10-20T10:00:00.000Z')
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-10-05' }))
    expect(res.status).toBe(200)
    expect('avviso' in (await res.json())).toBe(false)
  })

  it('la data NON cambiata (la scheda la rimanda sempre) non riavvisa a ogni salvataggio', async () => {
    alle('2026-08-20T10:00:00.000Z')
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-09-01', usa_pannolino: true }))
    expect(res.status).toBe(200)
    expect('avviso' in (await res.json())).toBe(false)
  })

  it('data oltre la fine dell’anno: resta 422 ANNO_NON_COERENTE', async () => {
    alle('2026-09-10T10:00:00.000Z')
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2027-09-02' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_COERENTE')
  })

  it('il giorno è quello di ROMA, anche sul PATCH (23:30 → futuro, 00:30 → oggi)', async () => {
    alle('2026-08-31T21:30:00.000Z')
    const prima = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-09-02' }))
    expect((await prima.json()).avviso).toBe('data-ingresso-futura')
    vi.setSystemTime(new Date('2026-09-02T22:30:00.000Z')) // 00:30 del 03/09 a Roma
    const dopo = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-09-03' }))
    expect('avviso' in (await dopo.json())).toBe(false)
  })
})
