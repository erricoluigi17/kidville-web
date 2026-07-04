-- =============================================================================
-- PRIMARIA — Fase 3: obiettivo per materia/classe
-- =============================================================================
-- Associa UN obiettivo di apprendimento a ciascuna materia di ciascuna classe
-- (sezione). L'obiettivo viene mostrato accanto alla disciplina nella pagella.
-- Idempotente.
-- =============================================================================

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

-- RLS (service_role full, authenticated read) — pattern di progetto.
ALTER TABLE public.sezione_materia_obiettivo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service sezione_materia_obiettivo" ON public.sezione_materia_obiettivo;
CREATE POLICY "service sezione_materia_obiettivo" ON public.sezione_materia_obiettivo
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo;
CREATE POLICY "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo
  FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
