import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B, SEDE_E2E, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// `degradoSedeLecito` — il guardiano scritto apposta per NON fare fail-open.
//
// La regola: si prosegue senza il filtro di sede SOLO se non c'è niente da
// isolare (al più UNA sede reale). Il rilievo dell'audit 2026-07-31: la funzione
// destrutturava `const { reali } = await sediReali(...)` e buttava via `error`.
// `sediReali` ritorna `{ tutte: [], reali: [], error }` anche quando la lettura
// di `schools` FALLISCE, e `0 <= 1` è vero: un guasto di lettura veniva quindi
// dichiarato «degrado lecito» e quattro route di modulistica rileggevano senza
// alcun filtro di sede. Non sapere quante sedi ci sono deve significare «nego».
// =============================================================================

const { degradoSedeLecito, colonnaSedeAssente } = await import('@/lib/forms/degrado-sede')

const dbConSedi = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('colonnaSedeAssente', () => {
  it('riconosce i due codici PostgREST di colonna mancante', () => {
    expect(colonnaSedeAssente({ code: 'PGRST204' })).toBe(true)
    expect(colonnaSedeAssente({ code: '42703' })).toBe(true)
    expect(colonnaSedeAssente({ code: '23505' })).toBe(false)
    expect(colonnaSedeAssente(null)).toBe(false)
  })
})

describe('degradoSedeLecito', () => {
  it('due sedi reali: il degrado NON è lecito', async () => {
    const sb = creaFintoSupabase(dbConSedi()) as SupabaseClient
    expect(await degradoSedeLecito(sb, 'test:GET')).toBe(false)
  })

  it('una sola sede reale (il DB E2E): il degrado è lecito', async () => {
    const db: DBFinto = {
      schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_E2E, nome: NOME_SEDE_E2E }],
      scuole: [{ id: SEDE_A, attiva: true }],
    }
    const sb = creaFintoSupabase(db) as SupabaseClient
    expect(await degradoSedeLecito(sb, 'test:GET')).toBe(true)
  })

  it('`schools` illeggibile: NEGA — «non so quante sedi ci sono» non è «non ce ne sono»', async () => {
    const sb = creaFintoSupabase(dbConSedi(), [], {
      errori: { schools: { code: '42P01', message: 'relation "schools" does not exist' } },
    }) as SupabaseClient
    expect(await degradoSedeLecito(sb, 'test:GET')).toBe(false)
  })
})
