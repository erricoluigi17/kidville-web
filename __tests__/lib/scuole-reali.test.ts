// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  SEDE_A,
  SEDE_B,
  SEDE_C,
  NOME_SEDE_A,
  NOME_SEDE_B,
  NOME_SEDE_C,
  SEDE_E2E,
} from '../fixtures/sedi'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isScuolaE2E, sediReali } from '@/lib/scuole/reali'

/**
 * Il predicato "scuola reale" era inline in `POST /api/iscrizione`. Da qui in poi
 * lo condivide anche `GET /api/iscrizione/sedi`: se i due divergessero, il wizard
 * mostrerebbe una sede che il POST rifiuta (o viceversa). Questi test sono il
 * contratto che tiene insieme i due punti.
 */

type Risultato = { data: unknown; error: unknown }

/**
 * Finto client PostgREST: i builder sono "thenable", così `await supabase.from(…)`
 * risolve nel risultato preparato senza dipendere dall'ordine dei metodi.
 * Registra anche le colonne richieste: la route pubblica NON deve leggere altro
 * che id e nome (nessun indirizzo, nessuna config).
 */
function fakeSupabase(opts: {
  schools?: Risultato
  scuole?: Risultato
  lanciaSu?: 'schools' | 'scuole'
  select?: string[]
}): SupabaseClient {
  return {
    from(table: string) {
      if (opts.lanciaSu === table) throw new Error(`boom su ${table}`)
      const risultato: Risultato =
        table === 'schools'
          ? (opts.schools ?? { data: [], error: null })
          : (opts.scuole ?? { data: [], error: null })
      const b: Record<string, unknown> = {}
      b.select = (cols: string) => {
        opts.select?.push(`${table}:${cols}`)
        return b
      }
      b.order = () => b
      b.in = () => b
      b.then = (res: (v: Risultato) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(risultato).then(res, rej)
      return b
    },
  } as unknown as SupabaseClient
}

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }
const E2E_ID = { id: SEDE_E2E, nome: 'Scuola di prova' }
const E2E_NOME = { id: '33333333-3333-4333-8333-333333333333', nome: 'Kidville E2E' }

describe('isScuolaE2E — predicato "scuola di test"', () => {
  it('riconosce la sede E2E dall\'id (prefisso e2e00000)', () => {
    expect(isScuolaE2E(E2E_ID)).toBe(true)
  })

  it('riconosce la sede E2E dal nome (case-insensitive)', () => {
    expect(isScuolaE2E(E2E_NOME)).toBe(true)
    expect(isScuolaE2E({ id: ALFA.id, nome: 'kidville e2e' })).toBe(true)
  })

  it('una sede reale non è E2E', () => {
    expect(isScuolaE2E(GAMMA)).toBe(false)
    expect(isScuolaE2E(ALFA)).toBe(false)
    expect(isScuolaE2E(BETA)).toBe(false)
  })

  it('non esplode se il nome è nullo (colonna nullable in DB)', () => {
    expect(isScuolaE2E({ id: ALFA.id, nome: null as unknown as string })).toBe(false)
  })
})

describe('sediReali — sedi reali e attive', () => {
  it('esclude la sede E2E dalle reali ma la lascia in `tutte`', async () => {
    const s = await sediReali(fakeSupabase({ schools: { data: [GAMMA, E2E_ID], error: null } }), 'test')
    expect(s.reali.map((x) => x.id)).toEqual([GAMMA.id])
    expect(s.tutte.map((x) => x.id)).toEqual([GAMMA.id, E2E_ID.id])
    expect(s.error).toBeNull()
  })

  it('scarta le sedi disattivate (scuole.attiva = false)', async () => {
    const s = await sediReali(
      fakeSupabase({
        schools: { data: [GAMMA, ALFA, BETA], error: null },
        scuole: { data: [{ id: BETA.id, attiva: false }], error: null },
      }),
      'test',
    )
    expect(s.reali.map((x) => x.id)).toEqual([GAMMA.id, ALFA.id])
    // `tutte` NON è filtrata: serve solo a validare uno scuola_id esplicito.
    expect(s.tutte).toHaveLength(3)
  })

  it('FAIL-OPEN: se la lettura del flag `attiva` fallisce, non filtra nulla', async () => {
    const s = await sediReali(
      fakeSupabase({
        schools: { data: [GAMMA, ALFA], error: null },
        scuole: { data: null, error: { code: '42703', message: 'column "attiva" does not exist' } },
      }),
      'test',
    )
    expect(s.reali.map((x) => x.id)).toEqual([GAMMA.id, ALFA.id])
    expect(s.error).toBeNull() // il degrado non è un errore della richiesta
  })

  it('errore sulla lettura di `schools` → liste vuote e `error` valorizzato', async () => {
    const s = await sediReali(
      fakeSupabase({ schools: { data: null, error: { code: '42P01', message: 'relation "schools" does not exist' } } }),
      'test',
    )
    expect(s.reali).toEqual([])
    expect(s.tutte).toEqual([])
    expect(s.error?.message).toContain('schools')
  })

  it('un throw del client non propaga: liste vuote e `error` valorizzato', async () => {
    const s = await sediReali(fakeSupabase({ lanciaSu: 'schools' }), 'test')
    expect(s.reali).toEqual([])
    expect(s.error).not.toBeNull()
  })

  it('legge SOLO id e nome da schools (nessun indirizzo, nessuna config)', async () => {
    const select: string[] = []
    await sediReali(fakeSupabase({ schools: { data: [GAMMA], error: null }, select }), 'test')
    expect(select).toContain('schools:id, nome')
    expect(select.join('|')).not.toMatch(/indirizzo|citta|config/)
  })

  it('nessuna sede reale (solo E2E, come sul DB della CI) → reali vuoto, nessun errore', async () => {
    const s = await sediReali(fakeSupabase({ schools: { data: [E2E_NOME], error: null } }), 'test')
    expect(s.reali).toEqual([])
    expect(s.error).toBeNull()
  })
})
