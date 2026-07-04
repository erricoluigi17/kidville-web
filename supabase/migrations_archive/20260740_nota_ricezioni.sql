-- =============================================================================
-- P2 — Presa visione note disciplinari (genitore, OTP/FES) — DL-014
-- =============================================================================
-- Traccia la firma di presa visione del genitore per una nota disciplinare,
-- con lo stesso pattern della pagella (pagella_ricezioni): firma JSONB =
-- signature_log FEA + slot firmatari (fea_signatures) + audit (fea_audit_log).
-- Il vecchio note_disciplinari.firmata_il resta valorizzato per retro-compat
-- con la GET genitore. Idempotente. Additiva → 0 ERROR advisor atteso.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.nota_ricezioni (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_id     UUID NOT NULL REFERENCES public.note_disciplinari(id) ON DELETE CASCADE,
  alunno_id   UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  genitore_id UUID NOT NULL,
  firmato_il  TIMESTAMPTZ DEFAULT NOW(),
  firma       JSONB,
  UNIQUE (nota_id, genitore_id)
);
CREATE INDEX IF NOT EXISTS idx_nota_ricezioni_lookup
  ON public.nota_ricezioni (nota_id, genitore_id);

ALTER TABLE public.nota_ricezioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service nota_ricezioni" ON public.nota_ricezioni;
CREATE POLICY "service nota_ricezioni" ON public.nota_ricezioni
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read nota_ricezioni" ON public.nota_ricezioni;
CREATE POLICY "read nota_ricezioni" ON public.nota_ricezioni
  FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
