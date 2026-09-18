// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const MIGRAZIONE = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260916190000_video_jobs.sql'),
  'utf8',
)

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = '11000000-0000-4000-8000-000000000001'
const UTENTE = '20000000-0000-4000-8000-000000000002'
const ALTRO_UTENTE = '21000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const INTENT_GLOBALE = '31000000-0000-4000-8000-000000000003'
const JOB_GLOBALE = '32000000-0000-4000-8000-000000000003'
const JOB = '40000000-0000-4000-8000-000000000004'
const INTENT_OUTPUT_NULLO = '33000000-0000-4000-8000-000000000003'
const JOB_OUTPUT_NULLO = '41000000-0000-4000-8000-000000000004'

let db: PGlite

async function valore<T>(sql: string): Promise<T> {
  const risultato = await db.query<Record<string, T>>(sql)
  return Object.values(risultato.rows[0])[0]
}

async function comeRuolo(
  ruolo: 'anon' | 'authenticated' | 'service_role',
  sql: string,
): Promise<void> {
  await db.exec(`SET ROLE ${ruolo}`)
  try {
    await db.exec(sql)
  } finally {
    await db.exec('RESET ROLE')
  }
}

async function preparaDatabase() {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY REFERENCES auth.users(id),
      scuola_id uuid NOT NULL REFERENCES public.schools(id)
    );

    CREATE TABLE public.log_migrazioni (payload jsonb NOT NULL);
    CREATE FUNCTION public.app_log_registra(righe jsonb)
    RETURNS int
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO public.log_migrazioni(payload) VALUES (righe);
      RETURN 1;
    END $$;

    INSERT INTO public.schools(id) VALUES ('${SEDE}'), ('${ALTRA_SEDE}');
    INSERT INTO auth.users(id) VALUES ('${UTENTE}'), ('${ALTRO_UTENTE}');
    INSERT INTO public.utenti(id, scuola_id) VALUES
      ('${UTENTE}', '${SEDE}'),
      ('${ALTRO_UTENTE}', '${ALTRA_SEDE}');

    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('gallery', 'gallery', false, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news', 'news', true, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news_bozze', 'news_bozze', false, 52428800, ARRAY['image/jpeg', 'video/mp4']);
  `)
  await db.exec(MIGRAZIONE)
}

beforeAll(async () => {
  db = new PGlite()
  await preparaDatabase()
})

afterAll(async () => {
  await db.close()
})

describe('migrazione video · job, intent, outbox e bucket', () => {
  it('crea le tre tabelle service-only con RLS, senza policy client', async () => {
    const catalogo = await db.query<{
      tabella: string
      rls: boolean
      rls_forzata: boolean
      policy: number
    }>(`
      SELECT c.relname AS tabella,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS rls_forzata,
             count(p.policyname)::int AS policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p
        ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public'
        AND c.relname IN ('video_intents', 'video_jobs', 'video_outbox')
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `)

    expect(catalogo.rows).toEqual([
      { tabella: 'video_intents', rls: true, rls_forzata: true, policy: 0 },
      { tabella: 'video_jobs', rls: true, rls_forzata: true, policy: 0 },
      { tabella: 'video_outbox', rls: true, rls_forzata: true, policy: 0 },
    ])

    for (const tabella of ['video_intents', 'video_jobs', 'video_outbox']) {
      expect(await valore<boolean>(
        `SELECT has_table_privilege('service_role', 'public.${tabella}', 'SELECT,INSERT,UPDATE,DELETE')`,
      )).toBe(true)
      expect(await valore<boolean>(
        `SELECT has_table_privilege('anon', 'public.${tabella}', 'SELECT')`,
      )).toBe(false)
      expect(await valore<boolean>(
        `SELECT has_table_privilege('authenticated', 'public.${tabella}', 'INSERT')`,
      )).toBe(false)
    }

    await expect(comeRuolo('anon', 'SELECT * FROM public.video_jobs'))
      .rejects.toThrow(/permission denied/i)
    await expect(comeRuolo(
      'authenticated',
      `INSERT INTO public.video_intents(owner_id, scuola_id, channel, requested_action)
       VALUES ('${UTENTE}', '${SEDE}', 'gallery', 'attach_private')`,
    )).rejects.toThrow(/permission denied/i)
  })

  it('ammette lo scope senza sede soltanto per News globale esplicito', async () => {
    await expect(db.exec(`
      INSERT INTO public.video_intents(id, owner_id, channel, requested_action, payload)
      VALUES ('${INTENT_GLOBALE}', '${UTENTE}', 'news', 'publish', '{"scope":"global"}')
    `)).resolves.toBeDefined()
    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        id, owner_id, channel, idempotency_key, intent_id,
        original_bucket, original_path
      ) VALUES (
        '${JOB_GLOBALE}', '${UTENTE}', 'news', 'upload-globale', '${INTENT_GLOBALE}',
        'video_originals', 'originals/${JOB_GLOBALE}/source'
      )
    `)).resolves.toBeDefined()

    await expect(db.exec(`
      INSERT INTO public.video_intents(owner_id, channel, requested_action, payload)
      VALUES ('${UTENTE}', 'news', 'publish', '{}')
    `)).rejects.toThrow(/video_intents_scuola_scope_chk/i)

    await expect(db.exec(`
      INSERT INTO public.video_intents(owner_id, channel, requested_action, payload)
      VALUES ('${UTENTE}', 'gallery', 'attach_private', '{"scope":"global"}')
    `)).rejects.toThrow(/video_intents_scuola_scope_chk/i)
  })

  it('impone idempotenza per proprietario e canale e unicità dei percorsi', async () => {
    await db.exec(`
      INSERT INTO public.video_intents(
        id, owner_id, scuola_id, channel, requested_action, payload
      ) VALUES (
        '${INTENT}', '${UTENTE}', '${SEDE}', 'gallery', 'attach_private', '{}'
      );
      INSERT INTO public.video_jobs(
        id, owner_id, scuola_id, channel, idempotency_key, intent_id,
        original_bucket, original_path
      ) VALUES (
        '${JOB}', '${UTENTE}', '${SEDE}', 'gallery', 'upload-uno', '${INTENT}',
        'video_originals', 'originals/${JOB}/source'
      );
    `)

    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        owner_id, scuola_id, channel, idempotency_key, intent_id,
        original_bucket, original_path
      ) VALUES (
        '${UTENTE}', '${SEDE}', 'gallery', 'upload-uno', '${INTENT}',
        'video_originals', 'originals/altro/source'
      )
    `)).rejects.toThrow(/video_jobs_owner_channel_idempotency_key_key/i)

    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        owner_id, scuola_id, channel, idempotency_key, intent_id,
        original_bucket, original_path
      ) VALUES (
        '${UTENTE}', '${SEDE}', 'gallery', 'upload-due', '${INTENT}',
        'video_originals', 'originals/${JOB}/source'
      )
    `)).rejects.toThrow(/video_jobs_originale_unico/i)
  })

  it('rifiuta scope discordanti, chiavi troppo lunghe e sorgenti oltre 2 GB', async () => {
    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        owner_id, channel, idempotency_key, intent_id, original_bucket, original_path
      ) VALUES (
        '${UTENTE}', 'news', 'scope-diverso', '${INTENT}',
        'video_originals', 'originals/scope-diverso/source'
      )
    `)).rejects.toThrow(/video_jobs_intent_scope_fk/i)

    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        owner_id, scuola_id, channel, idempotency_key, intent_id,
        original_bucket, original_path
      ) VALUES (
        '${UTENTE}', '${SEDE}', 'gallery', repeat('x', 129), '${INTENT}',
        'video_originals', 'originals/chiave-lunga/source'
      )
    `)).rejects.toThrow(/video_jobs_idempotency_key_chk/i)

    await expect(db.exec(`
      UPDATE public.video_jobs
      SET status = 'queued', source_size = 2000000000, source_mime = 'video/mp4'
      WHERE id = '${JOB}'
    `)).resolves.toBeDefined()

    await expect(db.exec(`
      UPDATE public.video_jobs
      SET status = 'queued', source_size = 2000000001, source_mime = 'video/mp4'
      WHERE id = '${JOB}'
    `)).rejects.toThrow(/video_jobs_source_size_chk/i)
  })

  it('rende immutabili scope e revisione dell’intent collegato', async () => {
    for (const modifica of [
      `owner_id = '${ALTRO_UTENTE}'`,
      "channel = 'news'",
      `scuola_id = '${ALTRA_SEDE}'`,
    ]) {
      await expect(db.exec(`
        UPDATE public.video_intents
        SET ${modifica}
        WHERE id = '${INTENT}'
      `)).rejects.toThrow(/video_intents_job_scope_immutabile/i)
    }

    await expect(db.exec(`
      UPDATE public.video_intents
      SET revision = 2
      WHERE id = '${INTENT}'
    `)).rejects.toThrow(/video_intents_revision_immutabile/i)
  })

  it('nega stati temporali incoerenti e processing senza lease completa', async () => {
    await expect(db.exec(`
      UPDATE public.video_intents
      SET status = 'published'
      WHERE id = '${INTENT}'
    `)).rejects.toThrow(/video_intents_stato_tempi_chk/i)

    await expect(db.exec(`
      UPDATE public.video_jobs
      SET status = 'processing'
      WHERE id = '${JOB}'
    `)).rejects.toThrow(/video_jobs_processing_lease_chk/i)

    await expect(db.exec(`
      UPDATE public.video_jobs
      SET status = 'processing',
          lease_owner = '${UTENTE}',
          lease_expires_at = now() + interval '5 minutes'
      WHERE id = '${JOB}'
    `)).resolves.toBeDefined()
  })

  it('rende ready solo un output verificato e programma l’originale a +7 giorni', async () => {
    await expect(db.exec(`
      UPDATE public.video_jobs
      SET probe_json = '{"durationSeconds":180.001}'
      WHERE id = '${JOB}'
    `)).rejects.toThrow(/video_jobs_probe_chk/i)

    await expect(db.exec(`
      UPDATE public.video_jobs
      SET status = 'ready',
          source_size = 1000,
          source_mime = 'video/quicktime',
          output_bucket = 'video_processing',
          output_path = 'outputs/${JOB}/final.mp4',
          output_size = 900,
          probe_json = '{"durationSeconds":12}',
          verified_at = now(),
          original_delete_after = now() + interval '6 days',
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = '${JOB}'
    `)).rejects.toThrow(/video_jobs_ready_chk|video_jobs_original_ttl_chk/i)

    await db.exec(`
      UPDATE public.video_jobs
      SET status = 'ready',
          source_size = 1000,
          source_mime = 'video/quicktime',
          output_bucket = 'video_processing',
          output_path = 'outputs/${JOB}/final.mp4',
          output_size = 900,
          probe_json = '{"durationSeconds":12}',
          verified_at = transaction_timestamp(),
          original_delete_after = transaction_timestamp() + interval '7 days',
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = '${JOB}'
    `)

    expect(await valore<boolean>(`
      SELECT original_delete_after = verified_at + interval '7 days'
      FROM public.video_jobs WHERE id = '${JOB}'
    `)).toBe(true)
  })

  it('rifiuta output parziali e ready con output_bucket NULL', async () => {
    await db.exec(`
      INSERT INTO public.video_intents(
        id, owner_id, scuola_id, channel, requested_action, payload
      ) VALUES (
        '${INTENT_OUTPUT_NULLO}', '${UTENTE}', '${SEDE}', 'gallery',
        'attach_private', '{}'
      )
    `)

    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        id, owner_id, scuola_id, channel, idempotency_key, intent_id,
        original_bucket, original_path, output_path, output_size
      ) VALUES (
        '${JOB_OUTPUT_NULLO}', '${UTENTE}', '${SEDE}', 'gallery',
        'output-bucket-nullo', '${INTENT_OUTPUT_NULLO}',
        'video_originals', 'originals/${JOB_OUTPUT_NULLO}/source',
        'outputs/${JOB_OUTPUT_NULLO}/final.mp4', 900
      )
    `)).rejects.toThrow(/video_jobs_output_chk/i)

    await expect(db.exec(`
      INSERT INTO public.video_jobs(
        id, owner_id, scuola_id, channel, idempotency_key, intent_id,
        status, original_bucket, original_path, source_size, source_mime,
        output_bucket, output_path, output_size, probe_json, verified_at,
        original_delete_after
      ) VALUES (
        '${JOB_OUTPUT_NULLO}', '${UTENTE}', '${SEDE}', 'gallery',
        'ready-bucket-nullo', '${INTENT_OUTPUT_NULLO}',
        'ready', 'video_originals', 'originals/${JOB_OUTPUT_NULLO}/source',
        1000, 'video/quicktime', NULL, 'outputs/${JOB_OUTPUT_NULLO}/final.mp4',
        900, '{"durationSeconds":12}', transaction_timestamp(),
        transaction_timestamp() + interval '7 days'
      )
    `)).rejects.toThrow(/video_jobs_output_chk|video_jobs_ready_chk/i)
  })

  it('consente alla cancellazione di anticipare il cleanup dell’originale', async () => {
    await expect(db.exec(`
      UPDATE public.video_jobs
      SET status = 'cancelled',
          original_delete_after = transaction_timestamp(),
          original_deleted_at = transaction_timestamp() + interval '1 second'
      WHERE id = '${JOB}'
    `)).resolves.toBeDefined()

    expect(await valore<boolean>(`
      SELECT original_delete_after < original_deleted_at
      FROM public.video_jobs WHERE id = '${JOB}'
    `)).toBe(true)
  })

  it('vincola outbox, lease e deduplica evento senza accettare payload estesi', async () => {
    await db.exec(`
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
      VALUES ('${INTENT}', 1, 'video.ready', '{"job_id":"${JOB}"}')
    `)

    await expect(db.exec(`
      UPDATE public.video_intents
      SET revision = 2
      WHERE id = '${INTENT}'
    `)).rejects.toThrow(/video_intents_revision_immutabile/i)

    await expect(db.exec(`
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
      VALUES ('${INTENT}', 1, 'video.ready', '{}')
    `)).rejects.toThrow(/video_outbox_intent_id_revision_event_type_key/i)

    await expect(db.exec(`
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
      VALUES ('${INTENT}', 2, 'video.ready', '{}')
    `)).rejects.toThrow(/video_outbox_intent_revision_fk/i)

    await expect(db.exec(`
      UPDATE public.video_outbox SET lease_owner = '${UTENTE}'
    `)).rejects.toThrow(/video_outbox_lease_chk/i)

    await expect(db.exec(`
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
      VALUES ('${INTENT}', 1, 'video.failed', jsonb_build_object('dati', repeat('x', 5000)))
    `)).rejects.toThrow(/video_outbox_payload_minimo_chk/i)
  })

  /**
   * I due bucket NUOVI nascono a 2 GB; i tre di DOMINIO non vengono sfiorati.
   *
   * Fino al 2026-09-17 la migrazione portava anche `gallery`, `news` e `news_bozze` a
   * 2.000.000.000. Quel numero non abilitava niente — il finalizer che ci deposita un MP4
   * Full HD è V08/V09 e non esiste — e intanto rendeva rosso
   * `__tests__/architecture/bucket-storage-dichiarati.test.ts`, che pretende lo stesso numero
   * in tre fonti: la migrazione, `TETTO_GALLERIA_BYTE` e la ricetta della route multipart.
   *
   * Questo caso è il guardiano di quella scelta: se qualcuno rimette l'`UPDATE`, qui diventa
   * rosso PRIMA che il lock d'architettura se ne accorga, e con un messaggio che dice perché.
   */
  it('porta a 2 GB i due bucket video e lascia intatti i tre di dominio', async () => {
    const bucket = await db.query<{
      id: string
      pubblico: boolean
      limite: number
      mime: string[] | null
    }>(`
      SELECT id, public AS pubblico, file_size_limit::int8 AS limite,
             allowed_mime_types AS mime
      FROM storage.buckets
      WHERE id IN ('gallery', 'news', 'news_bozze', 'video_originals', 'video_processing')
      ORDER BY id
    `)

    expect(bucket.rows).toEqual([
      // I tre di dominio: identici a come li ha lasciati `20260901174336_bucket_gallery_privato_50mb`.
      { id: 'gallery', pubblico: false, limite: 52_428_800, mime: ['image/jpeg', 'video/mp4'] },
      { id: 'news', pubblico: true, limite: 52_428_800, mime: ['image/jpeg', 'video/mp4'] },
      { id: 'news_bozze', pubblico: false, limite: 52_428_800, mime: ['image/jpeg', 'video/mp4'] },
      // I due nuovi: privati, 2 GB, e `mime: null` per scelta — il verdetto sul formato lo dà
      // `ffprobe` dopo il caricamento, non il `Content-Type` che dichiara il client.
      { id: 'video_originals', pubblico: false, limite: 2_000_000_000, mime: null },
      { id: 'video_processing', pubblico: false, limite: 2_000_000_000, mime: null },
    ])
  })

  it('è riapplicabile senza perdere righe e registra il successo con log fail-open', async () => {
    const primoLog = await valore<{ evento: string; contesto: { limite_byte: number } }>(`
      SELECT payload -> 0 FROM public.log_migrazioni LIMIT 1
    `)
    expect(primoLog).toMatchObject({
      evento: 'video-schema-migration',
      contesto: { limite_byte: 2_000_000_000 },
    })

    await db.exec(`
      CREATE OR REPLACE FUNCTION public.app_log_registra(righe jsonb)
      RETURNS int LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'logger guasto'; END $$;
    `)
    await expect(db.exec(MIGRAZIONE)).resolves.toBeDefined()

    expect(await valore<number>(
      `SELECT count(*)::int FROM public.video_jobs WHERE id = '${JOB}'`,
    )).toBe(1)
    expect(await valore<number>(
      `SELECT count(*)::int FROM public.log_migrazioni`,
    )).toBe(1)
  })
})
