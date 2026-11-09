import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { clienteSuPglite } from '../helpers/supabase-su-pglite'

/**
 * 4.5.16 · H · Il banco di prova deve comportarsi come PostgREST.
 *
 * `neq(c, v)` in PostgREST è `c <> v`: una riga con `c IS NULL` NON passa (NULL <> 'x' non è vero). Il banco usava
 * `IS DISTINCT FROM`, che la fa passare: un test poteva restare verde grazie a una riga che in produzione sarebbe stata esclusa.
 * Tabella di prova locale, testi finti: nessun dato di una famiglia.
 */
describe('banco su PGlite · neq come PostgREST', () => {
  let db: PGlite
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`CREATE TABLE prova_neq (id int PRIMARY KEY, stato text);
      INSERT INTO prova_neq VALUES (1, 'a'), (2, 'b'), (3, NULL);`)
  })
  afterAll(async () => {
    await db.close()
  })

  it('`neq("stato", "a")` restituisce SOLO la riga con un valore diverso: la riga con NULL non passa', async () => {
    await db.exec('BEGIN')
    const r = (await clienteSuPglite(db).from('prova_neq').select('id').neq('stato', 'a').order('id')) as { data: { id: number }[]; error: unknown }
    await db.exec('ROLLBACK')
    expect(r.error).toBeNull()
    expect(r.data.map((x) => x.id)).toEqual([2])
  })
})
