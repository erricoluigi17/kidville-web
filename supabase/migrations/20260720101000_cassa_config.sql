-- =============================================================================
-- MODULO CASSA · configurazione per sede (admin_settings.cassa_config)
--
--   { fondo?: number, soglia_avviso?: number|null, soglia_notificata_il?: string }
--   - fondo: contante fisso che resta in cassa dopo lo svuotamento (decisione #1)
--   - soglia_avviso: soglia oltre la quale notificare gli admin (decisione #13)
--   - soglia_notificata_il: stato interno anti-spam, scritto SOLO dal server
--     (notifica solo alla transizione sotto→sopra soglia)
--
--   Additivo (ADD COLUMN IF NOT EXISTS). Va applicata DOPO la 20260720100000
--   (l'ordine dei timestamp conta). Il DB E2E CI non è migrato: la colonna
--   assente dà PGRST204 e il codice degrada (shallow-merge in settings/route.ts).
-- =============================================================================

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS cassa_config jsonb NOT NULL DEFAULT '{}'::jsonb;
