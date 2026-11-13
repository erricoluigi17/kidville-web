import { describe, it, expect, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, SCHEMA_ISCRIZIONE_ANNO } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.9.0 · IL BANCO DI PROVA NON DIPENDE DALL'OROLOGIO.
 *
 * `creaAnniFissi` ricrea il calendario con `DATE '2026-11-06'`, ma le funzioni che leggono `giorno_roma(now())` (il tick,
 * `anno_attivo`, le catene M1…M45e) leggono l'orologio vero. Dal 01/09/2027 un test che chiamava `anni_tick()` senza `p_oggi`
 * creava il 2028/29; dal 01/09/2029 mancava il 2027/28. Il banco deve produrre lo STESSO calendario (3 anni per sede: 2025/26,
 * 2026/27, 2027/28) qualunque sia il giorno in cui gira.
 *
 * L'orologio si sposta con `vi.setSystemTime` (solo `Date`: i timer veri servono a PGlite). Prima prova che il `now()` di PGlite
 * segua davvero quel tempo: se non lo seguisse, le altre tre asserzioni sarebbero verdi per niente.
 */

const SEDE = 'e2e00000-0000-4000-8000-000000000049'
const SEDE_B = 'e2e00000-0000-4000-8000-000000000050'

let db: PGlite | undefined

afterEach(async () => {
  vi.useRealTimers()
  await db?.close()
  db = undefined
})

async function calendario(d: PGlite) {
  const r = await d.query<{ scuola_id: string; n: string; anni: string }>(
    `SELECT s.scuola_id, count(*)::text AS n, string_agg(y.anno_inizio::text || ':' || s.stato, ',' ORDER BY y.anno_inizio) AS anni
       FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      GROUP BY s.scuola_id ORDER BY s.scuola_id`)
  return r.rows
}

describe('il banco produce sempre lo stesso calendario', () => {
  it('prova che `now()` di PGlite segue il tempo finto (altrimenti le prove sotto sarebbero verdi per niente)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2029-09-02T10:00:00Z'))
    db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M1' })
    const r = await db.query<{ anno: string }>(`SELECT extract(year FROM now())::text AS anno`)
    expect(r.rows[0].anno).toBe('2029')
    const g = await db.query<{ g: string }>(`SELECT public.giorno_roma(now())::text AS g`)
    expect(g.rows[0].g).toBe('2029-09-02')
  }, 300_000)

  for (const giorno of ['2027-09-02', '2028-09-02', '2029-09-02']) {
    it(`il ${giorno} il calendario è 2025/26 chiuso, 2026/27 corrente, 2027/28 in preparazione (3 anni per sede)`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(`${giorno}T10:00:00Z`))
      db = await creaDbAnnoPr2({ sedi: [SEDE, SEDE_B], fino: 'M45e', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
      const righe = await calendario(db)
      expect(righe).toHaveLength(2)
      for (const r of righe) {
        expect(r.n, `sede ${r.scuola_id}: ${r.anni}`).toBe('3')
        expect(r.anni).toBe('2025:chiuso,2026:corrente,2027:in_preparazione')
      }
    }, 400_000)
  }
})
