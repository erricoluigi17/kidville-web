-- =============================================================================
-- PRIMARIA — Fase 3: pubblicazione scrutinio (gate visibilità voti ai genitori)
-- =============================================================================
-- I voti/pagelle di uno scrutinio CHIUSO non sono visibili ai genitori finché il
-- dirigente non dà l'OK (pubblicazione). La generazione dei PDF resta separata
-- dalla pubblicazione: il dirigente può generare/anteprima senza inviare.
-- Idempotente.
-- =============================================================================

ALTER TABLE public.scrutini
  ADD COLUMN IF NOT EXISTS pubblicato    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pubblicato_da UUID REFERENCES public.utenti(id),
  ADD COLUMN IF NOT EXISTS pubblicato_il TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
