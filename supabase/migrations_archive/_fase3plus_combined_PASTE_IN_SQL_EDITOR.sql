-- =============================================================================
-- PRIMARIA — FASE 3+ COMBINATA (da incollare nel Supabase SQL Editor)
-- =============================================================================
-- Applicare DOPO la Fase 2 (_fase2_combined_PASTE_IN_SQL_EDITOR.sql).
-- Include, in ordine: 20260632, 20260633, 20260634, 20260635, 20260636.
-- Tutto idempotente. Eseguibile più volte senza danni.
-- =============================================================================


-- ===== 20260632_giudizi_scala_estesa =======================================
ALTER TABLE public.giudizi_sintetici_scala
  ADD COLUMN IF NOT EXISTS valore_numerico      NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS giudizio_descrittivo TEXT;

UPDATE public.giudizi_sintetici_scala s
SET valore_numerico = v.valore
FROM (VALUES
  ('Ottimo', 10), ('Distinto', 9), ('Buono', 8),
  ('Discreto', 7), ('Sufficiente', 6), ('Non sufficiente', 4)
) AS v(etichetta, valore)
WHERE s.etichetta = v.etichetta AND s.valore_numerico IS NULL;


-- ===== 20260633_sezione_materia_obiettivo ===================================
CREATE TABLE IF NOT EXISTS public.sezione_materia_obiettivo (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id   UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  materia_id   UUID NOT NULL REFERENCES public.materie(id) ON DELETE CASCADE,
  obiettivo_id UUID NOT NULL REFERENCES public.obiettivi_apprendimento(id) ON DELETE CASCADE,
  creato_il    TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (section_id, materia_id)
);
CREATE INDEX IF NOT EXISTS idx_sez_mat_ob_section ON public.sezione_materia_obiettivo (section_id);

DROP TRIGGER IF EXISTS trg_sez_mat_ob_updated_at ON public.sezione_materia_obiettivo;
CREATE TRIGGER trg_sez_mat_ob_updated_at
  BEFORE UPDATE ON public.sezione_materia_obiettivo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.sezione_materia_obiettivo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service sezione_materia_obiettivo" ON public.sezione_materia_obiettivo;
CREATE POLICY "service sezione_materia_obiettivo" ON public.sezione_materia_obiettivo
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo;
CREATE POLICY "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo
  FOR SELECT TO authenticated USING (true);


-- ===== 20260634_scrutinio_pubblicazione =====================================
ALTER TABLE public.scrutini
  ADD COLUMN IF NOT EXISTS pubblicato    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pubblicato_da UUID REFERENCES public.utenti(id),
  ADD COLUMN IF NOT EXISTS pubblicato_il TIMESTAMPTZ;


-- ===== 20260635_scrutinio_giudizio_descrittivo ==============================
CREATE TABLE IF NOT EXISTS public.scrutinio_giudizio_descrittivo (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id            UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  livello              INTEGER NOT NULL CHECK (livello BETWEEN 1 AND 5),
  materia_codice       TEXT NOT NULL,
  periodo_id           UUID NOT NULL REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE,
  etichetta_voto       TEXT NOT NULL,
  giudizio_descrittivo TEXT NOT NULL,
  creato_il            TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, livello, materia_codice, periodo_id, etichetta_voto)
);
CREATE INDEX IF NOT EXISTS idx_scrut_giud_descr_lookup
  ON public.scrutinio_giudizio_descrittivo (scuola_id, livello, materia_codice, periodo_id);

DROP TRIGGER IF EXISTS trg_scrut_giud_descr_updated_at ON public.scrutinio_giudizio_descrittivo;
CREATE TRIGGER trg_scrut_giud_descr_updated_at
  BEFORE UPDATE ON public.scrutinio_giudizio_descrittivo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.scrutinio_giudizio_descrittivo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo;
CREATE POLICY "service scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo;
CREATE POLICY "read scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo
  FOR SELECT TO authenticated USING (true);


-- ===== 20260636_pagella_ricezioni ===========================================
CREATE TABLE IF NOT EXISTS public.pagella_ricezioni (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrutinio_id UUID NOT NULL REFERENCES public.scrutini(id) ON DELETE CASCADE,
  alunno_id    UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  genitore_id  UUID NOT NULL,
  firmato_il   TIMESTAMPTZ DEFAULT NOW(),
  firma        JSONB,
  UNIQUE (scrutinio_id, alunno_id, genitore_id)
);
CREATE INDEX IF NOT EXISTS idx_pagella_ric_lookup
  ON public.pagella_ricezioni (scrutinio_id, alunno_id, genitore_id);

ALTER TABLE public.pagella_ricezioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service pagella_ricezioni" ON public.pagella_ricezioni;
CREATE POLICY "service pagella_ricezioni" ON public.pagella_ricezioni
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read pagella_ricezioni" ON public.pagella_ricezioni;
CREATE POLICY "read pagella_ricezioni" ON public.pagella_ricezioni
  FOR SELECT TO authenticated USING (true);


NOTIFY pgrst, 'reload schema';
