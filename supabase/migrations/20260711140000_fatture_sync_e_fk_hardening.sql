-- =============================================================================
-- Fatture: numerazione allineata ad Aruba + hardening FK
--   (branch feat/fix-contabilita-merchandise, post-test PR #15)
--
--  • prossimo_numero_fattura_sync(): come prossimo_numero_fattura ma allinea il
--    contatore a GREATEST(interno, ultimo_numero_su_Aruba) PRIMA di incrementare,
--    così il progressivo non si accavalla con fatture emesse anche fuori dalla
--    web app. Il chiamante (lib/aruba/emissione) passa p_min = ultimo numero
--    letto da Aruba (findByUsername); se Aruba è irraggiungibile p_min = 0 e la
--    funzione si comporta come il contatore interno.
--  • ricevute_emesse.pagamento_id: FK da ON DELETE CASCADE a SET NULL (+ nullable)
--    → la cancellazione di un pagamento NON elimina più la ricevuta numerata
--    (niente buchi di numerazione senza traccia; il route DELETE annulla prima
--    la ricevuta attiva). Registro fiscale conservato.
--  • merch_rettifiche.articolo_id: FK da ON DELETE SET NULL a RESTRICT → un
--    articolo con movimenti di magazzino non può essere cancellato, così la
--    matrice giacenze non si corrompe con rettifiche orfane (articolo_id NULL).
-- Idempotente.
-- =============================================================================

-- --- Numerazione fatture allineata ad Aruba ----------------------------------
CREATE OR REPLACE FUNCTION public.prossimo_numero_fattura_sync(p_scuola uuid, p_anno int, p_min int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_num int;
BEGIN
  INSERT INTO public.fatture_numerazione (scuola_id, anno, ultimo_numero)
  VALUES (p_scuola, p_anno, GREATEST(0, COALESCE(p_min, 0)) + 1)
  ON CONFLICT (scuola_id, anno)
  DO UPDATE SET ultimo_numero = GREATEST(public.fatture_numerazione.ultimo_numero, COALESCE(p_min, 0)) + 1
  RETURNING ultimo_numero INTO v_num;
  RETURN v_num;
END $$;

REVOKE EXECUTE ON FUNCTION public.prossimo_numero_fattura_sync(uuid, int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prossimo_numero_fattura_sync(uuid, int, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prossimo_numero_fattura_sync(uuid, int, int) TO service_role;

-- --- ricevute_emesse: FK pagamento_id CASCADE → SET NULL ----------------------
ALTER TABLE public.ricevute_emesse ALTER COLUMN pagamento_id DROP NOT NULL;
ALTER TABLE public.ricevute_emesse DROP CONSTRAINT IF EXISTS ricevute_emesse_pagamento_id_fkey;
ALTER TABLE public.ricevute_emesse
  ADD CONSTRAINT ricevute_emesse_pagamento_id_fkey
  FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE SET NULL;

-- --- merch_rettifiche: FK articolo_id SET NULL → RESTRICT ---------------------
ALTER TABLE public.merch_rettifiche DROP CONSTRAINT IF EXISTS merch_rettifiche_articolo_id_fkey;
ALTER TABLE public.merch_rettifiche
  ADD CONSTRAINT merch_rettifiche_articolo_id_fkey
  FOREIGN KEY (articolo_id) REFERENCES public.divise_articoli(id) ON DELETE RESTRICT;
