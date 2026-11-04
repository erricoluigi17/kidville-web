import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

/**
 * Le materie di una docente in una classe (`utenti_sezioni_materie`).
 *
 * Il modulo NON è mockato altrove: qui si danno righe alla tabella e si guarda cosa esce. Il
 * punto che conta è che il controllo sia sulla COPPIA (classe, materia) e che un guasto del
 * database dia 500 e mai 403.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import {
  assertMateriaDelDocente,
  materieVisibili,
  rispostaMateriaNonAssegnata,
} from '@/lib/auth/materie-docente'

// Tutti uuid finti: il repo è pubblico.
const MAESTRA_ID = '00000000-0000-4000-8000-0000000000a1'
const ALTRA_ID = '00000000-0000-4000-8000-0000000000a2'
const SEZ_A = '00000000-0000-4000-8000-0000000000b1'
const SEZ_B = '00000000-0000-4000-8000-0000000000b2'
const MAT_ITA_A = '00000000-0000-4000-8000-0000000000c1'
const MAT_MAT_B = '00000000-0000-4000-8000-0000000000c2'
const MAT_ALTRA = '00000000-0000-4000-8000-0000000000c3'

const maestra: AppUser = { id: MAESTRA_ID, role: 'educator' }

function dbBase(): DBFinto {
  return {
    utenti_sezioni_materie: [
      { utente_id: MAESTRA_ID, section_id: SEZ_A, materia_id: MAT_ITA_A },
      { utente_id: MAESTRA_ID, section_id: SEZ_B, materia_id: MAT_MAT_B },
      // Un'altra docente: le sue righe non devono mai finire nell'elenco della maestra.
      { utente_id: ALTRA_ID, section_id: SEZ_A, materia_id: MAT_ALTRA },
    ],
  }
}

function client(
  db: DBFinto = dbBase(),
  tabelle: string[] = [],
  errori?: Record<string, { code: string }>,
): SupabaseClient {
  return creaFintoSupabase(db, tabelle, errori ? { errori } : {}) as unknown as SupabaseClient
}

beforeEach(() => {
  log.logEvento.mockClear()
})

describe('materieVisibili', () => {
  it.each(['admin', 'coordinator', 'segreteria'] as const)(
    '%s vede tutte le materie senza letture',
    async (role) => {
      const tabelle: string[] = []
      const r = await materieVisibili(client(dbBase(), tabelle), { id: 'staff', role }, SEZ_A)
      expect(r).toEqual({ ok: true, tutte: true })
      expect(tabelle).not.toContain('utenti_sezioni_materie')
    },
  )

  it('i ruoli veri contano: educator che è anche segreteria vede tutto', async () => {
    const tabelle: string[] = []
    const doppia: AppUser = { id: MAESTRA_ID, role: 'educator', ruoli: ['educator', 'segreteria'] }
    const r = await materieVisibili(client(dbBase(), tabelle), doppia, SEZ_A)
    expect(r).toEqual({ ok: true, tutte: true })
    expect(tabelle).not.toContain('utenti_sezioni_materie')
  })

  it('educator: solo le sue materie, per classe o in tutte', async () => {
    const c = client()
    const inA = await materieVisibili(c, maestra, SEZ_A)
    expect(inA).toEqual({ ok: true, tutte: false, materie: new Set([MAT_ITA_A]) })

    const ovunque = await materieVisibili(c, maestra)
    expect(ovunque).toEqual({ ok: true, tutte: false, materie: new Set([MAT_ITA_A, MAT_MAT_B]) })

    const nullo = await materieVisibili(c, maestra, null)
    expect(nullo).toEqual({ ok: true, tutte: false, materie: new Set([MAT_ITA_A, MAT_MAT_B]) })
  })

  it('una docente senza assegnazioni ha un insieme vuoto, non «tutte»', async () => {
    const r = await materieVisibili(client({ utenti_sezioni_materie: [] }), maestra, SEZ_A)
    expect(r).toEqual({ ok: true, tutte: false, materie: new Set() })
  })

  it('guasto: 500 LETTURA_FALLITA, mai un insieme vuoto che diventerebbe 403', async () => {
    const c = client(dbBase(), [], { 'utenti_sezioni_materie:select': { code: 'XX000' } })
    const r = await materieVisibili(c, maestra, SEZ_A)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(500)
    expect(await r.response.json()).toEqual({
      error: 'Verifica delle materie non riuscita. Riprova.',
      codice: 'LETTURA_FALLITA',
    })
    expect(log.logEvento).toHaveBeenCalledWith(
      'auth',
      'error',
      expect.objectContaining({ operazione: 'auth/materie-docente', esito: 'materie-docente-non-lette' }),
      expect.anything(),
    )
  })
})

describe('assertMateriaDelDocente', () => {
  it('la stessa docente in due classi: conta la coppia classe-materia', async () => {
    const c = client()
    expect(await assertMateriaDelDocente(c, maestra, SEZ_A, MAT_ITA_A)).toBeNull()
    expect(await assertMateriaDelDocente(c, maestra, SEZ_B, MAT_MAT_B)).toBeNull()
    const r = await assertMateriaDelDocente(c, maestra, SEZ_B, MAT_ITA_A)
    expect(r?.status).toBe(403)
    expect(await r?.json()).toEqual({
      error: 'Questa materia non ti è assegnata in questa classe.',
      codice: 'MATERIA_NON_ASSEGNATA',
    })
    expect((await assertMateriaDelDocente(c, maestra, SEZ_A, MAT_MAT_B))?.status).toBe(403)
  })

  it('la materia di un’altra docente nella stessa classe è rifiutata', async () => {
    const r = await assertMateriaDelDocente(client(), maestra, SEZ_A, MAT_ALTRA)
    expect(r?.status).toBe(403)
  })

  it('una classe vuota non diventa «tutte le classi»: la coppia non è una coppia, si nega', async () => {
    // Italiano è assegnata alla maestra in SEZ_A: senza la guardia,`''` leggerebbe tutte
    // le sue classi e la materia risulterebbe sua.
    const r = await assertMateriaDelDocente(client(), maestra, '', MAT_ITA_A)
    expect(r?.status).toBe(403)
  })

  it('lo staff passa senza letture', async () => {
    const tabelle: string[] = []
    const r = await assertMateriaDelDocente(
      client(dbBase(), tabelle),
      { id: 'staff', role: 'segreteria' },
      SEZ_B,
      MAT_ITA_A,
    )
    expect(r).toBeNull()
    expect(tabelle).not.toContain('utenti_sezioni_materie')
  })

  it('il rifiuto si logga col codice, senza nomi', async () => {
    await assertMateriaDelDocente(client(), maestra, SEZ_B, MAT_ITA_A)
    expect(log.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({
        operazione: 'auth/materie-docente',
        esito: 'materia-non-assegnata',
        section_id: SEZ_B,
        materia_id: MAT_ITA_A,
        error_code: 'MATERIA_NON_ASSEGNATA',
      }),
    )
  })

  it.each([null, undefined])('materia %s: null senza letture', async (materiaId) => {
    const tabelle: string[] = []
    const r = await assertMateriaDelDocente(client(dbBase(), tabelle), maestra, SEZ_A, materiaId)
    expect(r).toBeNull()
    expect(tabelle).not.toContain('utenti_sezioni_materie')
    expect(log.logEvento).not.toHaveBeenCalled()
  })

  it('guasto: 500 LETTURA_FALLITA, mai 403', async () => {
    const c = client(dbBase(), [], { 'utenti_sezioni_materie:select': { code: 'XX000' } })
    const r = await assertMateriaDelDocente(c, maestra, SEZ_A, MAT_ITA_A)
    expect(r?.status).toBe(500)
    expect(await r?.json()).toEqual({
      error: 'Verifica delle materie non riuscita. Riprova.',
      codice: 'LETTURA_FALLITA',
    })
    expect(log.logEvento).toHaveBeenCalledWith(
      'auth',
      'error',
      expect.objectContaining({ operazione: 'auth/materie-docente', esito: 'materie-docente-non-lette' }),
      expect.anything(),
    )
    // Il guasto non è un rifiuto: nessun log «materia-non-assegnata».
    expect(log.logEvento).not.toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ error_code: 'MATERIA_NON_ASSEGNATA' }),
    )
  })
})

describe('rispostaMateriaNonAssegnata', () => {
  it('è un 403 col codice stabile', async () => {
    const r = rispostaMateriaNonAssegnata()
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({
      error: 'Questa materia non ti è assegnata in questa classe.',
      codice: 'MATERIA_NON_ASSEGNATA',
    })
  })
})
