/**
 * `GET /api/admin/primaria/fascicolo-audit` — le aperture della scheda anagrafica non
 * affogano le visioni vere del fascicolo.
 *
 * Il registro della Direzione chiede le ultime 200 righe. Con 74 docenti che aprono
 * schede anagrafiche (finalità `anagrafica-docente`), le visioni di PEI/PDP uscirebbero
 * dalla finestra in meno di un giorno. Per questo quelle righe si chiedono A PARTE:
 * di default si escludono, con `conAnagrafica=1` ci sono tutte.
 *
 * La trappola SQL che questo test tiene ferma: `finalita <> 'anagrafica-docente'`
 * scarta anche le righe con `finalita` NULL (in SQL `NULL <> x` vale NULL), che sono la
 * MAGGIORANZA del registro. Il finto Supabase rispetta quella semantica, quindi un
 * `.neq()` al posto dell'`.or('finalita.is.null,…')` qui diventa rosso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { FINALITA_AUDIT_ANAGRAFICA } from '@/lib/anagrafiche/docente/tipi'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  opzioni: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, h.opzioni as OpzioniFinto) }
})
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))

import { GET } from '@/app/api/admin/primaria/fascicolo-audit/route'

const audit = (id: string, finalita: string | null, scuola_id: string) => ({
  id,
  alunno_id: `alunno-${id}`,
  documento_id: null,
  utente_id: 'doc1',
  azione: 'view',
  finalita,
  ip: null,
  creato_il: `2026-10-04T08:00:0${id.slice(-1)}.000Z`,
  utenti: { nome: 'Docente', cognome: 'Prova-E2E', ruolo: 'educator', role: 'educator' },
  alunni: { nome: 'Bimbo', cognome: `Riga-${id}-E2E`, scuola_id },
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  fascicolo_accessi_audit: [
    audit('r1', null, SEDE_A),
    audit('r2', 'stampa del modulo', SEDE_A),
    audit('r3', FINALITA_AUDIT_ANAGRAFICA, SEDE_A),
    audit('r4', FINALITA_AUDIT_ANAGRAFICA, SEDE_A),
    // L'altra sede resta fuori in tutti i casi: il nuovo filtro non allarga niente.
    audit('r5', null, SEDE_B),
    audit('r6', FINALITA_AUDIT_ANAGRAFICA, SEDE_B),
  ],
})

const chiama = (query = '') =>
  GET(new NextRequest(`http://localhost/api/admin/primaria/fascicolo-audit?limit=200${query}`))

const ids = async (res: Response) => ((await res.json()).data as { id: string }[]).map((r) => r.id).sort()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.opzioni = {}
  h.requireStaff.mockResolvedValue({ response: null, user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('fascicolo-audit — le aperture della scheda anagrafica, a parte', () => {
  it('senza parametro: le righe `anagrafica-docente` non ci sono, quelle con finalità NULL sì', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await ids(res)).toEqual(['r1', 'r2'])
  })

  it('`conAnagrafica=1`: ci sono tutte (della propria sede)', async () => {
    const res = await chiama('&conAnagrafica=1')
    expect(res.status).toBe(200)
    expect(await ids(res)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('`conAnagrafica=0` vale come assente', async () => {
    expect(await ids(await chiama('&conAnagrafica=0'))).toEqual(['r1', 'r2'])
  })

  it('un valore non booleano è un errore del client (400), e il database non si tocca', async () => {
    const res = await chiama('&conAnagrafica=forse')
    expect(res.status).toBe(400)
    expect(h.tabelle).not.toContain('fascicolo_accessi_audit')
  })
})
