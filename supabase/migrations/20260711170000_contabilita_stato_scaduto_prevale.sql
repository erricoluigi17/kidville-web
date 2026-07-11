-- =============================================================================
-- CONTABILITÀ · morosità con acconto (branch feat/fix-contabilita-merchandise)
--   Requisito: un pagamento NON saldato e SCADUTO deve restare 'scaduto'
--   (moroso) ANCHE quando ha ricevuto un acconto (importo_pagato > 0).
--   Prima l'ordine del CASE metteva 'parziale' sopra 'scaduto', così un acconto
--   su una rata scaduta la declassava a 'parziale' e la faceva sparire dai morosi.
--   Nuovo ordine:  pagato -> scaduto(se scaduto e non saldato) -> parziale -> da_pagare.
--
--   CREATE OR REPLACE preserva owner / ACL / search_path (i GRANT a service_role
--   del baseline restano). Backfill one-shot idempotente e rieseguibile: il
--   trigger `incassi_ricalcola` è su `incassi`, quindi scrivere `pagamenti.stato`
--   qui non lo fa ripartire.
-- Idempotente.
-- =============================================================================

-- 1) PADRE per primo (referenziato dalla figlia via ricalcola_stato_pagamento).
--    'scaduto' solo se la PRIMA rata ancora APERTA è scaduta: il FILTER evita il
--    falso-scaduto quando le rate scadute sono già tutte saldate.
CREATE OR REPLACE FUNCTION public.ricalcola_stato_padre(p_parent uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tot NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_min_scad_aperta DATE;
BEGIN
  SELECT importo INTO v_tot FROM public.pagamenti WHERE id = p_parent;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(importo_pagato),0),
         MIN(scadenza) FILTER (WHERE COALESCE(importo_pagato,0) < importo)
    INTO v_pagato, v_min_scad_aperta
  FROM public.pagamenti WHERE parent_payment_id = p_parent;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    stato = CASE
      WHEN v_pagato >= v_tot AND v_tot > 0 THEN 'pagato'
      WHEN v_min_scad_aperta IS NOT NULL AND v_min_scad_aperta < CURRENT_DATE THEN 'scaduto'
      WHEN v_pagato > 0 THEN 'parziale'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_parent;
END $$;

-- 2) SINGOLO / RATA / SPLIT: stato ricalcolato dal ledger incassi.
CREATE OR REPLACE FUNCTION public.ricalcola_stato_pagamento(p_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tot NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_scad DATE;
  v_parent UUID;
BEGIN
  SELECT importo, scadenza, parent_payment_id
    INTO v_tot, v_scad, v_parent
  FROM public.pagamenti WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(importo),0) INTO v_pagato
  FROM public.incassi WHERE pagamento_id = p_id;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    data_incasso   = CASE WHEN v_pagato >= v_tot AND v_tot > 0 THEN COALESCE(data_incasso, NOW()) ELSE NULL END,
    stato = CASE
      WHEN v_pagato >= v_tot AND v_tot > 0 THEN 'pagato'
      WHEN v_scad IS NOT NULL AND v_scad < CURRENT_DATE AND v_pagato < v_tot THEN 'scaduto'
      WHEN v_pagato > 0 THEN 'parziale'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_id;

  -- se è una rata, ricalcola anche lo stato del padre aggregato
  IF v_parent IS NOT NULL THEN
    PERFORM public.ricalcola_stato_padre(v_parent);
  END IF;
END $$;

-- 3) BACKFILL foglie: allinea i record esistenti al nuovo ordinamento. Copre
--    l'unica transizione NUOVA (parziale-scaduto -> scaduto) e, per idempotenza
--    con genera_solleciti, anche i da_pagare già scaduti.
UPDATE public.pagamenti
   SET stato = 'scaduto', aggiornato_il = NOW()
 WHERE tipo <> 'padre'
   AND stato IN ('da_pagare','parziale')
   AND scadenza IS NOT NULL AND scadenza < CURRENT_DATE
   AND COALESCE(importo_pagato,0) < importo;

-- 4) BACKFILL padri: ricomputa l'aggregato col nuovo FILTER.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.pagamenti WHERE tipo = 'padre' LOOP
    PERFORM public.ricalcola_stato_padre(r.id);
  END LOOP;
END $$;
