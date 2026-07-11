-- =============================================================================
-- Idempotenza creazione ordine Merchandise (rischio trasversale T2)
--
-- Un doppio click o un retry di rete su POST /api/admin/merch/ordini creava DUE
-- ordini completi + DUE addebiti per lo stesso submit. Il client genera una
-- idempotency_key per invio; il server, sulla violazione dell'indice univoco,
-- ritorna l'ordine già creato invece di duplicarlo.
-- Idempotente.
-- =============================================================================
ALTER TABLE public.divise_ordini ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS divise_ordini_idempotency_key_uq
  ON public.divise_ordini (idempotency_key) WHERE idempotency_key IS NOT NULL;
