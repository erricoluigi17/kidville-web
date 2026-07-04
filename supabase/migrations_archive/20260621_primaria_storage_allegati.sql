-- =============================================================================
-- PRIMARIA — F1.9 Allegati su argomenti/compiti del registro.
-- =============================================================================
-- Limiti applicati in API: PDF ≤10MB, immagini ≤3MB. Il bucket Storage
-- "registro-allegati" è creato/aggiornato dalla route di upload (come gallery).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.allegati_registro (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id    UUID NOT NULL REFERENCES public.registro_orario(id) ON DELETE CASCADE,
  ambito         TEXT NOT NULL DEFAULT 'argomento' CHECK (ambito IN ('argomento', 'compiti')),
  tipo           TEXT NOT NULL CHECK (tipo IN ('pdf', 'immagine')),
  file_url       TEXT NOT NULL,
  file_name      TEXT,
  dimensione_byte BIGINT,
  caricato_da    UUID REFERENCES public.utenti(id),
  creato_il      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_allegati_registro ON public.allegati_registro (registro_id);

ALTER TABLE public.allegati_registro ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service allegati_registro" ON public.allegati_registro;
CREATE POLICY "service allegati_registro" ON public.allegati_registro FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read allegati_registro" ON public.allegati_registro;
CREATE POLICY "read allegati_registro" ON public.allegati_registro FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
