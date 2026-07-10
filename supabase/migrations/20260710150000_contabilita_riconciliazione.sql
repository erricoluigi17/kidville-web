-- =============================================================================
-- CONTABILITÀ · riconciliazione bancaria da CSV (branch feat/contabilita-merchandise, A11)
--   • riconciliazione_import: testata di ogni import (solo metadati: il file
--     grezzo NON viene salvato — contiene PII bancarie).
--   • riconciliazione_movimenti: accrediti normalizzati con suggerimenti di
--     match (top-3, mai auto-confermati); hash anti re-import per scuola.
--     La conferma crea l'incasso (metodo bonifico) e collega incasso_id.
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.riconciliazione_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id     uuid NOT NULL,
  filename      text,
  righe_totali  int NOT NULL DEFAULT 0,
  caricato_da   uuid,
  caricato_il   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS riconciliazione_import_scuola_idx
  ON public.riconciliazione_import (scuola_id, caricato_il DESC);

CREATE TABLE IF NOT EXISTS public.riconciliazione_movimenti (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        uuid NOT NULL REFERENCES public.riconciliazione_import(id) ON DELETE CASCADE,
  scuola_id        uuid NOT NULL,
  data_operazione  date NOT NULL,
  importo          numeric(10,2) NOT NULL,
  causale          text,
  controparte      text,
  hash_movimento   text NOT NULL,
  stato            text NOT NULL DEFAULT 'da_abbinare'
    CHECK (stato IN ('da_abbinare', 'suggerito', 'confermato', 'ignorato')),
  suggerimenti     jsonb NOT NULL DEFAULT '[]',
  pagamento_id     uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL,
  incasso_id       uuid,
  confermato_da    uuid,
  confermato_il    timestamptz,
  UNIQUE (scuola_id, hash_movimento)
);
CREATE INDEX IF NOT EXISTS riconciliazione_movimenti_stato_idx
  ON public.riconciliazione_movimenti (scuola_id, stato, data_operazione DESC);

ALTER TABLE public.riconciliazione_import ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service riconciliazione_import" ON public.riconciliazione_import;
CREATE POLICY "service riconciliazione_import" ON public.riconciliazione_import
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.riconciliazione_import TO service_role;

ALTER TABLE public.riconciliazione_movimenti ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service riconciliazione_movimenti" ON public.riconciliazione_movimenti;
CREATE POLICY "service riconciliazione_movimenti" ON public.riconciliazione_movimenti
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.riconciliazione_movimenti TO service_role;
