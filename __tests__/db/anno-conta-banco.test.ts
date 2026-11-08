import { describe, it, expect } from 'vitest'
import { creaDbAnnoPr2, applicaPr2 } from '../helpers/schema-anno-pglite'

/**
 * BANCO DI MISURA · il conteggio delle righe nei giorni spostati, prima e dopo il filtro per sede (Compito 4.2.1).
 *
 * Gira SOLO con `KIDVILLE_BANCO_ANNO=1` (un `describe.runIf`: senza la variabile non fa niente, resta fuori dal
 * gate). 40.000 presenze di altre due sedi e 2.000 della sede, tutte nello stesso anno e negli stessi giorni, così
 * il filtro per anno e per data non scarta nulla e conta solo quello per sede. `EXPLAIN (ANALYZE, BUFFERS)` della
 * query che la funzione esegue, prima (la CTE prende tutto, la sede si risolve per riga) e dopo (la sede sta nella
 * CTE e usa l'indice `(scuola_id, anno_id)`): il numero che interessa è `Rows Removed by Filter`. Nessuna
 * asserzione sui tempi (PGlite è WASM, vale come ordine di grandezza); si asserisce solo che il dopo scarti meno di
 * 100 righe e che i due conteggi diano lo stesso risultato. Solo uuid finti.
 *
 * Le due query sono copiate dalla funzione (vecchia e nuova): se la funzione cambia forma, qui va ritoccato.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const GRANDE_1 = '22222222-2222-4222-8222-222222222223'
const GRANDE_2 = '22222222-2222-4222-8222-222222222224'
const PICCOLA = 2_000
const GRANDE = 20_000   // per ciascuna delle due sedi grandi: 40.000 in tutto

const attivo = process.env.KIDVILLE_BANCO_ANNO === '1'

describe.runIf(attivo)('banco anno · conta_righe_assegnate_nei_giorni, filtro per sede', () => {
  it('misura Rows Removed by Filter prima e dopo', async () => {
    const db = await creaDbAnnoPr2({ sedi: [SEDE, GRANDE_1, GRANDE_2], fino: 'M3' })
    const anno = (await db.query<{ id: string }>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)).rows[0].id
    // L'anno si assegna a mano e il trigger si spegne: il banco misura il conteggio, non l'INSERT.
    await db.exec('ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica')
    for (const [sede, quante] of [[SEDE, PICCOLA], [GRANDE_1, GRANDE], [GRANDE_2, GRANDE]] as const) {
      await db.query(
        `INSERT INTO public.presenze (scuola_id, data, anno_id)
         SELECT $1, DATE '2027-08-16' + (g % 16), $2 FROM generate_series(1, ${quante}) g`, [sede, anno])
    }
    await db.exec('ANALYZE public.presenze')

    const vecchia =
      `WITH c AS MATERIALIZED (SELECT to_jsonb(t) AS j FROM public.presenze t WHERE t.anno_id = '${anno}' AND t.data BETWEEN DATE '2027-08-16' AND DATE '2027-08-31') ` +
      `SELECT count(*) FROM c WHERE public.anno_sede_della_riga('presenze', c.j) = '${SEDE}'`
    const nuova =
      `WITH c AS MATERIALIZED (SELECT 1 AS uno FROM public.presenze t WHERE t.anno_id = '${anno}' AND t.data BETWEEN DATE '2027-08-16' AND DATE '2027-08-31' ` +
      `AND (t.scuola_id = '${SEDE}' OR (t.scuola_id IS NULL AND public.anno_sede_della_riga('presenze', to_jsonb(t)) = '${SEDE}'))) ` +
      `SELECT count(*) FROM c`

    const scartate = async (sql: string) => {
      const piano = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`)).rows.map((r) => r['QUERY PLAN'])
      const n = piano.map((l) => /Rows Removed by Filter: (\d+)/.exec(l)).filter(Boolean).map((m) => Number(m![1]))
      return { piano, totale: n.reduce((a, b) => a + b, 0) }
    }
    const prima = await scartate(vecchia)
    const dopo = await scartate(nuova)
    console.log(`BANCO conta · Rows Removed by Filter: prima ${prima.totale}, dopo ${dopo.totale}\n--- prima\n${prima.piano.join('\n')}\n--- dopo\n${dopo.piano.join('\n')}`)

    const a = Number((await db.query<{ count: string }>(vecchia)).rows[0].count)
    const b = Number((await db.query<{ count: string }>(nuova)).rows[0].count)
    expect(a).toBe(PICCOLA)
    expect(b).toBe(PICCOLA)
    expect(dopo.totale).toBeLessThan(100)

    // e la funzione vera (dopo la migrazione) dà lo stesso numero
    await applicaPr2(db, 'M42')
    const f = await db.query<{ n: string }>(
      `SELECT public.anno_conta_righe_assegnate_nei_giorni('presenze', $1, $2, DATE '2027-08-16', DATE '2027-08-31')::text AS n`, [anno, SEDE])
    expect(Number(f.rows[0].n)).toBe(PICCOLA)
  }, 600_000)
})
