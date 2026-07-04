-- =============================================================================
-- PRIMARIA — Fase 3+: firma di ricezione pagella (genitore, OTP/FES)
-- =============================================================================
-- Traccia la presa visione/firma del genitore per la pagella di uno scrutinio.
-- Il genitore deve firmare (OTP email) UNA VOLTA per pagella; dopo la firma può
-- vedere i giudizi a schermo e scaricare il PDF. Lo staff non firma (bypass).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pagella_ricezioni (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrutinio_id UUID NOT NULL REFERENCES public.scrutini(id) ON DELETE CASCADE,
  alunno_id    UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  genitore_id  UUID NOT NULL,
  firmato_il   TIMESTAMPTZ DEFAULT NOW(),
  firma        JSONB,
  UNIQUE (scrutinio_id, alunno_id, genitore_id)
);
CREATE INDEX IF NOT EXISTS idx_pagella_ric_lookup
  ON public.pagella_ricezioni (scrutinio_id, alunno_id, genitore_id);

ALTER TABLE public.pagella_ricezioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service pagella_ricezioni" ON public.pagella_ricezioni;
CREATE POLICY "service pagella_ricezioni" ON public.pagella_ricezioni
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read pagella_ricezioni" ON public.pagella_ricezioni;
CREATE POLICY "read pagella_ricezioni" ON public.pagella_ricezioni
  FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
