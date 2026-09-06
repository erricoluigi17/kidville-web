import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `PUT /api/mensa/menu` — LA CHIAVE DI CONFLITTO È UNA SOLA, E PORTA SEMPRE `menu_config_id`.
 *
 * Il 2026-09-05 la segreteria di Cesa ha provato 9 volte a salvare la rotazione e ha preso 9
 * volte `42P10` («there is no unique or exclusion constraint matching the ON CONFLICT
 * specification»): la route sceglieva la chiave a runtime — con `menu_config_id`, senza —
 * e in produzione ENTRAMBE erano coperte solo da indici PARZIALI, che `ON CONFLICT (colonne)`
 * non sa inferire perché PostgREST non può mandare il `WHERE`.
 *
 * Questo test guarda solo ciò che la route MANDA: coi mock il database dice sempre di sì.
 * Che il database ACCETTI quella chiave lo prova il lock
 * `__tests__/architecture/onconflict-arbitro.test.ts`. Servono tutti e due.
 */

/**
 * ⚠️ SEDE E MENU SONO FINTI, e non è una formalità: il piano di correzione portava
 * qui l'uuid REALE di Kidville Cesa e quello di una configurazione menu di
 * produzione, presi dall'indagine sul difetto. Il lock
 * `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts` li rifiuta —
 * il repository è pubblico, e un uuid vero copiato da un test finisce prima o poi
 * in uno script che scrive sul database delle famiglie. La sede viene da
 * `__tests__/fixtures/sedi.ts`, il menu ha la forma dei suoi vicini in
 * `mensa-config-scope-sede.test.ts`.
 */
const CFG_MENU = 'c0c0c0c0-0000-4000-8000-cccccccccccc'

/**
 * La firma è dichiarata perché il test asserisce sul SECONDO argomento
 * (`upsert.mock.calls[0][1]`): con una `vi.fn()` nuda quella tupla è vuota e
 * l'asserzione non compilerebbe. L'esito è tipizzato largo per poter iniettare
 * l'errore `42P10` con `mockResolvedValueOnce`.
 */
type EsitoUpsert = { error: { code?: string; message?: string } | null }
type Upsert = (righe: unknown[], opzioni: { onConflict: string }) => Promise<EsitoUpsert>

const upsert = vi.fn<Upsert>(() => Promise.resolve({ error: null }))
const from = vi.fn(() => ({ upsert }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from }),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: { id: 'u1', ruolo: 'segreteria' } }),
  requireUser: async () => ({ user: { id: 'u1', ruolo: 'segreteria' } }),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE_A }),
  scuoleDiUtente: async () => [SEDE_A],
}))

import { PUT } from '@/app/api/mensa/menu/route'
import { CHIAVE_ROTAZIONE, CHIAVE_OVERRIDE } from '@/lib/mensa/chiave-menu'

const put = (body: unknown) =>
  new NextRequest('http://localhost/api/mensa/menu', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify(body),
  })

describe('PUT /api/mensa/menu — una sola chiave di conflitto', () => {
  beforeEach(() => { upsert.mockClear(); from.mockClear() })

  it('col menu unico (menu_config_id null) manda comunque la chiave con menu_config_id', async () => {
    const res = await PUT(put({
      scuola_id: SEDE_A,
      menu_config_id: null,
      rotazione: [{ settimana: 1, giorno_settimana: 1, portate: {} }],
    }))
    expect(res.status).toBe(200)
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: CHIAVE_ROTAZIONE })
  })

  it('con un menu selezionato manda la STESSA chiave', async () => {
    await PUT(put({
      scuola_id: SEDE_A,
      menu_config_id: CFG_MENU,
      rotazione: [{ settimana: 1, giorno_settimana: 1, portate: {} }],
    }))
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: CHIAVE_ROTAZIONE })
  })

  it('anche le variazioni hanno una chiave sola, con menu_config_id', async () => {
    await PUT(put({
      scuola_id: SEDE_A,
      menu_config_id: null,
      override: [{ data: '2026-09-10', chiuso: false, portate: {} }],
    }))
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: CHIAVE_OVERRIDE })
  })

  it('le due chiavi contengono menu_config_id (se cade, il ramo legacy è tornato)', () => {
    expect(CHIAVE_ROTAZIONE.split(',')).toContain('menu_config_id')
    expect(CHIAVE_OVERRIDE.split(',')).toContain('menu_config_id')
  })

  it('42P10 non esce a schermo come prosa di PostgREST', async () => {
    upsert.mockResolvedValueOnce({
      error: { code: '42P10', message: 'there is no unique or exclusion constraint matching…' },
    })
    const res = await PUT(put({
      scuola_id: SEDE_A,
      menu_config_id: null,
      rotazione: [{ settimana: 1, giorno_settimana: 1, portate: {} }],
    }))
    const j = await res.json()
    expect(res.status).toBe(500)
    expect(j.codice).toBe('MENU_NON_SALVATO')
    expect(j.error).not.toMatch(/ON CONFLICT/i)
  })
})
