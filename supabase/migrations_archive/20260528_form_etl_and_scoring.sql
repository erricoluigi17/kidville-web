-- ============================================================
-- KIDVILLE — Form ETL + Scoring/Graduatorie
-- Migration: 20260528_form_etl_and_scoring.sql
-- ============================================================
-- 1) Aggiunge score + manual_adjustments a form_submissions
-- 2) Funzioni PL/pgSQL per il calcolo del punteggio dallo schema
-- 3) Trigger BEFORE per scrivere lo score sulla riga (no ricorsione)
-- 4) Trigger AFTER per l'ETL anagrafico (upsert adults/alunni/link)
--    al passaggio dello stato a 'completed'.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Nuove colonne
-- ─────────────────────────────────────────────────────────────
ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;

ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS manual_adjustments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Flag opzionale per identificare i moduli d'iscrizione (oltre al match sul titolo)
ALTER TABLE form_models
  ADD COLUMN IF NOT EXISTS is_enrollment_form BOOLEAN NOT NULL DEFAULT false;

-- Indice per ordinamento graduatorie (score desc, signed_at asc)
CREATE INDEX IF NOT EXISTS idx_form_submissions_ranking
  ON form_submissions (model_id, score DESC, signed_at ASC);

-- ─────────────────────────────────────────────────────────────
-- 2. Calcolo punteggio base dallo schema + risposte
--    Incrocia data (field_id → valore) con i points dei campi e
--    delle opzioni, applicando i pesi definiti in scoring.weights.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION calc_form_base_score(p_schema jsonb, p_data jsonb)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_total   numeric := 0;
  v_weights jsonb;
  v_page    jsonb;
  v_field   jsonb;
  v_fid     text;
  v_weight  numeric;
  v_points  numeric;
  v_answer  jsonb;
  v_optval  text;
BEGIN
  IF p_schema IS NULL OR jsonb_typeof(p_schema->'pages') <> 'array' THEN
    RETURN 0;
  END IF;

  v_weights := COALESCE(p_schema->'scoring'->'weights', '{}'::jsonb);

  FOR v_page IN SELECT jsonb_array_elements(p_schema->'pages')
  LOOP
    IF jsonb_typeof(v_page->'fields') <> 'array' THEN
      CONTINUE;
    END IF;

    FOR v_field IN SELECT jsonb_array_elements(v_page->'fields')
    LOOP
      v_fid    := v_field->>'id';
      v_answer := p_data->v_fid;
      v_weight := COALESCE((v_weights->>v_fid)::numeric, 1);

      -- nessuna risposta → nessun punteggio
      IF v_answer IS NULL OR v_answer::text IN ('null', '""') THEN
        CONTINUE;
      END IF;

      IF jsonb_typeof(v_field->'options') = 'array' THEN
        -- Campo a scelta: somma i points delle opzioni selezionate
        IF jsonb_typeof(v_answer) = 'array' THEN
          FOR v_optval IN SELECT jsonb_array_elements_text(v_answer)
          LOOP
            SELECT (opt->>'points')::numeric
              INTO v_points
            FROM jsonb_array_elements(v_field->'options') AS opt
            WHERE opt->>'value' = v_optval
            LIMIT 1;
            v_total := v_total + COALESCE(v_points, 0) * v_weight;
          END LOOP;
        ELSE
          v_optval := trim(both '"' FROM v_answer::text);
          SELECT (opt->>'points')::numeric
            INTO v_points
          FROM jsonb_array_elements(v_field->'options') AS opt
          WHERE opt->>'value' = v_optval
          LIMIT 1;
          v_total := v_total + COALESCE(v_points, 0) * v_weight;
        END IF;
      ELSE
        -- Campo semplice: assegna i points base se valorizzato
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

-- Somma dei delta manuali (bonus/malus) registrati dallo staff
CREATE OR REPLACE FUNCTION calc_manual_delta(p_adjustments jsonb)
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(
    SUM((adj->>'delta')::numeric), 0
  )::integer
  FROM jsonb_array_elements(COALESCE(p_adjustments, '[]'::jsonb)) AS adj;
$$;

-- ─────────────────────────────────────────────────────────────
-- 3. Trigger BEFORE: scrive lo score totale sulla riga
--    (BEFORE → set NEW.score: nessuna ricorsione)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_form_submission_score()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_schema jsonb;
BEGIN
  IF NEW.status = 'completed' THEN
    SELECT schema INTO v_schema FROM form_models WHERE id = NEW.model_id;
    NEW.score :=
      calc_form_base_score(v_schema, NEW.data)
      + calc_manual_delta(NEW.manual_adjustments);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_form_submission_score ON form_submissions;
CREATE TRIGGER trg_form_submission_score
  BEFORE INSERT OR UPDATE OF status, data, manual_adjustments
  ON form_submissions
  FOR EACH ROW EXECUTE FUNCTION fn_form_submission_score();

-- ─────────────────────────────────────────────────────────────
-- 4. Trigger AFTER: ETL anagrafico al completamento.
--    Routing guidato da db_mapping (es. "alunni.nome",
--    "adults.fiscal_code") per garantire coerenza transazionale.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_form_submission_etl()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_model        form_models%ROWTYPE;
  v_is_enrollment boolean;
  v_page  jsonb;
  v_field jsonb;
  v_map   text;
  v_fid   text;
  v_val   text;
  -- campi alunno
  s_nome text; s_cognome text; s_data_nascita text; s_sezione text; s_note text;
  -- campi adulto/genitore
  a_first text; a_last text; a_fiscal text; a_email text; a_phone text; a_address text;
  v_student_id uuid;
  v_adult_id   uuid;
  c_scuola_id  uuid := '11111111-1111-1111-1111-111111111111';
BEGIN
  -- Solo alla prima transizione verso 'completed'
  IF NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_model FROM form_models WHERE id = NEW.model_id;

  v_is_enrollment :=
    COALESCE(v_model.is_enrollment_form, false)
    OR COALESCE((v_model.schema->>'is_enrollment_form')::boolean, false)
    OR v_model.title ILIKE '%iscriz%';

  IF NOT v_is_enrollment THEN
    RETURN NEW;
  END IF;

  -- Estrazione valori in base ai db_mapping dello schema
  FOR v_page IN SELECT jsonb_array_elements(v_model.schema->'pages')
  LOOP
    IF jsonb_typeof(v_page->'fields') <> 'array' THEN CONTINUE; END IF;
    FOR v_field IN SELECT jsonb_array_elements(v_page->'fields')
    LOOP
      v_map := v_field->>'db_mapping';
      IF v_map IS NULL OR v_map = '' THEN CONTINUE; END IF;
      v_fid := v_field->>'id';
      v_val := NEW.data->>v_fid;
      IF v_val IS NULL OR v_val = '' THEN CONTINUE; END IF;

      CASE v_map
        WHEN 'alunni.nome'          THEN s_nome := v_val;
        WHEN 'alunni.cognome'       THEN s_cognome := v_val;
        WHEN 'alunni.data_nascita'  THEN s_data_nascita := v_val;
        WHEN 'alunni.sezione'       THEN s_sezione := v_val;
        WHEN 'alunni.note_mediche'  THEN s_note := v_val;
        WHEN 'adults.first_name'    THEN a_first := v_val;
        WHEN 'adults.last_name'     THEN a_last := v_val;
        WHEN 'adults.fiscal_code'   THEN a_fiscal := upper(v_val);
        WHEN 'adults.email'         THEN a_email := lower(v_val);
        WHEN 'adults.phone'         THEN a_phone := v_val;
        WHEN 'adults.address'       THEN a_address := v_val;
        ELSE NULL;
      END CASE;
    END LOOP;
  END LOOP;

  -- ── Upsert ADULTO ──────────────────────────────────────────
  -- adults.id referenzia auth.users: serve un utente autenticato.
  IF NEW.user_id IS NOT NULL AND (a_first IS NOT NULL OR a_fiscal IS NOT NULL) THEN
    BEGIN
      INSERT INTO adults (id, first_name, last_name, fiscal_code, emails, phones, address, role)
      VALUES (
        NEW.user_id,
        COALESCE(a_first, 'N/D'),
        COALESCE(a_last, 'N/D'),
        a_fiscal,
        CASE WHEN a_email IS NOT NULL THEN ARRAY[a_email] ELSE NULL END,
        CASE WHEN a_phone IS NOT NULL THEN ARRAY[a_phone] ELSE NULL END,
        a_address,
        'parent'
      )
      ON CONFLICT (id) DO UPDATE SET
        first_name  = COALESCE(EXCLUDED.first_name, adults.first_name),
        last_name   = COALESCE(EXCLUDED.last_name,  adults.last_name),
        fiscal_code = COALESCE(EXCLUDED.fiscal_code, adults.fiscal_code),
        emails      = COALESCE(EXCLUDED.emails, adults.emails),
        phones      = COALESCE(EXCLUDED.phones, adults.phones),
        address     = COALESCE(EXCLUDED.address, adults.address)
      RETURNING id INTO v_adult_id;
    EXCEPTION WHEN unique_violation THEN
      -- fiscal_code già presente su un altro record: aggiorna quello
      UPDATE adults SET
        first_name = COALESCE(a_first, first_name),
        last_name  = COALESCE(a_last, last_name),
        emails     = COALESCE(CASE WHEN a_email IS NOT NULL THEN ARRAY[a_email] ELSE NULL END, emails),
        phones     = COALESCE(CASE WHEN a_phone IS NOT NULL THEN ARRAY[a_phone] ELSE NULL END, phones),
        address    = COALESCE(a_address, address)
      WHERE fiscal_code = a_fiscal
      RETURNING id INTO v_adult_id;
    END;
  END IF;

  -- ── Upsert ALUNNO ──────────────────────────────────────────
  -- alunni non ha vincolo univoco: match manuale nome+cognome+data.
  IF s_nome IS NOT NULL AND s_cognome IS NOT NULL THEN
    SELECT id INTO v_student_id
    FROM alunni
    WHERE lower(nome) = lower(s_nome)
      AND lower(cognome) = lower(s_cognome)
      AND (s_data_nascita IS NULL OR data_nascita = NULLIF(s_data_nascita, '')::date)
    LIMIT 1;

    IF v_student_id IS NULL THEN
      INSERT INTO alunni (nome, cognome, data_nascita, sezione, note_mediche, scuola_id)
      VALUES (
        s_nome, s_cognome,
        NULLIF(s_data_nascita, '')::date,
        s_sezione, s_note, c_scuola_id
      )
      RETURNING id INTO v_student_id;
    ELSE
      UPDATE alunni SET
        sezione      = COALESCE(s_sezione, sezione),
        note_mediche = COALESCE(s_note, note_mediche)
      WHERE id = v_student_id;
    END IF;
  END IF;

  -- ── Collega genitore ↔ alunno ──────────────────────────────
  IF v_student_id IS NOT NULL AND v_adult_id IS NOT NULL THEN
    INSERT INTO student_adults (student_id, adult_id, relationship_role, can_pickup, can_view_diary)
    VALUES (v_student_id, v_adult_id, 'parent', true, true)
    ON CONFLICT (student_id, adult_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_form_submission_etl ON form_submissions;
CREATE TRIGGER trg_form_submission_etl
  AFTER INSERT OR UPDATE OF status
  ON form_submissions
  FOR EACH ROW EXECUTE FUNCTION fn_form_submission_etl();

-- ─────────────────────────────────────────────────────────────
-- 5. Backfill score per le compilazioni già completate
-- ─────────────────────────────────────────────────────────────
UPDATE form_submissions s
SET score = calc_form_base_score(m.schema, s.data)
          + calc_manual_delta(s.manual_adjustments)
FROM form_models m
WHERE m.id = s.model_id
  AND s.status = 'completed';
