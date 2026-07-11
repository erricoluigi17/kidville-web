-- =============================================================================
-- WORM (Write Once Read Many) sui registri fiscali — conservazione decennale
--   (branch feat/fix-contabilita-merchandise, rischio trasversale T5)
--
-- fatture_emesse e ricevute_emesse sono registri fiscali: una volta inserita la
-- riga, i campi a valenza fiscale (numero, importo, xml, intestatario…) non
-- devono più cambiare né la riga essere cancellata. Restano modificabili solo:
--   • fatture: lo stato SDI (sdi_stato/label/scarto, aruba_filename, pdf_path,
--     inviata_il, aggiornata_il) — aggiornato dal polling/sync;
--   • ricevute: l'annullo (annullata_il/da, annullo_motivo) e l'azzeramento di
--     pagamento_id via ON DELETE SET NULL (il numero resta a registro).
-- I trigger valgono anche per il service-role (enforcement a livello DB).
--
-- Inoltre fatture_emesse.pagamento_id passa da ON DELETE CASCADE a RESTRICT: un
-- pagamento con fattura trasmessa allo SDI non è più cancellabile (prima il
-- cascade avrebbe tentato di eliminare la fattura, ora vietato dal WORM).
-- Idempotente.
-- =============================================================================

-- --- fatture_emesse: solo lo stato SDI è mutabile, niente DELETE ---------------
CREATE OR REPLACE FUNCTION public.worm_fatture_emesse()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fatture_emesse: registro fiscale immodificabile (DELETE non consentito)';
  END IF;
  IF NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.anno IS DISTINCT FROM OLD.anno
     OR NEW.importo IS DISTINCT FROM OLD.importo
     OR NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
     OR NEW.pagamento_id IS DISTINCT FROM OLD.pagamento_id
     OR NEW.xml_inviato IS DISTINCT FROM OLD.xml_inviato
     OR NEW.quota_adult_id IS DISTINCT FROM OLD.quota_adult_id
     OR NEW.progressivo_invio IS DISTINCT FROM OLD.progressivo_invio
     OR NEW.intestatario IS DISTINCT FROM OLD.intestatario
     OR NEW.bollo_virtuale IS DISTINCT FROM OLD.bollo_virtuale
     OR NEW.creato_il IS DISTINCT FROM OLD.creato_il THEN
    RAISE EXCEPTION 'fatture_emesse: campi fiscali immutabili (numero/importo/xml/intestatario): consentito solo l''aggiornamento dello stato SDI';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_worm_fatture_emesse ON public.fatture_emesse;
CREATE TRIGGER trg_worm_fatture_emesse
  BEFORE UPDATE OR DELETE ON public.fatture_emesse
  FOR EACH ROW EXECUTE FUNCTION public.worm_fatture_emesse();

-- --- ricevute_emesse: solo annullo + azzeramento pagamento_id ------------------
CREATE OR REPLACE FUNCTION public.worm_ricevute_emesse()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ricevute_emesse: registro fiscale immodificabile (DELETE non consentito)';
  END IF;
  -- pagamento_id può solo diventare NULL (ON DELETE SET NULL), non altro valore
  IF NEW.pagamento_id IS DISTINCT FROM OLD.pagamento_id AND NEW.pagamento_id IS NOT NULL THEN
    RAISE EXCEPTION 'ricevute_emesse: pagamento_id non modificabile (solo azzeramento alla cancellazione del pagamento)';
  END IF;
  IF NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.anno IS DISTINCT FROM OLD.anno
     OR NEW.importo IS DISTINCT FROM OLD.importo
     OR NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
     OR NEW.alunno_id IS DISTINCT FROM OLD.alunno_id
     OR NEW.metodi IS DISTINCT FROM OLD.metodi
     OR NEW.intestatario IS DISTINCT FROM OLD.intestatario
     OR NEW.dati_struttura IS DISTINCT FROM OLD.dati_struttura
     OR NEW.creato_il IS DISTINCT FROM OLD.creato_il THEN
    RAISE EXCEPTION 'ricevute_emesse: campi fiscali immutabili: consentito solo l''annullo (annullata_il/da/motivo)';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_worm_ricevute_emesse ON public.ricevute_emesse;
CREATE TRIGGER trg_worm_ricevute_emesse
  BEFORE UPDATE OR DELETE ON public.ricevute_emesse
  FOR EACH ROW EXECUTE FUNCTION public.worm_ricevute_emesse();

-- --- fatture_emesse.pagamento_id: CASCADE → RESTRICT --------------------------
ALTER TABLE public.fatture_emesse DROP CONSTRAINT IF EXISTS fatture_emesse_pagamento_id_fkey;
ALTER TABLE public.fatture_emesse
  ADD CONSTRAINT fatture_emesse_pagamento_id_fkey
  FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE RESTRICT;
