-- =============================================================================
-- CONTABILITÀ v2 · genera_rette_mensili v2 — sconti configurabili (slice S6)
--
--   CREATE OR REPLACE a FIRMA INVARIATA (genera_rette_mensili(date) → integer,
--   SECURITY INVOKER come oggi; CREATE OR REPLACE preserva l'ACL esistente).
--   Genera le rette come prima e in più valorizza pagamenti.sconto/sconto_motivo
--   leggendo admin_settings.rette_config DENTRO la SQL:
--
--     • sconto fratelli — i figli in posizione ≥2 nella famiglia (unione dei
--       legami: legame_genitori_alunni ∪ student_parents→parents, ponte via
--       parents.auth_user_id) prendono lo scaglione con posizione più alta ≤ della
--       propria. modo 'percentuale' → round(importo*valore/100,2); modo 'importo'
--       → valore. Ordinamento stabile: data_nascita, poi id. Contano solo i
--       fratelli 'iscritto'. Motivo «Sconto fratelli».
--
--     • pro-rata iscrizione — SOLO sulla retta del mese di alunni.data_iscrizione;
--       percentuale dovuta = scaglione con dal_giorno più alto ≤ giorno di
--       iscrizione (100% se nessuno matcha); sconto = round(importo*(100−perc)/100,2).
--       Motivo «Pro-rata iscrizione».
--
--     • i due sconti si SOMMANO (clamp a ≤ importo), motivo concatenato con «; ».
--
--   rette_config NULL o `enabled=false` → sconto 0 = OUTPUT IDENTICO A OGGI. Le
--   regole replicano ESATTAMENTE src/lib/pagamenti/rette-config.ts (stesso
--   arrotondamento half-away-from-zero via round(numeric,2) di Postgres).
--
--   Il DB E2E CI NON è migrato: qui non c'è degradazione da gestire (la funzione
--   vive solo su prod; la route /api/pagamenti/genera-rette invoca l'RPC così com'è).
--   NB: questa migrazione crea/aggiorna solo la funzione, NON la esegue.
-- =============================================================================

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
  v_cfg JSONB;
  v_sf JSONB;
  v_pr JSONB;
  v_modo TEXT;
  v_valore NUMERIC;
  v_perc NUMERIC;
  v_giorno_isc INT;
  v_sconto_fratelli NUMERIC;
  v_sconto_prorata NUMERIC;
  v_sconto_tot NUMERIC;
  v_motivo_fratelli TEXT;
  v_motivo_prorata TEXT;
  v_motivo TEXT;
BEGIN
  SELECT id INTO v_cat FROM public.payment_categories WHERE slug = 'retta' AND scuola_id IS NULL LIMIT 1;

  FOR r IN
    WITH links AS (
      -- (alunno, chiave-genitore canonica) da entrambe le sponde dei legami
      SELECT lga.alunno_id, ('u:' || lga.genitore_id::text) AS pk
        FROM public.legame_genitori_alunni lga
      UNION
      SELECT sp.student_id AS alunno_id,
             COALESCE('u:' || pr.auth_user_id::text, 'p:' || sp.parent_id::text) AS pk
        FROM public.student_parents sp
        LEFT JOIN public.parents pr ON pr.id = sp.parent_id
    ),
    dl AS (SELECT DISTINCT alunno_id, pk FROM links)
    SELECT al.id AS alunno_id, al.scuola_id,
           COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150) AS importo,
           al.genitori_separati, al.retta_split_config,
           -- giorno di paga personalizzato dell'alunno, altrimenti default di scuola
           COALESCE(al.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) AS giorno,
           COALESCE(s.retta_giorno_visibilita, 25) AS giorno_visib,
           s.rette_config AS rette_config,
           al.data_iscrizione,
           -- posizione del figlio nella famiglia (1 = primogenito, nessuno sconto).
           -- Conta i fratelli 'iscritto' più «vecchi» che condividono un genitore.
           (SELECT 1 + COUNT(DISTINCT sib.alunno_id)
              FROM dl me
              JOIN dl sib ON sib.pk = me.pk AND sib.alunno_id <> me.alunno_id
              JOIN public.alunni asib ON asib.id = sib.alunno_id AND asib.stato = 'iscritto'
             WHERE me.alunno_id = al.id
               AND ( asib.data_nascita < al.data_nascita
                     OR (asib.data_nascita = al.data_nascita AND asib.id < al.id) )
           ) AS posizione
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

    -- ── sconti configurabili (admin_settings.rette_config della scuola) ────────
    v_sconto_fratelli := 0; v_sconto_prorata := 0; v_sconto_tot := 0;
    v_motivo_fratelli := NULL; v_motivo_prorata := NULL; v_motivo := NULL;
    v_valore := NULL; v_perc := NULL;
    v_cfg := r.rette_config;

    IF v_cfg IS NOT NULL THEN
      -- sconto fratelli (figli in posizione ≥2)
      v_sf := v_cfg -> 'sconto_fratelli';
      IF v_sf IS NOT NULL AND COALESCE((v_sf ->> 'enabled')::boolean, false) AND r.posizione >= 2 THEN
        v_modo := COALESCE(v_sf ->> 'modo', 'percentuale');
        -- scaglione con posizione più alta ≤ della propria (scaglioni sanificati inline)
        SELECT (e ->> 'valore')::numeric INTO v_valore
          FROM jsonb_array_elements(COALESCE(v_sf -> 'scaglioni', '[]'::jsonb)) e
         WHERE (e ->> 'posizione') ~ '^[0-9]+$'
           AND (e ->> 'posizione')::int >= 2
           AND (e ->> 'posizione')::int <= r.posizione
           AND (e ->> 'valore') ~ '^[0-9]+(\.[0-9]+)?$'
           AND (e ->> 'valore')::numeric >= 0
         ORDER BY (e ->> 'posizione')::int DESC, (e ->> 'valore')::numeric DESC
         LIMIT 1;
        IF v_valore IS NOT NULL THEN
          IF v_modo = 'importo' THEN
            v_sconto_fratelli := round(v_valore, 2);
          ELSE
            v_sconto_fratelli := round(r.importo * LEAST(v_valore, 100) / 100.0, 2);
          END IF;
          IF v_sconto_fratelli > 0 THEN v_motivo_fratelli := 'Sconto fratelli'; END IF;
        END IF;
      END IF;

      -- pro-rata iscrizione (SOLO sulla retta del mese di iscrizione)
      v_pr := v_cfg -> 'pro_rata_iscrizione';
      IF v_pr IS NOT NULL AND COALESCE((v_pr ->> 'enabled')::boolean, false)
         AND r.data_iscrizione IS NOT NULL
         AND (date_trunc('month', r.data_iscrizione))::date = p_periodo THEN
        v_giorno_isc := EXTRACT(day FROM r.data_iscrizione)::int;
        SELECT (e ->> 'percentuale')::numeric INTO v_perc
          FROM jsonb_array_elements(COALESCE(v_pr -> 'scaglioni', '[]'::jsonb)) e
         WHERE (e ->> 'dal_giorno') ~ '^[0-9]+$'
           AND (e ->> 'dal_giorno')::int >= 1
           AND (e ->> 'dal_giorno')::int <= v_giorno_isc
           AND (e ->> 'percentuale') ~ '^[0-9]+(\.[0-9]+)?$'
           AND (e ->> 'percentuale')::numeric >= 0
         ORDER BY (e ->> 'dal_giorno')::int DESC
         LIMIT 1;
        v_perc := LEAST(COALESCE(v_perc, 100), 100);   -- nessuno scaglione → 100 = niente sconto
        v_sconto_prorata := round(r.importo * (100 - v_perc) / 100.0, 2);
        IF v_sconto_prorata > 0 THEN v_motivo_prorata := 'Pro-rata iscrizione'; END IF;
      END IF;

      v_sconto_tot := COALESCE(v_sconto_fratelli, 0) + COALESCE(v_sconto_prorata, 0);
      IF v_sconto_tot > r.importo THEN v_sconto_tot := r.importo; END IF;   -- clamp a ≤ importo
      IF v_sconto_tot > 0 THEN
        v_motivo := NULLIF(concat_ws('; ', v_motivo_fratelli, v_motivo_prorata), '');
      ELSE
        v_sconto_tot := 0; v_motivo := NULL;
      END IF;
    END IF;

    INSERT INTO public.pagamenti (
      alunno_id, scuola_id, categoria_id, descrizione, importo, sconto, sconto_motivo, scadenza,
      tipo, obbligatorio, gruppo, periodo_competenza, visibile_dal, stato
    ) VALUES (
      r.alunno_id, r.scuola_id, v_cat, 'Retta ' || to_char(p_periodo, 'MM/YYYY'),
      r.importo, v_sconto_tot, v_motivo,
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
