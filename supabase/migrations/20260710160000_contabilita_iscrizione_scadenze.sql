-- =============================================================================
-- CONTABILITÀ · data di iscrizione + giorno di paga per alunno (Fase A2, A14)
--   • alunni.data_iscrizione: le rette si generano SOLO dal mese di iscrizione
--     in poi (iscrizione precedente al 1° settembre → tutto l'anno scolastico).
--     NULL = alunno storico, iscritto da sempre → tutte le rette.
--   • alunni.giorno_scadenza_pagamenti (1-28): scadenza personalizzata della
--     retta ("il genitore paga il 15"); NULL = default di scuola
--     (admin_settings.retta_giorno_scadenza, default 5).
--   • genera_rette_mensili aggiornata: identica alla versione del baseline
--     (righe 514-566) + filtro data_iscrizione + COALESCE del giorno per-alunno.
--     genera_rette_anno resta invariata (delega).
-- Idempotente.
-- =============================================================================

ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS data_iscrizione date;
ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS giorno_scadenza_pagamenti integer
    CONSTRAINT alunni_giorno_scadenza_check CHECK (giorno_scadenza_pagamenti IS NULL OR (giorno_scadenza_pagamenti BETWEEN 1 AND 28));

CREATE OR REPLACE FUNCTION public.genera_rette_mensili(p_periodo date DEFAULT (date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone))::date) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  r RECORD;
  v_cat UUID;
  v_count INT := 0;
  v_pid UUID;
  v_visibile DATE;
BEGIN
  SELECT id INTO v_cat FROM public.payment_categories WHERE slug = 'retta' AND scuola_id IS NULL LIMIT 1;

  FOR r IN
    SELECT al.id AS alunno_id, al.scuola_id,
           COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150) AS importo,
           al.genitori_separati, al.retta_split_config,
           -- giorno di paga personalizzato dell'alunno, altrimenti default di scuola
           COALESCE(al.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) AS giorno,
           COALESCE(s.retta_giorno_visibilita, 25) AS giorno_visib
    FROM public.alunni al
    LEFT JOIN public.admin_settings s ON s.scuola_id = al.scuola_id
    WHERE al.stato = 'iscritto'
      AND (al.classe_sezione IS NOT NULL OR al.section_id IS NOT NULL)
      -- retta solo dal mese di iscrizione in poi (NULL = da sempre)
      AND (al.data_iscrizione IS NULL OR (date_trunc('month', al.data_iscrizione))::date <= p_periodo)
      AND COALESCE(s.retta_auto_enabled, true) = true
      AND NOT EXISTS (
        SELECT 1 FROM public.pagamenti p
        WHERE p.alunno_id = al.id AND p.periodo_competenza = p_periodo AND p.categoria_id = v_cat
      )
  LOOP
    v_visibile := ((p_periodo - interval '1 month')::date
                   + ((r.giorno_visib - 1) || ' days')::interval)::date;

    INSERT INTO public.pagamenti (
      alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
      tipo, obbligatorio, gruppo, periodo_competenza, visibile_dal, stato
    ) VALUES (
      r.alunno_id, r.scuola_id, v_cat, 'Retta ' || to_char(p_periodo, 'MM/YYYY'),
      r.importo,
      (p_periodo + ((r.giorno - 1) || ' days')::interval)::date,
      (CASE WHEN r.genitori_separati THEN 'split' ELSE 'singolo' END)::pagamento_tipo,
      true, 'retta-' || to_char(p_periodo, 'YYYY-MM'), p_periodo, v_visibile, 'da_pagare'
    )
    RETURNING id INTO v_pid;

    IF r.genitori_separati THEN
      PERFORM public.crea_quote_da_config(v_pid, r.alunno_id, r.importo, r.retta_split_config);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;
