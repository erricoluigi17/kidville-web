-- 20260765 — Fatture per quota (genitori separati). Aggancia ogni riga
-- fatture_emesse alla quota che rappresenta: quota_adult_id (adult che paga la
-- quota, spazio utenti.id/parents come da resolveParentRegistry), quota_label
-- (etichetta leggibile "Mamma"/"Papà"/nome), parent_registry_id (parents.id
-- risolto per l'intestatario XML). Nullable/idempotente: le righe legacy restano
-- valide (quota unica = quota_adult_id NULL fino al prossimo re-run). Applicata live.
ALTER TABLE public.fatture_emesse
  ADD COLUMN IF NOT EXISTS quota_adult_id     uuid,
  ADD COLUMN IF NOT EXISTS quota_label        text,
  ADD COLUMN IF NOT EXISTS parent_registry_id uuid;
CREATE INDEX IF NOT EXISTS idx_fatture_emesse_pagamento_quota
  ON public.fatture_emesse (pagamento_id, quota_adult_id);
NOTIFY pgrst, 'reload schema';

-- ROLLBACK
-- DROP INDEX IF EXISTS public.idx_fatture_emesse_pagamento_quota;
-- ALTER TABLE public.fatture_emesse
--   DROP COLUMN IF EXISTS quota_adult_id,
--   DROP COLUMN IF EXISTS quota_label,
--   DROP COLUMN IF EXISTS parent_registry_id;
