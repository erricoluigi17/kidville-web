-- =============================================================================
-- PRIMARIA — Fase 3: scala giudizi sintetici estesa
-- =============================================================================
-- Aggiunge a giudizi_sintetici_scala:
--   - valore_numerico: valore per il calcolo della media matematica delle
--     valutazioni in itinere (mappa etichetta → numero).
--   - giudizio_descrittivo: testo descrittivo associato al "voto", configurabile
--     da impostazioni e applicato in automatico (in itinere e in pagella).
-- Idempotente.
-- =============================================================================

ALTER TABLE public.giudizi_sintetici_scala
  ADD COLUMN IF NOT EXISTS valore_numerico      NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS giudizio_descrittivo TEXT;

-- Backfill valori indicativi per i 6 giudizi ufficiali (editabili da UI).
-- Solo dove non già valorizzato, per non sovrascrivere personalizzazioni.
UPDATE public.giudizi_sintetici_scala s
SET valore_numerico = v.valore
FROM (VALUES
  ('Ottimo', 10), ('Distinto', 9), ('Buono', 8),
  ('Discreto', 7), ('Sufficiente', 6), ('Non sufficiente', 4)
) AS v(etichetta, valore)
WHERE s.etichetta = v.etichetta AND s.valore_numerico IS NULL;

NOTIFY pgrst, 'reload schema';
