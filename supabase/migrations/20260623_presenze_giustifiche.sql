-- =============================================================================
-- PRIMARIA — Giustifiche assenze (genitore) + presa visione (docente)
-- =============================================================================
-- Additivo su public.presenze. Idempotente. Solo primaria (gating applicato lato
-- API in base allo school_type della sezione del figlio).
--   - giustificata        : il genitore ha giustificato l'assenza/ritardo/uscita
--   - giustificazione_testo: motivazione inserita dal genitore
--   - giustificata_da/_il  : chi e quando ha giustificato (genitore)
--   - giust_vista_da/_il   : presa visione del docente
-- =============================================================================

ALTER TABLE public.presenze
  ADD COLUMN IF NOT EXISTS giustificata          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS giustificazione_testo TEXT,
  ADD COLUMN IF NOT EXISTS giustificata_da       UUID,
  ADD COLUMN IF NOT EXISTS giustificata_il       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS giust_vista_da        UUID REFERENCES public.utenti(id),
  ADD COLUMN IF NOT EXISTS giust_vista_il        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_presenze_giustificata ON public.presenze (giustificata);

NOTIFY pgrst, 'reload schema';
