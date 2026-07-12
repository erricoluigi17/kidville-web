-- =============================================================================
-- NOTIFICHE — Config toggle per tipo + tick cron promemoria giornaliero
-- =============================================================================
-- 1) admin_settings.notifiche_config: { "toggles": { "<tipo>": true|false } }.
--    Chiave assente = notifica ATTIVA (default on). Il catalogo canonico dei
--    tipi è in src/lib/notifiche/tipi.ts; il gate applicativo è
--    isNotificaAbilitata() (fail-open su colonna mancante → DB E2E CI ok).
-- 2) notifiche_promemoria_tick(): clone di notifiche_dispatch_tick() che
--    chiama /api/notifiche/promemoria (moduli non compilati, richieste
--    armadietto, documenti in scadenza). Da schedulare in PROD via SQL editor:
--      SELECT cron.schedule('notifiche-promemoria', '0 6 * * *',
--        $$ SELECT public.notifiche_promemoria_tick(); $$);
--    Prerequisito GUC (una tantum, come app.push_dispatch_url):
--      ALTER DATABASE postgres SET app.notifiche_promemoria_url =
--        'https://kidville-web.vercel.app/api/notifiche/promemoria';
-- =============================================================================

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS notifiche_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.admin_settings.notifiche_config IS
  'Config notifiche per scuola: { "toggles": { "<tipo>": bool } } — chiave assente = attiva. Catalogo tipi in src/lib/notifiche/tipi.ts';

CREATE OR REPLACE FUNCTION public.notifiche_promemoria_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    TEXT := current_setting('app.notifiche_promemoria_url', true);
  v_secret TEXT := current_setting('app.cron_secret', true);
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

ALTER FUNCTION public.notifiche_promemoria_tick() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.notifiche_promemoria_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_promemoria_tick() TO service_role;

NOTIFY pgrst, 'reload schema';
