-- =============================================================================
-- Legame canonico DOCENTE ↔ SEZIONE  (utenti ↔ sections)
-- =============================================================================
-- Sostituisce gli hack precedenti (src/lib/educator-sections.json, mappe
-- email→sezione hardcoded) con un'unica fonte di verità a DB, basata sulle
-- tabelle REALI del modello live: utenti(id) e sections(id).
--
-- NB: la vecchia educator_sections (20260510) puntava ad `adults`, tabella non
-- presente nel DB live → mai creata. Qui usiamo utenti(id), coerente col resto.
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.utenti_sezioni (
  utente_id   UUID NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
  section_id  UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (utente_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_utenti_sezioni_utente  ON public.utenti_sezioni (utente_id);
CREATE INDEX IF NOT EXISTS idx_utenti_sezioni_section ON public.utenti_sezioni (section_id);

-- RLS: scrittura service-role, lettura agli autenticati (come gli altri legami).
ALTER TABLE public.utenti_sezioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service utenti_sezioni" ON public.utenti_sezioni;
CREATE POLICY "service utenti_sezioni" ON public.utenti_sezioni FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read utenti_sezioni" ON public.utenti_sezioni;
CREATE POLICY "read utenti_sezioni" ON public.utenti_sezioni FOR SELECT TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- Seed dei legami noti (idempotente). Anna→Girasoli, Chiara→Tulipani.
-- Solo se utente e sezione esistono ancora.
-- -----------------------------------------------------------------------------
INSERT INTO public.utenti_sezioni (utente_id, section_id)
SELECT v.utente_id::uuid, v.section_id::uuid
FROM (VALUES
  ('22222222-2222-2222-2222-222222222222', '2c06371c-7b3d-45e2-a3e9-15fa8ec7ab02'), -- Anna  → Girasoli
  ('22222222-2222-2222-2222-333333333333', '25e542d8-7d85-4fe9-ba9d-fe69b78f01ef')  -- Chiara → Tulipani
) AS v(utente_id, section_id)
WHERE EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = v.utente_id::uuid)
  AND EXISTS (SELECT 1 FROM public.sections s WHERE s.id = v.section_id::uuid)
ON CONFLICT (utente_id, section_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
