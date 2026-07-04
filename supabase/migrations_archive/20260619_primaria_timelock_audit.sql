-- =============================================================================
-- PRIMARIA — Vincoli temporali: audit degli sblocchi del dirigente.
-- =============================================================================
-- Il blocco oltre scadenza è calcolato in API (vedi src/lib/primaria/timelock.ts)
-- in base alle scadenze configurabili in admin_settings. Lo sblocco è un override
-- diretto del dirigente, tracciato qui con motivazione (decisione di prodotto).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sblocchi_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entita_tipo  TEXT NOT NULL CHECK (entita_tipo IN ('registro', 'valutazione', 'nota')),
  entita_id    UUID NOT NULL,
  dirigente_id UUID REFERENCES public.utenti(id),
  motivazione  TEXT NOT NULL,
  sbloccato_il TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sblocchi_entita ON public.sblocchi_audit (entita_tipo, entita_id);

ALTER TABLE public.sblocchi_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service sblocchi_audit" ON public.sblocchi_audit;
CREATE POLICY "service sblocchi_audit" ON public.sblocchi_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read sblocchi_audit" ON public.sblocchi_audit;
CREATE POLICY "read sblocchi_audit" ON public.sblocchi_audit FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
