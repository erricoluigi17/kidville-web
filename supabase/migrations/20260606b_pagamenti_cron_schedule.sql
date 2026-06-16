-- =============================================================================
-- Modulo PAGAMENTI — Schedulazione pg_cron (DA APPLICARE IN PRODUZIONE)
-- =============================================================================
-- Installa pg_cron e pianifica i job. APPLICARE ESPLICITAMENTE quando si
-- attivano le automazioni in produzione (non in sviluppo: il DB hosted non
-- raggiunge localhost per il dispatch push).
--
-- PREREQUISITI (una tantum, come ruolo con privilegi):
--   ALTER DATABASE postgres SET app.push_dispatch_url = 'https://<dominio>/api/push/dispatch';
--   ALTER DATABASE postgres SET app.cron_secret       = '<CRON_SECRET di .env.local>';
--
--   * rette mensili: 1° del mese alle 06:00
--   * solleciti: ogni 6 ore
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN PERFORM cron.unschedule('genera-rette-mensili'); EXCEPTION WHEN OTHERS THEN null; END $$;
DO $$ BEGIN PERFORM cron.unschedule('genera-solleciti');     EXCEPTION WHEN OTHERS THEN null; END $$;

SELECT cron.schedule('genera-rette-mensili', '0 6 1 * *', $$ SELECT public.genera_rette_mensili(); $$);
SELECT cron.schedule('genera-solleciti',     '0 */6 * * *', $$ SELECT public.genera_solleciti(); $$);
