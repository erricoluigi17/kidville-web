import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// LA SEDE DI UNA CLASSE: `sections.scuola_id`, la stessa con cui la PATCH e il ricalcolo SQL cercano i quadrimestri.
// =============================================================================

const h = vi.hoisted(() => ({ logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

import { scuolaDiSezione } from '@/lib/primaria/sede-classe'

const SEZ_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const SEZ_SENZA_SEDE = 'cccc3333-0000-4000-8000-0000000000c3'
const SEZ_INESISTENTE = 'dddd4444-0000-4000-8000-0000000000d4'

let db: DBFinto
let tabelle: string[]
let opzioni: OpzioniFinto

beforeEach(() => {
  h.logErrore.mockReset()
  tabelle = []
  opzioni = {}
  db = {
    sections: [
      { id: SEZ_A, scuola_id: SEDE_A },
      { id: SEZ_B, scuola_id: SEDE_B },
      { id: SEZ_SENZA_SEDE, scuola_id: null },
    ],
  }
})

const client = () => creaFintoSupabase(db, tabelle, opzioni)

describe('scuolaDiSezione', () => {
  it('la sede della classe chiesta, e di nessun’altra', async () => {
    expect(await scuolaDiSezione(client(), SEZ_A, 'prova')).toBe(SEDE_A)
    expect(await scuolaDiSezione(client(), SEZ_B, 'prova')).toBe(SEDE_B)
  })

  it('una classe senza sede, o che non esiste: null (non è un guasto)', async () => {
    expect(await scuolaDiSezione(client(), SEZ_SENZA_SEDE, 'prova')).toBeNull()
    expect(await scuolaDiSezione(client(), SEZ_INESISTENTE, 'prova')).toBeNull()
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('una lettura fallita: undefined, e il guasto è loggato a livello error con l’operazione', async () => {
    opzioni = { errori: { 'sections:select': { code: '57014', message: 'timeout' } } }
    expect(await scuolaDiSezione(client(), SEZ_A, 'primaria/valutazioni:POST')).toBeUndefined()
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'primaria/valutazioni:POST', stato: 500 }),
      expect.objectContaining({ code: '57014' }),
    )
  })
})
