import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W2-N · R108 — «questa classe è tua?», non solo «di che sede è?»
//
// Sette route indicizzate sul NOME della classe avevano il filtro di sede
// (aggiunto il 29-30 luglio) ma non il gate per SEZIONE ASSEGNATA. Il modello
// (PRD §3/§12, decisione del titolare del 2026-07-30) dice: educator → SOLO le
// sezioni assegnate. Senza il gate un educator poteva chiedere qualunque nome
// di classe del proprio plesso e ottenere, fra le altre cose, le NOTE MEDICHE
// dei bambini di una classe non sua (`diary/students`) e il prospetto presenze
// del mese (`attendance/monthly`).
//
// Le due prove sono separate, come chiede l'audit:
//  · classe della PROPRIA sede ma NON assegnata  → 403 (vincolo per sezione);
//  · classe di UN'ALTRA sede                      → 403 (vincolo di sede);
// e in entrambi i casi la tabella con i dati dei minori non viene nemmeno letta.
// Chi vede tutte le classi del plesso (admin/coordinator/segreteria) NON è
// toccato: è il permesso deciso il 30/07 e qui resta.
// =============================================================================

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'
const MIA = 'MIA CLASSE'
const ALTRUI = 'CLASSE DEL COLLEGA'
const SOLO_B = 'SOLO SEDE B'
const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRUI = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const GIORNO = '2026-07-31'

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
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET as GET_DIARY_STUDENTS } from '@/app/api/diary/students/route'
import { GET as GET_DIARY_ENTRIES } from '@/app/api/diary/entries/route'
import { GET as GET_MONTHLY } from '@/app/api/attendance/monthly/route'
import { GET as GET_DAILY } from '@/app/api/attendance/daily/route'
import { GET as GET_DELEGATES } from '@/app/api/attendance/delegates/route'
import { GET as GET_LOCKER_REQ } from '@/app/api/locker/requests/route'
import { GET as GET_LOCKER_INV } from '@/app/api/locker/inventory/route'

const q = (base: string, classe: string) =>
  new NextRequest(`http://localhost${base}${base.includes('?') ? '&' : '?'}${classe}`)

/** Le sette route, ognuna con la sua forma di query e la tabella che NON deve
 *  essere letta quando il gate nega. */
const ROUTE = [
  {
    nome: 'diary/students:GET',
    chiama: (classe: string) => GET_DIARY_STUDENTS(q('/api/diary/students', `sezione=${encodeURIComponent(classe)}`)),
    tabellaSensibile: 'alunni',
  },
  {
    nome: 'diary/entries:GET',
    chiama: (classe: string) => GET_DIARY_ENTRIES(q('/api/diary/entries', `sezione=${encodeURIComponent(classe)}&date=${GIORNO}`)),
    tabellaSensibile: 'alunni',
  },
  {
    nome: 'attendance/monthly:GET',
    chiama: (classe: string) => GET_MONTHLY(q('/api/attendance/monthly', `year=2026&month=7&sezione=${encodeURIComponent(classe)}`)),
    tabellaSensibile: 'alunni',
  },
  {
    nome: 'attendance/daily:GET',
    chiama: (classe: string) => GET_DAILY(q('/api/attendance/daily', `data=${GIORNO}&sezione=${encodeURIComponent(classe)}`)),
    tabellaSensibile: 'presenze',
  },
  {
    nome: 'attendance/delegates:GET',
    chiama: (classe: string) => GET_DELEGATES(q('/api/attendance/delegates', `sezione=${encodeURIComponent(classe)}`)),
    tabellaSensibile: 'delegates',
  },
  {
    nome: 'locker/requests:GET',
    chiama: (classe: string) => GET_LOCKER_REQ(q('/api/locker/requests', `classe_sezione=${encodeURIComponent(classe)}`)),
    tabellaSensibile: 'alunni',
  },
  {
    nome: 'locker/inventory:GET',
    chiama: (classe: string) => GET_LOCKER_INV(q('/api/locker/inventory', `classe_sezione=${encodeURIComponent(classe)}`)),
    tabellaSensibile: 'alunni',
  },
] as const

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: MIA, school_type: 'infanzia' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: ALTRUI, school_type: 'infanzia' },
    { id: SEZ_B, scuola_id: SEDE_B, name: SOLO_B, school_type: 'infanzia' },
  ],
  // L'educator ha UNA sola sezione assegnata, come i 10 educator in produzione.
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_scuole: [],
  alunni: [
    { id: ALU_MIO, nome: 'Alfa', cognome: 'Mia', classe_sezione: MIA, section_id: SEZ_MIA, scuola_id: SEDE_A, stato: 'iscritto', note_mediche: 'NOTA-MEDICA-MIA', consenso_privacy: true },
    { id: ALU_ALTRUI, nome: 'Beta', cognome: 'Altrui', classe_sezione: ALTRUI, section_id: SEZ_ALTRUI, scuola_id: SEDE_A, stato: 'iscritto', note_mediche: 'NOTA-MEDICA-ALTRUI', consenso_privacy: true },
  ],
  presenze: [
    { id: 'pre-mia', alunno_id: ALU_MIO, data: GIORNO, stato: 'presente', scuola_id: SEDE_A, section_id: SEZ_MIA, alunni: { id: ALU_MIO, nome: 'Alfa', cognome: 'Mia', classe_sezione: MIA, scuola_id: SEDE_A } },
    { id: 'pre-altrui', alunno_id: ALU_ALTRUI, data: GIORNO, stato: 'assente', scuola_id: SEDE_A, section_id: SEZ_ALTRUI, alunni: { id: ALU_ALTRUI, nome: 'Beta', cognome: 'Altrui', classe_sezione: ALTRUI, scuola_id: SEDE_A } },
  ],
  delegates: [
    { id: 'del-mia', student_id: ALU_MIO, first_name: 'Nonna', last_name: 'Mia', document_number: 'DOC-1', alunni: { classe_sezione: MIA, scuola_id: SEDE_A } },
    { id: 'del-altrui', student_id: ALU_ALTRUI, first_name: 'Nonno', last_name: 'Altrui', document_number: 'DOC-2', alunni: { classe_sezione: ALTRUI, scuola_id: SEDE_A } },
  ],
  locker_requests: [{ id: 'req-1', alunno_id: ALU_ALTRUI, stato: 'pending', creato_il: '2026-07-30' }],
  armadietto: [{ id: 'arm-1', alunno_id: ALU_ALTRUI, materiale: 'Pannolini', quantita: 2, portato: true, date: GIORNO, scuola_id: SEDE_A }],
  eventi_diario: [{ id: 'ev-1', alunno_id: ALU_ALTRUI, tipo_evento: 'pranzo', orario_inizio: `${GIORNO}T12:00:00.000Z` }],
  utenti: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore' } })
})

describe.each(ROUTE)('$nome — educator: solo le sezioni assegnate', ({ chiama, tabellaSensibile }) => {
  it('403 sulla classe NON assegnata della PROPRIA sede, senza leggerne i dati', async () => {
    const res = await chiama(ALTRUI)
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain(tabellaSensibile)
  })

  it('403 su una classe di UN\'ALTRA sede, senza leggerne i dati', async () => {
    const res = await chiama(SOLO_B)
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain(tabellaSensibile)
  })

  it('200 sulla PROPRIA sezione assegnata', async () => {
    const res = await chiama(MIA)
    expect(res.status).toBe(200)
  })

  it('segreteria: 200 anche sulla classe non assegnata del proprio plesso (permesso del 30/07)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await chiama(ALTRUI)
    expect(res.status).toBe(200)
  })
})

describe('diary/students:GET — le note mediche restano nella classe assegnata', () => {
  it('la classe assegnata risponde con i SUOI alunni; quella del collega è negata', async () => {
    const mia = await GET_DIARY_STUDENTS(q('/api/diary/students', `sezione=${encodeURIComponent(MIA)}`))
    expect(mia.status).toBe(200)
    const corpo = await mia.text()
    expect(corpo).toContain('NOTA-MEDICA-MIA')
    expect(corpo).not.toContain('NOTA-MEDICA-ALTRUI')

    h.tabelle = []
    const altrui = await GET_DIARY_STUDENTS(q('/api/diary/students', `sezione=${encodeURIComponent(ALTRUI)}`))
    expect(altrui.status).toBe(403)
    expect(await altrui.text()).not.toContain('NOTA-MEDICA-ALTRUI')
  })
})

describe('sezione assente: contratto storico invariato (nessun 400, lista vuota)', () => {
  it('diary/students senza `sezione` → 200 []', async () => {
    const res = await GET_DIARY_STUDENTS(new NextRequest('http://localhost/api/diary/students'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(h.tabelle).not.toContain('alunni')
  })

  it('diary/entries senza `sezione` → 200 []', async () => {
    const res = await GET_DIARY_ENTRIES(new NextRequest('http://localhost/api/diary/entries'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(h.tabelle).not.toContain('alunni')
  })

  it('attendance/monthly senza `sezione` → 200 []', async () => {
    const res = await GET_MONTHLY(new NextRequest('http://localhost/api/attendance/monthly?year=2026&month=7'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(h.tabelle).not.toContain('alunni')
  })

  it('attendance/daily senza `sezione` → 200 []', async () => {
    const res = await GET_DAILY(new NextRequest(`http://localhost/api/attendance/daily?data=${GIORNO}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(h.tabelle).not.toContain('presenze')
  })
})
