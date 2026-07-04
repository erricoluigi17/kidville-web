-- =============================================================================
-- PRIMARIA — Valutazioni: campo libero "argomento" al posto degli obiettivi
-- =============================================================================
-- Su richiesta committente, nella valutazione in itinere l'obiettivo di
-- apprendimento è sostituito da un argomento a testo libero. Colonna additiva;
-- la tabella valutazione_obiettivi resta per le valutazioni storiche.
-- =============================================================================

ALTER TABLE public.valutazioni
  ADD COLUMN IF NOT EXISTS argomento TEXT;

NOTIFY pgrst, 'reload schema';
