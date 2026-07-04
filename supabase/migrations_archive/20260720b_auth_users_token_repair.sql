-- P0/S5 — Riparazione auth.users seedati via SQL.
-- Alcuni auth.users (staff) sono stati inseriti manualmente con NULL nei campi
-- token che GoTrue si aspetta come stringa vuota. Questo rompe l'admin API
-- (listUsers → "Database error finding users") e va sistemato prima del backfill
-- genitori (S6) e dei login. Fix documentato: NULL → ''. Idempotente.

UPDATE auth.users SET
  confirmation_token         = coalesce(confirmation_token, ''),
  recovery_token             = coalesce(recovery_token, ''),
  email_change               = coalesce(email_change, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
WHERE confirmation_token IS NULL OR recovery_token IS NULL OR email_change IS NULL
   OR email_change_token_new IS NULL OR email_change_token_current IS NULL
   OR phone_change IS NULL OR phone_change_token IS NULL OR reauthentication_token IS NULL;
