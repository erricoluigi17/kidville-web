-- =============================================================================
-- Modulo PAGAMENTI — Visibilità ritardata rette + causale fattura configurabile
-- =============================================================================
-- Additiva e idempotente. Applicare con:
--   node scripts/apply_pagamenti_migrations.mjs 20260608_pagamenti_visibilita_causale.sql
--
-- Obiettivi (richiesta committente):
--  - I pagamenti ricorrenti (retta) NON devono comparire al genitore per tutto
--    l'anno: ogni retta mensile diventa visibile solo dal giorno X (default 25,
--    configurabile) del mese PRECEDENTE alla competenza.
--  - La causale fattura ha un template di default configurabile, modificabile
--    al momento dell'emissione.
-- =============================================================================

-- 1) Colonna visibilità sul pagamento (NULL = visibile da subito → una tantum)
ALTER TABLE public.pagamenti
  ADD COLUMN IF NOT EXISTS visibile_dal DATE;

-- Causale fattura scelta all'emissione (NULL → si usa la descrizione)
ALTER TABLE public.pagamenti
  ADD COLUMN IF NOT EXISTS fattura_causale TEXT;

CREATE INDEX IF NOT EXISTS idx_pagamenti_visibile_dal
  ON public.pagamenti (visibile_dal);

-- 2) Impostazioni: giorno di visibilità rette + template causale fattura
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS retta_giorno_visibilita INTEGER DEFAULT 25;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'admin_settings' AND constraint_name = 'chk_retta_giorno_visibilita'
  ) THEN
    ALTER TABLE public.admin_settings
      ADD CONSTRAINT chk_retta_giorno_visibilita
      CHECK (retta_giorno_visibilita BETWEEN 1 AND 28);
  END IF;
END $$;

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS fattura_causale_template TEXT
  DEFAULT '{descrizione} - {alunno}';

-- 3) Ridefinizione genera_rette_mensili: popola anche visibile_dal.
--    visibile_dal = (primo del mese precedente) + (giorno_visibilita - 1) giorni
--    es. competenza 2026-03 con giorno 25 -> visibile dal 2026-02-25
CREATE OR REPLACE FUNCTION public.genera_rette_mensili(
  p_periodo DATE DEFAULT date_trunc('month', CURRENT_DATE)::date
) RETURNS integer LANGUAGE plpgsql AS $$
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
           COALESCE(s.retta_giorno_scadenza, 5) AS giorno,
           COALESCE(s.retta_giorno_visibilita, 25) AS giorno_visib
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

NOTIFY pgrst, 'reload schema';
