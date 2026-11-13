// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Elenco FISSO dei servizi per sede (decisione del titolare, 13/11/2026): nido e infanzia in tutte e
 * tre le sedi, primaria solo a Giugliano e Cesa. Non dipende dalle sezioni dell'anno.
 */
const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith('_crm_servizi_sede.sql'))
  if (!f) throw new Error('migrazione *_crm_servizi_sede.sql non trovata')
  return readFileSync(join(CARTELLA, f), 'utf8')
}

const GIUGLIANO = 'a0000000-0000-4000-8000-000000000001'
const AVERSA = 'a0000000-0000-4000-8000-000000000002'
const CESA = 'a0000000-0000-4000-8000-000000000003'
const DEMO = 'a0000000-0000-4000-8000-000000000004'
const ALTRA = 'a0000000-0000-4000-8000-000000000005'

let db: PGlite
const servizi = async (sede: string) =>
  (await db.query<{ grado: string }>('SELECT grado::text FROM public.crm_servizi_sede WHERE scuola_id = $1 ORDER BY grado', [sede]))
    .rows.map((r) => r.grado)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TYPE public.school_type_enum AS ENUM ('nido', 'infanzia', 'primaria');
    CREATE TABLE public.schools (id uuid PRIMARY KEY, nome text NOT NULL);
    INSERT INTO public.schools VALUES
      ('${GIUGLIANO}', 'Kidville Giugliano'), ('${AVERSA}', 'Kidville Aversa'), ('${CESA}', 'Kidville Cesa'),
      ('${DEMO}', 'Kidville Demo'), ('${ALTRA}', 'Sede nuova');
  `)
  await db.exec(migrazione())
  await db.exec(migrazione()) // idempotente
}, 60_000)
afterAll(async () => { if (db) await db.close() })

describe('crm_servizi_sede', () => {
  it('Giugliano e Cesa offrono nido, infanzia e primaria', async () => {
    expect(await servizi(GIUGLIANO)).toEqual(['infanzia', 'nido', 'primaria'])
    expect(await servizi(CESA)).toEqual(['infanzia', 'nido', 'primaria'])
  })

  it('Aversa offre nido e infanzia, non la primaria', async () => {
    expect(await servizi(AVERSA)).toEqual(['infanzia', 'nido'])
  })

  it('la sede Demo offre tutti e tre i servizi, per le prove', async () => {
    expect(await servizi(DEMO)).toEqual(['infanzia', 'nido', 'primaria'])
  })

  it('una sede non elencata resta senza servizi: chiude in sicurezza', async () => {
    expect(await servizi(ALTRA)).toEqual([])
  })

  it('la migrazione ripetuta non duplica le righe', async () => {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.crm_servizi_sede')
    expect(rows[0].n).toBe(3 + 3 + 2 + 3)
  })

  it('RLS accesa, nessun permesso a anon e authenticated, lettura e scrittura al service-role', async () => {
    const { rows } = await db.query<{ rls: boolean }>(
      "SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.crm_servizi_sede'::regclass",
    )
    expect(rows[0].rls).toBe(true)
    const p = async (ruolo: string, priv: string) =>
      (await db.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', [ruolo, 'public.crm_servizi_sede', priv])).rows[0].ok
    expect(await p('anon', 'SELECT')).toBe(false)
    expect(await p('authenticated', 'SELECT')).toBe(false)
    expect(await p('service_role', 'SELECT')).toBe(true)
    expect(await p('service_role', 'INSERT')).toBe(true)
  })
})
