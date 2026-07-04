-- =============================================================================
-- PRIMARIA — F1.1 Cataloghi: legame DOCENTE × CLASSE × MATERIA
-- =============================================================================
-- Estende il legame docente↔sezione (utenti_sezioni, che resta canonico per
-- "Le mie classi") con la dimensione MATERIA: supporta la contitolarità e
-- l'isolamento per disciplina (un docente vede/valuta solo le proprie materie).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.utenti_sezioni_materie (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utente_id     UUID NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
  section_id    UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  materia_id    UUID NOT NULL REFERENCES public.materie(id) ON DELETE CASCADE,
  e_contitolare BOOLEAN NOT NULL DEFAULT false,
  creato_il     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (utente_id, section_id, materia_id)
);
CREATE INDEX IF NOT EXISTS idx_usm_utente   ON public.utenti_sezioni_materie (utente_id);
CREATE INDEX IF NOT EXISTS idx_usm_section  ON public.utenti_sezioni_materie (section_id);
CREATE INDEX IF NOT EXISTS idx_usm_materia  ON public.utenti_sezioni_materie (materia_id);

ALTER TABLE public.utenti_sezioni_materie ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service utenti_sezioni_materie" ON public.utenti_sezioni_materie;
CREATE POLICY "service utenti_sezioni_materie" ON public.utenti_sezioni_materie FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read utenti_sezioni_materie" ON public.utenti_sezioni_materie;
CREATE POLICY "read utenti_sezioni_materie" ON public.utenti_sezioni_materie FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
