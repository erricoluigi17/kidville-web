-- =============================================================================
-- RICARICA DEI TICKET MENSA · UNA TRANSAZIONE SOLA
-- Fase 5 della roadmap di robustezza («Soldi corretti», problema D5-A).
--
-- PRIMA: `POST /api/pagamenti/ticket` faceva quattro scritture separate —
-- saldo (`varia_saldo_ticket`), pagamento, incasso, movimento del ledger — più
-- un «rientro» del saldo scritto a mano se il pagamento non nasceva. Ogni
-- passo poteva fallire dopo i precedenti: saldo salito senza pagamento, o
-- pagamento senza incasso (la famiglia fra i morosi per una ricarica pagata),
-- o movimento perso (lo storico non torna più col saldo). E la guardia «ha già
-- ricaricato oggi?» leggeva il ledger PRIMA di scrivere, senza blocco: due click
-- ravvicinati passavano entrambi.
--
-- ORA: tutto in questa funzione, in una transazione. Le ricariche dello stesso
-- bambino sono serializzate da un advisory lock di transazione (la riga di
-- `ticket_mensa` può non esistere ancora, quindi non si può bloccare quella):
-- la guardia del duplicato legge il ledger DOPO il blocco. Se un passo
-- fallisce, non resta niente.
--
-- Misura del 10/10: 197 ricariche in produzione, 0 senza incasso, 0 senza
-- movimento — il difetto non ha ancora prodotto righe a metà.
--
-- Solo funzioni: nessuna tabella, policy o indice.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ricarica_ticket_mensa(
  p_alunno_id          uuid,
  p_pezzi              integer,
  p_costo              numeric,
  p_operatore          uuid,
  p_metodo             text        DEFAULT NULL,
  p_conferma_duplicato boolean     DEFAULT false,
  p_giorno_dalle       timestamptz DEFAULT NULL,
  p_giorno_alle        timestamptz DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_scuola     uuid;
  v_costo      numeric(10,2) := round(p_costo, 2);
  v_prec       record;
  v_saldo      integer;
  v_categoria  uuid;
  v_pagamento  uuid;
  v_incasso    uuid;
BEGIN
  IF p_pezzi IS NULL OR p_pezzi <= 0 THEN
    RAISE EXCEPTION 'pezzi deve essere un intero > 0' USING ERRCODE = '22023';
  END IF;
  IF p_costo IS NULL OR p_costo < 0 THEN
    RAISE EXCEPTION 'costo deve essere >= 0' USING ERRCODE = '22023';
  END IF;

  -- La sede è SEMPRE quella del bambino, mai quella del client.
  SELECT scuola_id INTO v_scuola FROM public.alunni WHERE id = p_alunno_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;

  -- 🔒 Una ricarica alla volta per bambino, fino alla fine della transazione.
  PERFORM pg_advisory_xact_lock(hashtextextended('ricarica_ticket_mensa:' || p_alunno_id::text, 0));

  -- «Ha già ricaricato oggi?» — sui confini del giorno CIVILE passati dalla
  -- route (mai sulla colonna `data`, che segue il fuso della sessione), e letto
  -- DOPO il blocco: il secondo click vede la ricarica del primo.
  IF NOT COALESCE(p_conferma_duplicato, false)
     AND p_giorno_dalle IS NOT NULL AND p_giorno_alle IS NOT NULL THEN
    SELECT m.creato_il, m.delta, pg.importo
      INTO v_prec
      FROM public.mensa_ticket_movimenti m
      LEFT JOIN public.pagamenti pg ON pg.id = m.pagamento_id
     WHERE m.alunno_id = p_alunno_id
       AND m.tipo = 'ricarica'
       AND m.creato_il >= p_giorno_dalle
       AND m.creato_il <= p_giorno_alle
     ORDER BY m.creato_il DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'esito', 'duplicato',
        'precedente', jsonb_build_object(
          'creato_il', v_prec.creato_il,
          'pezzi', v_prec.delta,
          'importo', v_prec.importo
        )
      );
    END IF;
  END IF;

  -- 1) saldo: la stessa variazione atomica di sempre.
  v_saldo := public.varia_saldo_ticket(p_alunno_id, p_pezzi);

  -- 2) pagamento Mensa (categoria globale). Descrizione CANONICA con l'em dash
  --    U+2014: il backfill del ledger riestrae il numero con una regexp.
  SELECT id INTO v_categoria
    FROM public.payment_categories
   WHERE slug = 'mensa' AND scuola_id IS NULL
   LIMIT 1;

  INSERT INTO public.pagamenti
    (alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
     tipo, obbligatorio, stato, creato_da)
  VALUES
    (p_alunno_id, v_scuola, v_categoria,
     'Ricarica mensa — ' || p_pezzi::text || ' ticket', v_costo, CURRENT_DATE,
     'singolo'::public.pagamento_tipo, false, 'da_pagare', p_operatore)
  RETURNING id INTO v_pagamento;

  -- 3) incasso contestuale: il trigger porta il pagamento a «pagato».
  IF v_costo > 0 THEN
    INSERT INTO public.incassi (pagamento_id, importo, metodo, note, registrato_da)
    VALUES (v_pagamento, v_costo,
            COALESCE(NULLIF(btrim(p_metodo), ''), 'contanti')::public.incasso_metodo,
            'Ricarica ticket mensa', p_operatore)
    RETURNING id INTO v_incasso;
  END IF;

  -- 4) movimento del ledger, con il saldo che la variazione ha restituito.
  INSERT INTO public.mensa_ticket_movimenti
    (alunno_id, scuola_id, tipo, delta, saldo_dopo, pagamento_id, origine, creato_da)
  VALUES
    (p_alunno_id, v_scuola, 'ricarica', p_pezzi, v_saldo, v_pagamento, 'segreteria', p_operatore);

  RETURN jsonb_build_object(
    'esito', 'ok',
    'saldo', v_saldo,
    'scuola_id', v_scuola,
    'pagamento_id', v_pagamento,
    'incasso_id', v_incasso
  );
END $$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.ricarica_ticket_mensa(uuid, integer, numeric, uuid, text, boolean, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ricarica_ticket_mensa(uuid, integer, numeric, uuid, text, boolean, timestamptz, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.ricarica_ticket_mensa(uuid, integer, numeric, uuid, text, boolean, timestamptz, timestamptz) IS
  'Ricarica dei ticket mensa in una transazione: saldo, pagamento Mensa, incasso e movimento del ledger, con le ricariche dello stesso bambino serializzate (advisory lock) e la guardia «già ricaricato oggi» letta dopo il blocco. Dal 2026-10-10 (fase 5 robustezza): prima erano quattro scritture separate.';

NOTIFY pgrst, 'reload schema';
