import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `GET /api/admin/dashboard` — i conteggi li fa il database, e un guasto non è uno zero.
 * (Fase 5 robustezza, problema S6: «report che mentono».)
 *
 * Fino al 2026-10-10 gli iscritti e i pagamenti scaduti erano la LUNGHEZZA di un
 * elenco di righe, e PostgREST taglia ogni risposta a `max_rows` (1000) senza dirlo:
 * il 10/10 gli iscritti delle tre sedi erano 750. Il finto client qui ha il tetto
 * acceso (`maxRighe: 1000`) e 1.500 iscritti: il codice di prima rispondeva 1000.
 * E sei letture su nove non controllavano l'`error`: un guasto diventava uno zero.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  opzioni: {} as Record<string, unknown>,
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { maxRighe: 1000, ...(h.opzioni as OpzioniFinto) }) }
})
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<object>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))

import { GET } from '@/app/api/admin/dashboard/route'

const req = () => new NextRequest('http://localhost/api/admin/dashboard')
const CLASSI = ['2 ANNI', '3 ANNI', 'PRIMA A']

function dbGrande(): DBFinto {
  const alunni = Array.from({ length: 1500 }, (_, n) => ({
    id: `al-${String(n).padStart(5, '0')}`,
    classe_sezione: CLASSI[n % 3],
    stato: 'iscritto',
    scuola_id: SEDE_A,
  }))
  const pagamenti = Array.from({ length: 1200 }, (_, n) => ({
    id: `pag-${String(n).padStart(5, '0')}`,
    scuola_id: SEDE_A,
    tipo: 'singolo',
    scadenza: `2026-0${1 + (n % 8)}-10`,
    stato: 'da_pagare',
    fattura_stato: null,
    alunni: { nome: 'Prova', cognome: `Collaudo ${n}` },
  }))
  return {
    utenti_scuole: [],
    alunni,
    pagamenti,
    enrollment_submissions: [],
    mensa_prenotazioni: [],
    form_submissions: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbGrande()
  h.opzioni = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/admin/dashboard — conteggi del database, non lunghezze di elenchi tagliati', () => {
  it('🔴 1.500 iscritti con il tetto a 1000 → 1500, e la distribuzione per classe somma a 1500', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.studenti.iscritti).toBe(1500)
    expect(body.studenti.perClasse).toEqual(CLASSI.map((classe) => ({ classe, count: 500 })))
    expect(h.logEvento).not.toHaveBeenCalledWith('anagrafica', 'warn', expect.objectContaining({ esito: 'per-classe-non-quadra' }))
  })

  it('🔴 1.200 pagamenti scaduti → 1200, e l’elenco degli alert resta di 5', async () => {
    const body = await (await GET(req())).json()
    expect(body.pagamenti.scadutoCount).toBe(1200)
    expect(body.alert.scaduti).toHaveLength(5)
    expect(body.alert.scaduti[0].scadenza).toBe('2026-01-10')
  })

  it('🔴 un guasto vero su una lettura → 500 DASHBOARD_NON_LETTA, non uno zero', async () => {
    h.opzioni = { errori: { 'pagamenti:select': { code: '57014', message: 'canceling statement due to statement timeout' } } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('DASHBOARD_NON_LETTA')
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500, evento: 'db:pagamenti:scaduti' }), expect.anything())
  })

  it('schema assente (DB E2E non migrato, 42703) → 200 con lo zero, e la riga di log che lo dice', async () => {
    h.opzioni = { errori: { 'form_submissions:select': { code: '42703', message: 'column form_submissions.scuola_id does not exist' } } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moduli.submissionTotale).toBe(0)
    expect(body.studenti.iscritti).toBe(1500)
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 200, evento: 'db:form_submissions:totale' }), expect.anything())
  })
})
