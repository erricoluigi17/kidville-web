-- =============================================================================
-- CONTABILITÀ v2 · SLICE S7 — schedulazione automatica dei solleciti
-- =============================================================================
-- Il motore d'invio esiste già (src/lib/pagamenti/solleciti-invio.ts) ed è
-- esposto da POST /api/pagamenti/solleciti/run (protetta dall'header
-- x-cron-secret). Mancava SOLO la schedulazione: nessuno chiamava la route,
-- quindi la transizione a «scaduto» e gli avvisi automatici (livelli 1-2; il 3°
-- resta SOLO manuale per costruzione — solleciti-invio.ts:124-127) non
-- partivano mai. Questa migrazione accende il cron giornaliero.
--
-- Pattern Vault identico alle tick esistenti
-- (20260712220000_cron_config_vault.sql): `cron_config()` legge i segreti PRIMA
-- dal Vault e in fallback dalle GUC. Qui NON esiste un segreto dedicato «url del
-- solleciti/run»: si RIUSA l'origine (schema://host) di un URL già configurato
-- (`app.push_dispatch_url`, in fallback `app.notifiche_promemoria_url`),
-- scartandone il path, e vi si riattacca `/api/pagamenti/solleciti/run`. Nessun
-- segreto è scritto nel file: URL e cron secret restano SOLO nel Vault.
--
-- pg_cron è attivo in PRODUZIONE ma NON esiste sul DB E2E della CI: il blocco
-- DO ... EXCEPTION WHEN OTHERS THEN null protegge quel progetto (stesso pattern
-- di 20260713090000_app_log.sql:245).
--
-- Idempotente: la tick è CREATE OR REPLACE, lo schedule fa unschedule-se-presente
-- + schedule, l'enable è un merge NON distruttivo su solleciti_config.
-- =============================================================================

-- 1) TICK — battito che bussa alla route dei solleciti (fire-and-forget).
CREATE OR REPLACE FUNCTION public.pagamenti_solleciti_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Fallback: se il primo URL non è configurato, prova un altro endpoint già
  -- impostato — serve SOLO per ricavarne l'origine (schema://host).
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    RETURN; -- nessun URL configurato: no-op silenzioso, come le tick esistenti
  END IF;
  -- Origine = schema://host[:porta], scartando il path dell'endpoint sorgente.
  v_origin := substring(v_base FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    RETURN;
  END IF;
  v_url := v_origin || '/api/pagamenti/solleciti/run';
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

-- SECURITY DEFINER come postgres (come cron_config): può decifrare il Vault
-- tramite cron_config() e invocare net.http_post.
ALTER FUNCTION public.pagamenti_solleciti_tick() OWNER TO postgres;

-- Innesca net.http_post con il cron secret: mai esposta ai ruoli client.
-- In Supabase anon/authenticated ricevono EXECUTE via GRANT esplicito, NON via
-- PUBLIC: il REVOKE dal solo PUBLIC NON basta (regressione RPC mensa 2026-07-18).
REVOKE ALL ON FUNCTION public.pagamenti_solleciti_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pagamenti_solleciti_tick() TO service_role;

-- 2) SCHEDULE — ogni mattina alle 06:00 UTC. Idempotente (unschedule-se-presente).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pagamenti-solleciti-run';
  PERFORM cron.schedule('pagamenti-solleciti-run', '0 6 * * *', $cron$ SELECT public.pagamenti_solleciti_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- 3) ENABLE per la sede di produzione (Kidville Giugliano). Merge NON distruttivo:
-- le altre chiavi di solleciti_config (cadenza_min_giorni, livelli, testi) restano.
UPDATE public.admin_settings
   SET solleciti_config = COALESCE(solleciti_config, '{}'::jsonb) || jsonb_build_object('enabled', true)
 WHERE scuola_id = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529';

NOTIFY pgrst, 'reload schema';
