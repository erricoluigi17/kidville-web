-- =============================================================================
-- PUSH (P1) — Funzione di dispatch generico del buffer notifiche
-- =============================================================================
-- Drena il buffer generico della tabella `notifiche`: richiama /api/push/dispatch
-- via pg_net. Finora SOLO i pagamenti avevano un cron → le notifiche bufferizzate
-- (es. valutazioni primaria, enqueueNotifiche con bufferMin) si accodavano ma non
-- partivano mai. Questa funzione + lo schedule (20260733b) completano il servizio
-- "dispatch per evento con buffer 10 min". Stile mensa_check_allergie_giornaliero.
--
-- PREREQUISITI (una tantum, ruolo privilegiato):
--   ALTER DATABASE postgres SET app.push_dispatch_url = 'https://<dominio>/api/push/dispatch';
--   ALTER DATABASE postgres SET app.cron_secret       = '<CRON_SECRET di .env>';
--
-- NB: in sviluppo il DB hosted non raggiunge localhost (no-op se URL vuoto).
-- Idempotente.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notifiche_dispatch_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url    TEXT := current_setting('app.push_dispatch_url', true);
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

NOTIFY pgrst, 'reload schema';
