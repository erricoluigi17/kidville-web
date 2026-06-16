-- =============================================================================
-- PRIMARIA — Giustifica didattica ("impreparato", giustifica a priori)
-- =============================================================================
-- Dichiarazione di impreparazione, inseribile dal GENITORE in anticipo
-- (origine='genitore') o dal DOCENTE durante la lezione (origine='docente').
-- materia_id opzionale (giustifica generica o riferita a una materia/interrogazione).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.giustifiche_didattiche (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id   UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  section_id  UUID REFERENCES public.sections(id) ON DELETE CASCADE,
  materia_id  UUID REFERENCES public.materie(id) ON DELETE SET NULL,
  data        DATE NOT NULL,
  motivo      TEXT,
  origine     TEXT NOT NULL CHECK (origine IN ('genitore', 'docente')),
  creato_da   UUID,
  creato_il   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giust_did_section_data ON public.giustifiche_didattiche (section_id, data);
CREATE INDEX IF NOT EXISTS idx_giust_did_alunno       ON public.giustifiche_didattiche (alunno_id);

-- RLS coerente con le altre tabelle primaria.
ALTER TABLE public.giustifiche_didattiche ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service giustifiche_didattiche" ON public.giustifiche_didattiche;
CREATE POLICY "service giustifiche_didattiche" ON public.giustifiche_didattiche FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read giustifiche_didattiche" ON public.giustifiche_didattiche;
CREATE POLICY "read giustifiche_didattiche" ON public.giustifiche_didattiche FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
