-- M5.1 — Gestione submissions builder (piano-app-100)
-- Aggiunge lo stato "gestita" alle submissions del builder ammissioni:
-- gestita_il = quando lo staff l'ha presa in carico, gestita_da = chi.
-- NB: tabella form_submissions (builder), NON forms_submissions (modulistica FEA).

ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS gestita_il TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gestita_da UUID REFERENCES public.utenti(id);

NOTIFY pgrst, 'reload schema';

-- ROLLBACK
-- ALTER TABLE public.form_submissions DROP COLUMN IF EXISTS gestita_da;
-- ALTER TABLE public.form_submissions DROP COLUMN IF EXISTS gestita_il;
