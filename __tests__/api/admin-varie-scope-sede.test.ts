import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W2-H — Admin varie: la coda di moderazione UGC, il registro immutabile delle
// scritture e i KPI di direzione erano di TUTTE le sedi.
//
//  · admin/segnalazioni  GET: `select('*')` senza `scuola_id` → il coordinatore
//    di un plesso leggeva (e chiudeva) le segnalazioni degli altri due. È testo
//    scritto da un genitore su un contenuto che riguarda minori.
//  · admin/audit         GET: `scuola_id` era nella proiezione e MAI nel filtro:
//    l'unico dei rilievi che perdeva righe in produzione (3 di Aversa su 345).
//  · admin/dashboard     3 aggregati su 9 senza scope: il contatore Moduli
//    contava già una riga della sede FINTA E2E.
//
// Il finto Supabase applica DAVVERO i filtri e registra DAVVERO le scritture:
// qui non si asserisce «non è 403», si asserisce lo stato esatto E l'effetto sul
// database (accumulatore `scritture`).
// =============================================================================

const SEG_A = '11111111-1111-4111-8111-11111111111a'
const SEG_B = '22222222-2222-4222-8222-22222222222b'
const SEG_NULL = '33333333-3333-4333-8333-333333333333'
const ADMIN = 'aaaa0000-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori,
      }),
  }
})

import { GET as SEGNALAZIONI_GET, PATCH as SEGNALAZIONI_PATCH } from '@/app/api/admin/segnalazioni/route'
import { GET as AUDIT_GET } from '@/app/api/admin/audit/route'
import { GET as DASHBOARD_GET } from '@/app/api/admin/dashboard/route'
import { dataCivile } from '@/i18n/config'

// «Oggi» per una scuola di Giugliano è oggi in ITALIA, non a Greenwich.
//
// Questa riga era `new Date().toISOString().slice(0, 10)`, cioè la data in UTC,
// e il 2026-08-01 all'01:08 italiane ha fatto diventare rosso il test degli
// incassi: la fixture datava l'incasso al 31 luglio, la dashboard cercava
// «questo mese» in agosto. Non era un test fragile — era il difetto vero, che
// si era manifestato da solo nelle due ore in cui Italia e UTC stanno in mesi
// diversi. In produzione quelle due ore ci sono ogni notte, perché su Vercel il
// processo gira in UTC.
//
// Ora la fixture usa la stessa nozione di «oggi» del prodotto, e il test non
// dipende più dal fuso della macchina che lo esegue: verificato con
// Europe/Rome, UTC, Pacific/Kiritimati (UTC+14) e Pacific/Niue (UTC-11).
const OGGI = dataCivile()

const req = (url: string, cookie?: string) =>
  new NextRequest(url, cookie ? { headers: { cookie } } : undefined)

const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/segnalazioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  segnalazioni: [
    {
      id: SEG_A,
      scuola_id: SEDE_A,
      tipo_oggetto: 'messaggio_chat',
      categoria: 'spam',
      stato: 'aperta',
      motivo: 'MOTIVO-SEDE-A',
      creata_il: '2026-07-30T10:00:00.000Z',
    },
    {
      id: SEG_B,
      scuola_id: SEDE_B,
      tipo_oggetto: 'messaggio_chat',
      categoria: 'molestie_bullismo',
      stato: 'aperta',
      motivo: 'MOTIVO-SEDE-B',
      creata_il: '2026-07-30T11:00:00.000Z',
    },
    {
      id: SEG_NULL,
      scuola_id: null,
      tipo_oggetto: 'utente',
      categoria: 'spam',
      stato: 'aperta',
      motivo: 'MOTIVO-SENZA-SEDE',
      creata_il: '2026-07-30T12:00:00.000Z',
    },
  ],
  audit_scritture_docente: [
    { id: 'au-a', attore_id: 'x', attore_ruolo: 'educator', scuola_id: SEDE_A, section_id: 'sez-a', entita_tipo: 'presenze', entita_id: null, azione: 'update', creato_il: '2026-07-30T10:00:00.000Z' },
    { id: 'au-b', attore_id: 'y', attore_ruolo: 'educator', scuola_id: SEDE_B, section_id: 'sez-b', entita_tipo: 'valutazione', entita_id: null, azione: 'insert', creato_il: '2026-07-30T11:00:00.000Z' },
  ],
  alunni: [
    { id: 'al-a', classe_sezione: '2 ANNI', stato: 'iscritto', scuola_id: SEDE_A },
    { id: 'al-b', classe_sezione: '2 ANNI', stato: 'iscritto', scuola_id: SEDE_B },
  ],
  pagamenti: [],
  enrollment_submissions: [],
  mensa_prenotazioni: [],
  incassi: [
    { id: 'inc-a', importo: 100, data_incasso: OGGI, pagamenti: { scuola_id: SEDE_A } },
    { id: 'inc-b', importo: 900, data_incasso: OGGI, pagamenti: { scuola_id: SEDE_B } },
  ],
  form_submissions: [
    { id: 'fs-a', scuola_id: SEDE_A, status: 'pending_signature' },
    { id: 'fs-b1', scuola_id: SEDE_B, status: 'pending_signature' },
    { id: 'fs-b2', scuola_id: SEDE_B, status: 'completed' },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

const scrittureSu = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

describe('GET /api/admin/segnalazioni — la coda di moderazione è del proprio plesso', () => {
  it('la segnalazione della sede B non compare, e nemmeno il suo motivo', async () => {
    const res = await SEGNALAZIONI_GET(req('http://localhost/api/admin/segnalazioni'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.segnalazioni.map((s: { id: string }) => s.id)).toEqual([SEG_A])
    expect(j.total).toBe(1)
    const corpo = JSON.stringify(j)
    expect(corpo).toContain('MOTIVO-SEDE-A')
    expect(corpo).not.toContain('MOTIVO-SEDE-B')
    expect(corpo).not.toContain('MOTIVO-SENZA-SEDE')
  })

  it('admin multi-plesso col SedeSelector su A: la sede B resta fuori', async () => {
    h.db.utenti_scuole = [
      { utente_id: ADMIN, scuola_id: SEDE_A },
      { utente_id: ADMIN, scuola_id: SEDE_B },
    ]
    const res = await SEGNALAZIONI_GET(
      req('http://localhost/api/admin/segnalazioni', `sedi_attive=${SEDE_A}`),
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.segnalazioni.map((s: { id: string }) => s.id)).toEqual([SEG_A])
  })

  it('scope vuoto (cookie con una sede non accessibile) ⇒ coda VUOTA, mai «allora eccoti tutto»', async () => {
    const res = await SEGNALAZIONI_GET(
      req('http://localhost/api/admin/segnalazioni', `sedi_attive=${SEDE_B}`),
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.segnalazioni).toEqual([])
    expect(j.total).toBe(0)
  })
})

describe('PATCH /api/admin/segnalazioni — non si modera la coda di un altro plesso', () => {
  it('403 sulla segnalazione della sede B: nessuna UPDATE sul database', async () => {
    const res = await SEGNALAZIONI_PATCH(patchReq({ id: SEG_B, stato: 'chiusa' }))
    expect(res.status).toBe(403)
    expect(scrittureSu('segnalazioni')).toHaveLength(0)
    const rigaB = h.db.segnalazioni.find((s) => s.id === SEG_B)!
    expect(rigaB.stato).toBe('aperta')
    expect(rigaB.gestita_da).toBeUndefined()
  })

  it('403 sulla segnalazione SENZA sede (colonna nullable): non è attribuibile a nessuno', async () => {
    const res = await SEGNALAZIONI_PATCH(patchReq({ id: SEG_NULL, stato: 'chiusa' }))
    expect(res.status).toBe(403)
    expect(scrittureSu('segnalazioni')).toHaveLength(0)
    expect(h.db.segnalazioni.find((s) => s.id === SEG_NULL)!.stato).toBe('aperta')
  })

  it('200 sulla propria: la riga viene chiusa e gestita_da è quello del GATE', async () => {
    const res = await SEGNALAZIONI_PATCH(patchReq({ id: SEG_A, stato: 'chiusa', note_gestione: 'ok' }))
    expect(res.status).toBe(200)
    const scritte = scrittureSu('segnalazioni')
    expect(scritte).toHaveLength(1)
    expect(scritte[0].operazione).toBe('update')
    expect(scritte[0].colpite.map((r) => r.id)).toEqual([SEG_A])
    const rigaA = h.db.segnalazioni.find((s) => s.id === SEG_A)!
    expect(rigaA.stato).toBe('chiusa')
    expect(rigaA.gestita_da).toBe(ADMIN)
  })

  it('404 se la segnalazione non esiste affatto', async () => {
    const res = await SEGNALAZIONI_PATCH(
      patchReq({ id: '99999999-9999-4999-8999-999999999999', stato: 'chiusa' }),
    )
    expect(res.status).toBe(404)
    expect(scrittureSu('segnalazioni')).toHaveLength(0)
  })
})

describe('GET /api/admin/audit — il registro immutabile è del proprio plesso', () => {
  it('la segreteria di A non vede le scritture registrate su B', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await AUDIT_GET(req('http://localhost/api/admin/audit'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual(['au-a'])
  })

  it('scope vuoto ⇒ elenco vuoto (deny), mai l\'intero registro', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await AUDIT_GET(req('http://localhost/api/admin/audit', `sedi_attive=${SEDE_B}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
  })

  it('401 anonimo: nessuna lettura del registro', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await AUDIT_GET(req('http://localhost/api/admin/audit'))
    expect(res.status).toBe(401)
    expect(h.tabelle).not.toContain('audit_scritture_docente')
  })
})

describe('GET /api/admin/dashboard — i KPI non sommano le altre sedi', () => {
  it('Moduli conta solo le compilazioni del proprio plesso', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await DASHBOARD_GET(req('http://localhost/api/admin/dashboard'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.moduli.submissionTotale).toBe(1)
    expect(j.moduli.daFirmare).toBe(1)
  })

  it('Incassato del mese: solo gli incassi legati a pagamenti del proprio plesso', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await DASHBOARD_GET(req('http://localhost/api/admin/dashboard'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.pagamenti.incassatoMese).toBe(100)
    const totaleTrend = (j.trend as { incassato: number }[]).reduce((a, t) => a + t.incassato, 0)
    expect(totaleTrend).toBe(100)
  })

  it('scope vuoto ⇒ tutti gli aggregati a zero (deny), non i totali di tutte le sedi', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await DASHBOARD_GET(req('http://localhost/api/admin/dashboard', `sedi_attive=${SEDE_B}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.studenti.iscritti).toBe(0)
    expect(j.moduli.submissionTotale).toBe(0)
    expect(j.pagamenti.incassatoMese).toBe(0)
  })

  // Il DB E2E della CI non è migrato e `form_submissions.scuola_id` non c'è:
  // il filtro nuovo ci risponde `42703`. La dashboard non deve rompersi — ma
  // uno zero senza log è indistinguibile da «non ci sono compilazioni», che è
  // esattamente l'ambiguità che ha tenuto nascosto il guasto delle email.
  it('colonna assente (42703): il KPI degrada a 0 ma l\'errore FINISCE nei log', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    h.errori = { form_submissions: { code: '42703', message: 'column does not exist' } }
    const res = await DASHBOARD_GET(req('http://localhost/api/admin/dashboard'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.moduli.submissionTotale).toBe(0)
    expect(j.studenti.iscritti).toBe(1) // il resto della dashboard regge
    const eventi = h.logErrore.mock.calls.map((c) => (c[0] as { evento?: string }).evento)
    // Il log dice QUALE aggregato è a zero: «db» e basta non basterebbe a
    // distinguere il modulo dagli incassi.
    expect(eventi).toContain('db:form_submissions:totale')
    expect(eventi).toContain('db:form_submissions:da_firmare')
  })

  it('incassi illeggibili: l\'errore del join non resta muto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    h.errori = { incassi: { code: '42703', message: 'column does not exist' } }
    const res = await DASHBOARD_GET(req('http://localhost/api/admin/dashboard'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.pagamenti.incassatoMese).toBe(0)
    expect(h.logErrore).toHaveBeenCalled()
  })
})
