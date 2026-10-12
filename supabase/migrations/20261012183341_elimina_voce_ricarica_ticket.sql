-- =============================================================================
-- ELIMINARE UNA VOCE DI RICARICA TICKET · VOCE E TICKET IN UNA TRANSAZIONE
-- Richiesta del titolare del 2026-10-12: «eliminare pagamenti generati per errore».
--
-- Una ricarica (`ricarica_ticket_mensa`) crea la voce Mensa e accredita SUBITO i
-- ticket. La FK del ledger verso `pagamenti` è SET NULL: cancellare la voce da
-- sola lascerebbe i ticket accreditati senza più nessun debito dietro. Al
-- 12/10 le voci di ricarica non pagate erano 41.
--
-- Questa funzione storna i ticket della ricarica (movimento «rettifica» col
-- delta opposto) e cancella la voce nella STESSA transazione. Se i ticket sono
-- già stati usati (saldo sotto la ricarica) non scrive niente. Un incasso
-- arrivato nel frattempo fa scattare la FK RESTRICT degli incassi e riporta
-- indietro anche lo storno.
--
-- Blocco: lo stesso advisory lock di `ricarica_ticket_mensa`, così una ricarica
-- e un'eliminazione dello stesso bambino non si incrociano; la riga del saldo
-- è presa FOR UPDATE, così un consumo aspetta.
--
-- Solo una funzione: nessuna tabella, nessun indice.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.elimina_voce_ricarica_ticket(
  p_pagamento_id uuid,
  p_operatore    uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_alunno  uuid;
  v_scuola  uuid;
  v_ticket  integer;
  v_saldo   integer;
BEGIN
  SELECT alunno_id INTO v_alunno FROM public.pagamenti WHERE id = p_pagamento_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovata');
  END IF;

  -- 🔒 Lo stesso blocco delle ricariche di questo bambino.
  PERFORM pg_advisory_xact_lock(hashtextextended('ricarica_ticket_mensa:' || v_alunno::text, 0));

  -- Riletta DOPO il blocco, e bloccata: chi è arrivato prima può averla già tolta.
  SELECT alunno_id, scuola_id INTO v_alunno, v_scuola
    FROM public.pagamenti WHERE id = p_pagamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovata');
  END IF;

  SELECT COALESCE(sum(delta), 0)::integer INTO v_ticket
    FROM public.mensa_ticket_movimenti
   WHERE pagamento_id = p_pagamento_id AND tipo = 'ricarica';
  IF v_ticket <= 0 THEN
    RETURN jsonb_build_object('esito', 'senza_ricarica');
  END IF;

  SELECT COALESCE(saldo_ticket, 0) INTO v_saldo
    FROM public.ticket_mensa WHERE alunno_id = v_alunno FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo := 0;
  END IF;
  IF v_saldo < v_ticket THEN
    RETURN jsonb_build_object('esito', 'ticket_gia_usati', 'ticket', v_ticket, 'saldo', v_saldo);
  END IF;

  v_saldo := public.varia_saldo_ticket(v_alunno, -v_ticket);

  INSERT INTO public.mensa_ticket_movimenti
    (alunno_id, scuola_id, tipo, delta, saldo_dopo, pagamento_id, origine, note, creato_da)
  VALUES
    (v_alunno, v_scuola, 'rettifica', -v_ticket, v_saldo, NULL, 'segreteria',
     'Storno ricarica (voce eliminata)', p_operatore);

  DELETE FROM public.pagamenti WHERE id = p_pagamento_id;

  RETURN jsonb_build_object('esito', 'eliminata', 'ticket_tolti', v_ticket, 'saldo_dopo', v_saldo);
END $$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.elimina_voce_ricarica_ticket(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elimina_voce_ricarica_ticket(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.elimina_voce_ricarica_ticket(uuid, uuid) IS
  'Elimina una voce di ricarica ticket mensa stornando i suoi ticket (movimento rettifica) nella stessa transazione; rifiuta se i ticket sono già stati usati. Dal 2026-10-12.';

NOTIFY pgrst, 'reload schema';
