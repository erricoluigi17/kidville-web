-- =============================================================================
-- OTP Sistema B (FES) · consumo del ticket (uso singolo) + unicità firme  [M5]
--
-- Il ticket HMAC di firma (src/lib/auth/otp-ticket.ts) è STATELESS e riusabile
-- entro i 10 minuti di validità: lo stesso code+ticket poteva essere rigiocato
-- (replay) e produrre più `forms_submissions` firmate sullo stesso (modulo, alunno).
-- Due presidi, indipendenti e complementari:
--   1) STORE dei ticket consumati (`otp_ticket_consumati`): il jti = SHA256(ticket)
--      è inserito alla firma; il replay collide sulla chiave primaria → uso singolo.
--   2) INDICE UNIQUE PARZIALE su forms_submissions(form_id, student_id) WHERE is_signed:
--      ri-firma vietata a livello DB (backstop race-safe, indipendente dallo store).
--
-- Additiva ed idempotente. Prima dell'indice deduplica eventuali firme doppie già
-- presenti (conserva la più recente per coppia). Il codice applicativo degrada
-- pulito se tabella/indice non esistono (DB E2E CI non migrato).
-- =============================================================================

-- 1) Store dei jti/nonce consumati (uso singolo del ticket OTP).
CREATE TABLE IF NOT EXISTS public.otp_ticket_consumati (
  jti       text PRIMARY KEY,
  usato_il  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.otp_ticket_consumati ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service otp_ticket_consumati" ON public.otp_ticket_consumati;
CREATE POLICY "service otp_ticket_consumati" ON public.otp_ticket_consumati
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.otp_ticket_consumati TO service_role;

-- Indice per la pulizia periodica: i nonce oltre il TTL (10 min) non servono più.
CREATE INDEX IF NOT EXISTS otp_ticket_consumati_usato_il_idx
  ON public.otp_ticket_consumati (usato_il);

-- 2) DEDUP delle firme doppie già presenti, coerente con la semantica dell'indice
--    unique che segue: solo le coppie con student_id NON NULL (i NULL restano
--    distinti → firme di onboarding non vincolate). Per ogni (form_id, student_id)
--    con più righe firmate conserva la PIÙ RECENTE ed elimina le altre.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY form_id, student_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.forms_submissions
  WHERE is_signed IS TRUE
    AND student_id IS NOT NULL
)
DELETE FROM public.forms_submissions f
USING ranked r
WHERE f.id = r.id
  AND r.rn > 1;

-- 3) Indice unique parziale: una sola firma per (form_id, student_id).
--    Semantica SQL standard: student_id NULL (onboarding) resta non vincolato.
CREATE UNIQUE INDEX IF NOT EXISTS forms_submissions_firma_unica_idx
  ON public.forms_submissions (form_id, student_id)
  WHERE is_signed;
