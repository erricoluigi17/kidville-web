// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * DUE CORSE CHIUSE (D12 del rapporto del 20/10, sessione 8 della seconda serie).
 *
 *  · Promemoria: la deduplica era «leggi, poi inserisci». Ora `notifiche.chiave_dedup` ha un indice
 *    UNICO e NON PARZIALE (PostgREST non sa usare un indice parziale come arbitro: 42P10), e la
 *    scrittura è `ON CONFLICT (chiave_dedup) DO NOTHING`.
 *  · Sincronizzazione delle fatture: una presa con scadenza per giro (`cron_prese`), sul modello di
 *    `20261010230945_code_robuste_prese_con_scadenza.sql`.
 *
 * Due giri davvero CONCORRENTI non si provano in PGlite (una connessione sola): qui si prova la
 * regola che li separa, cioè l'arbitro e l'aggiornamento condizionato sul tempo del database.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_promemoria_e_sync_senza_doppioni.sql')

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AVVISO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ESTRANEO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    -- Come in Supabase: una tabella o una funzione nuova di postgres in public nasce con ALL ai tre
    -- ruoli. La revoca della migrazione si prova contro questi default, non contro un banco vuoto.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    CREATE TABLE public.notifiche (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      utente_id uuid NOT NULL,
      tipo text NOT NULL,
      entita_id uuid,
      creato_il timestamptz NOT NULL DEFAULT now()
    );
  `)
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('DELETE FROM public.notifiche; DELETE FROM public.cron_prese;')
})

async function accoda(chiave: string | null): Promise<void> {
  await db.query(
    `INSERT INTO public.notifiche (utente_id, tipo, entita_id, chiave_dedup)
     VALUES ($1, 'modulo_promemoria', $2, $3)
     ON CONFLICT (chiave_dedup) DO NOTHING`,
    [U1, AVVISO, chiave],
  )
}

async function righe(): Promise<number> {
  return Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.notifiche')).rows[0].n)
}

describe('promemoria: una riga per chiave', () => {
  it('l’indice è UNICO e NON parziale', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'notifiche_chiave_dedup_key'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/UNIQUE/)
    expect(rows[0].indexdef).not.toMatch(/WHERE/i)
  })

  it('due giri con la stessa chiave lasciano una riga', async () => {
    const chiave = `modulo_promemoria:${AVVISO}:${U1}:2026-10-21`
    await accoda(chiave)
    await accoda(chiave)
    expect(await righe()).toBe(1)
  })

  it('le notifiche senza chiave non si toccano', async () => {
    await accoda(null)
    await accoda(null)
    expect(await righe()).toBe(2)
  })
})

describe('sincronizzazione: presa con scadenza per giro', () => {
  const prendi = async (job = 'fattura-sync'): Promise<string | null> =>
    (await db.query<{ t: string | null }>('SELECT public.cron_presa_prendi($1, 330) AS t', [job])).rows[0].t
  const rilascia = async (token: string): Promise<boolean> =>
    (await db.query<{ ok: boolean }>(`SELECT public.cron_presa_rilascia('fattura-sync', $1) AS ok`, [token])).rows[0].ok

  it('una sola alla volta; si rilascia solo col proprio token; scade da sola', async () => {
    const prima = await prendi()
    expect(prima).toMatch(/^[0-9a-f-]{36}$/)
    expect(await prendi()).toBeNull()
    expect(await rilascia(ESTRANEO)).toBe(false)
    expect(await prendi()).toBeNull()
    expect(await rilascia(prima!)).toBe(true)
    const seconda = await prendi()
    expect(seconda).not.toBeNull()
    expect(seconda).not.toBe(prima)
    // Un giro morto a metà non rilascia: la presa scade da sola.
    await db.exec(`UPDATE public.cron_prese SET presa_scade_il = now() - interval '1 second' WHERE job = 'fattura-sync'`)
    expect(await prendi()).not.toBeNull()
  })

  it('un giro mai visto nasce alla prima presa', async () => {
    expect(await prendi('altro-giro')).not.toBeNull()
  })

  it('argomenti assurdi: 22023', async () => {
    await expect(db.query(`SELECT public.cron_presa_prendi('fattura-sync', 0)`)).rejects.toMatchObject({ code: '22023' })
    await expect(db.query(`SELECT public.cron_presa_prendi('fattura-sync', 3600)`)).rejects.toMatchObject({ code: '22023' })
  })

  it('solo service_role: RLS accesa, niente ad anon e authenticated', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('authenticated', 'public.cron_presa_prendi(text, integer)', 'EXECUTE') AS auth_prendi,
             has_function_privilege('anon', 'public.cron_presa_rilascia(text, uuid)', 'EXECUTE') AS anon_rilascia,
             has_function_privilege('service_role', 'public.cron_presa_prendi(text, integer)', 'EXECUTE') AS sr_prendi,
             has_table_privilege('authenticated', 'public.cron_prese', 'SELECT') AS auth_legge,
             (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cron_prese'::regclass) AS rls`)
    expect(rows[0]).toEqual({ auth_prendi: false, anon_rilascia: false, sr_prendi: true, auth_legge: false, rls: true })
  })

  it('cron_prese come cron_chiamate: service_role legge e basta, anche contro i privilegi predefiniti', async () => {
    // service_role ha BYPASSRLS: con un grant di scrittura potrebbe prendere o liberare una presa
    // senza passare dalle due funzioni. Scrivono solo loro (SECURITY DEFINER, del proprietario).
    const { rows } = await db.query<{ ruolo: string; privilegio: string }>(`
      SELECT r AS ruolo, p AS privilegio
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
       WHERE has_table_privilege(r, 'public.cron_prese', p)
       ORDER BY 1, 2`)
    expect(rows).toEqual([{ ruolo: 'service_role', privilegio: 'SELECT' }])
  })

  it('le due funzioni: niente ad anon e authenticated anche contro i privilegi predefiniti', async () => {
    const { rows } = await db.query<{ ruolo: string; funzione: string }>(`
      SELECT r AS ruolo, f AS funzione
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['public.cron_presa_prendi(text, integer)', 'public.cron_presa_rilascia(text, uuid)']) AS f
       WHERE has_function_privilege(r, f, 'EXECUTE')
       ORDER BY 1, 2`)
    expect(rows).toEqual([
      { ruolo: 'service_role', funzione: 'public.cron_presa_prendi(text, integer)' },
      { ruolo: 'service_role', funzione: 'public.cron_presa_rilascia(text, uuid)' },
    ])
  })
})

describe('la migrazione non ferma notifiche dietro una transazione aperta', () => {
  // L'ADD COLUMN vuole un ACCESS EXCLUSIVE su notifiche: aspetta ogni transazione aperta sulla
  // tabella, e intanto ogni lettura e scrittura nuova si accoda dietro di lui. Con lock_timeout la
  // migrazione fallisce forte (55P03) dopo 15 secondi invece di tenere ferma la tabella. Due
  // connessioni non si provano in PGlite: qui la forma e la portata; la coda vera è provata su un
  // Postgres 17 locale (rapporto della sessione 8).
  const istruzioni = NUOVA.split('\n').filter((l) => !/^\s*--/.test(l) && l.trim() !== '')

  it('SET LOCAL lock_timeout = 15s è la prima istruzione, prima di ogni ALTER e CREATE', () => {
    expect(istruzioni[0]).toBe("SET LOCAL lock_timeout = '15s';")
    const primaAlter = istruzioni.findIndex((l) => /^\s*(ALTER|CREATE)\b/i.test(l))
    expect(primaAlter).toBeGreaterThan(0)
    // Sulle istruzioni, non sul file: il commento della migrazione spiega perché CONCURRENTLY no.
    expect(istruzioni.join('\n')).not.toMatch(/CONCURRENTLY/i)
  })

  it('vale dentro la transazione della migrazione e non ne esce', async () => {
    const b = new PGlite()
    await b.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
                  CREATE TABLE public.notifiche (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), utente_id uuid NOT NULL, tipo text NOT NULL);`)
    await b.exec(`BEGIN; ${NUOVA}`)
    expect((await b.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout).toBe('15s')
    await b.exec('COMMIT')
    expect((await b.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0')
    await b.close()
  })
})
