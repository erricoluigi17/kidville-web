-- Metodi di pagamento AMMESSI su una voce (decisione del titolare, 2026-10-05):
-- la segreteria dichiara alla creazione se una voce si paga in contanti, con
-- bonifico o in entrambi i modi. Con il solo contanti il genitore non vede IBAN
-- e causale (la decisione si prende a valle dei motori unici di causale e
-- coordinate, non qui).
--
-- Il DEFAULT è «tutti e due», cioè il comportamento di prima: copre da solo
-- le RPC delle rette, i ticket, la composizione e il merchandise, che non
-- nominano la colonna. Nessun backfill: le righe esistenti nascono col default.
ALTER TABLE public.pagamenti
  ADD COLUMN IF NOT EXISTS metodi_ammessi text[] NOT NULL DEFAULT ARRAY['contanti', 'bonifico']::text[];

ALTER TABLE public.pagamenti
  DROP CONSTRAINT IF EXISTS pagamenti_metodi_ammessi_validi;
ALTER TABLE public.pagamenti
  ADD CONSTRAINT pagamenti_metodi_ammessi_validi CHECK (
    cardinality(metodi_ammessi) >= 1
    AND metodi_ammessi <@ ARRAY['contanti', 'bonifico']::text[]
  );

COMMENT ON COLUMN public.pagamenti.metodi_ammessi IS
  'Metodi con cui la voce si può pagare (contanti, bonifico). Senza bonifico il genitore non vede IBAN né causale.';
