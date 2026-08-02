import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `pagamenti/famiglia` — il genitore si raggiunge solo attraverso i FIGLI in scope.
//
// La route leggeva `parents` per uuid e calcolava `saldoCredito` PRIMA di
// qualunque controllo di sede: nome, cognome e saldo credito di un genitore
// qualunque delle tre sedi tornavano a ogni staff che ne conoscesse l'uuid — il
// filtro di sede arrivava dopo, e solo sui figli. E quel filtro era a sua volta
// fail-open: `!a.scuola_id || sedi.length === 0 || sedi.includes(…)` restituiva
// TUTTI i figli quando lo scope era vuoto o quando la riga non aveva sede.
//
// `assertParentInScope` è il primitivo già usato da `admin/regenerate-credentials`:
// deriva lo scope dai figli, perché un genitore può averne in due sedi e «la sua
// sede» non esiste. Fail-closed: nessun figlio in scope ⇒ 403.
//
// Le asserzioni guardano l'EFFETTO — quali tabelle sono state lette, se il
// credito è stato calcolato, quali figli tornano — non la sola forma della
// risposta: un 403 che ha già letto l'anagrafica e calcolato il saldo avrebbe
// comunque toccato i dati che doveva proteggere.
// =============================================================================

const STAFF = '11111111-1111-4111-8111-111111111111'
const GENITORE = '33333333-3333-4333-8333-333333333333'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ALU_SENZA_SEDE = 'c3c3c3c3-3333-4333-8333-cccccccccccc'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  saldoCredito: vi.fn(async () => 25),
  figliDiGenitore: vi.fn(async () => [] as string[]),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/pagamenti/credito', () => ({ saldoCredito: (...a: unknown[]) => h.saldoCredito(...(a as [])) }))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: (...a: unknown[]) => h.figliDiGenitore(...(a as [])),
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(a),
  logErrore: (...a: unknown[]) => h.log.push(a),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) as never }
})

import { GET } from '@/app/api/pagamenti/famiglia/route'

const get = (qs: string, cookie?: string) =>
  new NextRequest(`http://localhost/api/pagamenti/famiglia?${qs}`, {
    headers: cookie ? { cookie } : undefined,
  })

/** Il genitore ha un figlio nella sede indicata (o più d'uno). */
const dbCon = (figli: { id: string; sede: string | null }[]): DBFinto => ({
  utenti_scuole: [],
  parents: [{ id: GENITORE, first_name: 'Anna', last_name: 'Rossi', auth_user_id: null }],
  // `assertParentInScope` legge student_parents con join `!inner` su alunni
  student_parents: figli.map((f) => ({
    parent_id: GENITORE,
    student_id: f.id,
    alunni: { scuola_id: f.sede },
  })),
  alunni: figli.map((f) => ({ id: f.id, nome: 'Figlio', cognome: 'Rossi', scuola_id: f.sede })),
  ticket_mensa: [],
  pagamenti: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.log = []
  h.saldoCredito.mockResolvedValue(25)
  h.figliDiGenitore.mockResolvedValue([])
  h.db = dbCon([{ id: ALU_A, sede: SEDE_A }])
  h.requireStaff.mockResolvedValue({ user: { id: STAFF, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/pagamenti/famiglia — il genitore passa dal gate di sede', () => {
  it('genitore con figli SOLO in un\'altra sede: 403, anagrafica non letta, credito non calcolato', async () => {
    h.db = dbCon([{ id: ALU_B, sede: SEDE_B }])
    const res = await GET(get(`parent_id=${GENITORE}`))
    expect(res.status).toBe(403)
    expect(h.saldoCredito).not.toHaveBeenCalled()
    expect(h.tabelle).not.toContain('parents')
  })

  it('genitore della propria sede: 200, con figli, credito e voci', async () => {
    h.db.pagamenti.push({
      id: 'pag-1', alunno_id: ALU_A, scuola_id: SEDE_A, importo: 100,
      importo_pagato: 0, sconto: 0, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo',
    })
    const res = await GET(get(`parent_id=${GENITORE}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.figli.map((f: { id: string }) => f.id)).toEqual([ALU_A])
    expect(j.data.voci.map((v: { id: string }) => v.id)).toEqual(['pag-1'])
    expect(j.data.credito).toBe(25)
  })

  it('figli in DUE sedi: entra dal gate, ma tornano solo quelli della propria', async () => {
    h.db = dbCon([{ id: ALU_A, sede: SEDE_A }, { id: ALU_B, sede: SEDE_B }])
    const res = await GET(get(`parent_id=${GENITORE}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.figli.map((f: { id: string }) => f.id)).toEqual([ALU_A])
  })

  it('figlio senza sede: NON passa il filtro (una riga senza plesso non è di nessuno)', async () => {
    h.db = dbCon([{ id: ALU_A, sede: SEDE_A }, { id: ALU_SENZA_SEDE, sede: null }])
    const res = await GET(get(`parent_id=${GENITORE}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.figli.map((f: { id: string }) => f.id)).toEqual([ALU_A])
  })

  it('sedi attive vuote (cookie su una sede non accessibile): nessun figlio, mai «tutti»', async () => {
    const res = await GET(get(`parent_id=${GENITORE}`, `sedi_attive=${SEDE_C}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.figli).toEqual([])
    expect(j.data.voci).toEqual([])
  })
})
