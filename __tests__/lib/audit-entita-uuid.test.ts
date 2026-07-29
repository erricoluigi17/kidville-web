import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * REGRESSIONE 2026-07-29 — l'audit dei legami non è MAI stato scritto.
 *
 * `audit_scritture_docente.entita_id` è una colonna uuid, ma sei punti della
 * codebase ci passavano una chiave composta (`"studentId:parentId"`) perché
 * l'entità è una RELAZIONE e un uuid proprio non ce l'ha. Postgres rifiutava
 * l'INSERT con «invalid input syntax for type uuid» e la riga non veniva scritta
 * affatto: per i legami genitore↔figlio e per le assegnazioni docente↔sezione
 * non è mai esistita una traccia di chi avesse collegato chi a chi.
 *
 * Trovato leggendo `app_log` dopo il primo import reale su Aversa — l'errore
 * c'era a ogni iscrizione importata, da sempre.
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { logScrittura } from '@/lib/audit/scrittura'

const ATTORE = { id: '11111111-1111-4111-8111-111111111111', role: 'admin', scuola_id: null } as never
const STUDENT = '22222222-2222-4222-8222-222222222222'
const PARENT = '33333333-3333-4333-8333-333333333333'

const righe: Record<string, unknown>[] = []
const client = {
  from: () => ({ insert: async (r: Record<string, unknown>) => { righe.push(r); return { error: null } } }),
} as never

beforeEach(() => { righe.length = 0; logEvento.mockClear() })

describe('logScrittura — entita_id è una colonna uuid', () => {
  it('un uuid valido passa intatto e i valori non vengono toccati', async () => {
    await logScrittura(client, {
      attore: ATTORE, entitaTipo: 'legame', entitaId: STUDENT, azione: 'insert',
      valoreDopo: { student_id: STUDENT, parent_id: PARENT },
    })
    expect(righe[0].entita_id).toBe(STUDENT)
    expect(righe[0].valore_dopo).toEqual({ student_id: STUDENT, parent_id: PARENT })
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('una chiave COMPOSTA non fa più perdere la riga: colonna null, chiave nel valore', async () => {
    await logScrittura(client, {
      attore: ATTORE, entitaTipo: 'legame', entitaId: `${STUDENT}:${PARENT}`, azione: 'insert',
      valoreDopo: { student_id: STUDENT, parent_id: PARENT },
    })
    // Prima di questa correzione l'INSERT veniva RIFIUTATO e `righe` restava vuoto.
    expect(righe).toHaveLength(1)
    expect(righe[0].entita_id).toBeNull()
    expect(righe[0].valore_dopo).toEqual({
      student_id: STUDENT, parent_id: PARENT, entita_chiave: `${STUDENT}:${PARENT}`,
    })
  })

  it('su delete la chiave finisce nel valore PRIMA, che è quello popolato', async () => {
    await logScrittura(client, {
      attore: ATTORE, entitaTipo: 'sezione_docente', entitaId: 'sez:doc', azione: 'delete',
      valorePrima: { section_id: 'x', utente_id: 'y' },
    })
    expect(righe).toHaveLength(1)
    expect((righe[0].valore_prima as Record<string, unknown>).entita_chiave).toBe('sez:doc')
  })

  it('senza alcun valore la chiave si porta da sola: la riga si scrive comunque', async () => {
    await logScrittura(client, {
      attore: ATTORE, entitaTipo: 'legame', entitaId: 'a:b', azione: 'insert',
    })
    expect(righe).toHaveLength(1)
    expect(righe[0].valore_dopo).toEqual({ entita_chiave: 'a:b' })
  })

  it('una chiave non-uuid si SEGNALA: non è fatale, ma non è nemmeno normale', async () => {
    await logScrittura(client, {
      attore: ATTORE, entitaTipo: 'legame', entitaId: 'a:b', azione: 'insert',
      valoreDopo: { x: 1 },
    })
    const warn = logEvento.mock.calls.find(
      c => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'chiave-non-uuid',
    )
    expect(warn).toBeDefined()
  })

  it('entitaId assente resta null senza inventare nulla', async () => {
    await logScrittura(client, {
      attore: ATTORE, entitaTipo: 'presenze', azione: 'update', valoreDopo: { stato: 'presente' },
    })
    expect(righe[0].entita_id).toBeNull()
    expect(righe[0].valore_dopo).toEqual({ stato: 'presente' })
    expect(logEvento).not.toHaveBeenCalled()
  })
})
