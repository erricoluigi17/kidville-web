-- =============================================================================
-- P3.3b — Graduatorie/Scoring (foundation) + Delibera ammissioni (DL-025)
-- =============================================================================
-- NB: la migrazione 20260528 (scoring + ETL) non era applicata in live. Qui se
-- ne applica SOLO la parte SCORING (colonne + calcolo + trigger BEFORE + indice
-- + backfill). Il trigger ETL form→anagrafiche di 20260528 è VOLUTAMENTE ESCLUSO
-- perché referenzia tabelle inesistenti in live (`adults`/`student_adults`, drift
-- vs `parents`/`student_parents`): andrà riscritto in una slice dedicata.
-- Aggiunge inoltre l'esito di ammissione (delibera) su form_submissions.
-- Idempotente.
-- =============================================================================

-- ── Scoring foundation ──────────────────────────────────────────────────────
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS manual_adjustments JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.form_models
  ADD COLUMN IF NOT EXISTS is_enrollment_form BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_form_submissions_ranking
  ON public.form_submissions (model_id, score DESC, signed_at ASC);

CREATE OR REPLACE FUNCTION public.calc_form_base_score(p_schema jsonb, p_data jsonb)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total numeric := 0; v_weights jsonb; v_page jsonb; v_field jsonb;
  v_fid text; v_weight numeric; v_points numeric; v_answer jsonb; v_optval text;
BEGIN
  IF p_schema IS NULL OR jsonb_typeof(p_schema->'pages') <> 'array' THEN RETURN 0; END IF;
  v_weights := COALESCE(p_schema->'scoring'->'weights', '{}'::jsonb);
  FOR v_page IN SELECT jsonb_array_elements(p_schema->'pages') LOOP
    IF jsonb_typeof(v_page->'fields') <> 'array' THEN CONTINUE; END IF;
    FOR v_field IN SELECT jsonb_array_elements(v_page->'fields') LOOP
      v_fid := v_field->>'id'; v_answer := p_data->v_fid;
      v_weight := COALESCE((v_weights->>v_fid)::numeric, 1);
      IF v_answer IS NULL OR v_answer::text IN ('null', '""') THEN CONTINUE; END IF;
      IF jsonb_typeof(v_field->'options') = 'array' THEN
        IF jsonb_typeof(v_answer) = 'array' THEN
          FOR v_optval IN SELECT jsonb_array_elements_text(v_answer) LOOP
            SELECT (opt->>'points')::numeric INTO v_points
            FROM jsonb_array_elements(v_field->'options') AS opt
            WHERE opt->>'value' = v_optval LIMIT 1;
            v_total := v_total + COALESCE(v_points, 0) * v_weight;
          END LOOP;
        ELSE
          v_optval := trim(both '"' FROM v_answer::text);
          SELECT (opt->>'points')::numeric INTO v_points
          FROM jsonb_array_elements(v_field->'options') AS opt
          WHERE opt->>'value' = v_optval LIMIT 1;
          v_total := v_total + COALESCE(v_points, 0) * v_weight;
        END IF;
      ELSE
        v_points := COALESCE((v_field->>'points')::numeric, 0);
        IF v_points <> 0 AND v_answer::text NOT IN ('false', '0') THEN
          v_total := v_total + v_points * v_weight;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN round(v_total)::integer;
END;
$$;

CREATE OR REPLACE FUNCTION public.calc_manual_delta(p_adjustments jsonb)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM((adj->>'delta')::numeric), 0)::integer
  FROM jsonb_array_elements(COALESCE(p_adjustments, '[]'::jsonb)) AS adj;
$$;

CREATE OR REPLACE FUNCTION public.fn_form_submission_score()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_schema jsonb;
BEGIN
  IF NEW.status = 'completed' THEN
    SELECT schema INTO v_schema FROM public.form_models WHERE id = NEW.model_id;
    NEW.score := public.calc_form_base_score(v_schema, NEW.data)
               + public.calc_manual_delta(NEW.manual_adjustments);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_form_submission_score ON public.form_submissions;
CREATE TRIGGER trg_form_submission_score
  BEFORE INSERT OR UPDATE OF status, data, manual_adjustments
  ON public.form_submissions
  FOR EACH ROW EXECUTE FUNCTION public.fn_form_submission_score();

UPDATE public.form_submissions s
SET score = public.calc_form_base_score(m.schema, s.data) + public.calc_manual_delta(s.manual_adjustments)
FROM public.form_models m
WHERE m.id = s.model_id AND s.status = 'completed';

-- ── Delibera ammissioni (DL-025) ────────────────────────────────────────────
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS esito_ammissione text
    CHECK (esito_ammissione IN ('ammesso', 'lista_attesa', 'non_ammesso')),
  ADD COLUMN IF NOT EXISTS esito_il   timestamptz,
  ADD COLUMN IF NOT EXISTS esito_da   uuid,
  ADD COLUMN IF NOT EXISTS esito_note text;

NOTIFY pgrst, 'reload schema';
