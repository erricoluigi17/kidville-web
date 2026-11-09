// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  CAT_SERVIZIO, creaAlunno, creaBancoRette, creaFrequenza, inRollback, listino, righe as righeSu, SEDE_A, UTENTE, uuidFinto, una,
  type MappaAnni,
} from '../helpers/banco-rette-pglite'

/**
 * COMPITO 4.6.1 · M46a · I SERVIZI MENSILI SEGUONO LA FREQUENZA DELL'ANNO, in PGlite vero.
 *
 * Prima `servizi_da_generare` esigeva `alunni.stato = 'iscritto'` (cioè «oggi»); ora vuole una frequenza viva dell'anno che
 * contiene il periodo. `genera_servizi_anno` prende i mesi dal listino (ripiego sulla retta, poi sui dieci mesi).
 * Nessun `now()`, solo uuid finti.
 */

let db: PGlite
let anni: MappaAnni
const righe = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => righeSu<T>(db, sql, params)
const prova = (nome: string, fn: () => Promise<void>) => it(nome, () => inRollback(db, fn), 30_000)

beforeAll(async () => {
  ;({ db, anni } = await creaBancoRette())
}, 120_000)
afterAll(async () => {
  await db?.close()
})

async function iscrizioneServizio(alunno: string, dal = '2026-09-01'): Promise<void> {
  await db.query(
    `INSERT INTO public.iscrizioni_servizi (alunno_id, categoria_id, scuola_id, importo_mensile, dal, creato_da) VALUES ($1, $2, $3, 80, $4, $5)`,
    [alunno, CAT_SERVIZIO, SEDE_A, dal, UTENTE])
}
async function daGenerare(periodo: string): Promise<string[]> {
  return (await righe<{ alunno_id: string }>(`SELECT alunno_id FROM public.servizi_da_generare($1::date, $2::uuid)`, [periodo, SEDE_A])).map((r) => r.alunno_id)
}

describe('servizi_da_generare', () => {
  prova('vale se il bambino ha la frequenza viva dell’anno del periodo, anche se alunni.stato non dice «iscritto»', async () => {
    const a = uuidFinto(); await creaAlunno(db, a, { stato: 'sospeso' })
    await creaFrequenza(db, anni, a, { anno: 2026 })
    await iscrizioneServizio(a)
    expect(await daGenerare('2026-10-01')).toEqual([a])
  })

  prova('un bambino che ha solo la frequenza dell’anno prossimo non riceve il servizio di questo anno', async () => {
    const a = uuidFinto(); await creaAlunno(db, a, { stato: 'iscritto' })
    await creaFrequenza(db, anni, a, { anno: 2027, stato: 'in_attesa' })
    await iscrizioneServizio(a)
    expect(await daGenerare('2026-10-01')).toEqual([])
    expect(await daGenerare('2027-10-01')).toEqual([a]) // il mese dell'anno prossimo sì: ha la sua frequenza
  })

  prova('un bambino `in_arrivo` (nessuna frequenza dell’anno in corso) non riceve il servizio', async () => {
    const a = uuidFinto(); await creaAlunno(db, a, { stato: 'in_arrivo' })
    await creaFrequenza(db, anni, a, { anno: 2027, stato: 'in_attesa' })
    await iscrizioneServizio(a)
    expect(await daGenerare('2026-10-01')).toEqual([])
  })

  prova('una frequenza ritirata non conta', async () => {
    const a = uuidFinto(); await creaAlunno(db, a)
    await creaFrequenza(db, anni, a, { anno: 2026, stato: 'ritirato', uscita: '2026-09-30' })
    await iscrizioneServizio(a)
    expect(await daGenerare('2026-10-01')).toEqual([])
  })
})

describe('genera_servizi_anno usa i mesi del listino', () => {
  async function conUnBambino(): Promise<string> {
    const a = uuidFinto(); await creaAlunno(db, a)
    await creaFrequenza(db, anni, a, { anno: 2026 })
    await iscrizioneServizio(a)
    return a
  }
  async function annuale(): Promise<number> {
    return Number(await una(db, `SELECT public.genera_servizi_anno(2026, $1::uuid)`, [SEDE_A]))
  }

  prova('senza listino: i dieci mesi di sempre', async () => {
    await conUnBambino()
    expect(await annuale()).toBe(10)
  })

  prova('con una riga `servizio` con i mesi {9,10,11}: tre voci', async () => {
    await conUnBambino()
    await listino(db, anni, 2026, 80, { voce: 'servizio', mesi: [9, 10, 11] })
    expect(await annuale()).toBe(3)
  })

  prova('senza riga `servizio` ma con la `retta` a {9}: ripiega sulla retta (una voce)', async () => {
    await conUnBambino()
    await listino(db, anni, 2026, 250, { mesi: [9] })
    expect(await annuale()).toBe(1)
  })

  prova('una riga `servizio` con i mesi NULL e la retta a {9}: ripiega ancora sulla retta', async () => {
    await conUnBambino()
    await listino(db, anni, 2026, 250, { mesi: [9] })
    await listino(db, anni, 2026, 80, { voce: 'servizio', mesi: null })
    expect(await annuale()).toBe(1)
  })
})
