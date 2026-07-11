-- =============================================================================
-- CONTABILITÀ · base fiscale (branch feat/contabilita-merchandise, step A4)
--   • ricevute_numerazione + prossimo_numero_ricevuta(): numerazione atomica
--     delle ricevute per scuola/anno (stesso pattern di fatture_numerazione).
--   • ricevute_emesse: registro ricevute numerate con SNAPSHOT jsonb
--     (intestatario + dati struttura) → il PDF è rigenerabile senza storage.
--     Una sola ricevuta ATTIVA per pagamento (indice parziale); l'annullo
--     brucia il numero e conserva il motivo (registro coerente).
--   • alunni.opposizione_ade: opposizione della famiglia alla comunicazione
--     delle spese scolastiche all'Agenzia delle Entrate (precompilata).
--   • fatture_emesse.bollo_virtuale: bollo assolto in modo virtuale nell'XML.
--   • admin_settings.fiscale_config: dati struttura + bollo (jsonb).
-- Idempotente.
-- =============================================================================

-- --- Numerazione ricevute per scuola/anno ------------------------------------
CREATE TABLE IF NOT EXISTS public.ricevute_numerazione (
  scuola_id     uuid NOT NULL,
  anno          int  NOT NULL,
  ultimo_numero int  NOT NULL DEFAULT 0,
  PRIMARY KEY (scuola_id, anno)
);

CREATE OR REPLACE FUNCTION public.prossimo_numero_ricevuta(p_scuola uuid, p_anno int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_num int;
BEGIN
  INSERT INTO public.ricevute_numerazione (scuola_id, anno, ultimo_numero)
  VALUES (p_scuola, p_anno, 1)
  ON CONFLICT (scuola_id, anno)
  DO UPDATE SET ultimo_numero = public.ricevute_numerazione.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_num;
  RETURN v_num;
END $$;

REVOKE EXECUTE ON FUNCTION public.prossimo_numero_ricevuta(uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prossimo_numero_ricevuta(uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prossimo_numero_ricevuta(uuid, int) TO service_role;

-- --- Registro ricevute emesse -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ricevute_emesse (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pagamento_id       uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  scuola_id          uuid NOT NULL,
  alunno_id          uuid,
  numero             int  NOT NULL,
  anno               int  NOT NULL,
  importo            numeric(10,2) NOT NULL,
  periodo_competenza date,
  metodi             text[] NOT NULL DEFAULT '{}',
  tracciabile        boolean NOT NULL DEFAULT false,
  bollo              boolean NOT NULL DEFAULT false,
  intestatario       jsonb,
  dati_struttura     jsonb,
  annullata_il       timestamptz,
  annullata_da       uuid,
  annullo_motivo     text,
  creato_da          uuid,
  creato_il          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scuola_id, anno, numero)
);

-- Idempotenza dell'emissione: al massimo UNA ricevuta attiva per pagamento.
CREATE UNIQUE INDEX IF NOT EXISTS ricevute_emesse_pagamento_attiva
  ON public.ricevute_emesse (pagamento_id) WHERE annullata_il IS NULL;
CREATE INDEX IF NOT EXISTS idx_ricevute_emesse_scuola
  ON public.ricevute_emesse (scuola_id, anno DESC, numero DESC);

ALTER TABLE public.ricevute_numerazione ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service ricevute_numerazione" ON public.ricevute_numerazione;
CREATE POLICY "service ricevute_numerazione" ON public.ricevute_numerazione
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.ricevute_numerazione TO service_role;

ALTER TABLE public.ricevute_emesse ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service ricevute_emesse" ON public.ricevute_emesse;
CREATE POLICY "service ricevute_emesse" ON public.ricevute_emesse
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.ricevute_emesse TO service_role;

-- --- Colonne di supporto -------------------------------------------------------
ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS opposizione_ade boolean NOT NULL DEFAULT false;
ALTER TABLE public.fatture_emesse
  ADD COLUMN IF NOT EXISTS bollo_virtuale boolean NOT NULL DEFAULT false;
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS fiscale_config jsonb NOT NULL DEFAULT '{}'::jsonb;
