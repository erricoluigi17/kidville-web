-- =============================================================================
-- FEA (DL-001 / DL-007) — Ledger additivo degli slot firmatari
-- =============================================================================
-- Abilita la firma congiunta: 1 riga per slot firmatario di un'entità firmabile
-- (pagella | giustifica | forms | …). Le colonne per-flusso esistenti restano
-- source-of-truth del firmatario primario; questo ledger affianca per valutare
-- la completion policy (default 'any-one' = basta una firma; 'all-required' =
-- richieste tutte). `signer_user_id` SENZA FK: il firmatario è auth.uid() e i
-- genitori vivono su `parents`, non `utenti` (stesso criterio di pagella_ricezioni).
-- Additiva + idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.fea_signatures (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entita_tipo       TEXT NOT NULL,
  entita_id         UUID NOT NULL,
  slot_index        INT  NOT NULL DEFAULT 0,
  signer_user_id    UUID,
  stato             TEXT NOT NULL DEFAULT 'signed' CHECK (stato IN ('pending','signed')),
  completion_policy TEXT NOT NULL DEFAULT 'any-one' CHECK (completion_policy IN ('any-one','all-required')),
  signature_log     JSONB,
  firmato_il        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entita_tipo, entita_id, slot_index)
);
CREATE INDEX IF NOT EXISTS idx_fea_signatures_entita
  ON public.fea_signatures (entita_tipo, entita_id);

ALTER TABLE public.fea_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service fea_signatures" ON public.fea_signatures;
CREATE POLICY "service fea_signatures" ON public.fea_signatures
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read fea_signatures" ON public.fea_signatures;
CREATE POLICY "read fea_signatures" ON public.fea_signatures
  FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
