-- =============================================================================
-- SEZIONE «NEWS» · schedulazione cron
--
-- Due battiti che bussano a POST /api/news/cron/run (protetta da x-cron-secret):
--   · news_tick()        job "tick"   ogni 10' — promuove le programmate scadute
--                                     a pubblicate (+ notifica) e fa l'health-check
--                                     degli embed Instagram.
--   · news_digest_tick() job "digest" alle 08:00 del 1° del mese — genera e invia
--                                     il digest del mese precedente a tutte le sedi.
--
-- Pattern Vault IDENTICO a 20260718400000_pagamenti_solleciti_cron.sql:
-- `cron_config()` legge i segreti dal Vault (fallback GUC); si RIUSA l'origine di
-- `app.push_dispatch_url` (fallback `app.notifiche_promemoria_url`), scartandone il
-- path, e vi si riattacca `/api/news/cron/run`. Nessun segreto nel file.
--
-- pg_cron è attivo in PRODUZIONE ma NON esiste sul DB E2E della CI: il blocco
-- DO ... EXCEPTION WHEN OTHERS THEN null protegge quel progetto.
--
-- SECURITY DEFINER (come cron_config, può decifrare il Vault e invocare
-- net.http_post): in Supabase anon/authenticated ricevono EXECUTE via GRANT
-- esplicito, NON via PUBLIC — il REVOKE dal solo PUBLIC NON basta (regressione RPC
-- mensa 2026-07-18). Perciò REVOKE ... FROM PUBLIC, anon, authenticated + GRANT a
-- service_role. Il lock security-definer-revoke-lock.test.ts lo verifica.
-- =============================================================================

-- 1) TICK "tick" — battito ogni 10 minuti.
CREATE OR REPLACE FUNCTION public.news_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    RETURN; -- nessun URL configurato: no-op silenzioso
  END IF;
  v_origin := substring(v_base FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    RETURN;
  END IF;
  v_url := v_origin || '/api/news/cron/run';
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{"job":"tick"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

ALTER FUNCTION public.news_tick() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.news_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.news_tick() TO service_role;

-- 2) TICK "digest" — battito mensile.
CREATE OR REPLACE FUNCTION public.news_digest_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    RETURN;
  END IF;
  v_origin := substring(v_base FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    RETURN;
  END IF;
  v_url := v_origin || '/api/news/cron/run';
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{"job":"digest"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

ALTER FUNCTION public.news_digest_tick() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.news_digest_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.news_digest_tick() TO service_role;

-- 3) SCHEDULE — idempotente (unschedule-se-presente). Protetto per il DB CI senza pg_cron.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'news-tick';
  PERFORM cron.schedule('news-tick', '*/10 * * * *', $cron$ SELECT public.news_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'news-digest';
  PERFORM cron.schedule('news-digest', '0 8 1 * *', $cron$ SELECT public.news_digest_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;

NOTIFY pgrst, 'reload schema';
