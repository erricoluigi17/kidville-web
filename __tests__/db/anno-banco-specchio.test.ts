import { describe, it, expect } from 'vitest'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * BANCO DI MISURA · il costo dello specchio `alunni` → `frequenze` (Compito 2.3-b, trigger
 * `trg_alunni_specchio_frequenza_ins`).
 *
 * Gira SOLO con `KIDVILLE_BANCO_ANNO=1`; senza la variabile salta. Nessuna asserzione sui tempi (instabili): si
 * asserisce solo che le righe ci siano. PGlite è WASM, un solo processo, niente disco: i numeri valgono come ordine di
 * grandezza e come rapporto fra «con» e «senza» lo specchio, non come tempi assoluti. Solo uuid finti.
 *
 * Misura 1.000 INSERT SINGOLI su `alunni` (un'istruzione per riga, come fa l'app) con la manopola
 * `anno_regole.specchio_alunni_attivo` spenta e poi accesa.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SINGOLI = 1_000
const attivo = process.env.KIDVILLE_BANCO_ANNO === '1'

describe.runIf(attivo)('banco anno · lo specchio alunni → frequenze', () => {
  it('misura e stampa i tempi', async () => {
    const db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'V2', completo: true })
    const sez = (await db.query<{ id: string }>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [SEDE])).rows[0].id
    const righe: Array<[string, number]> = []
    const serie = async (nome: string, specchio: boolean) => {
      await db.query(`UPDATE public.anno_regole SET specchio_alunni_attivo = $1`, [specchio])
      const t = performance.now()
      for (let i = 0; i < SINGOLI; i++) {
        await db.query(`INSERT INTO public.alunni (scuola_id, section_id) VALUES ($1, $2)`, [SEDE, sez])
      }
      righe.push([nome, Math.round(performance.now() - t)])
    }
    await serie(`${SINGOLI} INSERT singoli di alunni, specchio SPENTO`, false)
    await serie(`${SINGOLI} INSERT singoli di alunni, specchio ACCESO`, true)
    const alunni = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.alunni`)).rows[0].n)
    const frequenze = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.frequenze`)).rows[0].n)
    console.log(['BANCO specchio (ms)', ...righe.map(([n, ms]) => `  ${n}: ${ms} ms`), `  alunni ${alunni}, frequenze ${frequenze}`].join('\n'))
    expect(alunni).toBe(2 * SINGOLI)
    expect(frequenze).toBe(SINGOLI)
    await db.close()
  }, 600_000)
})
