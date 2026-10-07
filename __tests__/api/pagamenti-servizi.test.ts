import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B, SEDE_E2E } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// Iscrizioni ai servizi mensili: GET / POST / PATCH / DELETE di
// `/api/pagamenti/servizi`.
//
// Il finto Supabase APPLICA i filtri e ESEGUE le scritture: le asserzioni stanno sullo
// STATO FINALE delle tabelle finte (iscrizioni, voci), non solo sulle chiamate. Un mock
// piatto sarebbe verde anche senza `.eq('scuola_id', …)` e senza il «due tempi».
//
// La gara fra il primo e il secondo tempo si simula con un gancio (`h.durante`) che scatta
// quando la route legge `incassi` — l'ultima lettura di sicurezza, DOPO la classificazione
// e PRIMA della cancellazione — e cambia la riga sotto i piedi della route.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const CAT = 'c0000000-0000-4000-8000-0000000000a1'
const CAT_NON_MENSILE = 'c0000000-0000-4000-8000-0000000000a2'
const CAT_ALTRA_SEDE = 'c0000000-0000-4000-8000-0000000000a3'
const CAT_SPENTA = 'c0000000-0000-4000-8000-0000000000a4'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const ALU_ALTRA_SEDE = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'
const ALU_RITIRATO = 'a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa'
const ISCR_1 = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ISCR_ALTRA_SEDE = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Record<string, unknown>[],
  errori: {} as Record<string, { code: string; message?: string }>,
  /** Scatta quando la route legge `incassi`: la gara fra il primo e il secondo tempo. */
  durante: null as null | (() => void),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(a),
  logErrore: (...a: unknown[]) => h.log.push(a),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const client = creaFintoSupabase(h.db, h.tabelle, {
        errori: h.errori,
        scritture: h.scritture as unknown as Scrittura[],
      }) as unknown as { from: (t: string) => unknown }
      const from = client.from.bind(client)
      client.from = (tabella: string) => {
        if (tabella === 'incassi' && h.durante) {
          const f = h.durante
          h.durante = null
          f()
        }
        return from(tabella)
      }
      return client as never
    },
  }
})

import { GET, POST, PATCH, DELETE } from '@/app/api/pagamenti/servizi/route'

const get = (qs = '') => new Request(`http://localhost/api/pagamenti/servizi?${qs}`)
const corpo = (metodo: string, body: unknown) =>
  new Request('http://localhost/api/pagamenti/servizi', {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const post = (b: unknown) => POST(corpo('POST', b))
const patch = (b: unknown) => PATCH(corpo('PATCH', b))
const del = (qs: string) => DELETE(new Request(`http://localhost/api/pagamenti/servizi?${qs}`, { method: 'DELETE' }))

const ADMIN_UTENTE = { id: ADMIN, role: 'admin', scuola_id: SEDE_A }
const SEGRETERIA_UTENTE = { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_B }

const voce = (id: string, mese: string, extra: Riga = {}): Riga => ({
  id,
  scuola_id: SEDE_A,
  alunno_id: ALU_1,
  categoria_id: CAT,
  tipo: 'singolo',
  importo: 80,
  importo_pagato: 0,
  stato: 'da_pagare',
  periodo_competenza: `${mese}-01`,
  scadenza: `${mese}-05`,
  fattura_stato: 'non_richiesta',
  fattura_aruba_id: null,
  descrizione: `Pomeridiano ${mese}`,
  ...extra,
})

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: 'Sede A' },
    { id: SEDE_B, nome: 'Sede B' },
    { id: SEDE_E2E, nome: 'Sede di collaudo' },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
    { id: SEDE_E2E, attiva: true },
  ],
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
    { utente_id: ADMIN, scuola_id: SEDE_E2E },
  ],
  payment_categories: [
    { id: CAT, nome: 'Pomeridiano', slug: 'pomeridiano', scuola_id: null, mensile: true, attivo: true, importo_mensile_default: 80 },
    { id: CAT_NON_MENSILE, nome: 'Mensa', slug: 'mensa', scuola_id: null, mensile: false, attivo: true, importo_mensile_default: null },
    { id: CAT_ALTRA_SEDE, nome: 'Pulmino B', slug: 'pulmino', scuola_id: SEDE_B, mensile: true, attivo: true, importo_mensile_default: null },
    { id: CAT_SPENTA, nome: 'Doposcuola', slug: 'doposcuola', scuola_id: null, mensile: true, attivo: false, importo_mensile_default: null },
  ],
  alunni: [
    { id: ALU_1, scuola_id: SEDE_A, stato: 'iscritto', nome: 'Mario', cognome: 'Rossi', classe_sezione: '3A' },
    { id: ALU_2, scuola_id: SEDE_A, stato: 'iscritto', nome: 'Anna', cognome: 'Bianchi', classe_sezione: '3B' },
    { id: ALU_ALTRA_SEDE, scuola_id: SEDE_B, stato: 'iscritto', nome: 'Luca', cognome: 'Verdi', classe_sezione: '1A' },
    { id: ALU_RITIRATO, scuola_id: SEDE_A, stato: 'ritirato', nome: 'Gino', cognome: 'Neri', classe_sezione: '2A' },
  ],
  iscrizioni_servizi: [],
  pagamenti: [],
  incassi: [],
  fatture_emesse: [],
  fatture_coda: [],
  solleciti: [],
  registro_modifiche: [],
})

const iscrizione = (id: string, alunno: string, dal: string, al: string | null, sede = SEDE_A, extra: Riga = {}): Riga => ({
  id, alunno_id: alunno, categoria_id: CAT, scuola_id: sede, importo_mensile: 80, dal, al, creato_da: ADMIN,
  alunni: { nome: 'Mario', cognome: 'Rossi', classe_sezione: '3A', stato: 'iscritto' },
  ...extra,
})

const T = (nome: string) => h.db[nome] as Riga[]
const iscrizioni = () => T('iscrizioni_servizi')
const pagamenti = () => T('pagamenti')
const idsVoci = () => pagamenti().map((p) => p.id as string).sort()
const audit = () => T('registro_modifiche')
const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)
/** Copia profonda dello stato di tutte le tabelle: per provare che «NULLA cambia». */
const istantanea = () => JSON.stringify(h.db)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.log = []
  h.durante = null
  h.requireStaff.mockResolvedValue({ user: ADMIN_UTENTE })
})

const logJson = () => JSON.stringify(h.log)

// ─── gate, zod, sede ────────────────────────────────────────────────────────────────────────

describe('gate, validazione e sede', () => {
  it('non staff: la risposta del gate passa tale e quale, nessuna lettura né scrittura', async () => {
    const { NextResponse } = await import('next/server')
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const prima = istantanea()
    expect((await GET(get(`scuola_id=${SEDE_A}`))).status).toBe(403)
    expect((await post({})).status).toBe(403)
    expect((await patch({})).status).toBe(403)
    expect((await del(`id=${ISCR_1}&scuola_id=${SEDE_A}`)).status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(istantanea()).toBe(prima)
  })

  it.each([
    ['alunno_ids vuoto', { alunno_ids: [] }],
    ['alunno_ids duplicati', { alunno_ids: [ALU_1, ALU_1] }],
    ['alunno_ids non uuid', { alunno_ids: ['x'] }],
    ['importo zero', { importo_mensile: 0 }],
    ['importo negativo', { importo_mensile: -5 }],
    ['importo con tre decimali', { importo_mensile: 10.123 }],
    ['importo oltre il tetto', { importo_mensile: 100000 }],
    ['importo stringa', { importo_mensile: '80' }],
    ['dal non è un mese', { dal: '2026-13' }],
    ['al non è un mese', { al: 'ottobre' }],
    ['scuola_id mancante', { scuola_id: undefined }],
    ['categoria_id non uuid', { categoria_id: 'abc' }],
  ])('POST con %s: 400 e nessuna scrittura', async (_nome, guasto) => {
    const ok = { scuola_id: SEDE_A, categoria_id: CAT, alunno_ids: [ALU_1], importo_mensile: 80, dal: '2026-09' }
    const res = await post({ ...ok, ...guasto })
    expect(res.status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('PATCH senza nessuna modifica: 400; DELETE con id non uuid: 400', async () => {
    expect((await patch({ id: ISCR_1, scuola_id: SEDE_A })).status).toBe(400)
    expect((await del(`id=xyz&scuola_id=${SEDE_A}`)).status).toBe(400)
    expect((await del(`id=${ISCR_1}&scuola_id=${SEDE_A}&voci_future=boh`)).status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('sede fuori dal perimetro: 403 su tutti i verbi, nulla scritto', async () => {
    h.requireStaff.mockResolvedValue({ user: SEGRETERIA_UTENTE })
    const prima = istantanea()
    expect((await GET(get(`scuola_id=${SEDE_A}`))).status).toBe(403)
    expect((await post({ scuola_id: SEDE_A, categoria_id: CAT, alunno_ids: [ALU_1], importo_mensile: 80, dal: '2026-09' })).status).toBe(403)
    expect((await patch({ id: ISCR_1, scuola_id: SEDE_A, importo_mensile: 90 })).status).toBe(403)
    expect((await del(`id=${ISCR_1}&scuola_id=${SEDE_A}`)).status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(istantanea()).toBe(prima)
  })

  it('la sede di collaudo SI LEGGE (a differenza della generazione): 200', async () => {
    const res = await GET(get(`scuola_id=${SEDE_E2E}`))
    expect(res.status).toBe(200)
  })
})

// ─── GET ────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/pagamenti/servizi', () => {
  it('servizi mensili attivi (globali o della sede) e iscrizioni della SOLA sede, coi nomi', async () => {
    h.db.iscrizioni_servizi = [
      iscrizione(ISCR_1, ALU_1, '2026-09-01', null),
      iscrizione(ISCR_ALTRA_SEDE, ALU_ALTRA_SEDE, '2026-09-01', null, SEDE_B),
    ]
    const res = await GET(get(`scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
    const { success, data } = await res.json()
    expect(success).toBe(true)
    // Mensa non è mensile, Pulmino B è della sede B, Doposcuola è spento: resta il Pomeridiano.
    expect(data.servizi.map((s: { id: string }) => s.id)).toEqual([CAT])
    expect(data.servizi[0]).toEqual({
      id: CAT, nome: 'Pomeridiano', slug: 'pomeridiano', scuola_id: null, importo_mensile_default: 80,
    })
    expect(data.iscrizioni).toHaveLength(1)
    expect(data.iscrizioni[0]).toMatchObject({
      id: ISCR_1, alunno_id: ALU_1, categoria_id: CAT, importo_mensile: 80, dal: '2026-09-01', al: null,
      alunno: { nome: 'Mario', cognome: 'Rossi', classe_sezione: '3A', stato: 'iscritto' },
    })
    // I nomi servono alla schermata: nel log non ci sono mai.
    expect(logJson()).not.toMatch(/Mario|Rossi/)
  })

  it('la sede B vede il suo servizio e le sue iscrizioni, non quelle della A', async () => {
    h.db.iscrizioni_servizi = [
      iscrizione(ISCR_1, ALU_1, '2026-09-01', null),
      iscrizione(ISCR_ALTRA_SEDE, ALU_ALTRA_SEDE, '2026-09-01', null, SEDE_B),
    ]
    const { data } = await (await GET(get(`scuola_id=${SEDE_B}`))).json()
    expect(data.servizi.map((s: { id: string }) => s.id).sort()).toEqual([CAT, CAT_ALTRA_SEDE].sort())
    expect(data.iscrizioni.map((i: { id: string }) => i.id)).toEqual([ISCR_ALTRA_SEDE])
  })

  it.each([
    ['colonna mensile assente (42703)', { payment_categories: { code: '42703' } }],
    ['tabella assente (PGRST205)', { iscrizioni_servizi: { code: 'PGRST205' } }],
    ['tabella assente (42P01)', { iscrizioni_servizi: { code: '42P01' } }],
    ['colonna fuori cache (PGRST204)', { payment_categories: { code: 'PGRST204' } }],
  ])('schema assente, %s: 200 non_disponibile e log error', async (_n, errori) => {
    h.errori = errori
    const res = await GET(get(`scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { non_disponibile: true } })
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('servizi-non-disponibili'))).toBe(true)
  })

  it('altro guasto di lettura: 500 SERVIZI_LETTURA_FALLITA senza il testo del database', async () => {
    h.errori = { iscrizioni_servizi: { code: 'XX000', message: 'guasto interno segreto' } }
    const res = await GET(get(`scuola_id=${SEDE_A}`))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZI_LETTURA_FALLITA')
    expect(JSON.stringify(j)).not.toContain('segreto')
  })
})

// ─── POST ───────────────────────────────────────────────────────────────────────────────────

const base = { scuola_id: SEDE_A, categoria_id: CAT, alunno_ids: [ALU_1, ALU_2], importo_mensile: 80, dal: '2026-09' }

describe('POST /api/pagamenti/servizi', () => {
  it('felice: crea una riga per bambino con creato_da, sede e primo del mese; audit; log senza nomi', async () => {
    const res = await post({ ...base, al: '2027-06' })
    expect(res.status).toBe(201)
    expect((await res.json()).data.creati).toBe(2)
    expect(iscrizioni()).toHaveLength(2)
    for (const r of iscrizioni()) {
      expect(r).toMatchObject({
        categoria_id: CAT, scuola_id: SEDE_A, importo_mensile: 80, dal: '2026-09-01', al: '2027-06-01', creato_da: ADMIN,
      })
    }
    expect(iscrizioni().map((r) => r.alunno_id).sort()).toEqual([ALU_1, ALU_2].sort())
    expect(audit()).toHaveLength(1)
    expect(audit()[0]).toMatchObject({ azione: 'crea_iscrizioni_servizio', tabella_interessata: 'iscrizioni_servizi', utente_id: ADMIN })
    const evento = h.log.find((c) => JSON.stringify(c).includes('iscrizioni-servizio-create'))
    expect(evento).toBeTruthy()
    expect(JSON.stringify(evento)).toContain('"n":2')
    expect(JSON.stringify(evento)).toContain(CAT)
    expect(logJson()).not.toMatch(/Mario|Rossi|Anna|Bianchi/)
  })

  it('senza `al`: iscrizione aperta (al nullo)', async () => {
    expect((await post(base)).status).toBe(201)
    for (const r of iscrizioni()) expect(r.al).toBeNull()
  })

  it('al prima di dal: 400 SERVIZIO_PERIODO_NON_VALIDO, nessuna riga', async () => {
    const res = await post({ ...base, dal: '2026-10', al: '2026-09' })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SERVIZIO_PERIODO_NON_VALIDO')
    expect(iscrizioni()).toHaveLength(0)
  })

  it('categoria di un\'altra sede: 404; inesistente: 404; non mensile: 409; spenta: 409. Mai una riga', async () => {
    const r1 = await post({ ...base, categoria_id: CAT_ALTRA_SEDE })
    expect(r1.status).toBe(404)
    expect((await r1.json()).codice).toBe('SERVIZIO_NON_TROVATO')
    expect((await post({ ...base, categoria_id: 'c0000000-0000-4000-8000-0000000000ff' })).status).toBe(404)
    const r3 = await post({ ...base, categoria_id: CAT_NON_MENSILE })
    expect(r3.status).toBe(409)
    expect((await r3.json()).codice).toBe('SERVIZIO_NON_MENSILE')
    expect((await post({ ...base, categoria_id: CAT_SPENTA })).status).toBe(409)
    expect(iscrizioni()).toHaveLength(0)
    expect(h.scritture).toEqual([])
  })

  it('alunno di un\'altra sede o non iscritto: 400 con l\'elenco, e NESSUNA riga nemmeno per i validi', async () => {
    const res = await post({ ...base, alunno_ids: [ALU_1, ALU_ALTRA_SEDE, ALU_RITIRATO] })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZIO_ALUNNI_NON_VALIDI')
    expect(j.alunno_ids.sort()).toEqual([ALU_ALTRA_SEDE, ALU_RITIRATO].sort())
    expect(iscrizioni()).toHaveLength(0)
    expect(h.scritture).toEqual([])
  })

  it('sovrapposizione anche di un mese solo: 409 con i bambini in conflitto e nessuna riga nuova', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', '2026-12-01')]
    const res = await post({ ...base, dal: '2026-12', al: '2027-03' })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZIO_ISCRIZIONE_SOVRAPPOSTA')
    expect(j.alunno_ids).toEqual([ALU_1])
    // ALU_2 non era in conflitto, ma la richiesta è tutto-o-niente.
    expect(iscrizioni()).toHaveLength(1)
    expect(scrittureSu('iscrizioni_servizi')).toEqual([])
  })

  it('sovrapposizione con un\'iscrizione aperta (al nullo): 409', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    expect((await post({ ...base, dal: '2030-01' })).status).toBe(409)
    expect(iscrizioni()).toHaveLength(1)
  })

  it('mesi ADIACENTI: ok (il 12 finisce, il 01 comincia)', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', '2026-12-01')]
    const res = await post({ ...base, dal: '2027-01' })
    expect(res.status).toBe(201)
    expect(iscrizioni()).toHaveLength(3)
  })

  it('stesso bambino, ALTRO servizio: nessun conflitto', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null, SEDE_A, { categoria_id: 'c0000000-0000-4000-8000-0000000000b9' })]
    expect((await post(base)).status).toBe(201)
  })

  it('gara fra due salvataggi (23P01 dal database): 409 SERVIZIO_ISCRIZIONE_SOVRAPPOSTA, nessuna riga', async () => {
    h.errori = { 'iscrizioni_servizi:insert': { code: '23P01' } }
    const res = await post(base)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SERVIZIO_ISCRIZIONE_SOVRAPPOSTA')
    expect(iscrizioni()).toHaveLength(0)
  })

  it('altro errore di scrittura: 500 SERVIZI_SCRITTURA_FALLITA, log error col conteggio, niente testo del database', async () => {
    h.errori = { 'iscrizioni_servizi:insert': { code: 'XX000', message: 'dettaglio interno' } }
    const res = await post(base)
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZI_SCRITTURA_FALLITA')
    expect(JSON.stringify(j)).not.toContain('dettaglio interno')
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('iscrizioni-servizio-non-create'))).toBe(true)
    expect(iscrizioni()).toHaveLength(0)
  })

  it.each([
    ['colonna mensile assente', { payment_categories: { code: '42703' } }],
    ['tabella assente alla scrittura', { 'iscrizioni_servizi:insert': { code: '42P01' } }],
  ])('schema assente, %s: 503 SERVIZI_NON_DISPONIBILI', async (_n, errori) => {
    h.errori = errori
    const res = await post(base)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SERVIZI_NON_DISPONIBILI')
    expect(iscrizioni()).toHaveLength(0)
  })

  it('la sede passa dal perimetro: un utente di un\'altra sede non scrive in A', async () => {
    h.requireStaff.mockResolvedValue({ user: SEGRETERIA_UTENTE })
    expect((await post(base)).status).toBe(403)
    expect(iscrizioni()).toHaveLength(0)
  })
})

// ─── PATCH e DELETE: iscrizione con voci già generate ───────────────────────────────────────

/**
 * Iscrizione aperta da settembre 2026, con voci per ogni genere di caso:
 *  09 pagata (dentro il nuovo periodo) · 10 e 11 eliminabili · 12 parziale · 01 fatturata ·
 *  02 in coda · 03 con un incasso registrato.
 */
function scenario(): void {
  h.db.iscrizioni_servizi = [
    iscrizione(ISCR_1, ALU_1, '2026-09-01', null),
    iscrizione(ISCR_ALTRA_SEDE, ALU_ALTRA_SEDE, '2026-09-01', null, SEDE_B),
  ]
  h.db.pagamenti = [
    voce('p-09', '2026-09', { stato: 'pagato', importo_pagato: 80 }),
    voce('p-10', '2026-10'),
    voce('p-11', '2026-11'),
    voce('p-12', '2026-12', { stato: 'parziale', importo_pagato: 30 }),
    voce('p-01', '2027-01', { fattura_stato: 'emessa', fattura_aruba_id: 'ARU-1' }),
    voce('p-02', '2027-02'),
    voce('p-03', '2027-03'),
    // un'altra sede, stesso servizio: MAI toccata
    voce('p-altra', '2026-11', { scuola_id: SEDE_B, alunno_id: ALU_ALTRA_SEDE }),
    // un'altra sede, STESSO alunno e STESSA categoria (dato sporco): mai proposta né cancellata
    voce('p-altra-sede-stesso-alunno', '2026-11', { scuola_id: SEDE_B }),
    // un altro bambino della stessa sede: non è di questa iscrizione
    voce('p-altro-bimbo', '2026-11', { alunno_id: ALU_2 }),
    // un'altra causale dello stesso bambino: non è di questo servizio
    voce('p-altra-causale', '2026-11', { categoria_id: CAT_NON_MENSILE }),
  ]
  h.db.fatture_coda = [{ id: 'q1', pagamento_id: 'p-02', stato: 'in_coda', scuola_id: SEDE_A }]
  h.db.incassi = [{ id: 'i1', pagamento_id: 'p-03', importo: 10 }]
}

const ALTRE = ['p-altra', 'p-altra-causale', 'p-altro-bimbo', 'p-altra-sede-stesso-alunno']
const INTOCCABILI = ['p-12', 'p-01', 'p-02', 'p-03']
const TUTTE = [
  'p-09', 'p-10', 'p-11', 'p-12', 'p-01', 'p-02', 'p-03', ...ALTRE,
].sort()

describe('PATCH — accorciare il periodo: il primo tempo CHIEDE', () => {
  const accorcia = { id: ISCR_1, scuola_id: SEDE_A, al: '2026-09' }

  it('senza voci_future: 409 VOCI_FUTURE_DA_DECIDERE con l\'elenco, e NULLA cambia', async () => {
    scenario()
    const prima = istantanea()
    const res = await patch(accorcia)
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.codice).toBe('VOCI_FUTURE_DA_DECIDERE')
    expect(j.data.eliminabili.map((v: { id: string }) => v.id).sort()).toEqual(['p-10', 'p-11'])
    expect(j.data.eliminabili[0]).toEqual({
      id: 'p-10', periodo: '2026-10', importo: 80, scadenza: '2026-10-05', stato: 'da_pagare', sollecitata: false,
    })
    expect(j.data.intoccabili.find((v: { id: string }) => v.id === 'p-12')).toMatchObject({
      scadenza: '2026-12-05', stato: 'parziale', sollecitata: false, motivo: 'parziale',
    })
    const motivi = Object.fromEntries(j.data.intoccabili.map((v: { id: string; motivo: string }) => [v.id, v.motivo]))
    expect(motivi).toEqual({ 'p-12': 'parziale', 'p-01': 'fatturata', 'p-02': 'in_coda', 'p-03': 'incassi' })
    expect(h.scritture).toEqual([])
    expect(istantanea()).toBe(prima)
  })

  it('voci_future "elimina": spariscono SOLO le eliminabili; intoccabili e altrui restano; l\'iscrizione è aggiornata', async () => {
    scenario()
    const res = await patch({ ...accorcia, voci_future: 'elimina' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ voci_eliminate: 2, voci_mantenute: 0, intoccabili: 4 })
    expect(idsVoci()).toEqual(['p-09', ...INTOCCABILI, ...ALTRE].sort())
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ dal: '2026-09-01', al: '2026-09-01' })
    // l'iscrizione di un'altra sede è intatta
    expect(iscrizioni().find((r) => r.id === ISCR_ALTRA_SEDE)).toMatchObject({ dal: '2026-09-01', al: null })
    // audit: UNA riga per voce cancellata (riga intera, come DELETE /api/pagamenti/[id]) + una per l'iscrizione
    const perVoce = audit().filter((a) => a.tabella_interessata === 'pagamenti')
    expect(perVoce.map((a) => a.record_id).sort()).toEqual(['p-10', 'p-11'])
    for (const a of perVoce) {
      expect(a).toMatchObject({ azione: 'elimina_pagamento', utente_id: ADMIN })
      expect(a.vecchio_valore).toMatchObject({ id: a.record_id, scuola_id: SEDE_A, alunno_id: ALU_1, importo: 80, descrizione: expect.any(String) })
    }
    expect(audit().filter((a) => a.tabella_interessata === 'iscrizioni_servizi').map((a) => a.azione)).toEqual(['modifica_iscrizione_servizio'])
    const evento = h.log.find((c) => JSON.stringify(c).includes('iscrizione-servizio-aggiornata'))
    expect(JSON.stringify(evento)).toContain('"voci_eliminate":2')
    expect(logJson()).not.toMatch(/Mario|Rossi/)
  })

  it('voci_future "mantieni": voci intatte, iscrizione aggiornata, conteggi', async () => {
    scenario()
    const res = await patch({ ...accorcia, voci_future: 'mantieni' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ voci_eliminate: 0, voci_mantenute: 2, intoccabili: 4 })
    expect(idsVoci()).toEqual(TUTTE)
    expect(scrittureSu('pagamenti')).toEqual([])
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ al: '2026-09-01' })
  })

  it('senza voci interessate: applicata subito, senza chiedere', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    h.db.pagamenti = [voce('p-09', '2026-09', { stato: 'pagato', importo_pagato: 80 })]
    const res = await patch(accorcia)
    expect(res.status).toBe(200)
    expect(iscrizioni()[0]).toMatchObject({ al: '2026-09-01' })
    expect(idsVoci()).toEqual(['p-09'])
  })

  it('solo l\'importo: applicato subito anche con voci future, nessuna voce toccata', async () => {
    scenario()
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, importo_mensile: 95.5 })
    expect(res.status).toBe(200)
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ importo_mensile: 95.5, al: null })
    expect(idsVoci()).toEqual(TUTTE)
  })

  it('allungare o togliere la fine: nessuna voce esce, applicata subito', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', '2026-10-01')]
    h.db.pagamenti = [voce('p-10', '2026-10')]
    expect((await patch({ id: ISCR_1, scuola_id: SEDE_A, al: null })).status).toBe(200)
    expect(iscrizioni()[0].al).toBeNull()
    expect(idsVoci()).toEqual(['p-10'])
  })

  it('spostare l\'INIZIO in avanti: le voci dei mesi scoperti sono interessate', async () => {
    scenario()
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, dal: '2026-11' })
    expect(res.status).toBe(409)
    const j = await res.json()
    // settembre (pagata) e ottobre (eliminabile) escono dal periodo
    expect(j.data.eliminabili.map((v: { id: string }) => v.id)).toEqual(['p-10'])
    expect(j.data.intoccabili.map((v: { id: string }) => v.id)).toEqual(['p-09'])
    expect(j.data.intoccabili[0].motivo).toBe('pagata')
  })

  it('nuovo periodo che tocca un\'altra iscrizione dello stesso bambino e servizio: 409 sovrapposta, nulla cambia', async () => {
    h.db.iscrizioni_servizi = [
      iscrizione(ISCR_1, ALU_1, '2026-09-01', '2026-10-01'),
      iscrizione('b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb', ALU_1, '2027-01-01', null),
    ]
    const prima = istantanea()
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2027-01' })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SERVIZIO_ISCRIZIONE_SOVRAPPOSTA')
    expect(istantanea()).toBe(prima)
  })

  it('periodo adiacente all\'altra iscrizione: ok; se stessa non conta come conflitto', async () => {
    h.db.iscrizioni_servizi = [
      iscrizione(ISCR_1, ALU_1, '2026-09-01', '2026-10-01'),
      iscrizione('b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb', ALU_1, '2027-01-01', null),
    ]
    expect((await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-12' })).status).toBe(200)
    expect(iscrizioni()[0].al).toBe('2026-12-01')
  })

  it('periodo incoerente (la fine precede l\'inizio esistente): 400', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-06' })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SERVIZIO_PERIODO_NON_VALIDO')
    expect(iscrizioni()[0].al).toBeNull()
  })

  it('iscrizione inesistente: 404 ISCRIZIONE_SERVIZIO_NON_TROVATA', async () => {
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, importo_mensile: 10 })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ISCRIZIONE_SERVIZIO_NON_TROVATA')
  })

  it('RIGA DI UN\'ALTRA SEDE con id indovinato: 404 e mai toccata (iscrizione e voci)', async () => {
    scenario()
    const prima = istantanea()
    const res = await patch({ id: ISCR_ALTRA_SEDE, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' })
    expect(res.status).toBe(404)
    expect(h.scritture).toEqual([])
    expect(istantanea()).toBe(prima)
  })

  it('la cancellazione delle voci fallisce: 500, l\'iscrizione NON viene toccata', async () => {
    scenario()
    h.errori = { 'pagamenti:delete': { code: 'XX000', message: 'guasto' } }
    const res = await patch({ ...accorcia, voci_future: 'elimina' })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SERVIZI_SCRITTURA_FALLITA')
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ al: null })
    expect(idsVoci()).toEqual(TUTTE)
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('voci-servizio-non-eliminate'))).toBe(true)
  })

  it('la modifica dell\'iscrizione fallisce DOPO la cancellazione delle voci: 500 e il log dice quante erano', async () => {
    scenario()
    h.errori = { 'iscrizioni_servizi:update': { code: 'XX000', message: 'guasto' } }
    const res = await patch({ ...accorcia, voci_future: 'elimina' })
    expect(res.status).toBe(500)
    const corpoRisposta = await res.json()
    expect(corpoRisposta.codice).toBe('SERVIZI_SCRITTURA_FALLITA')
    const riga = h.log.find((c) => c[1] === 'error' && JSON.stringify(c).includes('iscrizione-servizio-non-scritta'))
    expect(JSON.stringify(riga)).toContain('"voci_eliminate":2')
    // anche il CORPO della risposta lo dice, perché il client possa avvisare la segreteria
    expect(corpoRisposta.voci_eliminate).toBe(2)
    // le voci eliminabili sono andate; l'iscrizione è com'era; le altre intatte
    expect(idsVoci()).toEqual(['p-09', ...INTOCCABILI, ...ALTRE].sort())
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ al: null })
    // ritentando: le eliminabili non ci sono più, restano solo le intoccabili (la finestra si
    // ripresenta con quelle); con una scelta la modifica passa e nulla resta orfano
    h.errori = {}
    const richiesta = await patch(accorcia)
    expect(richiesta.status).toBe(409)
    expect((await richiesta.json()).data.eliminabili).toEqual([])
    expect((await patch({ ...accorcia, voci_future: 'elimina' })).status).toBe(200)
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ al: '2026-09-01' })
  })

  it('gara sull\'iscrizione DOPO la cancellazione delle voci (23P01): 409 con voci_eliminate nel corpo', async () => {
    scenario()
    h.errori = { 'iscrizioni_servizi:update': { code: '23P01' } }
    const res = await patch({ ...accorcia, voci_future: 'elimina' })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZIO_ISCRIZIONE_SOVRAPPOSTA')
    expect(j.voci_eliminate).toBe(2)
  })

  it('gara sull\'iscrizione (23P01 all\'update): 409 sovrapposta', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    h.errori = { 'iscrizioni_servizi:update': { code: '23P01' } }
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, importo_mensile: 99 })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SERVIZIO_ISCRIZIONE_SOVRAPPOSTA')
  })
})

describe('Fra il primo e il secondo tempo: la gara', () => {
  const elimina = { id: ISCR_1, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' }

  it('una voce incassata nel frattempo (importo_pagato > 0) NON si cancella', async () => {
    scenario()
    h.durante = () => {
      const v = pagamenti().find((p) => p.id === 'p-10') as Riga
      v.importo_pagato = 20 // l'incasso arriva dopo la classificazione
    }
    const res = await patch(elimina)
    expect(res.status).toBe(200)
    expect(idsVoci()).toContain('p-10')
    expect(idsVoci()).not.toContain('p-11')
    expect((await res.json()).data).toMatchObject({ voci_eliminate: 1, voci_mantenute: 1 })
  })

  it('una voce diventata `pagato` nel frattempo NON si cancella', async () => {
    scenario()
    h.durante = () => {
      const v = pagamenti().find((p) => p.id === 'p-11') as Riga
      v.stato = 'pagato'
    }
    expect((await patch(elimina)).status).toBe(200)
    expect(idsVoci()).toContain('p-11')
    expect(idsVoci()).not.toContain('p-10')
  })

  it('una voce fatturata nel frattempo NON si cancella', async () => {
    scenario()
    h.durante = () => {
      const v = pagamenti().find((p) => p.id === 'p-10') as Riga
      v.fattura_aruba_id = 'ARU-9'
    }
    expect((await patch(elimina)).status).toBe(200)
    expect(idsVoci()).toContain('p-10')
  })

  it('una voce che non è più della sede NON si cancella (il filtro di sede è anche nella DELETE)', async () => {
    scenario()
    h.durante = () => {
      const v = pagamenti().find((p) => p.id === 'p-10') as Riga
      v.scuola_id = SEDE_B
    }
    expect((await patch(elimina)).status).toBe(200)
    expect(idsVoci()).toContain('p-10')
    expect(idsVoci()).not.toContain('p-11')
  })
})

describe('DELETE — eliminare l\'iscrizione, in due tempi', () => {
  const qs = (extra = '') => `id=${ISCR_1}&scuola_id=${SEDE_A}${extra}`

  it('senza voci_future: 409 con l\'elenco di TUTTE le voci del periodo e NULLA cambia', async () => {
    scenario()
    const prima = istantanea()
    const res = await del(qs())
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.codice).toBe('VOCI_FUTURE_DA_DECIDERE')
    expect(j.data.eliminabili.map((v: { id: string }) => v.id).sort()).toEqual(['p-10', 'p-11'])
    expect(j.data.intoccabili.map((v: { id: string }) => v.id).sort()).toEqual(['p-01', 'p-02', 'p-03', 'p-09', 'p-12'])
    expect(h.scritture).toEqual([])
    expect(istantanea()).toBe(prima)
  })

  it('"elimina": l\'iscrizione sparisce, spariscono solo le voci eliminabili, le altre restano', async () => {
    scenario()
    const res = await del(qs('&voci_future=elimina'))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ voci_eliminate: 2, voci_mantenute: 0, intoccabili: 5 })
    expect(iscrizioni().map((r) => r.id)).toEqual([ISCR_ALTRA_SEDE])
    expect(idsVoci()).toEqual(['p-09', ...INTOCCABILI, ...ALTRE].sort())
    expect(audit().map((a) => a.azione).sort()).toEqual(['elimina_iscrizione_servizio', 'elimina_pagamento', 'elimina_pagamento'])
  })

  it('"mantieni": sparisce solo l\'iscrizione, le voci restano tutte', async () => {
    scenario()
    const res = await del(qs('&voci_future=mantieni'))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ voci_eliminate: 0, voci_mantenute: 2, intoccabili: 5 })
    expect(iscrizioni().map((r) => r.id)).toEqual([ISCR_ALTRA_SEDE])
    expect(idsVoci()).toEqual(TUTTE)
  })

  it('senza nessuna voce: eliminata subito, senza chiedere', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    const res = await del(qs())
    expect(res.status).toBe(200)
    expect(iscrizioni()).toHaveLength(0)
    const evento = h.log.find((c) => JSON.stringify(c).includes('iscrizione-servizio-eliminata'))
    expect(evento).toBeTruthy()
  })

  it('ID di un\'altra sede indovinato: 404 e riga + voci MAI toccate, anche con voci_future=elimina', async () => {
    scenario()
    const prima = istantanea()
    const res = await del(`id=${ISCR_ALTRA_SEDE}&scuola_id=${SEDE_A}&voci_future=elimina`)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ISCRIZIONE_SERVIZIO_NON_TROVATA')
    expect(h.scritture).toEqual([])
    expect(istantanea()).toBe(prima)
  })

  it('la voce incassata fra il primo e il secondo tempo non viene cancellata', async () => {
    scenario()
    // primo tempo: p-10 è eliminabile
    const primo = await del(qs())
    expect((await primo.json()).data.eliminabili.map((v: { id: string }) => v.id)).toContain('p-10')
    // nel frattempo la segreteria incassa p-10
    const v = pagamenti().find((p) => p.id === 'p-10') as Riga
    v.importo_pagato = 80
    v.stato = 'pagato'
    // secondo tempo: la classificazione la rilegge e la protegge
    const secondo = await del(qs('&voci_future=elimina'))
    expect(secondo.status).toBe(200)
    expect(idsVoci()).toContain('p-10')
    expect(idsVoci()).not.toContain('p-11')
  })

  it('cancellazione delle voci fallita: 500 e l\'iscrizione resta', async () => {
    scenario()
    h.errori = { 'pagamenti:delete': { code: 'XX000' } }
    const res = await del(qs('&voci_future=elimina'))
    expect(res.status).toBe(500)
    expect(iscrizioni().map((r) => r.id)).toContain(ISCR_1)
    expect(idsVoci()).toEqual(TUTTE)
  })

  it('una lettura di sicurezza che fallisce (incassi) FERMA tutto: 500, nessuna cancellazione', async () => {
    scenario()
    h.errori = { incassi: { code: 'XX000' } }
    const res = await del(qs('&voci_future=elimina'))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SERVIZI_LETTURA_FALLITA')
    expect(h.scritture).toEqual([])
    expect(idsVoci()).toEqual(TUTTE)
  })

  it('le voci a rate (padre/split) sono sempre intoccabili', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    h.db.pagamenti = [voce('p-padre', '2026-10', { tipo: 'padre' }), voce('p-split', '2026-11', { tipo: 'split' })]
    const j = await (await del(qs())).json()
    expect(j.data.eliminabili).toEqual([])
    expect(j.data.intoccabili.map((v: { motivo: string }) => v.motivo)).toEqual(['rateizzata', 'rateizzata'])
  })
})

// ─── la revisione di T6: voci manuali, solleciti, voci_ids, altre gare ──────────────────────

describe('voci scritte a mano (senza periodo_competenza): mai eliminabili', () => {
  const accorcia = { id: ISCR_1, scuola_id: SEDE_A, al: '2026-09' }
  /** Il caso di produzione: una voce storica di ottobre, scaduta, già sollecitata. */
  function storica(): void {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    h.db.pagamenti = [
      voce('p-storica', '2026-10', { periodo_competenza: null, stato: 'scaduto', ultimo_sollecito_il: '2026-10-20T08:00:00Z' }),
      voce('p-10', '2026-10'),
    ]
    h.db.solleciti = [{ id: 's1', pagamento_id: 'p-storica', scuola_id: SEDE_A }]
  }

  it('è elencata come intoccabile «manuale», con scadenza, stato e sollecitata', async () => {
    storica()
    const res = await patch(accorcia)
    expect(res.status).toBe(409)
    const { data } = await res.json()
    expect(data.eliminabili.map((v: { id: string }) => v.id)).toEqual(['p-10'])
    expect(data.intoccabili).toEqual([
      { id: 'p-storica', periodo: '2026-10', importo: 80, scadenza: '2026-10-05', stato: 'scaduto', sollecitata: true, motivo: 'manuale' },
    ])
  })

  it('anche con "elimina" resta in tabella, coi suoi solleciti; sparisce solo la voce normale', async () => {
    storica()
    const res = await patch({ ...accorcia, voci_future: 'elimina' })
    expect(res.status).toBe(200)
    expect(idsVoci()).toEqual(['p-storica'])
    expect(T('solleciti')).toHaveLength(1)
    expect((await res.json()).data).toEqual({ voci_eliminate: 1, voci_mantenute: 0, intoccabili: 1 })
  })

  it('stessa cosa per la DELETE dell\'iscrizione', async () => {
    storica()
    const res = await del(`id=${ISCR_1}&scuola_id=${SEDE_A}&voci_future=elimina`)
    expect(res.status).toBe(200)
    expect(idsVoci()).toEqual(['p-storica'])
    expect(T('solleciti')).toHaveLength(1)
  })

  it('una voce che perde il periodo FRA i due tempi non si cancella (il filtro è anche nella DELETE)', async () => {
    scenario()
    h.durante = () => {
      const v = pagamenti().find((p) => p.id === 'p-10') as Riga
      v.periodo_competenza = null
    }
    expect((await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' })).status).toBe(200)
    expect(idsVoci()).toContain('p-10')
    expect(idsVoci()).not.toContain('p-11')
  })
})

describe('sollecitata: la finestra deve poter dire che si perdono i solleciti', () => {
  it('vale per una riga in `solleciti` e per `ultimo_sollecito_il`; altrimenti falso', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    h.db.pagamenti = [
      voce('p-10', '2026-10'),
      voce('p-11', '2026-11', { ultimo_sollecito_il: '2026-11-20T08:00:00Z' }),
      voce('p-12', '2026-12'),
    ]
    h.db.solleciti = [{ id: 's1', pagamento_id: 'p-10', scuola_id: SEDE_A }]
    const { data } = await (await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-09' })).json()
    const per = Object.fromEntries(data.eliminabili.map((v: { id: string; sollecitata: boolean }) => [v.id, v.sollecitata]))
    expect(per).toEqual({ 'p-10': true, 'p-11': true, 'p-12': false })
  })
})

describe('voci_ids: il secondo tempo cancella solo ciò che il client ha visto', () => {
  const accorcia = { id: ISCR_1, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' as const }

  it('voci_ids che non sono uuid: 400 e nessuna scrittura', async () => {
    scenario()
    const res = await patch({ ...accorcia, voci_ids: ['p-10'] })
    expect(res.status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('PATCH: cancella l\'intersezione fra voci_ids e le eliminabili ricalcolate (p-11 non confermata resta, p-12 intoccabile resta)', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    const U10 = 'd0000000-0000-4000-8000-000000000010'
    const U11 = 'd0000000-0000-4000-8000-000000000011'
    const U12 = 'd0000000-0000-4000-8000-000000000012'
    h.db.pagamenti = [
      voce(U10, '2026-10'),
      voce(U11, '2026-11'),
      voce(U12, '2026-12', { stato: 'parziale', importo_pagato: 30 }),
    ]
    const res = await patch({ ...accorcia, voci_ids: [U10, U12] })
    expect(res.status).toBe(200)
    expect(idsVoci()).toEqual([U11, U12].sort())
    expect((await res.json()).data).toEqual({ voci_eliminate: 1, voci_mantenute: 1, intoccabili: 1 })
  })

  it('DELETE: voci_ids separati da virgola', async () => {
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', null)]
    const U10 = 'd0000000-0000-4000-8000-000000000010'
    const U11 = 'd0000000-0000-4000-8000-000000000011'
    h.db.pagamenti = [voce(U10, '2026-10'), voce(U11, '2026-11')]
    const res = await del(`id=${ISCR_1}&scuola_id=${SEDE_A}&voci_future=elimina&voci_ids=${U11}`)
    expect(res.status).toBe(200)
    expect(idsVoci()).toEqual([U10])
    expect(iscrizioni()).toHaveLength(0)
  })

  it('senza voci_ids: tutte le eliminabili (comportamento di prima)', async () => {
    scenario()
    expect((await patch(accorcia)).status).toBe(200)
    expect(idsVoci()).not.toContain('p-10')
    expect(idsVoci()).not.toContain('p-11')
  })
})

describe('altre gare fra i due tempi: la voce cambiata resta', () => {
  const elimina = { id: ISCR_1, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' as const }

  it.each([
    ['diventa padre (solo tipo)', { tipo: 'padre' }],
    ['viene fatturata (solo fattura_stato)', { fattura_stato: 'in_attesa' }],
    ['diventa parziale (solo stato)', { stato: 'parziale' }],
  ])('%s', async (_n, cambio) => {
    scenario()
    h.durante = () => {
      Object.assign(pagamenti().find((p) => p.id === 'p-10') as Riga, cambio)
    }
    expect((await patch(elimina)).status).toBe(200)
    expect(idsVoci()).toContain('p-10')
    expect(idsVoci()).not.toContain('p-11')
  })
})

describe('nessuna voce esce dal periodo: "elimina" non cancella niente', () => {
  it('PATCH del solo importo con voci_future "elimina"', async () => {
    scenario()
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, importo_mensile: 90, voci_future: 'elimina' })
    expect(res.status).toBe(200)
    expect(scrittureSu('pagamenti')).toEqual([])
    expect(idsVoci()).toEqual(TUTTE)
    expect((await res.json()).data).toEqual({ voci_eliminate: 0, voci_mantenute: 0, intoccabili: 0 })
  })

  it('PATCH che allunga il periodo con voci_future "elimina"', async () => {
    scenario()
    h.db.iscrizioni_servizi = [iscrizione(ISCR_1, ALU_1, '2026-09-01', '2026-12-01')]
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2027-06', voci_future: 'elimina' })
    expect(res.status).toBe(200)
    expect(scrittureSu('pagamenti')).toEqual([])
    expect(idsVoci()).toEqual(TUTTE)
    expect(iscrizioni()[0].al).toBe('2027-06-01')
  })
})

describe('letture di sicurezza fallite: 500 e nulla cancellato', () => {
  it.each(['fatture_emesse', 'fatture_coda', 'solleciti'])('%s', async (tabella) => {
    scenario()
    h.errori = { [tabella]: { code: 'XX000' } }
    const res = await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SERVIZI_LETTURA_FALLITA')
    expect(h.scritture).toEqual([])
    expect(idsVoci()).toEqual(TUTTE)
    expect(iscrizioni().find((r) => r.id === ISCR_1)).toMatchObject({ al: null })
  })
})

describe('voci di un\'altra sede con lo STESSO alunno e la stessa categoria', () => {
  it('mai proposte (né nei due elenchi) e mai cancellate', async () => {
    scenario()
    const j = await (await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-09' })).json()
    const viste = [...j.data.eliminabili, ...j.data.intoccabili].map((v: { id: string }) => v.id)
    expect(viste).not.toContain('p-altra-sede-stesso-alunno')
    expect((await patch({ id: ISCR_1, scuola_id: SEDE_A, al: '2026-09', voci_future: 'elimina' })).status).toBe(200)
    expect(idsVoci()).toContain('p-altra-sede-stesso-alunno')
  })
})
