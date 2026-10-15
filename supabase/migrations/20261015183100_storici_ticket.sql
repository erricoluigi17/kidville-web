-- Ricariche dimenticate: giorno reale nel ledger e nell'incasso, registrazione tecnica conservata.
CREATE OR REPLACE FUNCTION public.ricarica_ticket_mensa_storico(
  p_alunno_id uuid,
  p_pezzi integer,
  p_costo numeric,
  p_operatore uuid,
  p_giorno_competenza date,
  p_metodo text DEFAULT NULL,
  p_conferma_duplicato boolean DEFAULT false,
  p_giorno_dalle timestamptz DEFAULT NULL,
  p_giorno_alle timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_prec record;
  v_esito jsonb;
  v_pagamento uuid;
  v_incasso uuid;
  v_ultimo_carico timestamptz;
  v_evento timestamptz;
BEGIN
  IF p_giorno_competenza IS NULL OR p_giorno_competenza > (now() AT TIME ZONE 'Europe/Rome')::date THEN
    RAISE EXCEPTION 'giorno di competenza non valido' USING ERRCODE = '22023';
  END IF;
  -- Stesso lock del percorso originale: anche le richieste dei client vecchi sono serializzate.
  PERFORM pg_advisory_xact_lock(hashtextextended('ricarica_ticket_mensa:' || p_alunno_id::text, 0));
  IF NOT COALESCE(p_conferma_duplicato, false) THEN
    SELECT m.creato_il, m.delta, pg.importo INTO v_prec
      FROM public.mensa_ticket_movimenti m
      LEFT JOIN public.pagamenti pg ON pg.id = m.pagamento_id
     WHERE m.alunno_id = p_alunno_id AND m.tipo = 'ricarica'
       AND COALESCE(m.data, (m.creato_il AT TIME ZONE 'Europe/Rome')::date) = p_giorno_competenza
     ORDER BY m.creato_il DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('esito', 'duplicato', 'precedente', jsonb_build_object(
        'creato_il', v_prec.creato_il, 'pezzi', v_prec.delta, 'importo', v_prec.importo,
        'giorno_competenza', p_giorno_competenza));
    END IF;
  END IF;
  SELECT ultimo_carico INTO v_ultimo_carico FROM public.ticket_mensa WHERE alunno_id = p_alunno_id;
  -- Il wrapper ha già verificato i duplicati sul giorno reale, sotto lo stesso lock.
  v_esito := public.ricarica_ticket_mensa(p_alunno_id, p_pezzi, p_costo, p_operatore,
    p_metodo, true, p_giorno_dalle, p_giorno_alle);
  IF v_esito->>'esito' <> 'ok' THEN RETURN v_esito; END IF;
  v_pagamento := (v_esito->>'pagamento_id')::uuid;
  v_incasso := (v_esito->>'incasso_id')::uuid;
  UPDATE public.pagamenti SET scadenza = p_giorno_competenza WHERE id = v_pagamento;
  IF v_incasso IS NOT NULL THEN
    UPDATE public.incassi SET data_incasso = p_giorno_competenza WHERE id = v_incasso;
  END IF;
  UPDATE public.mensa_ticket_movimenti SET data = p_giorno_competenza
    WHERE pagamento_id = v_pagamento AND tipo = 'ricarica';
  v_evento := (p_giorno_competenza + (now() AT TIME ZONE 'Europe/Rome')::time) AT TIME ZONE 'Europe/Rome';
  UPDATE public.ticket_mensa SET ultimo_carico = GREATEST(v_ultimo_carico, v_evento)
    WHERE alunno_id = p_alunno_id;
  RETURN v_esito || jsonb_build_object('giorno_competenza', p_giorno_competenza);
END $$;

REVOKE ALL ON FUNCTION public.ricarica_ticket_mensa_storico(uuid, integer, numeric, uuid, date, text, boolean, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ricarica_ticket_mensa_storico(uuid, integer, numeric, uuid, date, text, boolean, timestamptz, timestamptz)
  TO service_role;
COMMENT ON FUNCTION public.ricarica_ticket_mensa_storico(uuid, integer, numeric, uuid, date, text, boolean, timestamptz, timestamptz)
  IS 'Ricarica mensa atomica nel giorno scelto: dedup sulla competenza, date contabili coerenti, audit tecnico originale e ultimo carico non regressivo.';
NOTIFY pgrst, 'reload schema';
