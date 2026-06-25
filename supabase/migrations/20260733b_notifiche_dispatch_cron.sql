-- =============================================================================
-- PUSH (P1) — Schedulazione pg_cron del dispatch generico (PRODUZIONE)
-- =============================================================================
-- Ogni 5 minuti drena il buffer notifiche (notifiche_dispatch_tick → pg_net →
-- /api/push/dispatch). 5 min < buffer 10 min: una notifica accodata parte entro
-- ~5-10 min. Stile 20260606b (cron pagamenti). Applicare esplicitamente in prod
-- (i prerequisiti GUC sono in 20260733). Idempotente.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN PERFORM cron.unschedule('notifiche-dispatch'); EXCEPTION WHEN OTHERS THEN null; END $$;
SELECT cron.schedule('notifiche-dispatch', '*/5 * * * *', $$ SELECT public.notifiche_dispatch_tick(); $$);

NOTIFY pgrst, 'reload schema';
