-- I due trigger WORM dei registri fiscali con `search_path` fissato.
--
-- PERCHÉ ADESSO. È un WARN che l'advisor di Supabase segnalava da luglio
-- (`function_search_path_mutable` su `worm_fatture_emesse` e `worm_ricevute_emesse`),
-- ed è rimasto aperto perché nessuno stava toccando quelle funzioni. La migrazione
-- `20260809233000_fatture_numerazione_sezionale` ha riscritto `worm_fatture_emesse`
-- per aggiungere `sezionale` all'elenco dei campi immutabili — cioè l'ha ricreata
-- portandosi dietro lo stesso difetto. Chi riscrive una funzione la lascia meglio di
-- come l'ha trovata, o il WARN sopravvive a tutti.
--
-- COSA RISCHIA UNA FUNZIONE SENZA `search_path`. Il corpo risolve i nomi non
-- qualificati (`public.fatture_emesse`, gli operatori, `now()`) usando il
-- `search_path` di CHI la esegue. Un ruolo che anteponga uno schema proprio può
-- far risolvere un nome a un oggetto suo. Su un trigger che sorveglia
-- l'immutabilità di un REGISTRO FISCALE la conseguenza non è teorica: la guardia
-- eseguirebbe qualcosa di diverso da ciò che il testo dice, e il registro
-- resterebbe scrivibile senza che nessun controllo se ne accorga.
--
-- Le funzioni sono identiche a prima: cambia SOLO l'aggiunta di
-- `SET search_path = public, pg_temp`. `pg_temp` va in coda per convenzione — se
-- stesse davanti, un oggetto temporaneo omonimo vincerebbe sul suo equivalente reale.
--
-- Additiva, idempotente, nessun dato toccato.

CREATE OR REPLACE FUNCTION public.worm_fatture_emesse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fatture_emesse: registro fiscale immodificabile (DELETE non consentito)';
  END IF;
  IF NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.anno IS DISTINCT FROM OLD.anno
     OR NEW.sezionale IS DISTINCT FROM OLD.sezionale
     OR NEW.importo IS DISTINCT FROM OLD.importo
     OR NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
     OR NEW.pagamento_id IS DISTINCT FROM OLD.pagamento_id
     OR NEW.xml_inviato IS DISTINCT FROM OLD.xml_inviato
     OR NEW.quota_adult_id IS DISTINCT FROM OLD.quota_adult_id
     OR NEW.progressivo_invio IS DISTINCT FROM OLD.progressivo_invio
     OR NEW.intestatario IS DISTINCT FROM OLD.intestatario
     OR NEW.bollo_virtuale IS DISTINCT FROM OLD.bollo_virtuale
     OR NEW.creato_il IS DISTINCT FROM OLD.creato_il THEN
    RAISE EXCEPTION 'fatture_emesse: campi fiscali immutabili (numero/sezionale/importo/xml/intestatario): consentito solo l''aggiornamento dello stato SDI';
  END IF;
  RETURN NEW;
END $$;

-- ⚠️ Il corpo qui sotto è COPIATO da `pg_get_functiondef` sulla funzione viva, non
-- riscritto a memoria. Due dettagli si sarebbero persi riscrivendola «uguale»:
--   · `pagamento_id` ha una regola PROPRIA — l'azzeramento è permesso (serve
--     all'`ON DELETE SET NULL` della FK verso `pagamenti`), il cambio ad altro
--     valore no. Trattarlo come gli altri campi immutabili avrebbe fatto fallire
--     la cancellazione di un pagamento;
--   · `metodi` è nell'elenco degli immutabili. Ometterlo avrebbe INDEBOLITO il
--     registro mentre la migrazione dichiarava di rinforzarlo.
CREATE OR REPLACE FUNCTION public.worm_ricevute_emesse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ricevute_emesse: registro fiscale immodificabile (DELETE non consentito)';
  END IF;
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
