// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrazione, schemaSoldi, TABELLE_SOLDI } from '../helpers/schema-soldi-pglite'

/**
 * ELIMINARE UNA VOCE DI RICARICA TICKET · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Una ricarica crea la voce e accredita SUBITO i ticket. Eliminare la voce senza togliere i
 * ticket lascerebbe pasti gratis (la FK del ledger è SET NULL): la funzione storna i ticket e
 * cancella la voce nella stessa transazione, e rifiuta se i ticket sono già stati usati.
 * Solo dati finti.
 */

const NUOVA = migrazione('_elimina_voce_ricarica_ticket.sql')
const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'e0000000-0000-4000-8000-000000000001'
const OPERATORE = 'b0000000-0000-4000-8000-000000000001'
const VOCE = 'c0000000-0000-4000-8000-000000000001'

let db: PGlite
type Esito = { esito: string } & Record<string, unknown>

async function elimina(id = VOCE): Promise<Esito> {
  const r = await db.query<{ r: Esito }>(
    'SELECT public.elimina_voce_ricarica_ticket(p_pagamento_id => $1, p_operatore => $2) AS r',
    [id, OPERATORE],
  )
  return r.rows[0].r
}

async function stato() {
  const r = await db.query<{ saldo: number | null; voci: number; ricariche: number; rettifiche: number; delta_rettifica: number | null }>(`
    SELECT (SELECT saldo_ticket FROM public.ticket_mensa WHERE alunno_id = $1) AS saldo,
           (SELECT count(*)::int FROM public.pagamenti WHERE id = $2) AS voci,
           (SELECT count(*)::int FROM public.mensa_ticket_movimenti WHERE tipo = 'ricarica') AS ricariche,
           (SELECT count(*)::int FROM public.mensa_ticket_movimenti WHERE tipo = 'rettifica') AS rettifiche,
           (SELECT delta FROM public.mensa_ticket_movimenti WHERE tipo = 'rettifica' LIMIT 1) AS delta_rettifica`,
    [ALUNNO, VOCE])
  return r.rows[0]
}

/** Una ricarica da `pezzi` ticket, come la scrive `ricarica_ticket_mensa`, con `consumati` già usati. */
async function ricarica(pezzi: number, consumati = 0) {
  await db.query(
    `INSERT INTO public.pagamenti (id, scuola_id, alunno_id, descrizione, importo, tipo, stato)
     VALUES ($1, $2, $3, 'Ricarica mensa — finta', 45, 'singolo', 'da_pagare')`, [VOCE, SEDE, ALUNNO])
  await db.query('INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket) VALUES ($1, $2)', [ALUNNO, pezzi - consumati])
  await db.query(
    `INSERT INTO public.mensa_ticket_movimenti (alunno_id, scuola_id, tipo, delta, saldo_dopo, pagamento_id, origine)
     VALUES ($1, $2, 'ricarica', $3, $3, $4, 'segreteria')`, [ALUNNO, SEDE, pezzi, VOCE])
}

beforeAll(async () => {
  db = new PGlite()
  await schemaSoldi(db)
  await db.exec(NUOVA)
})
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`TRUNCATE ${TABELLE_SOLDI} CASCADE;`)
  await db.query('INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)', [ALUNNO, SEDE])
})

describe('elimina_voce_ricarica_ticket · voce e ticket insieme', () => {
  it('la migrazione si riapplica senza errori (CREATE OR REPLACE)', async () => {
    await db.exec(NUOVA)
  })

  it('ricarica intatta: il saldo scende dei ticket della ricarica, una «rettifica», voce sparita', async () => {
    await ricarica(10)
    const e = await elimina()
    expect(e).toMatchObject({ esito: 'eliminata', ticket_tolti: 10, saldo_dopo: 0 })
    expect(await stato()).toEqual({ saldo: 0, voci: 0, ricariche: 1, rettifiche: 1, delta_rettifica: -10 })
    const m = await db.query<{ pagamento_id: string | null; creato_da: string; note: string }>(
      `SELECT pagamento_id, creato_da, note FROM public.mensa_ticket_movimenti WHERE tipo = 'rettifica'`,
    )
    expect(m.rows[0]).toEqual({ pagamento_id: null, creato_da: OPERATORE, note: 'Storno ricarica (voce eliminata)' })
  })

  it('saldo più alto della ricarica (altri ticket): toglie solo quelli della ricarica', async () => {
    await ricarica(10)
    await db.query('UPDATE public.ticket_mensa SET saldo_ticket = 14 WHERE alunno_id = $1', [ALUNNO])
    const e = await elimina()
    expect(e).toMatchObject({ esito: 'eliminata', ticket_tolti: 10, saldo_dopo: 4 })
  })

  it('🔴 ticket già usati (saldo sotto la ricarica) → «ticket_gia_usati», NIENTE scritto', async () => {
    await ricarica(10, 3)
    const prima = await stato()
    const e = await elimina()
    expect(e).toMatchObject({ esito: 'ticket_gia_usati', ticket: 10, saldo: 7 })
    expect(await stato()).toEqual(prima)
  })

  it('voce inesistente → «non_trovata»', async () => {
    expect((await elimina()).esito).toBe('non_trovata')
  })

  it('voce senza ricarica → «senza_ricarica», la voce resta', async () => {
    await db.query(
      `INSERT INTO public.pagamenti (id, scuola_id, alunno_id, descrizione, importo, tipo, stato)
       VALUES ($1, $2, $3, 'Gita finta', 10, 'singolo', 'da_pagare')`, [VOCE, SEDE, ALUNNO])
    expect((await elimina()).esito).toBe('senza_ricarica')
    expect((await stato()).voci).toBe(1)
  })

  it('🔴 un incasso sulla voce: la FK RESTRICT fa tornare indietro TUTTO (saldo e ledger invariati)', async () => {
    await ricarica(10)
    await db.query(`INSERT INTO public.incassi (pagamento_id, importo, metodo) VALUES ($1, 45, 'contanti')`, [VOCE])
    const prima = await stato()
    await expect(elimina()).rejects.toThrow(/foreign key|violates/i)
    expect(await stato()).toEqual(prima)
  })
})
