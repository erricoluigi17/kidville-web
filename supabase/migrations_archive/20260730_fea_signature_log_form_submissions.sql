-- =============================================================================
-- FEA (DL-001 / DL-010) — signature_log sul path wizard moduli
-- =============================================================================
-- Il wizard live (OtpSignatureModal → /api/forms/send-otp) scrive su
-- `form_submissions` (CANONICA) ma finora NON salvava alcun signature_log.
-- Aggiungiamo la colonna così anche questo flusso registra l'evidenza FES
-- canonica (come `forms_submissions.signature_log` del path legacy).
-- DL-010: `form_submissions` = canonica (wizard + export PDF);
--         `forms_submissions` = legacy (onboarding/persist-submission).
--         Nessuna migrazione dati in P1: i due path restano distinti.
-- Additiva + idempotente.
-- =============================================================================

ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS signature_log JSONB;

NOTIFY pgrst, 'reload schema';
