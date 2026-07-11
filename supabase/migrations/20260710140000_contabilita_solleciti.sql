-- =============================================================================
-- CONTABILITÀ · solleciti di pagamento (branch feat/contabilita-merchandise, A9)
--   • solleciti: log di ogni invio (testo effettivo = audit), livello 1-3,
--     manuale o automatico, destinatari con esito.
--   • admin_settings.solleciti_config: enabled (default off), cadenza minima,
--     template per livello con segnaposto {alunno} {descrizione} {importo}
--     {residuo} {scadenza} {scuola} {giorni_ritardo}.
--   L'anti-spam riusa pagamenti.ultimo_sollecito_il (colonna esistente).
--   La vecchia genera_solleciti() SQL resta DEPRECATA e non schedulata:
--   la sostituisce POST /api/pagamenti/solleciti/run (x-cron-secret).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.solleciti (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pagamento_id  uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  scuola_id     uuid NOT NULL,
  alunno_id     uuid,
  livello       smallint NOT NULL CHECK (livello BETWEEN 1 AND 3),
  canale        text NOT NULL DEFAULT 'email' CHECK (canale IN ('email', 'push')),
  destinatari   jsonb NOT NULL DEFAULT '[]',
  oggetto       text,
  corpo         text,
  automatico    boolean NOT NULL DEFAULT false,
  inviato_da    uuid,
  inviato_il    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS solleciti_pagamento_idx ON public.solleciti (pagamento_id, inviato_il DESC);
CREATE INDEX IF NOT EXISTS solleciti_scuola_idx ON public.solleciti (scuola_id, inviato_il DESC);

ALTER TABLE public.solleciti ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service solleciti" ON public.solleciti;
CREATE POLICY "service solleciti" ON public.solleciti TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.solleciti TO service_role;

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS solleciti_config jsonb NOT NULL DEFAULT '{}'::jsonb;
