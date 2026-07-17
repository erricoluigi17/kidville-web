-- =============================================================================
-- MENSA · RPC transazionali ticket (findings m6 / piano D3)
--   branch feat/collaudo-giornata-e2e
--
--   Oggi POST/DELETE di /api/mensa/prenotazioni eseguono TRE scritture separate
--   (saldo `ticket_mensa` · prenotazione `mensa_prenotazioni` · movimento
--   `mensa_ticket_movimenti`). Se l'ultima fallisce, il saldo è già stato
--   scalato/riaccreditato ma il libro mastro NON registra il movimento: saldo e
--   ledger DIVERGONO in silenzio (findings m6).
--
--   Queste due funzioni eseguono saldo + prenotazione + movimento in UN'UNICA
--   transazione tutto-o-niente e ritornano il nuovo saldo. `SECURITY DEFINER`
--   perché la route gira già col service-role e il gate applicativo è a monte
--   (requireUser + legame genitore + assertAlunnoNonSospeso).
--
--   IDEMPOTENTI: se lo stato di destinazione è già raggiunto (già 'prenotato'
--   per scala_ticket_e_prenota; nessuna prenotazione attiva per
--   riaccredita_ticket_e_disdici) la funzione è un no-op e ritorna il saldo
--   corrente — un retry non raddoppia lo scalo/riaccredito.
--
--   Il codice applicativo degrada in modo pulito se queste RPC non esistono
--   ancora (DB E2E CI non migrato → PostgREST PGRST202 / Postgres 42883):
--   fallback al percorso storico a 3 scritture, loggato a livello warn.
--
--   `SET search_path = public` mitiga l'advisor "function_search_path_mutable"
--   (SECURITY DEFINER); ogni oggetto è comunque referenziato schema-qualified.
-- Idempotente (CREATE OR REPLACE).
-- =============================================================================

-- ── POST: scala 1 ticket + prenota + movimento (consumo -1) ──────────────────
CREATE OR REPLACE FUNCTION public.scala_ticket_e_prenota(
  p_alunno_id uuid,
  p_scuola_id uuid,
  p_data      date,
  p_origine   text,
  p_utente_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo   integer;
  v_pren_id uuid;
BEGIN
  -- Idempotenza: se già prenotato per (alunno, data) → no-op, ritorna il saldo corrente.
  PERFORM 1
    FROM public.mensa_prenotazioni
   WHERE alunno_id = p_alunno_id AND data = p_data AND stato = 'prenotato';
  IF FOUND THEN
    SELECT COALESCE(saldo_ticket, 0) INTO v_saldo
      FROM public.ticket_mensa WHERE alunno_id = p_alunno_id;
    RETURN COALESCE(v_saldo, 0);
  END IF;

  -- 1) scala 1 ticket dal saldo autoritativo (upsert).
  INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket, ultimo_carico)
  VALUES (p_alunno_id, -1, now())
  ON CONFLICT (alunno_id) DO UPDATE
    SET saldo_ticket = COALESCE(ticket_mensa.saldo_ticket, 0) - 1,
        ultimo_carico = now()
  RETURNING saldo_ticket INTO v_saldo;

  -- 2) prenotazione 'prenotato' (riusa la riga se esisteva 'disdetto').
  INSERT INTO public.mensa_prenotazioni
    (alunno_id, scuola_id, data, stato, origine, ticket_scalato, prenotato_da)
  VALUES
    (p_alunno_id, p_scuola_id, p_data, 'prenotato', p_origine, 1, p_utente_id)
  ON CONFLICT (alunno_id, data) DO UPDATE
    SET stato = 'prenotato', origine = EXCLUDED.origine,
        ticket_scalato = 1, prenotato_da = EXCLUDED.prenotato_da,
        updated_at = now()
  RETURNING id INTO v_pren_id;

  -- 3) movimento di ledger (consumo -1), snapshot del saldo dopo lo scalo.
  INSERT INTO public.mensa_ticket_movimenti
    (alunno_id, scuola_id, tipo, delta, saldo_dopo, prenotazione_id, origine, data, creato_da)
  VALUES
    (p_alunno_id, p_scuola_id, 'consumo', -1, v_saldo, v_pren_id, p_origine, p_data, p_utente_id);

  RETURN v_saldo;
END;
$$;

-- ── DELETE: riaccredita ticket + disdici + movimento (disdetta +ticket) ───────
CREATE OR REPLACE FUNCTION public.riaccredita_ticket_e_disdici(
  p_alunno_id uuid,
  p_data      date,
  p_utente_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo   integer;
  v_pren_id uuid;
  v_scuola  uuid;
  v_ticket  integer;
BEGIN
  -- Prenotazione attiva da disdire?
  SELECT id, scuola_id, COALESCE(ticket_scalato, 1)
    INTO v_pren_id, v_scuola, v_ticket
    FROM public.mensa_prenotazioni
   WHERE alunno_id = p_alunno_id AND data = p_data AND stato = 'prenotato'
   LIMIT 1;

  -- Idempotenza: nessuna prenotazione attiva → no-op, ritorna il saldo corrente.
  IF v_pren_id IS NULL THEN
    SELECT COALESCE(saldo_ticket, 0) INTO v_saldo
      FROM public.ticket_mensa WHERE alunno_id = p_alunno_id;
    RETURN COALESCE(v_saldo, 0);
  END IF;

  -- 1) riaccredita il ticket scalato (upsert).
  INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket, ultimo_carico)
  VALUES (p_alunno_id, v_ticket, now())
  ON CONFLICT (alunno_id) DO UPDATE
    SET saldo_ticket = COALESCE(ticket_mensa.saldo_ticket, 0) + v_ticket,
        ultimo_carico = now()
  RETURNING saldo_ticket INTO v_saldo;

  -- 2) stato → disdetto.
  UPDATE public.mensa_prenotazioni
     SET stato = 'disdetto', prenotato_da = p_utente_id, updated_at = now()
   WHERE id = v_pren_id;

  -- 3) movimento di ledger (disdetta +ticket), snapshot del saldo riaccreditato.
  INSERT INTO public.mensa_ticket_movimenti
    (alunno_id, scuola_id, tipo, delta, saldo_dopo, prenotazione_id, origine, data, creato_da)
  VALUES
    (p_alunno_id, v_scuola, 'disdetta', v_ticket, v_saldo, v_pren_id, 'disdetta', p_data, p_utente_id);

  RETURN v_saldo;
END;
$$;

-- Solo il service-role (la route admin) può invocare le RPC. In Supabase i ruoli
-- anon/authenticated ricevono EXECUTE via GRANT ESPLICITO (default privileges): il
-- REVOKE ... FROM PUBLIC NON li tocca, quindi vanno revocati esplicitamente — altrimenti
-- le SECURITY DEFINER restano chiamabili in anonimo via /rest/v1/rpc con la sola anon key.
REVOKE ALL ON FUNCTION public.scala_ticket_e_prenota(uuid, uuid, date, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.riaccredita_ticket_e_disdici(uuid, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scala_ticket_e_prenota(uuid, uuid, date, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.riaccredita_ticket_e_disdici(uuid, date, uuid) TO service_role;
