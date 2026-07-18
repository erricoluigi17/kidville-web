-- =============================================================================
-- OTP Sistema A (iscrizioni/ammissioni) · scadenza 10 minuti  [m4]
--
-- L'OTP di firma del Sistema A (`form_submissions.otp_secret`) non aveva scadenza:
-- restava valido finché non veniva rigenerato o consumato, a differenza del
-- Sistema B (ticket HMAC con TTL 10 min — OTP_TTL_MS in src/lib/auth/otp-ticket.ts).
-- Divergenza sanata: si registra l'orario di generazione del codice e la verifica
-- (PATCH /api/forms/send-otp) lo rifiuta oltre i 10 minuti.
--
-- Additiva ed idempotente. Il codice degrada pulito se la colonna manca (DB E2E CI
-- non migrato): SELECT torna 42703, UPDATE torna PGRST204/42703 → si riprova senza.
-- =============================================================================

ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS otp_generato_il timestamptz;

COMMENT ON COLUMN public.form_submissions.otp_generato_il IS
  'Orario di generazione dell''OTP corrente; la verifica lo rifiuta oltre 10 minuti (m4).';
