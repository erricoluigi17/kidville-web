-- =============================================================================
-- P3.2 — Sospensione account moroso (DL-021): flag soft per-alunno
-- =============================================================================
-- Sospensione manuale (Direzione) di un alunno per morosità. NON blocca login né
-- letture: inibisce solo le azioni di servizio del genitore (guard applicativi).
-- Idempotente.
-- =============================================================================

ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS sospeso        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sospeso_motivo text,
  ADD COLUMN IF NOT EXISTS sospeso_il     timestamptz,
  ADD COLUMN IF NOT EXISTS sospeso_da     uuid;

NOTIFY pgrst, 'reload schema';
