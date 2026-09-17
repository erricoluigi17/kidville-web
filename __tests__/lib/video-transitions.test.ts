// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const SCHEMA = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260916190000_video_jobs.sql'),
  'utf8',
)
const TRANSIZIONI = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260916190100_video_job_transitions.sql'),
  'utf8',
)

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const ALTRO_OWNER = '21000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const JOB = '40000000-0000-4000-8000-000000000004'
const LEASE_A = '50000000-0000-4000-8000-000000000005'
const LEASE_B = '51000000-0000-4000-8000-000000000005'

type Risposta = {
  ok: boolean
  code?: string
  job?: Record<string, unknown>
}

let db: PGlite

async function rpc(sql: string): Promise<Risposta> {
  const risultato = await db.query<{ risultato: Risposta }>(
    `SELECT ${sql} AS risultato`,
  )
  return risultato.rows[0].risultato
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

    INSERT INTO public.schools(id) VALUES ('${SEDE}');
    INSERT INTO auth.users(id) VALUES ('${OWNER}'), ('${ALTRO_OWNER}');
    INSERT INTO public.utenti(id, scuola_id)
    VALUES ('${OWNER}', '${SEDE}'), ('${ALTRO_OWNER}', '${SEDE}');

    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('gallery', 'gallery', false, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news', 'news', true, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news_bozze', 'news_bozze', false, 52428800, ARRAY['image/jpeg', 'video/mp4']);
  `)

  await db.exec(SCHEMA)
  await db.exec(TRANSIZIONI)
  await db.exec(`
    INSERT INTO public.video_intents(
      id, owner_id, scuola_id, channel, requested_action, payload
    ) VALUES (
      '${INTENT}', '${OWNER}', '${SEDE}', 'news', 'publish', '{}'
    );
    INSERT INTO public.video_jobs(
      id, owner_id, scuola_id, channel, idempotency_key, intent_id,
      original_bucket, original_path
    ) VALUES (
      '${JOB}', '${OWNER}', '${SEDE}', 'news', 'video-principale', '${INTENT}',
      'video_originals', 'originals/${JOB}/source'
    );
  `)
}

beforeEach(async () => {
  db = new PGlite()
  await preparaDatabase()
})

afterEach(async () => {
  await db.close()
})

describe('RPC lifecycle job video', () => {
  it('sono SECURITY DEFINER, hanno search_path chiuso e sono eseguibili solo dal service role', async () => {
    const catalogo = await db.query<{
      nome: string
      security_definer: boolean
      configurazione: string[]
    }>(`
      SELECT p.proname AS nome,
             p.prosecdef AS security_definer,
             p.proconfig AS configurazione
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'video_job_uploaded', 'video_job_claim', 'video_job_heartbeat',
          'video_job_ready', 'video_job_fail', 'video_job_cancel'
        )
      ORDER BY p.proname
    `)

    expect(catalogo.rows).toHaveLength(6)
    for (const funzione of catalogo.rows) {
      expect(funzione.security_definer).toBe(true)
      expect(funzione.configurazione).toContain('search_path=pg_catalog')
      expect(await db.query<{ permesso: boolean }>(`
        SELECT has_function_privilege(
          'service_role', p.oid, 'EXECUTE'
        ) AS permesso
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${funzione.nome}'
      `).then(({ rows }) => rows[0].permesso)).toBe(true)
      for (const ruolo of ['anon', 'authenticated']) {
        expect(await db.query<{ permesso: boolean }>(`
          SELECT has_function_privilege(
            '${ruolo}', p.oid, 'EXECUTE'
          ) AS permesso
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '${funzione.nome}'
        `).then(({ rows }) => rows[0].permesso)).toBe(false)
      }
    }
  })

  it('completa upload una sola volta e accetta il retry con gli stessi metadati', async () => {
    const prima = await rpc(
      `public.video_job_uploaded('${JOB}', '${OWNER}', 2000000000, 'video/quicktime')`,
    )
    const seconda = await rpc(
      `public.video_job_uploaded('${JOB}', '${OWNER}', 2000000000, 'video/quicktime')`,
    )

    expect(prima).toMatchObject({ ok: true, job: { status: 'queued' } })
    expect(seconda).toMatchObject({ ok: true, job: { status: 'queued' } })
    expect(await rpc(
      `public.video_job_uploaded('${JOB}', '${OWNER}', 10, 'video/mp4')`,
    )).toEqual({ ok: false, code: 'SOURCE_CONFLICT' })
    expect(await rpc(
      `public.video_job_uploaded('${JOB}', '${OWNER}', 2000000001, 'video/mp4')`,
    )).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('nega owner incrociato e argomenti NULL senza bypassare i controlli', async () => {
    expect(await rpc(
      `public.video_job_uploaded('${JOB}', '${ALTRO_OWNER}', 100, 'video/mp4')`,
    )).toEqual({ ok: false, code: 'OWNER_MISMATCH' })
    expect(await rpc(
      `public.video_job_uploaded('${JOB}', NULL, 100, 'video/mp4')`,
    )).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(
      `public.video_job_claim('${JOB}', NULL, 300)`,
    )).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('claim è idempotente per la lease attiva e limita il TTL a 1800 secondi', async () => {
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    expect(await rpc(
      `public.video_job_claim('${JOB}', '${LEASE_A}', 1801)`,
    )).toEqual({ ok: false, code: 'BAD_INPUT' })

    const prima = await rpc(
      `public.video_job_claim('${JOB}', '${LEASE_A}', 1800)`,
    )
    const seconda = await rpc(
      `public.video_job_claim('${JOB}', '${LEASE_A}', 1800)`,
    )

    expect(prima).toMatchObject({
      ok: true,
      job: { status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_A },
    })
    expect(seconda).toMatchObject({
      ok: true,
      job: { status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_A },
    })
    expect(await rpc(
      `public.video_job_claim('${JOB}', '${LEASE_B}', 300)`,
    )).toEqual({ ok: false, code: 'LEASE_ACTIVE' })
  })

  it('riassegna una lease scaduta e respinge il tentativo precedente tramite fence', async () => {
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${JOB}', '${LEASE_A}', 300)`)
    await db.exec(`
      UPDATE public.video_jobs
      SET lease_expires_at = transaction_timestamp() - interval '1 second'
      WHERE id = '${JOB}'
    `)

    expect(await rpc(
      `public.video_job_heartbeat('${JOB}', 1, '${LEASE_A}')`,
    )).toEqual({ ok: false, code: 'LEASE_EXPIRED' })

    const riacquisito = await rpc(
      `public.video_job_claim('${JOB}', '${LEASE_B}', 300)`,
    )
    expect(riacquisito).toMatchObject({
      ok: true,
      job: { attempt: 2, fence_epoch: 2, lease_owner: LEASE_B },
    })
    expect(await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/stale.mp4', 900,
      '{"durationSeconds":12}'::jsonb
    )`)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
  })

  it('heartbeat rinnova di cinque minuti soltanto una lease ancora valida', async () => {
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${JOB}', '${LEASE_A}', 60)`)
    const primaScadenza = await db.query<{ scadenza: Date }>(`
      SELECT lease_expires_at AS scadenza FROM public.video_jobs WHERE id = '${JOB}'
    `).then(({ rows }) => rows[0].scadenza)

    const risposta = await rpc(
      `public.video_job_heartbeat('${JOB}', 1, '${LEASE_A}')`,
    )
    expect(risposta).toMatchObject({ ok: true, job: { status: 'processing' } })
    const dopo = new Date(String(risposta.job?.lease_expires_at))
    expect(dopo.getTime()).toBeGreaterThan(new Date(primaScadenza).getTime())
  })

  it('ready valida durata e dimensione, è idempotente e fissa il TTL a sette giorni', async () => {
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${JOB}', '${LEASE_A}', 300)`)

    expect(await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/mancante.mp4', 900,
      '{}'::jsonb
    )`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/stringa.mp4', 900,
      '{"durationSeconds":"180"}'::jsonb
    )`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/oltre.mp4', 900,
      '{"durationSeconds":180.001}'::jsonb
    )`)).toEqual({ ok: false, code: 'BAD_INPUT' })

    const prima = await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/final.mp4', 2000000000,
      '{"durationSeconds":180}'::jsonb
    )`)
    const seconda = await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/final.mp4', 2000000000,
      '{"durationSeconds":180}'::jsonb
    )`)

    expect(prima).toMatchObject({
      ok: true,
      job: {
        status: 'ready',
        output_bucket: 'video_processing',
        output_size: 2000000000,
        lease_owner: null,
      },
    })
    expect(seconda).toMatchObject({ ok: true, job: { status: 'ready' } })
    expect(await db.query<{ esatto: boolean }>(`
      SELECT original_delete_after = verified_at + interval '7 days' AS esatto
      FROM public.video_jobs WHERE id = '${JOB}'
    `).then(({ rows }) => rows[0].esatto)).toBe(true)
  })

  it('fail distingue rejected da failed, chiude la lease e assegna TTL separato', async () => {
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${JOB}', '${LEASE_A}', 300)`)

    expect(await rpc(
      `public.video_job_fail('${JOB}', 1, '${LEASE_A}', 'testo libero', true)`,
    )).toEqual({ ok: false, code: 'BAD_INPUT' })

    const risposta = await rpc(
      `public.video_job_fail('${JOB}', 1, '${LEASE_A}', 'DURATION_LIMIT', true)`,
    )
    expect(risposta).toMatchObject({
      ok: true,
      job: { status: 'rejected', error_code: 'DURATION_LIMIT', lease_owner: null },
    })
    expect(await db.query<{ circa_sette_giorni: boolean }>(`
      SELECT original_delete_after BETWEEN
        transaction_timestamp() + interval '6 days 23 hours 59 minutes'
        AND transaction_timestamp() + interval '7 days 1 minute'
        AS circa_sette_giorni
      FROM public.video_jobs WHERE id = '${JOB}'
    `).then(({ rows }) => rows[0].circa_sette_giorni)).toBe(true)
  })

  it('cancel vince sul worker, revoca tutto l’intent ma preserva gli altri job', async () => {
    const altroJob = '41000000-0000-4000-8000-000000000004'
    await db.exec(`
      INSERT INTO public.video_jobs(
        id, owner_id, scuola_id, channel, idempotency_key, intent_id,
        original_bucket, original_path
      ) VALUES (
        '${altroJob}', '${OWNER}', '${SEDE}', 'news', 'secondo-video', '${INTENT}',
        'video_originals', 'originals/${altroJob}/source'
      );
      UPDATE public.video_intents
      SET status = 'confirmed', confirmed_at = transaction_timestamp()
      WHERE id = '${INTENT}';
    `)
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${JOB}', '${LEASE_A}', 300)`)

    const cancellato = await rpc(`public.video_job_cancel('${JOB}', '${OWNER}')`)
    expect(cancellato).toMatchObject({
      ok: true,
      job: { status: 'cancelled', fence_epoch: 2, lease_owner: null },
    })
    expect(await rpc(`public.video_job_ready(
      '${JOB}', 1, '${LEASE_A}', 'outputs/${JOB}/final.mp4', 900,
      '{"durationSeconds":12}'::jsonb
    )`)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })

    expect(await db.query<{ status: string; revocato: boolean }>(`
      SELECT status, revoked_at IS NOT NULL AS revocato
      FROM public.video_intents WHERE id = '${INTENT}'
    `).then(({ rows }) => rows[0])).toEqual({ status: 'cancelled', revocato: true })
    expect(await db.query<{ status: string }>(`
      SELECT status FROM public.video_jobs WHERE id = '${altroJob}'
    `).then(({ rows }) => rows[0].status)).toBe('awaiting_upload')
    expect(await rpc(
      `public.video_job_claim('${altroJob}', '${LEASE_B}', 300)`,
    )).toEqual({ ok: false, code: 'INTENT_INACTIVE' })
  })

  it('non cancella un job appartenente a un intent già pubblicato', async () => {
    await db.exec(`
      UPDATE public.video_intents
      SET status = 'published',
          confirmed_at = transaction_timestamp(),
          published_at = transaction_timestamp()
      WHERE id = '${INTENT}'
    `)

    expect(await rpc(
      `public.video_job_cancel('${JOB}', '${OWNER}')`,
    )).toEqual({ ok: false, code: 'INTENT_PUBLISHED' })
    expect(await db.query<{ status: string }>(`
      SELECT status FROM public.video_jobs WHERE id = '${JOB}'
    `).then(({ rows }) => rows[0].status)).toBe('awaiting_upload')
  })

  it('registra i successi di lifecycle senza rendere il logger vincolante', async () => {
    await rpc(`public.video_job_uploaded('${JOB}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${JOB}', '${LEASE_A}', 300)`)
    expect(await db.query<{ conteggio: number }>(`
      SELECT count(*)::int AS conteggio
      FROM public.log_migrazioni
      WHERE payload::text LIKE '%video-job-%'
    `).then(({ rows }) => rows[0].conteggio)).toBeGreaterThanOrEqual(2)

    await db.exec(`
      CREATE OR REPLACE FUNCTION public.app_log_registra(righe jsonb)
      RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'logger non disponibile';
      END $$
    `)
    await expect(rpc(
      `public.video_job_heartbeat('${JOB}', 1, '${LEASE_A}')`,
    )).resolves.toMatchObject({ ok: true })
  })
})
