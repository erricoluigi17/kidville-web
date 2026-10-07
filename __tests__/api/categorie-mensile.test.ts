import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_E2E } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// Causali di pagamento come SERVIZI MENSILI — `admin/settings/categorie`.
//
// `mensile` e `importo_mensile_default` passano da POST e PATCH; nel POST entrano
// nell'insert SOLO se il body li porta (il DB degli E2E non ha le colonne: un
// insert con chiavi sconosciute risponderebbe PGRST204). Gli errori del database
// con un significato (colonna assente, CHECK della retta, FK) hanno un codice.
// Lo scope di sede delle stesse route è provato in `settings-scope-sede.test.ts`.
// =============================================================================

const CAT_SISTEMA = '11111111-1111-4111-8111-111111111111'
const CAT_LIBERA = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  log: [] as unknown[][],
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
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }),
  }
})

import { POST, PATCH, DELETE } from '@/app/api/admin/settings/categorie/route'

const URL_CAT = '/api/admin/settings/categorie'
const corpo = (metodo: string, body: unknown) =>
  new NextRequest(`http://localhost${URL_CAT}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const elimina = (id: string) => new NextRequest(`http://localhost${URL_CAT}?id=${id}`, { method: 'DELETE' })

const ADMIN_TUTTE = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

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
    { utente_id: 'admin-1', scuola_id: SEDE_A },
    { utente_id: 'admin-1', scuola_id: SEDE_B },
  ],
  payment_categories: [
    { id: CAT_SISTEMA, scuola_id: null, nome: 'Retta', slug: 'retta', is_sistema: true, attivo: true, ordine: 1 },
    { id: CAT_LIBERA, scuola_id: null, nome: 'Pomeridiano', slug: 'pomeridiano', is_sistema: false, attivo: true, ordine: 2, mensile: false },
  ],
})

const categoria = (id: string): Riga | undefined => (h.db.payment_categories as Riga[]).find((c) => c.id === id)
const inserimenti = () => h.scritture.filter((s) => s.tabella === 'payment_categories' && s.operazione === 'insert')
const logHa = (livello: string, testo: string) =>
  h.log.some((c) => c[1] === livello && JSON.stringify(c).includes(testo))

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.log = []
  h.requireStaff.mockResolvedValue({ user: ADMIN_TUTTE })
})

describe('PATCH /api/admin/settings/categorie — servizio mensile', () => {
  it('mensile e importo predefinito sono accettati e SCRITTI', async () => {
    const res = await PATCH(corpo('PATCH', { id: CAT_LIBERA, mensile: true, importo_mensile_default: 85.5 }))
    expect(res.status).toBe(200)
    expect(categoria(CAT_LIBERA)).toMatchObject({ mensile: true, importo_mensile_default: 85.5 })
    const upd = h.scritture.find((s) => s.tabella === 'payment_categories' && s.operazione === 'update')
    expect(upd?.valori[0]).toEqual({ mensile: true, importo_mensile_default: 85.5 })
  })

  it('importo null (nessuna proposta) e zero sono ammessi', async () => {
    expect((await PATCH(corpo('PATCH', { id: CAT_LIBERA, importo_mensile_default: null }))).status).toBe(200)
    expect(categoria(CAT_LIBERA)?.importo_mensile_default).toBeNull()
    expect((await PATCH(corpo('PATCH', { id: CAT_LIBERA, importo_mensile_default: 0 }))).status).toBe(200)
  })

  it.each([
    ['negativo', -1],
    ['oltre il tetto', 100000],
    ['stringa', '85'],
  ])('importo %s: 400 e nessuna scrittura', async (_n, importo) => {
    const res = await PATCH(corpo('PATCH', { id: CAT_LIBERA, importo_mensile_default: importo }))
    expect(res.status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('mensile non booleano: 400', async () => {
    expect((await PATCH(corpo('PATCH', { id: CAT_LIBERA, mensile: 'si' }))).status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('la retta di sistema continua a rispondere 409 e non si tocca', async () => {
    const res = await PATCH(corpo('PATCH', { id: CAT_SISTEMA, mensile: true }))
    expect(res.status).toBe(409)
    expect(categoria(CAT_SISTEMA)?.mensile).toBeUndefined()
    expect(h.scritture).toEqual([])
  })

  it('successo: log info «categoria-aggiornata» con id e mensile, senza nome né importo', async () => {
    await PATCH(corpo('PATCH', { id: CAT_LIBERA, nome: 'Doposcuola', mensile: true, importo_mensile_default: 91.25 }))
    const riga = h.log.find((c) => c[1] === 'info' && JSON.stringify(c).includes('categoria-aggiornata'))
    expect(riga).toBeTruthy()
    const campi = riga![2] as Record<string, unknown>
    expect(campi).toMatchObject({ categoria_id: CAT_LIBERA, mensile: true })
    expect(JSON.stringify(campi)).not.toMatch(/Doposcuola|91\.25/)
  })

  it('colonna assente (PGRST204): 503 SERVIZI_NON_DISPONIBILI e log error', async () => {
    h.errori = { 'payment_categories:update': { code: 'PGRST204', message: "Could not find the 'mensile' column" } }
    const res = await PATCH(corpo('PATCH', { id: CAT_LIBERA, mensile: true }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SERVIZI_NON_DISPONIBILI')
    expect(logHa('error', 'servizi-non-disponibili')).toBe(true)
    expect(logHa('info', 'categoria-aggiornata')).toBe(false)
  })

  it('CHECK della retta (23514): 409 CATEGORIA_RETTA_NON_MENSILE', async () => {
    h.errori = { 'payment_categories:update': { code: '23514', message: 'violates check constraint' } }
    const res = await PATCH(corpo('PATCH', { id: CAT_LIBERA, mensile: true }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CATEGORIA_RETTA_NON_MENSILE')
  })

  it('altro errore del database: 500 come prima, e loggato', async () => {
    h.errori = { 'payment_categories:update': { code: 'XX000', message: 'guasto' } }
    const res = await PATCH(corpo('PATCH', { id: CAT_LIBERA, mensile: true }))
    expect(res.status).toBe(500)
    expect(h.log.some((c) => (c[0] as Record<string, unknown>)?.operazione === 'admin/settings/categorie:PATCH' && (c[0] as Record<string, unknown>)?.stato === 500)).toBe(true)
  })
})

describe('POST /api/admin/settings/categorie — servizio mensile', () => {
  it('SENZA le chiavi nuove l\'insert non le contiene (DB non migrato)', async () => {
    const res = await POST(corpo('POST', { nome: 'Gita', scuola_id: SEDE_A }))
    expect(res.status).toBe(201)
    const ins = inserimenti()
    expect(ins).toHaveLength(1)
    expect(Object.keys(ins[0].valori[0])).not.toContain('mensile')
    expect(Object.keys(ins[0].valori[0])).not.toContain('importo_mensile_default')
    expect(ins[0].valori[0]).toMatchObject({ nome: 'Gita', scuola_id: SEDE_A, is_sistema: false })
  })

  it('CON le chiavi nuove l\'insert le include (false e null compresi)', async () => {
    const res = await POST(corpo('POST', { nome: 'Pulmino', scuola_id: SEDE_A, mensile: true, importo_mensile_default: 40 }))
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ mensile: true, importo_mensile_default: 40 })
    await POST(corpo('POST', { nome: 'Altro', scuola_id: SEDE_A, mensile: false, importo_mensile_default: null }))
    const v = inserimenti()[1].valori[0]
    expect(v.mensile).toBe(false)
    expect(v.importo_mensile_default).toBeNull()
  })

  it('importo negativo: 400, nessun insert', async () => {
    const res = await POST(corpo('POST', { nome: 'Pulmino', scuola_id: SEDE_A, mensile: true, importo_mensile_default: -5 }))
    expect(res.status).toBe(400)
    expect(inserimenti()).toEqual([])
  })

  it('colonna assente (PGRST204): 503 SERVIZI_NON_DISPONIBILI', async () => {
    h.errori = { 'payment_categories:insert': { code: 'PGRST204', message: "Could not find the 'mensile' column" } }
    const res = await POST(corpo('POST', { nome: 'Pulmino', scuola_id: SEDE_A, mensile: true }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SERVIZI_NON_DISPONIBILI')
    expect(logHa('error', 'servizi-non-disponibili')).toBe(true)
  })
})

describe('DELETE /api/admin/settings/categorie — categoria in uso', () => {
  it('FK (23503): 409 CATEGORIA_IN_USO, la riga resta', async () => {
    h.errori = { 'payment_categories:delete': { code: '23503', message: 'violates foreign key constraint' } }
    const res = await DELETE(elimina(CAT_LIBERA))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CATEGORIA_IN_USO')
    expect(categoria(CAT_LIBERA)).toBeTruthy()
  })

  it('senza vincoli: eliminata (200)', async () => {
    const res = await DELETE(elimina(CAT_LIBERA))
    expect(res.status).toBe(200)
    expect(categoria(CAT_LIBERA)).toBeUndefined()
  })

  it('altro errore: 500 come prima', async () => {
    h.errori = { 'payment_categories:delete': { code: 'XX000', message: 'guasto' } }
    expect((await DELETE(elimina(CAT_LIBERA))).status).toBe(500)
  })

  it('la categoria di sistema resta 409 (senza codice di uso)', async () => {
    const res = await DELETE(elimina(CAT_SISTEMA))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBeUndefined()
  })
})
