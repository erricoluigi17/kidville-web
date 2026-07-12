-- =============================================================================
-- CRON CONFIG VIA VAULT — url e secret dei tick pg_cron leggibili senza GUC
-- =============================================================================
-- Su questo progetto `ALTER DATABASE ... SET app.*` è negato anche al ruolo
-- postgres (42501): le GUC previste dal pattern storico (20260733) non sono
-- MAI state configurabili dopo il reset DB → tutti i tick cron erano no-op
-- silenziosi (backlog notifiche mai spedite).
--
-- Nuovo pattern: helper `cron_config(nome)` che legge PRIMA dal Vault
-- (supabase_vault, chiavi omonime: 'app.cron_secret', 'app.push_dispatch_url',
-- 'app.notifiche_promemoria_url', 'app.mensa_allergie_url',
-- 'app.fattura_sync_url') e in fallback dalle GUC (compat con ambienti dove
-- le GUC funzionano). I VALORI si inseriscono una tantum via
--   SELECT vault.create_secret('<valore>', '<nome>');
-- e NON stanno mai nel repo.
--
-- Aggiornate le 4 funzioni tick schedulate/schedulabili:
-- notifiche_dispatch_tick, notifiche_promemoria_tick,
-- mensa_check_allergie_giornaliero, fatture_sdi_sync_tick.
-- (genera_solleciti conserva il nudge inline su GUC: non è schedulata e il
-- dispatch dei 5' copre comunque l'invio.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cron_config(p_nome text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v FROM vault.decrypted_secrets WHERE name = p_nome LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v := NULL; -- vault assente/non leggibile: fallback GUC
  END;
  IF v IS NULL OR v = '' THEN
    v := current_setting(p_nome, true);
  END IF;
  RETURN v;
END $$;

ALTER FUNCTION public.cron_config(text) OWNER TO postgres;
-- Restituisce segreti: mai esposta via PostgREST ai ruoli client.
REVOKE EXECUTE ON FUNCTION public.cron_config(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_config(text) TO service_role;

CREATE OR REPLACE FUNCTION public.notifiche_dispatch_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    TEXT := public.cron_config('app.push_dispatch_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.notifiche_promemoria_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    TEXT := public.cron_config('app.notifiche_promemoria_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.mensa_check_allergie_giornaliero() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_url    TEXT := public.cron_config('app.mensa_allergie_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.fatture_sdi_sync_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_url    text := public.cron_config('app.fattura_sync_url');
  v_secret text := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

NOTIFY pgrst, 'reload schema';
