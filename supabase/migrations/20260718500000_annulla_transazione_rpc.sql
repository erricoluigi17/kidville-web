-- =============================================================================
-- CONTABILITÀ v2 · ANNULLO ATOMICO DI UNA TRANSAZIONE (correzione ciclo 2)
--
--   BUG (causa radice): l'annullo di una transazione «Incasso unico» che include
--   una RICARICA MENSA stornava incassi ed eccedenza a credito (via transazione_id)
--   ma NON stornava i movimenti mensa: i ticket restavano regalati alla famiglia.
--   `registra_transazione_contabile` scrive TRE classi (incassi, crediti_famiglia,
--   mensa_ticket_movimenti + saldo ticket_mensa); l'annullo ne enumerava solo due.
--
--   Questa RPC è la GEMELLA SPECULARE di registra_transazione_contabile: in UNA
--   transazione (atomica) storna incassi, ricariche mensa (con aggiornamento del
--   saldo ticket_mensa, mai negativo) e l'eventuale eccedenza a credito.
--
--   SECURITY DEFINER, SET search_path = public. La route gira col service-role e il
--   gate applicativo (requireStaff + zod + scope di sede) è a monte. REGRESSIONE
--   NOTA nel progetto: in Supabase anon/authenticated ricevono EXECUTE via GRANT
--   ESPLICITO → il REVOKE ... FROM PUBLIC NON basta: si revoca anche da
--   anon/authenticated e si concede SOLO a service_role.
--
--   Additivo (solo una funzione nuova). Il DB E2E CI non è migrato: la RPC assente
--   dà PGRST202/42883 e la route degrada a 503 pulito SENZA storni parziali.
--
--   ERRCODE dedicati (la route li mappa su HTTP):
--     'KV404' → transazione non trovata            → 404
--     'KV409' → transazione già annullata (race)   → 409
--     'KV410' → credito eccedenza già speso        → 409 (recuperare prima il credito)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.annulla_transazione_contabile(p jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_txid            uuid := (p->>'transazione_id')::uuid;
  v_motivo          text := NULLIF(p->>'motivo', '');
  v_annulla         uuid := NULLIF(p->>'annullato_da', '')::uuid;
  v_scuola          uuid;
  v_pagante         uuid;
  v_annullata_il    timestamptz;
  v_metodo_storno   public.incasso_metodo;
  v_inc             record;
  v_ric             record;
  v_n_inc           int := 0;
  v_n_ric           int := 0;
  v_cred            numeric := 0;
  v_saldo_prec      numeric;
  v_saldo_new       numeric;
  v_ticket_consumati boolean := false;
  v_saldo_ticket    int;
  v_scala           int;
BEGIN
  IF v_txid IS NULL THEN
    RAISE EXCEPTION 'transazione_id obbligatorio';
  END IF;
  IF v_motivo IS NULL OR length(v_motivo) < 3 THEN
    RAISE EXCEPTION 'motivo obbligatorio (min 3 caratteri)';
  END IF;

  -- Lock della transazione (serializza gli annulli concorrenti sulla stessa tx).
  SELECT scuola_id, pagante_parent_id, annullata_il
    INTO v_scuola, v_pagante, v_annullata_il
    FROM public.pagamenti_transazioni
   WHERE id = v_txid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transazione non trovata' USING ERRCODE = 'KV404';
  END IF;
  IF v_annullata_il IS NOT NULL THEN
    RAISE EXCEPTION 'transazione già annullata' USING ERRCODE = 'KV409';
  END IF;

  -- metodo di storno → enum incasso_metodo (fallback 'altro' se non ammesso).
  v_metodo_storno := CASE
    WHEN 'storno' = ANY (enum_range(NULL::public.incasso_metodo)::text[])
      THEN 'storno'::public.incasso_metodo
    ELSE 'altro'::public.incasso_metodo END;

  -- (d/1) VERIFICA credito eccedenza PRIMA di qualunque mutazione: se il credito è
  --       già stato speso l'annullo lascerebbe il saldo negativo → EXCEPTION chiara.
  --       (La funzione è atomica: anche stornando dopo, un raise farebbe rollback;
  --        il controllo anticipato rende il fallimento pulito e leggibile.)
  SELECT COALESCE(SUM(importo), 0) INTO v_cred
    FROM public.crediti_famiglia
   WHERE transazione_id = v_txid AND causale = 'eccedenza';
  v_cred := round(v_cred, 2);
  IF v_cred > 0 THEN
    -- serializza sul parent (stesso pattern di registra_transazione_contabile).
    PERFORM 1 FROM public.parents WHERE id = v_pagante FOR UPDATE;
    SELECT saldo_dopo INTO v_saldo_prec
      FROM public.crediti_famiglia
     WHERE parent_id = v_pagante
     ORDER BY creato_il DESC, id DESC
     LIMIT 1;
    v_saldo_prec := COALESCE(v_saldo_prec, 0);
    IF round(v_saldo_prec, 2) + 0.005 < v_cred THEN
      RAISE EXCEPTION
        'Il credito generato da questa transazione è già stato utilizzato (saldo % < eccedenza %): recupera prima il credito speso, poi riprova.',
        v_saldo_prec, v_cred
        USING ERRCODE = 'KV410';
    END IF;
  END IF;

  -- (b) storna OGNI incasso originale collegato (i contro-incassi/storni si saltano).
  FOR v_inc IN
    SELECT id, pagamento_id, importo, metodo, storno_di, stornato_il
      FROM public.incassi
     WHERE transazione_id = v_txid
     FOR UPDATE
  LOOP
    IF v_inc.importo <= 0
       OR v_inc.metodo = 'storno'::public.incasso_metodo
       OR v_inc.storno_di IS NOT NULL
       OR v_inc.stornato_il IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- contro-incasso NEGATIVO tracciato (storno_di = originale, storno_motivo).
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, storno_di, storno_motivo, note, registrato_da)
    VALUES
      (v_inc.pagamento_id, -v_inc.importo, CURRENT_DATE, v_metodo_storno, v_inc.id, v_motivo,
       'Storno (annullo transazione)', v_annulla);

    -- marca l'originale come stornato.
    UPDATE public.incassi
       SET stornato_il = now(), storno_motivo = v_motivo
     WHERE id = v_inc.id;

    -- ricalcolo stato pagamento (sconto-aware; il trigger su incassi lo fa già,
    -- il PERFORM è difensivo/idempotente).
    PERFORM public.ricalcola_stato_pagamento(v_inc.pagamento_id);
    v_n_inc := v_n_inc + 1;
  END LOOP;

  -- (c) storna OGNI ricarica mensa collegata: movimento inverso 'rettifica' +
  --     aggiornamento del saldo ticket_mensa. Il saldo non scende MAI sotto 0: se i
  --     ticket sono già stati consumati si recupera solo il residuo e si segnala.
  FOR v_ric IN
    SELECT id, alunno_id, scuola_id, delta
      FROM public.mensa_ticket_movimenti
     WHERE transazione_id = v_txid AND tipo = 'ricarica'
     FOR UPDATE
  LOOP
    IF COALESCE(v_ric.delta, 0) <= 0 THEN CONTINUE; END IF;

    -- lock del saldo (0 se la riga non esiste più).
    SELECT COALESCE(saldo_ticket, 0) INTO v_saldo_ticket
      FROM public.ticket_mensa WHERE alunno_id = v_ric.alunno_id FOR UPDATE;
    IF NOT FOUND THEN v_saldo_ticket := 0; END IF;

    -- quanti ticket sono davvero recuperabili senza andare sotto zero.
    v_scala := LEAST(v_ric.delta, v_saldo_ticket);
    IF v_scala < 0 THEN v_scala := 0; END IF;
    IF v_scala < v_ric.delta THEN v_ticket_consumati := true; END IF;

    v_saldo_ticket := v_saldo_ticket - v_scala;

    UPDATE public.ticket_mensa
       SET saldo_ticket = v_saldo_ticket, ultimo_carico = now()
     WHERE alunno_id = v_ric.alunno_id;

    INSERT INTO public.mensa_ticket_movimenti
      (alunno_id, scuola_id, tipo, delta, saldo_dopo, origine, data, note, creato_da, transazione_id)
    VALUES
      (v_ric.alunno_id, COALESCE(v_ric.scuola_id, v_scuola), 'rettifica', -v_scala, v_saldo_ticket,
       'annullo_transazione', CURRENT_DATE,
       CASE WHEN v_scala < v_ric.delta
            THEN 'Storno parziale ricarica (ticket già consumati)'
            ELSE 'Storno ricarica (annullo transazione)' END,
       v_annulla, v_txid);
    v_n_ric := v_n_ric + 1;
  END LOOP;

  -- (d/2) storno effettivo dell'eccedenza a credito (saldo già verificato > = ecc).
  IF v_cred > 0 THEN
    v_saldo_new := GREATEST(round(v_saldo_prec - v_cred, 2), 0);
    INSERT INTO public.crediti_famiglia
      (parent_id, scuola_id, causale, importo, saldo_dopo, transazione_id, creato_da)
    VALUES
      (v_pagante, v_scuola, 'storno', -v_cred, v_saldo_new, v_txid, v_annulla);
  END IF;

  -- (e) marca la transazione annullata (il motivo vive in colonna, non nei log).
  --     NB: la tabella non ha colonna `annullata_da` (verificato sullo schema reale)
  --     → si registra solo annullata_il + annullo_motivo.
  UPDATE public.pagamenti_transazioni
     SET annullata_il = now(), annullo_motivo = v_motivo
   WHERE id = v_txid;

  RETURN jsonb_build_object(
    'incassi_stornati',     v_n_inc,
    'ricariche_stornate',   v_n_ric,
    'credito_stornato',     v_cred,
    'ticket_gia_consumati', v_ticket_consumati
  );
END $$;

-- SICUREZZA RPC: solo service_role (regressione anon/authenticated nota nel progetto).
REVOKE ALL ON FUNCTION public.annulla_transazione_contabile(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.annulla_transazione_contabile(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
