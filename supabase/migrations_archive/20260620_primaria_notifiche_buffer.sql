-- =============================================================================
-- PRIMARIA — F1.8 Buffer notifiche: invio programmato (es. +10 min per le
-- valutazioni). Il dispatch invia solo le notifiche il cui orario è arrivato.
-- =============================================================================
-- Idempotente.
-- =============================================================================

ALTER TABLE public.notifiche
  ADD COLUMN IF NOT EXISTS invio_programmato_il TIMESTAMPTZ;

-- Indice per il dispatch: notifiche non inviate e con orario raggiunto.
CREATE INDEX IF NOT EXISTS idx_notifiche_programmato
  ON public.notifiche (invio_programmato_il)
  WHERE push_inviata_il IS NULL;

NOTIFY pgrst, 'reload schema';
