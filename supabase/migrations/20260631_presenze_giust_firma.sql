-- =============================================================================
-- PRIMARIA — Fase 2: firma applicativa (FES) sulla giustifica genitore.
-- =============================================================================
-- La giustifica online dell'assenza/ritardo/uscita è ora protetta da conferma
-- OTP email (riuso del flusso FES dei moduli). Tracciamo la firma nel record
-- presenza. Idempotente.
-- =============================================================================

ALTER TABLE public.presenze
  ADD COLUMN IF NOT EXISTS giustificazione_firma JSONB;

NOTIFY pgrst, 'reload schema';
