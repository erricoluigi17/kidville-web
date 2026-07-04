-- =============================================================================
-- Modulo PAGAMENTI — Funzioni SQL (generazione rette + quote split)
-- =============================================================================
-- Usate sia dal pulsante manuale "Genera rette del mese" sia (in Fase 6) dal
-- cron mensile. Idempotenti grazie a NOT EXISTS + unique index uq_pagamenti_retta_mese.
--
-- MODELLO REALE: alunni.stato='iscritto'; tutori = utenti via legame_genitori_alunni.
-- =============================================================================

-- Crea le due (o più) quote split di un pagamento a partire da retta_split_config,
-- con fallback ai tutori collegati (legame_genitori_alunni) divisi per
-- percentuale_pagamento o 50/50.
CREATE OR REPLACE FUNCTION public.crea_quote_da_config(
  p_pagamento_id UUID,
  p_alunno_id    UUID,
  p_importo      NUMERIC,
  p_config       JSONB
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  q JSONB;
  v_count INT := 0;
  v_n INT;
  r RECORD;
BEGIN
  -- 1) da config esplicita {"quote":[{adult_id,importo},...]}
  IF p_config IS NOT NULL AND jsonb_typeof(p_config->'quote') = 'array' THEN
    FOR q IN SELECT * FROM jsonb_array_elements(p_config->'quote')
    LOOP
      IF (q->>'adult_id') IS NOT NULL THEN
        INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo, etichetta)
        VALUES (p_pagamento_id, (q->>'adult_id')::uuid,
                COALESCE((q->>'importo')::numeric, 0), q->>'nome')
        ON CONFLICT (pagamento_id, adult_id) DO UPDATE SET importo = EXCLUDED.importo;
        v_count := v_count + 1;
      END IF;
    END LOOP;
  END IF;
  IF v_count > 0 THEN RETURN; END IF;

  -- 2) fallback: tutori collegati
  SELECT COUNT(*) INTO v_n FROM public.legame_genitori_alunni WHERE alunno_id = p_alunno_id;
  IF v_n = 0 THEN RETURN; END IF;

  FOR r IN
    SELECT genitore_id, percentuale_pagamento
    FROM public.legame_genitori_alunni WHERE alunno_id = p_alunno_id
  LOOP
    INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo)
    VALUES (
      p_pagamento_id, r.genitore_id,
      CASE
        WHEN r.percentuale_pagamento IS NOT NULL THEN ROUND(p_importo * r.percentuale_pagamento / 100.0, 2)
        ELSE ROUND(p_importo / v_n, 2)
      END
    )
    ON CONFLICT (pagamento_id, adult_id) DO NOTHING;
  END LOOP;
END $$;

-- Genera le rette mensili per tutti gli alunni iscritti con retta > 0.
-- p_periodo = primo giorno del mese di competenza (default: mese corrente).
CREATE OR REPLACE FUNCTION public.genera_rette_mensili(
  p_periodo DATE DEFAULT date_trunc('month', CURRENT_DATE)::date
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  v_cat UUID;
  v_count INT := 0;
  v_pid UUID;
BEGIN
  SELECT id INTO v_cat FROM public.payment_categories WHERE slug = 'retta' AND scuola_id IS NULL LIMIT 1;

  FOR r IN
    SELECT al.id AS alunno_id, al.scuola_id, al.importo_retta_mensile,
           al.genitori_separati, al.retta_split_config,
           COALESCE(s.retta_giorno_scadenza, 5) AS giorno
    FROM public.alunni al
    LEFT JOIN public.admin_settings s ON s.scuola_id = al.scuola_id
    WHERE al.stato = 'iscritto'
      AND COALESCE(al.importo_retta_mensile, 0) > 0
      AND COALESCE(s.retta_auto_enabled, true) = true
      AND NOT EXISTS (
        SELECT 1 FROM public.pagamenti p
        WHERE p.alunno_id = al.id AND p.periodo_competenza = p_periodo AND p.categoria_id = v_cat
      )
  LOOP
    INSERT INTO public.pagamenti (
      alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
      tipo, obbligatorio, gruppo, periodo_competenza, stato
    ) VALUES (
      r.alunno_id, r.scuola_id, v_cat, 'Retta ' || to_char(p_periodo, 'MM/YYYY'),
      r.importo_retta_mensile,
      (p_periodo + ((r.giorno - 1) || ' days')::interval)::date,
      (CASE WHEN r.genitori_separati THEN 'split' ELSE 'singolo' END)::pagamento_tipo,
      true, 'retta-' || to_char(p_periodo, 'YYYY-MM'), p_periodo, 'da_pagare'
    )
    RETURNING id INTO v_pid;

    IF r.genitori_separati THEN
      PERFORM public.crea_quote_da_config(v_pid, r.alunno_id, r.importo_retta_mensile, r.retta_split_config);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

NOTIFY pgrst, 'reload schema';
