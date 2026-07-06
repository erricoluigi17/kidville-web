-- 20260767 — Anagrafiche: provincia e civico di residenza su alunni + parents
-- e propagazione dei nuovi campi nell'ETL dei moduli d'iscrizione (trigger).
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION.

ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS residence_province      varchar(2),
  ADD COLUMN IF NOT EXISTS residence_street_number varchar(20);

ALTER TABLE public.parents
  ADD COLUMN IF NOT EXISTS residence_province      varchar(2),
  ADD COLUMN IF NOT EXISTS residence_street_number varchar(20);

-- ETL moduli d'iscrizione (builder): popolare anche cittadinanza/nazione su
-- alunni e provincia/civico di residenza su alunni + parents.
CREATE OR REPLACE FUNCTION public.fn_form_submission_etl() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_model         form_models%ROWTYPE;
  v_is_enrollment boolean;
  v_page  jsonb;
  v_field jsonb;
  v_map   text;
  v_tab   text;
  v_col   text;
  v_val   text;
  parent_obj jsonb := '{}'::jsonb;
  alunno_obj jsonb := '{}'::jsonb;
  v_student_id uuid;
  v_parent_id  uuid;
  c_scuola_id  uuid := '11111111-1111-1111-1111-111111111111';
BEGIN
  IF NEW.status <> 'completed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN RETURN NEW; END IF;

  SELECT * INTO v_model FROM public.form_models WHERE id = NEW.model_id;
  v_is_enrollment :=
       COALESCE(v_model.is_enrollment_form, false)
    OR COALESCE((v_model.schema->>'is_enrollment_form')::boolean, false)
    OR v_model.title ILIKE '%iscriz%';
  IF NOT v_is_enrollment THEN RETURN NEW; END IF;

  FOR v_page IN SELECT jsonb_array_elements(v_model.schema->'pages') LOOP
    IF jsonb_typeof(v_page->'fields') <> 'array' THEN CONTINUE; END IF;
    FOR v_field IN SELECT jsonb_array_elements(v_page->'fields') LOOP
      v_map := v_field->>'db_mapping';
      IF v_map IS NULL OR position('.' IN v_map) = 0 THEN CONTINUE; END IF;
      v_val := NEW.data->>(v_field->>'id');
      IF v_val IS NULL OR v_val = '' THEN CONTINUE; END IF;
      v_tab := split_part(v_map, '.', 1);
      v_col := split_part(v_map, '.', 2);

      IF v_tab IN ('adults', 'parents') THEN
        v_col := CASE v_col
          WHEN 'address'     THEN 'residence_address'
          WHEN 'phones'      THEN 'phone_numbers'
          WHEN 'birth_place' THEN 'birth_city'
          ELSE v_col END;
        parent_obj := parent_obj || jsonb_build_object(v_col, v_val);
      ELSIF v_tab = 'alunni' THEN
        alunno_obj := alunno_obj || jsonb_build_object(v_col, v_val);
      END IF;
    END LOOP;
  END LOOP;

  IF (alunno_obj ? 'nome') AND (alunno_obj ? 'cognome') AND (alunno_obj ? 'data_nascita') THEN
    BEGIN
      IF alunno_obj ? 'codice_fiscale' THEN
        SELECT id INTO v_student_id FROM public.alunni
        WHERE upper(trim(codice_fiscale)) = upper(trim(alunno_obj->>'codice_fiscale')) LIMIT 1;
      END IF;
      IF v_student_id IS NULL THEN
        SELECT id INTO v_student_id FROM public.alunni
        WHERE lower(nome) = lower(alunno_obj->>'nome')
          AND lower(cognome) = lower(alunno_obj->>'cognome')
          AND data_nascita = (alunno_obj->>'data_nascita')::date
        LIMIT 1;
      END IF;

      IF v_student_id IS NULL THEN
        INSERT INTO public.alunni (
          scuola_id, nome, cognome, data_nascita, codice_fiscale, classe_sezione,
          note_mediche, allergies, gender, birth_city, birth_province,
          residence_address, residence_city, zip_code, is_bes_dsa, documento_path,
          citizenship, birth_nation, residence_province, residence_street_number
        ) VALUES (
          c_scuola_id, alunno_obj->>'nome', alunno_obj->>'cognome',
          (alunno_obj->>'data_nascita')::date, alunno_obj->>'codice_fiscale',
          alunno_obj->>'classe_sezione', alunno_obj->>'note_mediche', alunno_obj->>'allergies',
          alunno_obj->>'gender', alunno_obj->>'birth_city', alunno_obj->>'birth_province',
          alunno_obj->>'residence_address', alunno_obj->>'residence_city', alunno_obj->>'zip_code',
          (alunno_obj->>'is_bes_dsa')::boolean, alunno_obj->>'documento_path',
          alunno_obj->>'citizenship', alunno_obj->>'birth_nation',
          alunno_obj->>'residence_province', alunno_obj->>'residence_street_number'
        )
        RETURNING id INTO v_student_id;
      ELSE
        UPDATE public.alunni SET
          classe_sezione = COALESCE(alunno_obj->>'classe_sezione', classe_sezione),
          note_mediche   = COALESCE(alunno_obj->>'note_mediche', note_mediche)
        WHERE id = v_student_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ETL alunno fallito (best-effort): %', SQLERRM;
    END;
  END IF;

  IF (parent_obj ? 'first_name') OR (parent_obj ? 'fiscal_code') THEN
    BEGIN
      IF parent_obj ? 'fiscal_code' THEN
        SELECT id INTO v_parent_id FROM public.parents
        WHERE upper(trim(fiscal_code)) = upper(trim(parent_obj->>'fiscal_code')) LIMIT 1;
      END IF;

      IF v_parent_id IS NULL THEN
        INSERT INTO public.parents (
          first_name, last_name, fiscal_code, emails, phone_numbers,
          residence_address, residence_city, zip_code, birth_date, birth_city,
          birth_nation, birth_province, document_number, document_type, documento_path,
          gender, citizenship, residence_province, residence_street_number
        ) VALUES (
          COALESCE(parent_obj->>'first_name', 'N/D'), COALESCE(parent_obj->>'last_name', 'N/D'),
          parent_obj->>'fiscal_code',
          CASE WHEN parent_obj ? 'emails'        THEN ARRAY[parent_obj->>'emails']        END,
          CASE WHEN parent_obj ? 'phone_numbers' THEN ARRAY[parent_obj->>'phone_numbers'] END,
          parent_obj->>'residence_address', parent_obj->>'residence_city', parent_obj->>'zip_code',
          NULLIF(parent_obj->>'birth_date', '')::date, parent_obj->>'birth_city',
          parent_obj->>'birth_nation', parent_obj->>'birth_province',
          parent_obj->>'document_number', parent_obj->>'document_type', parent_obj->>'documento_path',
          parent_obj->>'gender', parent_obj->>'citizenship',
          parent_obj->>'residence_province', parent_obj->>'residence_street_number'
        )
        RETURNING id INTO v_parent_id;
      ELSE
        UPDATE public.parents SET
          first_name        = COALESCE(parent_obj->>'first_name', first_name),
          last_name         = COALESCE(parent_obj->>'last_name', last_name),
          emails            = COALESCE(CASE WHEN parent_obj ? 'emails'        THEN ARRAY[parent_obj->>'emails']        END, emails),
          phone_numbers     = COALESCE(CASE WHEN parent_obj ? 'phone_numbers' THEN ARRAY[parent_obj->>'phone_numbers'] END, phone_numbers),
          residence_address = COALESCE(parent_obj->>'residence_address', residence_address)
        WHERE id = v_parent_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ETL genitore fallito (best-effort): %', SQLERRM;
    END;
  END IF;

  IF v_student_id IS NOT NULL AND v_parent_id IS NOT NULL THEN
    INSERT INTO public.student_parents (student_id, parent_id, relation_type, is_primary)
    VALUES (v_student_id, v_parent_id, 'parent', true)
    ON CONFLICT (student_id, parent_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;
