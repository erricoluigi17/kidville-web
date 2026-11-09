import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * PR 4.5.8 · `GET /api/admin/sections?anno_id=…`: le classi proposte per una domanda sono quelle dell'anno DELLA domanda.
 * Il parametro è solo opzionale: senza, la route è quella di prima (l'anno attivo, o quello scelto col cookie) — lo provano
 * le suite `admin-sections-anno` e `sections-*`, non toccate. Il database è il finto che applica i filtri.
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/auth/require-staff')>()),
  requireStaff: async () => ({ user: { id: SEG, role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE_A } }),
}))
vi.mock('@/lib/auth/scope', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE_A],
  scuoleDiUtente: async () => [SEDE_A],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    creaFintoSupabase(h.db as DBFinto, [], {
      errori: h.errori,
      rpc: { anno_attivo: () => ({ data: S2A, error: null }) },
    }),
}))

import { GET } from '@/app/api/admin/sections/route'

const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente (2026/27)
const A3 = 'a3333333-3333-4333-8333-333333333333' // iscrizioni aperte (2027/28)
const A9 = 'a9999999-9999-4999-8999-999999999999' // un anno che la sede non ha
const S2A = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3A = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const SEG = '20000000-0000-4000-8000-000000000001'
const SEZ_OGGI = 'c1000000-0000-4000-8000-000000000001'
const SEZ_PROSSIMO = 'c1000000-0000-4000-8000-000000000002'
const SEZ_ALTRA_SEDE = 'c1000000-0000-4000-8000-000000000003'

const richiesta = (query = '') => new NextRequest(`http://localhost/api/admin/sections${query}`)
const idsDi = async (res: Response): Promise<string[]> =>
  ((await res.json()) as { id: string }[]).map((s) => s.id).sort()

beforeEach(() => {
  h.errori = {}
  h.db = {
    sections: [
      { id: SEZ_OGGI, name: '3 ANNI', scuola_id: SEDE_A, anno_id: A2 },
      { id: SEZ_PROSSIMO, name: '3 ANNI', scuola_id: SEDE_A, anno_id: A3 },
      { id: SEZ_ALTRA_SEDE, name: '3 ANNI', scuola_id: SEDE_B, anno_id: A3 },
    ] as Riga[],
    anni_sede: [
      { id: S2A, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
      { id: S3A, scuola_id: SEDE_A, anno_id: A3, stato: 'iscrizioni_aperte', domande_aperte: true },
    ] as Riga[],
  }
})

describe('GET /api/admin/sections · anno_id', () => {
  it('senza il parametro: solo l’anno attivo, come prima', async () => {
    expect(await idsDi(await GET(richiesta()))).toEqual([SEZ_OGGI])
  })

  it('con anno_id: le sezioni di QUELL’anno, nei soli plessi dello scope di chi chiede', async () => {
    const res = await GET(richiesta(`?anno_id=${A3}`))
    expect(res.status).toBe(200)
    expect(await idsDi(res)).toEqual([SEZ_PROSSIMO])
  })

  it('un anno che nessuna sede ha: elenco vuoto, non l’elenco di tutti gli anni', async () => {
    expect(await idsDi(await GET(richiesta(`?anno_id=${A9}`)))).toEqual([])
  })

  it('database senza lo schema dell’anno (la CI): nessun filtro, come prima', async () => {
    h.errori = { anni_sede: { code: 'PGRST205', message: 'tabella assente' } }
    expect((await idsDi(await GET(richiesta(`?anno_id=${A3}`)))).length).toBeGreaterThan(0)
  })

  it('anno_id non è un uuid: 400', async () => {
    expect((await GET(richiesta('?anno_id=non-un-uuid'))).status).toBe(400)
  })
})
