-- =============================================================================
-- QUOTE DI UN PAGAMENTO DIVISO · SI AGGIORNANO, NON SI CANCELLANO E REINSERISCONO
-- Fase 5 della roadmap di robustezza («Soldi corretti», problema D5-A).
--
-- PRIMA: `POST/PATCH /api/pagamenti/quote` cancellava TUTTE le quote del
-- pagamento e le reinseriva. Ogni quota rinasceva con un id nuovo, e la FK
-- `incassi.quota_id … ON DELETE SET NULL` staccava in silenzio ogni incasso già
-- registrato su una quota: l'incasso restava, ma non si sapeva più di chi fosse.
-- Lo stesso id è quello che il genitore usa per vedere la propria parte. E le due
-- scritture erano separate: se l'INSERT falliva dopo la DELETE, il pagamento
-- restava senza quote.
--
-- ORA: una transazione sola, con la riga del pagamento bloccata (FOR UPDATE).
-- La quota di un adulto che resta viene AGGIORNATA (stesso id, incassi ancora
-- collegati); si inseriscono solo gli adulti nuovi; si tolgono solo gli adulti
-- che non ci sono più, e mai se hanno incassi collegati (esito
-- `quota_con_incassi`, nessuna scrittura). La somma deve coincidere con
-- l'importo, come prima.
--
-- Le quote tolte finiscono comunque nella scatola nera (trigger su
-- `pagamenti_quote`). Solo funzioni: nessuna tabella, policy o indice.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.aggiorna_quote_pagamento(
  p_pagamento_id uuid,
  p_quote        jsonb,
  p_utente_id    uuid DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_pag       record;
  v_q         jsonb;
  v_aid       uuid;
  v_imp       numeric(10,2);
  v_somma     numeric(10,2) := 0;
  v_adulti    uuid[] := '{}';
  v_prima     jsonb;
  v_bloccate  jsonb;
  v_tolte     int := 0;
  v_dopo      jsonb;
BEGIN
  IF p_quote IS NULL OR jsonb_typeof(p_quote) <> 'array' OR jsonb_array_length(p_quote) < 2 THEN
    RAISE EXCEPTION 'servono almeno 2 quote' USING ERRCODE = '22023';
  END IF;

  -- 🔒 Due modifiche concorrenti delle quote dello stesso pagamento non si
  -- intrecciano, e nessun incasso legge la voce a metà.
  SELECT id, importo, tipo INTO v_pag
    FROM public.pagamenti
   WHERE id = p_pagamento_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;

  FOR v_q IN SELECT * FROM jsonb_array_elements(p_quote) LOOP
    v_aid := NULLIF(v_q->>'adult_id', '')::uuid;
    v_imp := (v_q->>'importo')::numeric;
    IF v_aid IS NULL OR v_imp IS NULL THEN
      RAISE EXCEPTION 'ogni quota richiede adult_id e importo' USING ERRCODE = '22023';
    END IF;
    IF v_aid = ANY (v_adulti) THEN
      RETURN jsonb_build_object('esito', 'adulto_ripetuto', 'adult_id', v_aid);
    END IF;
    v_adulti := v_adulti || v_aid;
    v_somma := v_somma + v_imp;
  END LOOP;

  IF abs(v_somma - v_pag.importo) > 0.01 THEN
    RETURN jsonb_build_object('esito', 'somma_diversa', 'somma', v_somma, 'importo', v_pag.importo);
  END IF;

  -- Una quota con incassi collegati non si toglie: l'incasso resterebbe di nessuno.
  SELECT jsonb_agg(q.id ORDER BY q.id) INTO v_bloccate
    FROM public.pagamenti_quote q
   WHERE q.pagamento_id = p_pagamento_id
     AND NOT (q.adult_id = ANY (v_adulti))
     AND EXISTS (SELECT 1 FROM public.incassi i WHERE i.quota_id = q.id);
  IF v_bloccate IS NOT NULL THEN
    RETURN jsonb_build_object('esito', 'quota_con_incassi', 'quote', v_bloccate);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.adult_id), '[]'::jsonb) INTO v_prima
    FROM public.pagamenti_quote q
   WHERE q.pagamento_id = p_pagamento_id;

  DELETE FROM public.pagamenti_quote q
   WHERE q.pagamento_id = p_pagamento_id
     AND NOT (q.adult_id = ANY (v_adulti));
  GET DIAGNOSTICS v_tolte = ROW_COUNT;

  FOR v_q IN SELECT * FROM jsonb_array_elements(p_quote) LOOP
    INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo, etichetta)
    VALUES (p_pagamento_id, (v_q->>'adult_id')::uuid, (v_q->>'importo')::numeric,
            NULLIF(v_q->>'etichetta', ''))
    ON CONFLICT (pagamento_id, adult_id) DO UPDATE
      SET importo = EXCLUDED.importo,
          etichetta = EXCLUDED.etichetta;
  END LOOP;

  IF v_pag.tipo::text <> 'split' THEN
    UPDATE public.pagamenti SET tipo = 'split', aggiornato_il = now() WHERE id = p_pagamento_id;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.adult_id), '[]'::jsonb) INTO v_dopo
    FROM public.pagamenti_quote q
   WHERE q.pagamento_id = p_pagamento_id;

  INSERT INTO public.registro_modifiche (azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore, utente_id)
  VALUES ('aggiorna_quote', 'pagamenti_quote', p_pagamento_id, v_prima, v_dopo, p_utente_id);

  RETURN jsonb_build_object('esito', 'ok', 'quote', v_dopo, 'tolte', v_tolte);
END $$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.aggiorna_quote_pagamento(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aggiorna_quote_pagamento(uuid, jsonb, uuid) TO service_role;

COMMENT ON FUNCTION public.aggiorna_quote_pagamento(uuid, jsonb, uuid) IS
  'Aggiorna le quote di un pagamento diviso in una transazione con la riga di pagamenti bloccata: aggiorna la quota di chi resta (stesso id, incassi collegati), inserisce i nuovi, toglie gli assenti solo se senza incassi. Dal 2026-10-10 (fase 5 robustezza): prima le quote si cancellavano e reinserivano, e incassi.quota_id finiva a NULL.';

NOTIFY pgrst, 'reload schema';
