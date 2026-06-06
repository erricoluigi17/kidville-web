-- =============================================================================
-- Modulo MENSA — Schedulazione pg_cron del controllo allergie (PRODUZIONE)
-- =============================================================================
-- Ogni mattina richiama /api/mensa/allergie-check tramite pg_net: per le
-- prenotazioni del giorno verifica i conflitti allergia↔menu e avvisa
-- segreteria/cuoca/insegnanti. Idempotente (dedup lato applicazione).
--
-- PREREQUISITI (una tantum, come ruolo con privilegi):
--   ALTER DATABASE postgres SET app.mensa_allergie_url = 'https://<dominio>/api/mensa/allergie-check';
--   ALTER DATABASE postgres SET app.cron_secret        = '<CRON_SECRET di .env>';
--
-- NB: in sviluppo il DB hosted non raggiunge localhost: la verifica avviene
-- comunque alla prenotazione (vedi /api/mensa/prenotazioni).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.mensa_check_allergie_giornaliero()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url    TEXT := current_setting('app.mensa_allergie_url', true);
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

DO $$ BEGIN PERFORM cron.unschedule('mensa-check-allergie'); EXCEPTION WHEN OTHERS THEN null; END $$;
SELECT cron.schedule('mensa-check-allergie', '0 7 * * *', $$ SELECT public.mensa_check_allergie_giornaliero(); $$);

NOTIFY pgrst, 'reload schema';
