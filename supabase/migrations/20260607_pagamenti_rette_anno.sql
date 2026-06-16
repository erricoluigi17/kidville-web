-- =============================================================================
-- Modulo PAGAMENTI — Retta default globale + generazione rette per anno scolastico
-- =============================================================================
-- Additiva e idempotente. Applicare con:
--   node scripts/apply_pagamenti_migrations.mjs 20260607_pagamenti_rette_anno.sql
--
-- Obiettivi (richiesta committente):
--  - retta default = 150 € per tutte le scuole (configurabile da Impostazioni)
--  - tutti gli alunni ATTIVI (iscritti + con sezione) ricevono la retta al default
--    anche senza importo personalizzato
--  - generare in un colpo l'intero anno scolastico (settembre -> giugno, 10 mesi)
-- =============================================================================

-- 1) Default globale 150 € (non sovrascrive importi gia' impostati > 0)
ALTER TABLE public.admin_settings
  ALTER COLUMN retta_default_importo SET DEFAULT 150;

UPDATE public.admin_settings
  SET retta_default_importo = 150
  WHERE COALESCE(retta_default_importo, 0) = 0;

-- 2) Ridefinizione genera_rette_mensili:
--    - importo = importo personalizzato dell'alunno, altrimenti default globale (150)
--    - filtro: iscritti CON sezione valorizzata (classe_sezione o section_id)
--    - rimosso il vincolo importo_retta_mensile > 0
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
    SELECT al.id AS alunno_id, al.scuola_id,
           COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150) AS importo,
           al.genitori_separati, al.retta_split_config,
           COALESCE(s.retta_giorno_scadenza, 5) AS giorno
    FROM public.alunni al
    LEFT JOIN public.admin_settings s ON s.scuola_id = al.scuola_id
    WHERE al.stato = 'iscritto'
      AND (al.classe_sezione IS NOT NULL OR al.section_id IS NOT NULL)
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
      r.importo,
      (p_periodo + ((r.giorno - 1) || ' days')::interval)::date,
      (CASE WHEN r.genitori_separati THEN 'split' ELSE 'singolo' END)::pagamento_tipo,
      true, 'retta-' || to_char(p_periodo, 'YYYY-MM'), p_periodo, 'da_pagare'
    )
    RETURNING id INTO v_pid;

    IF r.genitori_separati THEN
      PERFORM public.crea_quote_da_config(v_pid, r.alunno_id, r.importo, r.retta_split_config);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

-- 3) Generazione dell'intero anno scolastico: settembre(anno) -> giugno(anno+1).
--    Idempotente: riesegue genera_rette_mensili (NOT EXISTS) per ogni mese.
CREATE OR REPLACE FUNCTION public.genera_rette_anno(
  p_anno_inizio INT DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::int
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_total INT := 0;
  v_mese INT;
  v_periodo DATE;
BEGIN
  -- Settembre -> Dicembre dell'anno di inizio
  FOR v_mese IN 9..12 LOOP
    v_periodo := make_date(p_anno_inizio, v_mese, 1);
    v_total := v_total + public.genera_rette_mensili(v_periodo);
  END LOOP;
  -- Gennaio -> Giugno dell'anno successivo
  FOR v_mese IN 1..6 LOOP
    v_periodo := make_date(p_anno_inizio + 1, v_mese, 1);
    v_total := v_total + public.genera_rette_mensili(v_periodo);
  END LOOP;
  RETURN v_total;
END $$;

NOTIFY pgrst, 'reload schema';
