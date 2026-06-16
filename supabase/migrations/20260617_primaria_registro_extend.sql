-- =============================================================================
-- PRIMARIA — F1.4 Registro + Appello + Compresenza
-- =============================================================================
-- Estende (additivo, no drop) registro_orario, firme_docenti, note_disciplinari,
-- presenze. Aggiunge registro_destinatari (oscuramento per singoli alunni).
-- Idempotente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. registro_orario: section_id canonico, materia_id, da_orario, vincoli temporali
-- -----------------------------------------------------------------------------
ALTER TABLE public.registro_orario
  ADD COLUMN IF NOT EXISTS section_id  UUID REFERENCES public.sections(id),
  ADD COLUMN IF NOT EXISTS materia_id  UUID REFERENCES public.materie(id),
  ADD COLUMN IF NOT EXISTS da_orario   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_il   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lock_tipo   TEXT;

-- Backfill section_id da classe_sezione (match per nome).
UPDATE public.registro_orario r
SET section_id = s.id
FROM public.sections s
WHERE r.section_id IS NULL
  AND r.classe_sezione IS NOT NULL
  AND lower(replace(s.name, ' ', '')) = lower(replace(r.classe_sezione, ' ', ''));

CREATE INDEX IF NOT EXISTS idx_registro_section_data ON public.registro_orario (section_id, data);

-- -----------------------------------------------------------------------------
-- 2. firme_docenti: cofirma + argomento/compiti propri (firma indipendente)
-- -----------------------------------------------------------------------------
-- Estende il CHECK su tipo_compresenza per includere 'cofirma'.
DO $$ BEGIN
  ALTER TABLE public.firme_docenti DROP CONSTRAINT IF EXISTS firme_docenti_tipo_compresenza_check;
  ALTER TABLE public.firme_docenti
    ADD CONSTRAINT firme_docenti_tipo_compresenza_check
    CHECK (tipo_compresenza IN ('principale', 'sostegno', 'compresenza', 'cofirma'));
EXCEPTION WHEN others THEN null; END $$;

ALTER TABLE public.firme_docenti
  ADD COLUMN IF NOT EXISTS argomento_proprio TEXT,
  ADD COLUMN IF NOT EXISTS compiti_propri    TEXT;

-- -----------------------------------------------------------------------------
-- 3. registro_destinatari: oscuramento di argomento/compiti per singoli alunni
-- -----------------------------------------------------------------------------
-- Se per un (registro, firma) esistono righe destinatari, i contenuti propri di
-- quella firma sono visibili SOLO alle famiglie di quegli alunni.
CREATE TABLE IF NOT EXISTS public.registro_destinatari (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id UUID NOT NULL REFERENCES public.registro_orario(id) ON DELETE CASCADE,
  firma_id    UUID REFERENCES public.firme_docenti(id) ON DELETE CASCADE,
  alunno_id   UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (registro_id, firma_id, alunno_id)
);
CREATE INDEX IF NOT EXISTS idx_registro_dest_registro ON public.registro_destinatari (registro_id);
CREATE INDEX IF NOT EXISTS idx_registro_dest_alunno   ON public.registro_destinatari (alunno_id);

-- -----------------------------------------------------------------------------
-- 4. note_disciplinari: gruppo + oscuramento (coerente con la compresenza)
-- -----------------------------------------------------------------------------
ALTER TABLE public.note_disciplinari
  ADD COLUMN IF NOT EXISTS section_id        UUID REFERENCES public.sections(id),
  ADD COLUMN IF NOT EXISTS nota_gruppo_id    UUID,
  ADD COLUMN IF NOT EXISTS oscurata_ad_altri BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_note_gruppo ON public.note_disciplinari (nota_gruppo_id);

-- -----------------------------------------------------------------------------
-- 5. presenze: section_id + chi registra + nota appello (appello giornaliero)
-- -----------------------------------------------------------------------------
ALTER TABLE public.presenze
  ADD COLUMN IF NOT EXISTS section_id    UUID REFERENCES public.sections(id),
  ADD COLUMN IF NOT EXISTS registrato_da UUID REFERENCES public.utenti(id),
  ADD COLUMN IF NOT EXISTS note_appello  TEXT;

UPDATE public.presenze p
SET section_id = a.section_id
FROM public.alunni a
WHERE p.section_id IS NULL AND a.id = p.alunno_id AND a.section_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_presenze_section_data ON public.presenze (section_id, data);

-- -----------------------------------------------------------------------------
-- 6. RLS per la nuova tabella registro_destinatari
-- -----------------------------------------------------------------------------
ALTER TABLE public.registro_destinatari ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service registro_destinatari" ON public.registro_destinatari;
CREATE POLICY "service registro_destinatari" ON public.registro_destinatari FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read registro_destinatari" ON public.registro_destinatari;
CREATE POLICY "read registro_destinatari" ON public.registro_destinatari FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
