-- P4/DL-045 — onboarding genitore: marcatore + snapshot consensi GDPR.
ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS consensi_gdpr jsonb;
