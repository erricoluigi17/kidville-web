-- =============================================================================
-- FEA (DL-009) — Audit immutabile degli eventi di firma
-- =============================================================================
-- Evidenza FES (CAD Art. 20 / DPR 445/2000) di TUTTI i flussi di firma in un
-- unico log interrogabile. Immutabile: solo INSERT/SELECT (nessuna policy
-- UPDATE/DELETE), come audit_scritture_docente. Additiva + idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.fea_audit_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entita_tipo    TEXT NOT NULL,
  entita_id      UUID,
  signer_user_id UUID,
  email          TEXT,
  evento         TEXT NOT NULL CHECK (evento IN ('otp_sent','signed','verify_failed')),
  hash           TEXT,
  ip             TEXT,
  user_agent     TEXT,
  creato_il      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fea_audit_entita
  ON public.fea_audit_log (entita_tipo, entita_id);
CREATE INDEX IF NOT EXISTS idx_fea_audit_signer
  ON public.fea_audit_log (signer_user_id, creato_il DESC);

ALTER TABLE public.fea_audit_log ENABLE ROW LEVEL SECURITY;
-- Immutabile: service_role può inserire/leggere, authenticated può solo leggere.
DROP POLICY IF EXISTS "service insert fea_audit" ON public.fea_audit_log;
CREATE POLICY "service insert fea_audit" ON public.fea_audit_log
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS "service read fea_audit" ON public.fea_audit_log;
CREATE POLICY "service read fea_audit" ON public.fea_audit_log
  FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS "auth read fea_audit" ON public.fea_audit_log;
CREATE POLICY "auth read fea_audit" ON public.fea_audit_log
  FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
