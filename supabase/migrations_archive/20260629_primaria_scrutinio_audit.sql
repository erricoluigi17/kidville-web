-- =============================================================================
-- PRIMARIA — Fase 2: estende sblocchi_audit per gli sblocchi di scrutinio.
-- =============================================================================
-- Un dirigente può riaprire uno scrutinio chiuso (override tracciato). Riusa la
-- tabella di audit esistente aggiungendo 'scrutinio' tra le entità ammesse.
-- Idempotente.
-- =============================================================================

ALTER TABLE public.sblocchi_audit DROP CONSTRAINT IF EXISTS sblocchi_audit_entita_tipo_check;
ALTER TABLE public.sblocchi_audit
  ADD CONSTRAINT sblocchi_audit_entita_tipo_check
  CHECK (entita_tipo IN ('registro', 'valutazione', 'nota', 'scrutinio'));

NOTIFY pgrst, 'reload schema';
