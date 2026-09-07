-- =============================================================================
-- MENSA · il saldo ticket si varia in modo ATOMICO
--   branch feat/contabilita-ticket-cassa-generazione
--
--   `POST /api/pagamenti/ticket` leggeva `ticket_mensa.saldo_ticket` e lo
--   riscriveva per valore assoluto (`cur + pezzi`). È un read-modify-write: due
--   scritture concorrenti — due click sul bottone «Aggiungi ticket», oppure un
--   click e una transazione del wizard — leggono lo stesso valore e scrivono lo
--   stesso risultato.
--
--   Il danno NON è «saldo doppio», ed è la ragione per cui questa migrazione
--   esiste: è **saldo singolo e incasso doppio**. Nascono due righe in
--   `pagamenti` e due in `incassi`, ma il saldo sale una volta sola. La cassa
--   non quadra e il numero che l'operatore guarda sembra a posto.
--
--   Le altre due strade che toccano lo stesso numero lo fanno già in modo
--   atomico, e questa funzione non inventa niente: copia la loro forma.
--     · `scala_ticket_e_prenota`      (20260717212758) — consumo
--     · `registra_transazione_contabile` (20260718201000) — ricarica dal wizard
--   Erano due su tre. Questa è la terza.
--
--   `SECURITY DEFINER` perché la route gira già col service-role e il gate
--   applicativo è a monte (`requireStaff` + `assertAlunnoInScope`).
--   `SET search_path = public` mitiga l'advisor "function_search_path_mutable".
--
--   Il codice applicativo DEGRADA in modo pulito se questa RPC non esiste
--   ancora (DB E2E della CI, non migrato → PostgREST `PGRST202` / Postgres
--   `42883`): fallback al percorso storico, loggato a livello warn. Un errore
--   diverso da quei due NON degrada: risponde 500, perché «la funzione non c'è»
--   e «la funzione è fallita» sono due cose diverse e confonderle nasconde i
--   guasti veri.
--
--   Idempotente (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.varia_saldo_ticket(
  p_alunno_id uuid,
  p_delta     integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo integer;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'varia_saldo_ticket: delta 0 non ha senso';
  END IF;

  -- `ultimo_carico` significa «ultima RICARICA»: un decremento (consumo, o il
  -- rientro di una ricarica il cui pagamento non è nato) non lo tocca, o la
  -- colonna smetterebbe di dire ciò che il suo nome promette.
  INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket, ultimo_carico)
  VALUES (p_alunno_id, p_delta, CASE WHEN p_delta > 0 THEN now() ELSE NULL END)
  ON CONFLICT (alunno_id) DO UPDATE
    SET saldo_ticket  = COALESCE(ticket_mensa.saldo_ticket, 0) + p_delta,
        ultimo_carico = CASE WHEN p_delta > 0 THEN now() ELSE ticket_mensa.ultimo_carico END
  RETURNING saldo_ticket INTO v_saldo;

  RETURN v_saldo;
END;
$$;

COMMENT ON FUNCTION public.varia_saldo_ticket(uuid, integer) IS
  'Varia il saldo ticket mensa di un delta, in modo atomico. Ritorna il saldo dopo. Unico modo corretto di toccare ticket_mensa.saldo_ticket da codice applicativo.';

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon`/`authenticated` ricevono
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
-- Precedente: 20260803203201, applicata con `success` senza cambiare nulla
-- proprio perché revocava solo a PUBLIC.
REVOKE ALL ON FUNCTION public.varia_saldo_ticket(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.varia_saldo_ticket(uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated',
--          'public.varia_saldo_ticket(uuid,integer)', 'EXECUTE');   -- false
--   select has_function_privilege('anon',
--          'public.varia_saldo_ticket(uuid,integer)', 'EXECUTE');   -- false
--   select has_function_privilege('service_role',
--          'public.varia_saldo_ticket(uuid,integer)', 'EXECUTE');   -- true
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.varia_saldo_ticket(uuid, integer);
--   Il codice applicativo torna da solo al percorso storico (fallback 42883).
