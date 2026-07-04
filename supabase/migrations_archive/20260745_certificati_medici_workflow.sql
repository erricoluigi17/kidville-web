-- =============================================================================
-- P3.3d — Certificato medico self-service (DL-027)
-- =============================================================================
-- La tabella certificati_medici di 20260526 non era applicata in live (drift) e
-- aveva `caricato_da` FK ad auth.users + `giorni_coperti DATE[]`. Qui si crea lo
-- schema CORRETTO per il workflow: copertura come periodo (data_inizio/data_fine),
-- stato di validazione, tracciamento validatore; `caricato_da` senza FK (l'app
-- identifica il genitore via sessione). Bucket privato per i file (dato sanitario).
-- Nessun sollecito automatico (scelta di prodotto). Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.certificati_medici (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id        uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  file_path        text NOT NULL,
  data_inizio      date,
  data_fine        date,
  stato            text NOT NULL DEFAULT 'in_validazione',
  caricato_da      uuid,
  note             text,
  validato_da      uuid,
  validato_il      timestamptz,
  nota_validazione text,
  creato_il        timestamptz DEFAULT now()
);

-- Allineamento difensivo verso un eventuale schema vecchio (drift)
ALTER TABLE public.certificati_medici
  ADD COLUMN IF NOT EXISTS data_inizio      date,
  ADD COLUMN IF NOT EXISTS data_fine        date,
  ADD COLUMN IF NOT EXISTS stato            text NOT NULL DEFAULT 'in_validazione',
  ADD COLUMN IF NOT EXISTS validato_da      uuid,
  ADD COLUMN IF NOT EXISTS validato_il      timestamptz,
  ADD COLUMN IF NOT EXISTS nota_validazione text;

DO $$ BEGIN
  ALTER TABLE public.certificati_medici
    ADD CONSTRAINT certificati_medici_stato_chk
    CHECK (stato IN ('in_validazione', 'validato', 'rifiutato'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS idx_certificati_medici_alunno ON public.certificati_medici(alunno_id);
CREATE INDEX IF NOT EXISTS idx_certificati_medici_stato  ON public.certificati_medici(stato);

ALTER TABLE public.certificati_medici ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS certificati_medici_staff_read ON public.certificati_medici;
CREATE POLICY certificati_medici_staff_read ON public.certificati_medici
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.utenti u
    WHERE u.id = (SELECT auth.uid()) AND u.ruolo IN ('admin', 'coordinator', 'segreteria', 'educator')
  ));

-- Bucket privato per i certificati (dato particolare/sanitario)
INSERT INTO storage.buckets (id, name, public)
VALUES ('certificati-medici', 'certificati-medici', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
