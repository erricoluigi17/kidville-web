-- =============================================================================
-- INCASSO DI UNA VOCE · UNA TRANSAZIONE SOLA, CON LA RIGA DEL PAGAMENTO BLOCCATA
-- Fase 5 della roadmap di robustezza («Soldi corretti», problema D5-A).
--
-- PRIMA: `POST /api/pagamenti/incassi` leggeva il residuo (importo − sconto −
-- già incassato), decideva in JavaScript e poi scriveva l'incasso, il credito
-- famiglia, l'abbuono e l'audit con QUATTRO chiamate separate. Due operatori
-- sulla stessa voce leggevano lo stesso residuo e passavano entrambi il
-- controllo: la voce veniva incassata due volte, oltre il dovuto, senza errori.
-- E se l'accredito dell'eccedenza falliva dopo l'incasso, restava un incasso
-- del solo residuo con l'eccedenza persa («eccedenza_non_accreditata»).
--
-- ORA: questa funzione blocca la riga di `pagamenti` con `SELECT … FOR UPDATE`,
-- ricalcola il residuo DOPO il blocco e fa tutte le scritture nella stessa
-- transazione. Il secondo operatore aspetta il primo, poi legge il residuo
-- aggiornato dal trigger `incassi_ricalcola`, e riceve «eccedenza» (409) invece
-- di un secondo incasso.
--
-- Il residuo si calcola su `importo_pagato` (tenuto dal trigger), come faceva
-- la route (`residuoEffettivo`), e non sulla somma degli incassi: 5 voci di
-- produzione (misura del 10/10) risultano pagate senza nessun incasso nel
-- registro. Con la somma tornerebbero «da pagare» e si potrebbero incassare due
-- volte.
--
-- Le rate (`parent_payment_id` valorizzato) non hanno il controllo
-- dell'eccedenza: la loro eccedenza la sposta lo spill sulla rata successiva,
-- come prima.
--
-- Solo funzioni: nessuna tabella, nessuna policy, nessun indice. Chiamata solo
-- dalla service-role (route staff con `requireStaff` + scope di sede).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.registra_incasso_voce(
  p_pagamento_id        uuid,
  p_importo             numeric,
  p_registrato_da       uuid,
  p_data_incasso        date    DEFAULT NULL,
  p_metodo              text    DEFAULT NULL,
  p_note                text    DEFAULT NULL,
  p_quota_id            uuid    DEFAULT NULL,
  p_eccedenza_parent_id uuid    DEFAULT NULL,
  p_abbuono_motivo      text    DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_pag          record;
  v_importo      numeric(10,2) := round(p_importo, 2);
  v_residuo      numeric(10,2);
  v_da_incassare numeric(10,2);
  v_eccedenza    numeric(10,2) := 0;
  v_inc          public.incassi%ROWTYPE;
  v_ha_incasso   boolean := false;
  v_saldo_prec   numeric(10,2);
  v_saldo_dopo   numeric(10,2);
  v_credito_id   uuid;
  v_sconto_dopo  numeric(10,2);
BEGIN
  IF p_importo IS NULL OR v_importo = 0 THEN
    RAISE EXCEPTION 'importo deve essere diverso da 0' USING ERRCODE = '22023';
  END IF;

  -- 🔒 Il cuore della correzione: da qui alla fine della transazione nessun altro
  -- incasso su questa voce può leggere il residuo. Chi arriva dopo aspetta.
  SELECT id, importo, sconto, importo_pagato, parent_payment_id, scuola_id
    INTO v_pag
    FROM public.pagamenti
   WHERE id = p_pagamento_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;

  -- Una quota di un altro pagamento non si collega: l'incasso finirebbe nel
  -- conto di una persona che con questa voce non c'entra.
  IF p_quota_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pagamenti_quote q
     WHERE q.id = p_quota_id AND q.pagamento_id = p_pagamento_id
  ) THEN
    RETURN jsonb_build_object('esito', 'quota_estranea');
  END IF;

  v_residuo := GREATEST(0, v_pag.importo - COALESCE(v_pag.sconto, 0) - COALESCE(v_pag.importo_pagato, 0));
  v_da_incassare := v_importo;

  IF v_pag.parent_payment_id IS NULL AND v_importo > v_residuo + 0.005 THEN
    IF p_eccedenza_parent_id IS NULL THEN
      -- Nessuna scrittura: la segreteria deve decidere (credito famiglia o annulla).
      RETURN jsonb_build_object(
        'esito', 'eccedenza',
        'eccedenza', v_importo - v_residuo,
        'residuo', v_residuo
      );
    END IF;
    v_da_incassare := v_residuo;
    v_eccedenza := v_importo - v_residuo;
  END IF;

  -- Residuo zero con eccedenza confermata: niente incasso (il CHECK importo <> 0
  -- lo rifiuterebbe), tutto a credito.
  IF abs(v_da_incassare) > 0.005 THEN
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, note, quota_id, registrato_da)
    VALUES
      (p_pagamento_id, v_da_incassare, COALESCE(p_data_incasso, CURRENT_DATE),
       COALESCE(NULLIF(btrim(p_metodo), ''), 'contanti')::public.incasso_metodo,
       p_note, p_quota_id, p_registrato_da)
    RETURNING * INTO v_inc;
    v_ha_incasso := true;

    -- Audit nella stessa transazione: prima era un INSERT a parte con l'errore
    -- scartato, e un incasso poteva restare senza traccia.
    INSERT INTO public.registro_modifiche (azione, tabella_interessata, record_id, nuovo_valore, utente_id)
    VALUES ('registra_incasso', 'incassi', v_inc.id, to_jsonb(v_inc), p_registrato_da);
  END IF;

  -- Eccedenza → credito famiglia, serializzato sul parent (stesso blocco di
  -- `registra_transazione_contabile`): due accrediti concorrenti non leggono lo
  -- stesso saldo.
  IF v_eccedenza > 0 THEN
    IF v_pag.scuola_id IS NULL THEN
      RAISE EXCEPTION 'pagamento % senza sede: il credito famiglia non si può accreditare', p_pagamento_id
        USING ERRCODE = '23502';
    END IF;
    PERFORM 1 FROM public.parents WHERE id = p_eccedenza_parent_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pagante % inesistente', p_eccedenza_parent_id USING ERRCODE = '23503';
    END IF;
    SELECT saldo_dopo INTO v_saldo_prec
      FROM public.crediti_famiglia
     WHERE parent_id = p_eccedenza_parent_id
     ORDER BY creato_il DESC, id DESC
     LIMIT 1;
    v_saldo_dopo := COALESCE(v_saldo_prec, 0) + v_eccedenza;
    INSERT INTO public.crediti_famiglia
      (parent_id, scuola_id, causale, importo, saldo_dopo, incasso_id, creato_da)
    VALUES
      (p_eccedenza_parent_id, v_pag.scuola_id, 'eccedenza', v_eccedenza, v_saldo_dopo,
       CASE WHEN v_ha_incasso THEN v_inc.id END, p_registrato_da)
    RETURNING id INTO v_credito_id;
  END IF;

  -- «Salda con abbuono della differenza»: lo sconto copre quanto resta, la voce
  -- risulta saldata. Solo per un incasso positivo e senza eccedenza.
  IF p_abbuono_motivo IS NOT NULL AND v_eccedenza = 0
     AND v_da_incassare > 0 AND v_da_incassare < v_residuo - 0.005 THEN
    v_sconto_dopo := COALESCE(v_pag.sconto, 0) + (v_residuo - v_da_incassare);
    UPDATE public.pagamenti
       SET sconto = v_sconto_dopo, sconto_motivo = p_abbuono_motivo, aggiornato_il = now()
     WHERE id = p_pagamento_id;
    PERFORM public.ricalcola_stato_pagamento(p_pagamento_id);
    INSERT INTO public.registro_modifiche (azione, tabella_interessata, record_id, nuovo_valore, utente_id)
    VALUES ('abbuono_incasso', 'pagamenti', p_pagamento_id,
            jsonb_build_object('sconto', v_sconto_dopo, 'sconto_motivo', p_abbuono_motivo), p_registrato_da);
  END IF;

  RETURN jsonb_build_object(
    'esito', 'ok',
    'residuo_prima', v_residuo,
    'incasso', CASE WHEN v_ha_incasso THEN to_jsonb(v_inc) END,
    'importo_incassato', CASE WHEN v_ha_incasso THEN v_da_incassare ELSE 0 END,
    'eccedenza', v_eccedenza,
    'credito', CASE WHEN v_credito_id IS NOT NULL
                    THEN jsonb_build_object('id', v_credito_id, 'saldo_dopo', v_saldo_dopo) END,
    'sconto_dopo', v_sconto_dopo
  );
END $$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.registra_incasso_voce(uuid, numeric, uuid, date, text, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registra_incasso_voce(uuid, numeric, uuid, date, text, text, uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.registra_incasso_voce(uuid, numeric, uuid, date, text, text, uuid, uuid, text) IS
  'Registra l''incasso di una voce in una sola transazione con la riga di pagamenti bloccata (FOR UPDATE): residuo ricalcolato dopo il blocco, eccedenza oltre il dovuto rifiutata (esito eccedenza) o accreditata come credito famiglia, abbuono e audit nella stessa transazione. Dal 2026-10-10 (fase 5 robustezza): prima due operatori potevano incassare la stessa voce oltre il dovuto.';

NOTIFY pgrst, 'reload schema';
