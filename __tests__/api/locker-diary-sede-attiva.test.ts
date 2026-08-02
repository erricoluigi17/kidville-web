import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// W2-N · R70 — Armadietto e Diario: il selettore di sede arriva finalmente al server
//
// Entrambe le pagine hanno un selettore di sede, ma le chiamate dati mandavano
// SOLO `classe_sezione=<nome>`; e lato server `locker/inventory` e
// `diary/students` risolvevano i plessi con `scuoleDiUtente`, che **non legge
// nemmeno il cookie**: il SedeSelector non era decorativo, era inerte. Con due
// sedi accessibili e una classe OMONIMA, l'admin che aveva scelto una sola sede
// riceveva comunque i bambini di entrambe — e `diary/students` restituisce
// anche le `note_mediche`.
//
// Qui si prova che (a) il cookie `sedi_attive` conta, (b) `?scuola_id=` conta,
// (c) una sede chiesta ma non accessibile è un 403, non un elenco allargato.
// =============================================================================

const SEZ_A = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunno: async () => [],
  getGenitoriDiAlunni: async () => new Map(),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET as GET_INVENTORY } from '@/app/api/locker/inventory/route'
import { GET as GET_STUDENTS } from '@/app/api/diary/students/route'

const req = (base: string, qs: string, cookie?: string) =>
  new NextRequest(`http://localhost${base}?${qs}`, cookie ? { headers: { cookie } } : undefined)

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: OMONIMA },
    { id: SEZ_B, scuola_id: SEDE_B, name: OMONIMA },
  ],
  utenti_scuole: [
    { utente_id: 'adm1', scuola_id: SEDE_A },
    { utente_id: 'adm1', scuola_id: SEDE_B },
  ],
  utenti_sezioni: [],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, section_id: SEZ_A, scuola_id: SEDE_A, stato: 'iscritto', note_mediche: 'NOTA-A', consenso_privacy: true },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, section_id: SEZ_B, scuola_id: SEDE_B, stato: 'iscritto', note_mediche: 'NOTA-B', consenso_privacy: true },
  ],
  armadietto: [
    { id: 'arm-a', alunno_id: ALU_A, materiale: 'Pannolini', quantita: 3, portato: true, date: '2026-07-31', scuola_id: SEDE_A },
    { id: 'arm-b', alunno_id: ALU_B, materiale: 'Pannolini', quantita: 9, portato: true, date: '2026-07-31', scuola_id: SEDE_B },
  ],
  utenti: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  // Direzione con DUE plessi: è il caso in cui il selettore serve davvero.
  h.requireDocente.mockResolvedValue({ user: { id: 'adm1', role: 'admin', scuola_id: SEDE_A } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore' } })
})

describe('GET /api/locker/inventory — la sede scelta conta', () => {
  it('senza selezione: entrambe le sedi accessibili (nessuna restrizione)', async () => {
    const res = await GET_INVENTORY(req('/api/locker/inventory', `classe_sezione=${encodeURIComponent(OMONIMA)}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((a) => a.id).sort()).toEqual([ALU_A, ALU_B].sort())
  })

  it('cookie `sedi_attive` su una sola sede: solo i suoi alunni e il suo armadietto', async () => {
    const res = await GET_INVENTORY(
      req('/api/locker/inventory', `classe_sezione=${encodeURIComponent(OMONIMA)}`, `sedi_attive=${SEDE_A}`),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; inventario: { id: string }[] }[]
    expect(j.map((a) => a.id)).toEqual([ALU_A])
    expect(j[0].inventario.map((i) => i.id)).toEqual(['arm-a'])
  })

  it('`?scuola_id=` restringe alla sede dichiarata', async () => {
    const res = await GET_INVENTORY(
      req('/api/locker/inventory', `classe_sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_B}`),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((a) => a.id)).toEqual([ALU_B])
  })

  it('403 su una sede NON accessibile, senza leggere gli alunni', async () => {
    const res = await GET_INVENTORY(
      req('/api/locker/inventory', `classe_sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_C}`),
    )
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('alunni')
    expect(h.tabelle).not.toContain('armadietto')
  })
})

describe('GET /api/diary/students — la sede scelta conta (e con lei le note mediche)', () => {
  it('cookie `sedi_attive` su una sola sede: nessuna nota medica dell\'altra', async () => {
    const res = await GET_STUDENTS(
      req('/api/diary/students', `sezione=${encodeURIComponent(OMONIMA)}`, `sedi_attive=${SEDE_A}`),
    )
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('NOTA-A')
    expect(corpo).not.toContain('NOTA-B')
  })

  it('`?scuola_id=` restringe alla sede dichiarata', async () => {
    const res = await GET_STUDENTS(
      req('/api/diary/students', `sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_B}`),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((a) => a.id)).toEqual([ALU_B])
  })

  it('403 su una sede NON accessibile, senza leggere gli alunni', async () => {
    const res = await GET_STUDENTS(
      req('/api/diary/students', `sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_C}`),
    )
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('alunni')
  })
})
