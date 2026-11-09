// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  CAT_RETTA, CAT_SERVIZIO, creaBancoRette, errore as erroreSu, inRollback, righe as righeSu, SEDE_A, una as unaSu, type MappaAnni,
} from '../helpers/banco-rette-pglite'

/**
 * COMPITO 4.6.2 · M46b · LA SEGRETERIA SCRIVE LA RETTA DEL LISTINO, in PGlite vero.
 * `anno_listino_retta_imposta(anno_sede, voce, fascia, categoria, importo, mesi)`. Solo uuid finti.
 */

let db: PGlite
let anni: MappaAnni
const prova = (nome: string, fn: () => Promise<void>) => it(nome, () => inRollback(db, fn), 30_000)
const righe = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => righeSu<T>(db, sql, params)
const errore = (sql: string, params: unknown[] = []) => erroreSu(db, sql, params)
const una = <T = string>(sql: string, params: unknown[] = []) => unaSu<T>(db, sql, params)

beforeAll(async () => {
  ;({ db, anni } = await creaBancoRette({ fino: 'M46b' }))
}, 120_000)
afterAll(async () => {
  await db?.close()
})

const A26 = () => anni[`${SEDE_A}:2026`]
const A27 = () => anni[`${SEDE_A}:2027`]
const CHIAMA = `SELECT public.anno_listino_retta_imposta($1::uuid, $2, $3, $4::uuid, $5::numeric, $6::smallint[]) AS r`

async function imposta(anno: string, voce: string, fascia: string | null, importo: number | null, mesi: number[] | null = null, categoria: string | null = null) {
  const r = await righe<{ r: { cambiato: boolean; voce: string; fascia: string | null; importo: number | null } }>(CHIAMA, [anno, voce, fascia, categoria, importo, mesi])
  return r[0].r
}
async function righeListino() {
  return righe<{ voce: string; fascia: string | null; importo: string | null; mesi: number[] | null; payment_category_id: string }>(
    `SELECT voce, fascia, importo::text, mesi, payment_category_id FROM public.listino_voci WHERE anno_sede_id = $1 ORDER BY voce, fascia NULLS FIRST`, [A27()])
}

describe('anno_listino_retta_imposta', () => {
  prova('scrive la retta senza fascia con la categoria di sistema e la rilegge uguale', async () => {
    const r = await imposta(A27(), 'retta', null, 312.5)
    expect(r).toMatchObject({ cambiato: true, voce: 'retta', fascia: null, importo: 312.5 })
    expect(await righeListino()).toEqual([{ voce: 'retta', fascia: null, importo: '312.50', mesi: null, payment_category_id: CAT_RETTA }])
  })

  prova('importo 0, negativo o che arrotonda a zero → IMPORTO_NON_VALIDO', async () => {
    for (const x of [0, -5, 0.004]) {
      expect(await errore(CHIAMA, [A27(), 'retta', null, null, x, null]), String(x)).toBe('IMPORTO_NON_VALIDO')
    }
    expect(await righeListino()).toEqual([])
  })

  prova('un anno chiuso (o in chiusura) → ANNO_NON_MODIFICABILE; corrente e in preparazione sì', async () => {
    expect(await errore(CHIAMA, [anni[`${SEDE_A}:2025`], 'retta', null, null, 200, null])).toBe('ANNO_NON_MODIFICABILE')
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [A26()])
    expect(await errore(CHIAMA, [A26(), 'retta', null, null, 200, null])).toBe('ANNO_NON_MODIFICABILE')
    await db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [A26()])
    expect(await errore(CHIAMA, [A26(), 'retta', null, null, 200, null])).toBeNull()
    expect(await errore(CHIAMA, [A27(), 'retta', null, null, 200, null])).toBeNull()
  })

  prova('un anno che non c’è → ANNO_NON_TROVATO; voce o fascia sconosciute → PARAMETRO_MANCANTE', async () => {
    expect(await errore(CHIAMA, ['99999999-9999-4999-8999-999999999999', 'retta', null, null, 200, null])).toBe('ANNO_NON_TROVATO')
    expect(await errore(CHIAMA, [A27(), 'quota_nuova', null, null, 200, null])).toBe('PARAMETRO_MANCANTE')
    expect(await errore(CHIAMA, [A27(), 'retta', 'liceo', null, 200, null])).toBe('PARAMETRO_MANCANTE')
  })

  prova('i mesi: solo sulla riga senza fascia, dentro 1..12, non vuoti', async () => {
    expect(await errore(CHIAMA, [A27(), 'retta', 'infanzia', null, 200, '{9,10}'])).toBe('PARAMETRO_MANCANTE')
    expect(await errore(CHIAMA, [A27(), 'retta', null, null, 200, '{9,13}'])).toBe('PARAMETRO_MANCANTE')
    expect(await errore(CHIAMA, [A27(), 'retta', null, null, 200, '{0}'])).toBe('PARAMETRO_MANCANTE')
    expect(await errore(CHIAMA, [A27(), 'retta', null, null, 200, '{}'])).toBe('PARAMETRO_MANCANTE')
    expect(await righeListino()).toEqual([])
    await imposta(A27(), 'retta', null, 200, [11, 9, 10, 9])
    expect((await righeListino())[0].mesi).toEqual([9, 10, 11])
  })

  prova('mesi NULL non tocca i mesi già scritti', async () => {
    await imposta(A27(), 'retta', null, 200, [9, 10])
    const r = await imposta(A27(), 'retta', null, 220, null)
    expect(r.cambiato).toBe(true)
    expect(await righeListino()).toEqual([expect.objectContaining({ importo: '220.00', mesi: [9, 10] })])
  })

  prova('importo NULL toglie la riga e cambiato = true; rifatto, false', async () => {
    await imposta(A27(), 'retta', 'infanzia', 280)
    expect((await imposta(A27(), 'retta', 'infanzia', null)).cambiato).toBe(true)
    expect((await imposta(A27(), 'retta', 'infanzia', null)).cambiato).toBe(false)
    expect(await righeListino()).toEqual([])
  })

  prova('la stessa chiamata due volte non crea due righe e la seconda non cambia niente', async () => {
    expect((await imposta(A27(), 'retta', null, 250, [9, 10, 11])).cambiato).toBe(true)
    expect((await imposta(A27(), 'retta', null, 250, [9, 10, 11])).cambiato).toBe(false)
    expect(await righeListino()).toHaveLength(1)
  })

  prova('una riga per fascia usa la categoria della riga senza fascia; un servizio vuole la sua categoria', async () => {
    await imposta(A27(), 'retta', null, 250)
    await imposta(A27(), 'retta', 'nido_1', 400)
    expect((await righeListino()).map((x) => [x.fascia, x.payment_category_id])).toEqual([[null, CAT_RETTA], ['nido_1', CAT_RETTA]])
    expect(await errore(CHIAMA, [A27(), 'servizio', null, null, 80, null])).toBe('PARAMETRO_MANCANTE')
    await imposta(A27(), 'servizio', null, 80, [9, 10], CAT_SERVIZIO)
    expect((await righeListino()).filter((x) => x.voce === 'servizio')).toEqual([expect.objectContaining({ importo: '80.00', mesi: [9, 10], payment_category_id: CAT_SERVIZIO })])
  })
})

describe('lo specchio del default di sede', () => {
  const DEFAULT = `SELECT retta_default_importo::text FROM public.admin_settings WHERE scuola_id = $1`

  prova('la retta senza fascia di un anno corrente riscrive il default; quella di un anno in preparazione no', async () => {
    expect(await una(DEFAULT, [SEDE_A])).toBe('150.00')
    await imposta(A27(), 'retta', null, 333)
    expect(await una(DEFAULT, [SEDE_A])).toBe('150.00')
    await imposta(A26(), 'retta', null, 277.5)
    expect(await una(DEFAULT, [SEDE_A])).toBe('277.50')
    await imposta(A26(), 'retta', 'infanzia', 300) // per fascia: niente specchio
    expect(await una(DEFAULT, [SEDE_A])).toBe('277.50')
  })

  prova('senza la colonna `retta_default_importo` lo specchio salta senza errore', async () => {
    await db.exec('ALTER TABLE public.admin_settings DROP COLUMN retta_default_importo')
    expect(await errore(CHIAMA, [A26(), 'retta', null, null, 260, null])).toBeNull()
    expect((await righe<{ importo: string }>(`SELECT importo::text FROM public.listino_voci WHERE anno_sede_id = $1`, [A26()]))[0].importo).toBe('260.00')
  })
})

describe('la sicurezza', () => {
  it('la funzione è del solo service_role', async () => {
    const r = await righe<{ anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc
         FROM pg_proc p WHERE p.proname = 'anno_listino_retta_imposta'`)
    expect(r).toEqual([{ anon: false, auth: false, svc: true }])
  })
})
