// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const MIGRAZIONE = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260916120000_fatture_visibilita_snapshot.sql'),
  'utf8',
)

const SEDE_OFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_ON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GENITORE_A = '11111111-1111-4111-8111-111111111111'
const GENITORE_B = '22222222-2222-4222-8222-222222222222'
const FATTURA_STORICA = '33333333-3333-4333-8333-333333333333'
const FATTURA_IMMUTABILE = '44444444-4444-4444-8444-444444444444'
const FATTURA_ATTIVA = '55555555-5555-4555-8555-555555555555'

let db: PGlite

async function valore<T>(sql: string): Promise<T> {
  const risultato = await db.query<Record<string, T>>(sql)
  return Object.values(risultato.rows[0])[0]
}

async function comeRuolo(ruolo: 'anon' | 'authenticated' | 'service_role', sql: string) {
  await db.exec(`SET ROLE ${ruolo}`)
  try {
    return await db.exec(sql)
  } finally {
    await db.exec('RESET ROLE')
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      GRANT ALL ON TABLES TO service_role;

    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role()
    RETURNS text
    LANGUAGE sql
    STABLE
    AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY);
    CREATE TABLE public.fatture_emesse (
      id uuid PRIMARY KEY,
      scuola_id uuid NOT NULL,
      parent_registry_id uuid REFERENCES public.parents(id)
    );
    CREATE TABLE public.admin_settings (scuola_id uuid PRIMARY KEY);

    -- Il client authenticated arriva al trigger nel test anti-spoof: la prova
    -- deve misurare la guardia, non fermarsi prima sui privilegi della fixture.
    GRANT SELECT, UPDATE ON public.fatture_emesse TO authenticated;
  `)
  await db.exec(MIGRAZIONE)
  await db.exec(`
    INSERT INTO public.parents (id) VALUES ('${GENITORE_A}'), ('${GENITORE_B}');
    INSERT INTO public.admin_settings (scuola_id, fatture_visibilita_attiva_il)
    VALUES ('${SEDE_OFF}', NULL), ('${SEDE_ON}', now() + interval '1 day');
  `)
})

afterAll(async () => {
  await db.close()
})

describe('migrazione runtime · visibilità fatture', () => {
  it('considera attiva qualsiasi sede col flag valorizzato, anche se la data è futura', async () => {
    await expect(
      db.exec(`
        INSERT INTO public.fatture_emesse (id, scuola_id, parent_registry_id, modalita_emissione)
        VALUES ('${FATTURA_ATTIVA}', '${SEDE_ON}', '${GENITORE_A}', NULL)
      `),
    ).rejects.toThrow(/modalita_emissione obbligatoria/i)
  })

  it('consente ancora lo snapshot nullo finché il flag della sede è NULL', async () => {
    await db.exec(`
      INSERT INTO public.fatture_emesse (id, scuola_id, parent_registry_id, modalita_emissione)
      VALUES ('${FATTURA_STORICA}', '${SEDE_OFF}', NULL, NULL)
    `)
    expect(
      await valore<number>(
        `SELECT count(*)::int AS n FROM public.fatture_emesse WHERE id = '${FATTURA_STORICA}'`,
      ),
    ).toBe(1)
  })

  it('toglie al service role DELETE e TRUNCATE ereditati dai default privileges', async () => {
    expect(
      await valore<boolean>(
        `SELECT has_table_privilege('service_role', 'public.fatture_visibilita_revisioni', 'DELETE') AS permesso`,
      ),
    ).toBe(false)
    expect(
      await valore<boolean>(
        `SELECT has_table_privilege('service_role', 'public.fatture_visibilita_revisioni', 'TRUNCATE') AS permesso`,
      ),
    ).toBe(false)
    expect(
      await valore<boolean>(
        `SELECT has_table_privilege('service_role', 'public.fatture_visibilita_revisioni', 'SELECT,INSERT,UPDATE') AS permesso`,
      ),
    ).toBe(true)
  })

  it('rende immutabili modalità e destinatario delle fatture nuove', async () => {
    await db.exec(`
      INSERT INTO public.fatture_emesse (id, scuola_id, parent_registry_id, modalita_emissione)
      VALUES ('${FATTURA_IMMUTABILE}', '${SEDE_ON}', '${GENITORE_A}', 'ordinaria')
    `)
    await expect(
      db.exec(`
        UPDATE public.fatture_emesse
        SET modalita_emissione = 'quote_separate', parent_registry_id = '${GENITORE_B}'
        WHERE id = '${FATTURA_IMMUTABILE}'
      `),
    ).rejects.toThrow(/snapshot immutabili/i)
  })

  it('finalizza lo storico solo con GUC locale e ruolo SQL service_role', async () => {
    await expect(
      comeRuolo(
        'service_role',
        `UPDATE public.fatture_emesse SET modalita_emissione = 'ordinaria' WHERE id = '${FATTURA_STORICA}'`,
      ),
    ).rejects.toThrow(/snapshot immutabili/i)

    await db.exec(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT set_config('app.fatture_visibilita_finalizza_storico', 'on', true);
      UPDATE public.fatture_emesse
      SET modalita_emissione = 'quote_separate', parent_registry_id = '${GENITORE_A}'
      WHERE id = '${FATTURA_STORICA}';
      COMMIT;
    `)
    expect(
      await valore<string>(
        `SELECT modalita_emissione FROM public.fatture_emesse WHERE id = '${FATTURA_STORICA}'`,
      ),
    ).toBe('quote_separate')
  })

  it('nega lo spoof del claim service_role a un client authenticated', async () => {
    const id = '66666666-6666-4666-8666-666666666666'
    await db.exec(`
      UPDATE public.admin_settings
      SET fatture_visibilita_attiva_il = NULL
      WHERE scuola_id = '${SEDE_OFF}';
      INSERT INTO public.fatture_emesse (id, scuola_id, modalita_emissione)
      VALUES ('${id}', '${SEDE_OFF}', NULL);
    `)

    await expect(
      db.exec(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SELECT set_config('request.jwt.claim.role', 'service_role', true);
        SELECT set_config('app.fatture_visibilita_finalizza_storico', 'on', true);
        UPDATE public.fatture_emesse SET modalita_emissione = 'ordinaria' WHERE id = '${id}';
        COMMIT;
      `),
    ).rejects.toThrow(/snapshot immutabili/i)
    await db.exec('ROLLBACK')
  })

  it('RLS e grant negano ogni accesso diretto ad anon e authenticated', async () => {
    for (const ruolo of ['anon', 'authenticated'] as const) {
      await expect(
        comeRuolo(ruolo, 'SELECT * FROM public.fatture_visibilita_revisioni'),
      ).rejects.toThrow(/permission denied/i)
      await expect(
        comeRuolo(
          ruolo,
          `INSERT INTO public.fatture_visibilita_revisioni (fattura_id, modalita)
           VALUES ('${FATTURA_IMMUTABILE}', 'ordinaria')`,
        ),
      ).rejects.toThrow(/permission denied/i)
    }
  })

  it('rifiuta una revisione a quote separate priva del genitore', async () => {
    await expect(
      comeRuolo(
        'service_role',
        `INSERT INTO public.fatture_visibilita_revisioni (fattura_id, modalita)
         VALUES ('${FATTURA_IMMUTABILE}', 'quote_separate')`,
      ),
    ).rejects.toThrow(/fatture_visibilita_revisioni_parent_quote_chk/i)
  })

  it('può riapplicare la migrazione senza perdere revisioni o vincoli', async () => {
    await comeRuolo(
      'service_role',
      `INSERT INTO public.fatture_visibilita_revisioni (fattura_id, modalita)
       VALUES ('${FATTURA_IMMUTABILE}', 'ordinaria')`,
    )

    await expect(db.exec(MIGRAZIONE)).resolves.toBeDefined()
    expect(
      await valore<number>(
        `SELECT count(*)::int AS n FROM public.fatture_visibilita_revisioni WHERE fattura_id = '${FATTURA_IMMUTABILE}'`,
      ),
    ).toBe(1)
  })
})
