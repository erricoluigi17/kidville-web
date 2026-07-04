--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- [baseline] estensioni richieste dallo schema (idempotenti)
-- Nota: pg_net (net.http_post nei cron) NON è qui: si abilita come step di prod-readiness.
-- Le funzioni che lo usano si creano comunque perché il dump imposta check_function_bodies = false.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--




--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--



--
-- Name: document_type_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.document_type_enum AS ENUM (
    'diagnosi',
    'pei',
    '104',
    'pdp'
);


ALTER TYPE public.document_type_enum OWNER TO postgres;

--
-- Name: fattura_stato; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.fattura_stato AS ENUM (
    'non_richiesta',
    'in_attesa',
    'emessa',
    'scartata'
);


ALTER TYPE public.fattura_stato OWNER TO postgres;

--
-- Name: form_submission_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.form_submission_status AS ENUM (
    'draft',
    'pending_signature',
    'completed'
);


ALTER TYPE public.form_submission_status OWNER TO postgres;

--
-- Name: incasso_metodo; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.incasso_metodo AS ENUM (
    'contanti',
    'bonifico',
    'pos',
    'assegno',
    'altro'
);


ALTER TYPE public.incasso_metodo OWNER TO postgres;

--
-- Name: invoice_holder_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.invoice_holder_type AS ENUM (
    'mom',
    'dad',
    'other'
);


ALTER TYPE public.invoice_holder_type OWNER TO postgres;

--
-- Name: pagamento_tipo; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.pagamento_tipo AS ENUM (
    'singolo',
    'padre',
    'rata',
    'split'
);


ALTER TYPE public.pagamento_tipo OWNER TO postgres;

--
-- Name: school_type_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.school_type_enum AS ENUM (
    'nido',
    'infanzia',
    'primaria'
);


ALTER TYPE public.school_type_enum OWNER TO postgres;

--
-- Name: calc_form_base_score(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.calc_form_base_score(p_schema jsonb, p_data jsonb) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
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


ALTER FUNCTION public.calc_form_base_score(p_schema jsonb, p_data jsonb) OWNER TO postgres;

--
-- Name: calc_manual_delta(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.calc_manual_delta(p_adjustments jsonb) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE(SUM((adj->>'delta')::numeric), 0)::integer
  FROM jsonb_array_elements(COALESCE(p_adjustments, '[]'::jsonb)) AS adj;
$$;


ALTER FUNCTION public.calc_manual_delta(p_adjustments jsonb) OWNER TO postgres;

--
-- Name: crea_quote_da_config(uuid, uuid, numeric, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.crea_quote_da_config(p_pagamento_id uuid, p_alunno_id uuid, p_importo numeric, p_config jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.crea_quote_da_config(p_pagamento_id uuid, p_alunno_id uuid, p_importo numeric, p_config jsonb) OWNER TO postgres;

--
-- Name: current_parent_student_ids(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.current_parent_student_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT sp.student_id FROM public.student_parents sp
  JOIN public.parents p ON p.id = sp.parent_id
  WHERE p.auth_user_id = auth.uid()
$$;


ALTER FUNCTION public.current_parent_student_ids() OWNER TO postgres;

--
-- Name: exec_sql(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.exec_sql(sql text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  EXECUTE sql;
END;
$$;


ALTER FUNCTION public.exec_sql(sql text) OWNER TO postgres;

--
-- Name: fatture_sdi_sync_tick(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.fatture_sdi_sync_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_url    text := current_setting('app.fattura_sync_url', true);
  v_secret text := current_setting('app.cron_secret', true);
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;


ALTER FUNCTION public.fatture_sdi_sync_tick() OWNER TO postgres;

--
-- Name: fn_form_submission_etl(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.fn_form_submission_etl() RETURNS trigger
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
          residence_address, residence_city, zip_code, is_bes_dsa, documento_path
        ) VALUES (
          c_scuola_id, alunno_obj->>'nome', alunno_obj->>'cognome',
          (alunno_obj->>'data_nascita')::date, alunno_obj->>'codice_fiscale',
          alunno_obj->>'classe_sezione', alunno_obj->>'note_mediche', alunno_obj->>'allergies',
          alunno_obj->>'gender', alunno_obj->>'birth_city', alunno_obj->>'birth_province',
          alunno_obj->>'residence_address', alunno_obj->>'residence_city', alunno_obj->>'zip_code',
          (alunno_obj->>'is_bes_dsa')::boolean, alunno_obj->>'documento_path'
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
          gender, citizenship
        ) VALUES (
          COALESCE(parent_obj->>'first_name', 'N/D'), COALESCE(parent_obj->>'last_name', 'N/D'),
          parent_obj->>'fiscal_code',
          CASE WHEN parent_obj ? 'emails'        THEN ARRAY[parent_obj->>'emails']        END,
          CASE WHEN parent_obj ? 'phone_numbers' THEN ARRAY[parent_obj->>'phone_numbers'] END,
          parent_obj->>'residence_address', parent_obj->>'residence_city', parent_obj->>'zip_code',
          NULLIF(parent_obj->>'birth_date', '')::date, parent_obj->>'birth_city',
          parent_obj->>'birth_nation', parent_obj->>'birth_province',
          parent_obj->>'document_number', parent_obj->>'document_type', parent_obj->>'documento_path',
          parent_obj->>'gender', parent_obj->>'citizenship'
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


ALTER FUNCTION public.fn_form_submission_etl() OWNER TO postgres;

--
-- Name: fn_form_submission_score(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.fn_form_submission_score() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
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


ALTER FUNCTION public.fn_form_submission_score() OWNER TO postgres;

--
-- Name: genera_rette_anno(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.genera_rette_anno(p_anno_inizio integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.genera_rette_anno(p_anno_inizio integer) OWNER TO postgres;

--
-- Name: genera_rette_mensili(date); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.genera_rette_mensili(p_periodo date DEFAULT (date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone))::date) RETURNS integer
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


ALTER FUNCTION public.genera_rette_mensili(p_periodo date) OWNER TO postgres;

--
-- Name: genera_solleciti(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.genera_solleciti() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_count INT := 0;
  v_url   TEXT;
  v_secret TEXT;
BEGIN
  -- 1) aggiorna stati 'scaduto'
  UPDATE public.pagamenti SET stato = 'scaduto', aggiornato_il = NOW()
   WHERE stato IN ('da_pagare', 'parziale')
     AND scadenza < CURRENT_DATE
     AND COALESCE(importo_pagato, 0) < importo;

  -- 2) notifiche per gli obbligatori non saldati, scaduti/in scadenza, cadenza 2gg.
  --    Destinatari: split -> titolari di quota; altri -> tutti i tutori del bambino.
  WITH dovuti AS (
    SELECT p.id, p.descrizione, p.alunno_id, p.tipo
    FROM public.pagamenti p
    WHERE p.obbligatorio = true
      AND p.tipo IN ('singolo', 'rata', 'split')
      AND COALESCE(p.importo_pagato, 0) < p.importo
      AND p.scadenza <= CURRENT_DATE
      AND (p.ultimo_sollecito_il IS NULL OR p.ultimo_sollecito_il < NOW() - INTERVAL '2 days')
  ),
  destinatari AS (
    SELECT d.id AS pagamento_id, d.descrizione, q.adult_id AS utente_id
    FROM dovuti d
    JOIN public.pagamenti_quote q ON q.pagamento_id = d.id
    WHERE d.tipo = 'split'
    UNION
    SELECT d.id, d.descrizione, l.genitore_id
    FROM dovuti d
    JOIN public.legame_genitori_alunni l ON l.alunno_id = d.alunno_id
    WHERE d.tipo <> 'split'
  ),
  ins AS (
    INSERT INTO public.notifiche (utente_id, tipo, titolo, corpo, link, entita_tipo, entita_id)
    SELECT utente_id, 'sollecito_pagamento', 'Pagamento in scadenza',
           'Hai un pagamento da saldare: ' || descrizione, '/parent/pagamenti', 'pagamento', pagamento_id
    FROM destinatari
    RETURNING entita_id
  )
  SELECT COUNT(DISTINCT entita_id) INTO v_count FROM ins;

  -- segna i pagamenti sollecitati
  UPDATE public.pagamenti SET ultimo_sollecito_il = NOW()
   WHERE obbligatorio = true
     AND tipo IN ('singolo', 'rata', 'split')
     AND COALESCE(importo_pagato, 0) < importo
     AND scadenza <= CURRENT_DATE
     AND (ultimo_sollecito_il IS NULL OR ultimo_sollecito_il < NOW() - INTERVAL '2 days');

  -- 3) dispatch push best-effort (solo se le GUC sono configurate)
  v_url := current_setting('app.push_dispatch_url', true);
  v_secret := current_setting('app.cron_secret', true);
  IF v_url IS NOT NULL AND v_url <> '' THEN
    BEGIN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
        body := '{}'::jsonb
      );
    EXCEPTION WHEN OTHERS THEN null;
    END;
  END IF;

  RETURN v_count;
END $$;


ALTER FUNCTION public.genera_solleciti() OWNER TO postgres;

--
-- Name: is_staff_or_admin(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_staff_or_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.utenti
    WHERE id = auth.uid()
      AND ruolo IN ('admin', 'maestra', 'teacher', 'staff', 'cuoca', 'coordinatore', 'educator')
  );
$$;


ALTER FUNCTION public.is_staff_or_admin() OWNER TO postgres;

--
-- Name: mensa_check_allergie_giornaliero(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.mensa_check_allergie_giornaliero() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_url    TEXT := current_setting('app.mensa_allergie_url', true);
  v_secret TEXT := current_setting('app.cron_secret', true);
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;


ALTER FUNCTION public.mensa_check_allergie_giornaliero() OWNER TO postgres;

--
-- Name: notifiche_dispatch_tick(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.notifiche_dispatch_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    TEXT := current_setting('app.push_dispatch_url', true);
  v_secret TEXT := current_setting('app.cron_secret', true);
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;


ALTER FUNCTION public.notifiche_dispatch_tick() OWNER TO postgres;

--
-- Name: prossimo_numero_fattura(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.prossimo_numero_fattura(p_scuola uuid, p_anno integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE v_num int;
BEGIN
  INSERT INTO public.fatture_numerazione (scuola_id, anno, ultimo_numero)
  VALUES (p_scuola, p_anno, 1)
  ON CONFLICT (scuola_id, anno)
  DO UPDATE SET ultimo_numero = public.fatture_numerazione.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_num;
  RETURN v_num;
END $$;


ALTER FUNCTION public.prossimo_numero_fattura(p_scuola uuid, p_anno integer) OWNER TO postgres;

--
-- Name: ricalcola_stato_padre(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.ricalcola_stato_padre(p_parent uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tot NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_min_scad DATE;
BEGIN
  SELECT importo INTO v_tot FROM public.pagamenti WHERE id = p_parent;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(importo_pagato),0), MIN(scadenza)
    INTO v_pagato, v_min_scad
  FROM public.pagamenti WHERE parent_payment_id = p_parent;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    stato = CASE
      WHEN v_pagato >= v_tot AND v_tot > 0 THEN 'pagato'
      WHEN v_pagato > 0 THEN 'parziale'
      WHEN v_min_scad IS NOT NULL AND v_min_scad < CURRENT_DATE THEN 'scaduto'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_parent;
END $$;


ALTER FUNCTION public.ricalcola_stato_padre(p_parent uuid) OWNER TO postgres;

--
-- Name: ricalcola_stato_pagamento(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.ricalcola_stato_pagamento(p_id uuid) RETURNS void
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
      WHEN v_pagato > 0 THEN 'parziale'
      WHEN v_scad IS NOT NULL AND v_scad < CURRENT_DATE THEN 'scaduto'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_id;

  -- se è una rata, ricalcola anche lo stato del padre aggregato
  IF v_parent IS NOT NULL THEN
    PERFORM public.ricalcola_stato_padre(v_parent);
  END IF;
END $$;


ALTER FUNCTION public.ricalcola_stato_pagamento(p_id uuid) OWNER TO postgres;

--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION public.rls_auto_enable() OWNER TO postgres;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO postgres;

--
-- Name: sync_alunno_section_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.sync_alunno_section_id() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- Solo quando abbiamo un nome classe da risolvere.
  IF NEW.classe_sezione IS NOT NULL AND length(trim(NEW.classe_sezione)) > 0 THEN
    -- Risolvi solo se è un INSERT, oppure se classe_sezione è cambiata, oppure se
    -- section_id non è ancora valorizzato. (Non sovrascrive un section_id impostato
    -- esplicitamente quando classe_sezione non cambia.)
    IF TG_OP = 'INSERT'
       OR NEW.classe_sezione IS DISTINCT FROM OLD.classe_sezione
       OR NEW.section_id IS NULL THEN
      SELECT s.id INTO NEW.section_id
      FROM public.sections s
      WHERE s.scuola_id = NEW.scuola_id
        AND lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
      LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.sync_alunno_section_id() OWNER TO postgres;

--
-- Name: trg_incassi_ricalcola(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.trg_incassi_ricalcola() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public.ricalcola_stato_pagamento(COALESCE(NEW.pagamento_id, OLD.pagamento_id));
  RETURN NULL;
END $$;


ALTER FUNCTION public.trg_incassi_ricalcola() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.admin_settings (
    scuola_id uuid NOT NULL,
    retta_default_importo numeric(10,2) DEFAULT 150,
    retta_giorno_scadenza integer DEFAULT 5 NOT NULL,
    retta_auto_enabled boolean DEFAULT true NOT NULL,
    insoluto_tolleranza_giorni integer DEFAULT 7 NOT NULL,
    ticket_pacchetti jsonb DEFAULT '[]'::jsonb,
    aruba_config jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    retta_giorno_visibilita integer DEFAULT 25,
    fattura_causale_template text DEFAULT '{descrizione} - {alunno}'::text,
    mensa_cutoff_ora time without time zone DEFAULT '09:30:00'::time without time zone,
    mensa_giorni_attivi integer[] DEFAULT '{1,2,3,4,5}'::integer[],
    mensa_settimane_rotazione integer DEFAULT 4 NOT NULL,
    mensa_soglia_saldo_basso integer DEFAULT 5 NOT NULL,
    funzioni_matrice jsonb DEFAULT '{}'::jsonb NOT NULL,
    timelock_giorni_classe_orale integer DEFAULT 2 NOT NULL,
    timelock_giorni_scritto_pratico integer DEFAULT 15 NOT NULL,
    notif_buffer_valutazioni_min integer DEFAULT 10 NOT NULL,
    diario_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    presenze_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    note_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    avvisi_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    chat_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    galleria_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    armadietto_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    modulistica_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    segreteria_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    sidi_config jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT admin_settings_retta_giorno_scadenza_check CHECK (((retta_giorno_scadenza >= 1) AND (retta_giorno_scadenza <= 28))),
    CONSTRAINT chk_retta_giorno_visibilita CHECK (((retta_giorno_visibilita >= 1) AND (retta_giorno_visibilita <= 28)))
);


ALTER TABLE public.admin_settings OWNER TO postgres;

--
-- Name: COLUMN admin_settings.funzioni_matrice; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.funzioni_matrice IS 'Matrice preset+override grado→funzioni abilitate. Es: {"primaria":{"registro":true,...},"infanzia":{"diario":true,...}}';


--
-- Name: COLUMN admin_settings.diario_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.diario_config IS 'Config diario infanzia/nido: routine attive, finestra compilazione, visibilità genitori.';


--
-- Name: COLUMN admin_settings.presenze_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.presenze_config IS 'Config presenze/appello: regole giustifiche, firma OTP, soglie alert.';


--
-- Name: COLUMN admin_settings.note_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.note_config IS 'Config note disciplinari: firma OTP, visibilità, categorie, notifiche.';


--
-- Name: COLUMN admin_settings.avvisi_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.avvisi_config IS 'Config avvisi: ruoli pubblicazione, conferma lettura, allegati, scadenza.';


--
-- Name: COLUMN admin_settings.chat_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.chat_config IS 'Config chat: abilitazione genitori, orari docenti, broadcast.';


--
-- Name: COLUMN admin_settings.galleria_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.galleria_config IS 'Config galleria: privacy, ruoli upload, approvazione, download, dimensioni.';


--
-- Name: COLUMN admin_settings.armadietto_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.armadietto_config IS 'Config armadietto: soglie scorta, notifiche, richieste materiale.';


--
-- Name: COLUMN admin_settings.modulistica_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.modulistica_config IS 'Config modulistica: firma OTP, promemoria, ruoli invio, formato export.';


--
-- Name: COLUMN admin_settings.segreteria_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.admin_settings.segreteria_config IS 'Config Segreteria/Direzione: notifica_docente (bool) = avvisa il docente titolare quando segreteria/direzione scrive sulla sua classe. PRD §12.';


--
-- Name: allegati_registro; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.allegati_registro (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registro_id uuid NOT NULL,
    ambito text DEFAULT 'argomento'::text NOT NULL,
    tipo text NOT NULL,
    file_url text NOT NULL,
    file_name text,
    dimensione_byte bigint,
    caricato_da uuid,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT allegati_registro_ambito_check CHECK ((ambito = ANY (ARRAY['argomento'::text, 'compiti'::text]))),
    CONSTRAINT allegati_registro_tipo_check CHECK ((tipo = ANY (ARRAY['pdf'::text, 'immagine'::text])))
);


ALTER TABLE public.allegati_registro OWNER TO postgres;

--
-- Name: alunni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.alunni (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    scuola_id uuid NOT NULL,
    nome character varying(100) NOT NULL,
    cognome character varying(100) NOT NULL,
    data_nascita date NOT NULL,
    codice_fiscale character(16),
    classe_sezione character varying(50),
    stato character varying(50) DEFAULT 'iscritto'::character varying,
    note_mediche text,
    consenso_privacy boolean DEFAULT false,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    gender character varying(10),
    citizenship character varying(50),
    birth_nation character varying(50),
    birth_province character varying(50),
    birth_city character varying(100),
    residence_address character varying(200),
    residence_city character varying(100),
    zip_code character varying(10),
    allergies text,
    invoice_holder_type public.invoice_holder_type,
    invoice_holder_details jsonb,
    is_bes_dsa boolean DEFAULT false,
    fiscal_code character varying(16),
    section_id uuid,
    documento_path text,
    importo_retta_mensile numeric(10,2) DEFAULT 0,
    genitori_separati boolean DEFAULT false NOT NULL,
    retta_split_config jsonb,
    intestatario_fatture jsonb,
    allergeni text[] DEFAULT '{}'::text[],
    usa_pannolino boolean DEFAULT false NOT NULL,
    sospeso boolean DEFAULT false NOT NULL,
    sospeso_motivo text,
    sospeso_il timestamp with time zone,
    sospeso_da uuid,
    anonimizzato_il timestamp with time zone,
    gruppo_mensa_id uuid,
    numero_domanda_sidi text
);


ALTER TABLE public.alunni OWNER TO postgres;

--
-- Name: COLUMN alunni.usa_pannolino; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.alunni.usa_pannolino IS 'Se true, ogni evento Bagno del Diario 0-6 scala 1 pannolino dall''armadietto del bambino (PRD Armadietto §2.2).';


--
-- Name: COLUMN alunni.anonimizzato_il; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.alunni.anonimizzato_il IS 'Diritto all''oblio (DL-034): timestamp di anonimizzazione PII. NULL = attivo.';


--
-- Name: armadietto; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.armadietto (
    alunno_id uuid NOT NULL,
    nome_oggetto character varying(100) NOT NULL,
    quantita_residua integer DEFAULT 0,
    livello_allerta integer DEFAULT 5,
    livello_emergenza integer DEFAULT 2,
    materiale text DEFAULT 'Generico'::text NOT NULL,
    quantita integer DEFAULT 0 NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    portato boolean DEFAULT true NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    scuola_id uuid
);


ALTER TABLE public.armadietto OWNER TO postgres;

--
-- Name: audit_scritture_docente; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_scritture_docente (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attore_id uuid,
    attore_ruolo text,
    scuola_id uuid,
    section_id uuid,
    entita_tipo text NOT NULL,
    entita_id uuid,
    azione text NOT NULL,
    valore_prima jsonb,
    valore_dopo jsonb,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT audit_scritture_docente_azione_check CHECK ((azione = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))
);


ALTER TABLE public.audit_scritture_docente OWNER TO postgres;

--
-- Name: TABLE audit_scritture_docente; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.audit_scritture_docente IS 'Audit immodificabile delle scritture sulle funzioni docente: attore (docente/segreteria/direzione), plesso, classe, entità, azione e diff valore_prima/valore_dopo. PRD §3/§12.';


--
-- Name: avvisi; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.avvisi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    titolo character varying(255) NOT NULL,
    contenuto text NOT NULL,
    tipo character varying(20) DEFAULT 'presa_visione'::character varying NOT NULL,
    target_scope character varying(20) DEFAULT 'globale'::character varying NOT NULL,
    target_classes text[],
    scadenza date,
    attachment_url text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    scuola_id uuid
);


ALTER TABLE public.avvisi OWNER TO postgres;

--
-- Name: avvisi_risposte; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.avvisi_risposte (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    avviso_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    student_id uuid NOT NULL,
    letto_il timestamp with time zone,
    risposta character varying(10),
    risposto_il timestamp with time zone
);


ALTER TABLE public.avvisi_risposte OWNER TO postgres;

--
-- Name: campanelle; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.campanelle (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    giorno_settimana integer NOT NULL,
    ordine integer NOT NULL,
    ora_inizio time without time zone NOT NULL,
    ora_fine time without time zone NOT NULL,
    tipo text DEFAULT 'lezione'::text NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT campanelle_giorno_settimana_check CHECK (((giorno_settimana >= 1) AND (giorno_settimana <= 6))),
    CONSTRAINT campanelle_tipo_check CHECK ((tipo = ANY (ARRAY['lezione'::text, 'intervallo'::text, 'mensa'::text])))
);


ALTER TABLE public.campanelle OWNER TO postgres;

--
-- Name: certificati_competenze; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.certificati_competenze (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    section_id uuid,
    scrutinio_id uuid,
    anno_scolastico text NOT NULL,
    stato text DEFAULT 'bozza'::text NOT NULL,
    file_url text,
    firma_applicativa jsonb,
    generato_da uuid,
    generato_il timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT certificati_competenze_stato_check CHECK ((stato = ANY (ARRAY['bozza'::text, 'generato'::text, 'firmato'::text])))
);


ALTER TABLE public.certificati_competenze OWNER TO postgres;

--
-- Name: certificati_medici; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.certificati_medici (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alunno_id uuid NOT NULL,
    file_path text NOT NULL,
    data_inizio date,
    data_fine date,
    stato text DEFAULT 'in_validazione'::text NOT NULL,
    caricato_da uuid,
    note text,
    validato_da uuid,
    validato_il timestamp with time zone,
    nota_validazione text,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT certificati_medici_stato_chk CHECK ((stato = ANY (ARRAY['in_validazione'::text, 'validato'::text, 'rifiutato'::text])))
);


ALTER TABLE public.certificati_medici OWNER TO postgres;

--
-- Name: certificato_competenza_livelli; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.certificato_competenza_livelli (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    certificato_id uuid NOT NULL,
    competenza_codice text NOT NULL,
    livello text,
    note text,
    ordine integer DEFAULT 0 NOT NULL,
    CONSTRAINT certificato_competenza_livelli_livello_check CHECK ((livello = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text])))
);


ALTER TABLE public.certificato_competenza_livelli OWNER TO postgres;

--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    content text NOT NULL,
    attachment_url text,
    attachment_type character varying(20),
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.chat_messages OWNER TO postgres;

--
-- Name: chat_threads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.chat_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teacher_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    student_id uuid NOT NULL,
    last_message_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.chat_threads OWNER TO postgres;

--
-- Name: delegates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.delegates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    relation character varying(100),
    document_number character varying(50),
    document_url text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.delegates OWNER TO postgres;

--
-- Name: divise_articoli; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.divise_articoli (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    nome text NOT NULL,
    descrizione text,
    taglie text[] DEFAULT '{}'::text[] NOT NULL,
    prezzo numeric(10,2) DEFAULT 0 NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT divise_articoli_prezzo_check CHECK ((prezzo >= (0)::numeric))
);


ALTER TABLE public.divise_articoli OWNER TO postgres;

--
-- Name: divise_ordini; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.divise_ordini (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    parent_id uuid,
    stato text DEFAULT 'inviato'::text NOT NULL,
    totale numeric(10,2) DEFAULT 0 NOT NULL,
    pagamento_id uuid,
    note text,
    creato_il timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT divise_ordini_stato_check CHECK ((stato = ANY (ARRAY['inviato'::text, 'confermato'::text, 'consegnato'::text, 'annullato'::text]))),
    CONSTRAINT divise_ordini_totale_check CHECK ((totale >= (0)::numeric))
);


ALTER TABLE public.divise_ordini OWNER TO postgres;

--
-- Name: divise_ordini_righe; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.divise_ordini_righe (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ordine_id uuid NOT NULL,
    articolo_id uuid,
    articolo_nome text NOT NULL,
    taglia text NOT NULL,
    quantita integer NOT NULL,
    prezzo_unitario numeric(10,2) NOT NULL,
    CONSTRAINT divise_ordini_righe_prezzo_unitario_check CHECK ((prezzo_unitario >= (0)::numeric)),
    CONSTRAINT divise_ordini_righe_quantita_check CHECK ((quantita > 0))
);


ALTER TABLE public.divise_ordini_righe OWNER TO postgres;

--
-- Name: enrollment_submissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.enrollment_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    assigned_classes jsonb DEFAULT '{}'::jsonb,
    imported_at timestamp with time zone,
    credentials jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.enrollment_submissions OWNER TO postgres;

--
-- Name: eventi_agenda; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.eventi_agenda (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    section_id uuid,
    titolo text NOT NULL,
    descrizione text,
    tipo text DEFAULT 'evento'::text NOT NULL,
    data date NOT NULL,
    orario_inizio time without time zone,
    orario_fine time without time zone,
    visibile_genitori boolean DEFAULT true NOT NULL,
    creato_da uuid NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT eventi_agenda_tipo_check CHECK ((tipo = ANY (ARRAY['evento'::text, 'uscita'::text, 'scadenza'::text, 'riunione'::text])))
);


ALTER TABLE public.eventi_agenda OWNER TO postgres;

--
-- Name: eventi_diario; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.eventi_diario (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    alunno_id uuid,
    maestra_id uuid,
    tipo_evento character varying(50),
    orario_inizio timestamp with time zone NOT NULL,
    orario_fine timestamp with time zone,
    dettagli jsonb,
    nota_libera text,
    pubblicato boolean DEFAULT false,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.eventi_diario OWNER TO postgres;

--
-- Name: fascicolo_accessi_audit; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fascicolo_accessi_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alunno_id uuid NOT NULL,
    documento_id uuid,
    utente_id uuid,
    azione text NOT NULL,
    finalita text,
    ip text,
    user_agent text,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT fascicolo_accessi_audit_azione_check CHECK ((azione = ANY (ARRAY['list'::text, 'view'::text, 'download'::text, 'upload'::text, 'delete'::text])))
);


ALTER TABLE public.fascicolo_accessi_audit OWNER TO postgres;

--
-- Name: fatture_emesse; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fatture_emesse (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pagamento_id uuid NOT NULL,
    scuola_id uuid NOT NULL,
    numero integer NOT NULL,
    anno integer NOT NULL,
    progressivo_invio text,
    causale text,
    importo numeric(10,2) NOT NULL,
    intestatario jsonb,
    xml_inviato text,
    aruba_filename text,
    sdi_stato smallint,
    sdi_stato_label text,
    sdi_scarto_motivo text,
    pdf_path text,
    inviata_il timestamp with time zone,
    aggiornata_il timestamp with time zone DEFAULT now(),
    creato_da uuid,
    creato_il timestamp with time zone DEFAULT now(),
    quota_adult_id uuid,
    quota_label text,
    parent_registry_id uuid
);


ALTER TABLE public.fatture_emesse OWNER TO postgres;

--
-- Name: fatture_numerazione; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fatture_numerazione (
    scuola_id uuid NOT NULL,
    anno integer NOT NULL,
    ultimo_numero integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.fatture_numerazione OWNER TO postgres;

--
-- Name: fea_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fea_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entita_tipo text NOT NULL,
    entita_id uuid,
    signer_user_id uuid,
    email text,
    evento text NOT NULL,
    hash text,
    ip text,
    user_agent text,
    creato_il timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fea_audit_log_evento_check CHECK ((evento = ANY (ARRAY['otp_sent'::text, 'signed'::text, 'verify_failed'::text])))
);


ALTER TABLE public.fea_audit_log OWNER TO postgres;

--
-- Name: fea_signatures; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fea_signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entita_tipo text NOT NULL,
    entita_id uuid NOT NULL,
    slot_index integer DEFAULT 0 NOT NULL,
    signer_user_id uuid,
    stato text DEFAULT 'signed'::text NOT NULL,
    completion_policy text DEFAULT 'any-one'::text NOT NULL,
    signature_log jsonb,
    firmato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT fea_signatures_completion_policy_check CHECK ((completion_policy = ANY (ARRAY['any-one'::text, 'all-required'::text]))),
    CONSTRAINT fea_signatures_stato_check CHECK ((stato = ANY (ARRAY['pending'::text, 'signed'::text])))
);


ALTER TABLE public.fea_signatures OWNER TO postgres;

--
-- Name: firme_docenti; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.firme_docenti (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registro_id uuid NOT NULL,
    maestra_id uuid NOT NULL,
    tipo_compresenza character varying(50) DEFAULT 'principale'::character varying,
    firmato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    argomento_proprio text,
    compiti_propri text,
    CONSTRAINT firme_docenti_tipo_compresenza_check CHECK (((tipo_compresenza)::text = ANY ((ARRAY['principale'::character varying, 'sostegno'::character varying, 'compresenza'::character varying, 'cofirma'::character varying])::text[])))
);


ALTER TABLE public.firme_docenti OWNER TO postgres;

--
-- Name: firme_documenti; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.firme_documenti (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    utente_id uuid,
    tipo_documento character varying(100),
    impronta_digitale text NOT NULL,
    indirizzo_ip inet NOT NULL,
    user_agent text,
    firmato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.firme_documenti OWNER TO postgres;

--
-- Name: form_models; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.form_models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    requires_signature boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_enrollment_form boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    public_token uuid,
    access_mode text DEFAULT 'public'::text NOT NULL,
    signature_mode text DEFAULT 'single'::text NOT NULL,
    CONSTRAINT form_models_access_mode_check CHECK ((access_mode = ANY (ARRAY['public'::text, 'authenticated'::text]))),
    CONSTRAINT form_models_signature_mode_check CHECK ((signature_mode = ANY (ARRAY['single'::text, 'joint'::text])))
);


ALTER TABLE public.form_models OWNER TO postgres;

--
-- Name: COLUMN form_models.published_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.form_models.published_at IS 'NULL = bozza; valorizzato = pubblicato (link /m/{public_token} attivo). DL-030.';


--
-- Name: COLUMN form_models.public_token; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.form_models.public_token IS 'Token uuid stabile del link pubblico; generato alla 1a pubblicazione, preservato tra unpublish/republish.';


--
-- Name: COLUMN form_models.access_mode; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.form_models.access_mode IS 'public = chiunque col link; authenticated = solo utenti registrati.';


--
-- Name: COLUMN form_models.signature_mode; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.form_models.signature_mode IS 'single = 1 firmatario; joint = firma congiunta di entrambi i genitori (slot fea_signatures all-required). DL-031.';


--
-- Name: form_submissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.form_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_id uuid NOT NULL,
    user_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.form_submission_status DEFAULT 'draft'::public.form_submission_status NOT NULL,
    otp_secret text,
    signed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    signature_log jsonb,
    score integer DEFAULT 0 NOT NULL,
    manual_adjustments jsonb DEFAULT '[]'::jsonb NOT NULL,
    esito_ammissione text,
    esito_il timestamp with time zone,
    esito_da uuid,
    esito_note text,
    consents_log jsonb,
    gestita_il timestamp with time zone,
    gestita_da uuid,
    CONSTRAINT form_submissions_esito_ammissione_check CHECK ((esito_ammissione = ANY (ARRAY['ammesso'::text, 'lista_attesa'::text, 'non_ammesso'::text])))
);


ALTER TABLE public.form_submissions OWNER TO postgres;

--
-- Name: COLUMN form_submissions.consents_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.form_submissions.consents_log IS 'Snapshot dei consensi (blocchi consent) accettati/rifiutati al momento dell''invio: evidenza legale GDPR. Popolato server-side da estraiConsensi().';


--
-- Name: forms_submissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.forms_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    form_id uuid NOT NULL,
    parent_id uuid,
    student_id uuid,
    answers jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_signed boolean DEFAULT false,
    signature_log jsonb,
    pdf_path text,
    created_at timestamp with time zone DEFAULT now(),
    origine text DEFAULT 'online'::text NOT NULL,
    CONSTRAINT forms_submissions_origine_check CHECK ((origine = ANY (ARRAY['online'::text, 'cartaceo'::text])))
);


ALTER TABLE public.forms_submissions OWNER TO postgres;

--
-- Name: COLUMN forms_submissions.origine; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.forms_submissions.origine IS 'online = compilato dal genitore; cartaceo = scansione acquisita dallo staff (proxy upload). DL-032.';


--
-- Name: forms_templates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.forms_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    form_type character varying(20) DEFAULT 'autorizzazione'::character varying NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    target_scope character varying(20) DEFAULT 'class'::character varying NOT NULL,
    target_classes text[] DEFAULT '{}'::text[],
    expiration_date timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.forms_templates OWNER TO postgres;

--
-- Name: galleria_media; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.galleria_media (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    scuola_id uuid,
    caricato_da uuid,
    url_file text NOT NULL,
    tipo_file character varying(20),
    tag_alunni uuid[] NOT NULL,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.galleria_media OWNER TO postgres;

--
-- Name: galleria_media_v2; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.galleria_media_v2 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploaded_by uuid NOT NULL,
    file_url text NOT NULL,
    file_type character varying(20) DEFAULT 'foto'::character varying NOT NULL,
    caption text,
    tag_students uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    is_broadcast boolean DEFAULT false,
    target_classes text[],
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.galleria_media_v2 OWNER TO postgres;

--
-- Name: giudizi_sintetici_scala; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.giudizi_sintetici_scala (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    etichetta text NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    valore_numerico numeric(4,2),
    giudizio_descrittivo text
);


ALTER TABLE public.giudizi_sintetici_scala OWNER TO postgres;

--
-- Name: giudizio_template; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.giudizio_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid,
    dimensione text NOT NULL,
    valore text NOT NULL,
    frammento text NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT giudizio_template_dimensione_check CHECK ((dimensione = ANY (ARRAY['autonomia'::text, 'continuita'::text, 'tipologia'::text, 'risorse'::text])))
);


ALTER TABLE public.giudizio_template OWNER TO postgres;

--
-- Name: giustifiche_didattiche; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.giustifiche_didattiche (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alunno_id uuid NOT NULL,
    section_id uuid,
    materia_id uuid,
    data date NOT NULL,
    motivo text,
    origine text NOT NULL,
    creato_da uuid,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT giustifiche_didattiche_origine_check CHECK ((origine = ANY (ARRAY['genitore'::text, 'docente'::text])))
);


ALTER TABLE public.giustifiche_didattiche OWNER TO postgres;

--
-- Name: gruppi_mensa; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.gruppi_mensa (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    nome text NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.gruppi_mensa OWNER TO postgres;

--
-- Name: incassi; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.incassi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pagamento_id uuid NOT NULL,
    importo numeric(10,2) NOT NULL,
    data_incasso date DEFAULT CURRENT_DATE NOT NULL,
    metodo public.incasso_metodo DEFAULT 'contanti'::public.incasso_metodo NOT NULL,
    note text,
    quota_id uuid,
    registrato_da uuid,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT incassi_importo_check CHECK ((importo <> (0)::numeric))
);


ALTER TABLE public.incassi OWNER TO postgres;

--
-- Name: legame_genitori_alunni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.legame_genitori_alunni (
    genitore_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    intestatario_fattura boolean DEFAULT true,
    percentuale_pagamento integer DEFAULT 100
);


ALTER TABLE public.legame_genitori_alunni OWNER TO postgres;

--
-- Name: locker_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.locker_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    classe_sezione text,
    nome text NOT NULL,
    icona text DEFAULT '📦'::text NOT NULL,
    unita text DEFAULT 'pz'::text NOT NULL,
    livello_allerta integer DEFAULT 5 NOT NULL,
    livello_emergenza integer DEFAULT 2 NOT NULL,
    ordine integer DEFAULT 99 NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.locker_config OWNER TO postgres;

--
-- Name: materie; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.materie (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    section_id uuid NOT NULL,
    nome text NOT NULL,
    codice text NOT NULL,
    e_civica boolean DEFAULT false NOT NULL,
    turno_mensa boolean DEFAULT false NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    attiva boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.materie OWNER TO postgres;

--
-- Name: materie_preset; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.materie_preset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    livello integer NOT NULL,
    nome text NOT NULL,
    codice text NOT NULL,
    e_civica boolean DEFAULT false NOT NULL,
    turno_mensa boolean DEFAULT false NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT materie_preset_livello_check CHECK (((livello >= 1) AND (livello <= 5)))
);


ALTER TABLE public.materie_preset OWNER TO postgres;

--
-- Name: mensa_class_menu_assignment; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mensa_class_menu_assignment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    classe text NOT NULL,
    menu_config_id uuid NOT NULL,
    attivo_dal date NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.mensa_class_menu_assignment OWNER TO postgres;

--
-- Name: mensa_menu_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mensa_menu_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    nome text NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.mensa_menu_config OWNER TO postgres;

--
-- Name: mensa_menu_override; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mensa_menu_override (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid,
    data date NOT NULL,
    chiuso boolean DEFAULT false NOT NULL,
    portate jsonb DEFAULT '{}'::jsonb,
    note text,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ingredienti jsonb DEFAULT '{}'::jsonb NOT NULL,
    allergeni jsonb DEFAULT '{}'::jsonb NOT NULL,
    menu_config_id uuid
);


ALTER TABLE public.mensa_menu_override OWNER TO postgres;

--
-- Name: mensa_menu_rotazione; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mensa_menu_rotazione (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid,
    settimana integer NOT NULL,
    giorno_settimana integer NOT NULL,
    portate jsonb DEFAULT '{}'::jsonb NOT NULL,
    note text,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ingredienti jsonb DEFAULT '{}'::jsonb NOT NULL,
    allergeni jsonb DEFAULT '{}'::jsonb NOT NULL,
    menu_config_id uuid,
    CONSTRAINT mensa_menu_rotazione_giorno_settimana_check CHECK (((giorno_settimana >= 1) AND (giorno_settimana <= 7))),
    CONSTRAINT mensa_menu_rotazione_settimana_check CHECK (((settimana >= 1) AND (settimana <= 8)))
);


ALTER TABLE public.mensa_menu_rotazione OWNER TO postgres;

--
-- Name: mensa_prenotazioni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mensa_prenotazioni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alunno_id uuid NOT NULL,
    scuola_id uuid,
    data date NOT NULL,
    stato text DEFAULT 'prenotato'::text NOT NULL,
    origine text DEFAULT 'genitore'::text NOT NULL,
    ticket_scalato integer DEFAULT 1 NOT NULL,
    prenotato_da uuid,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.mensa_prenotazioni OWNER TO postgres;

--
-- Name: nota_ricezioni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.nota_ricezioni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nota_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    genitore_id uuid NOT NULL,
    firmato_il timestamp with time zone DEFAULT now(),
    firma jsonb
);


ALTER TABLE public.nota_ricezioni OWNER TO postgres;

--
-- Name: note_disciplinari; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.note_disciplinari (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alunno_id uuid NOT NULL,
    maestra_id uuid NOT NULL,
    categoria character varying(50) NOT NULL,
    testo text NOT NULL,
    richiede_firma boolean DEFAULT false,
    firmata_il timestamp with time zone,
    firmata_da uuid,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    section_id uuid,
    nota_gruppo_id uuid,
    oscurata_ad_altri boolean DEFAULT true NOT NULL,
    CONSTRAINT note_disciplinari_categoria_check CHECK (((categoria)::text = ANY ((ARRAY['disciplinare'::character varying, 'didattica'::character varying, 'compiti_non_svolti'::character varying])::text[])))
);


ALTER TABLE public.note_disciplinari OWNER TO postgres;

--
-- Name: notifiche; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifiche (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    utente_id uuid NOT NULL,
    tipo text NOT NULL,
    titolo text NOT NULL,
    corpo text,
    link text,
    entita_tipo text,
    entita_id uuid,
    letta_il timestamp with time zone,
    push_inviata_il timestamp with time zone,
    creato_il timestamp with time zone DEFAULT now(),
    invio_programmato_il timestamp with time zone
);


ALTER TABLE public.notifiche OWNER TO postgres;

--
-- Name: obiettivi_apprendimento; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.obiettivi_apprendimento (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    materia_codice text NOT NULL,
    livello integer NOT NULL,
    codice text,
    descrizione text NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT obiettivi_apprendimento_livello_check CHECK (((livello >= 1) AND (livello <= 5)))
);


ALTER TABLE public.obiettivi_apprendimento OWNER TO postgres;

--
-- Name: orario_settimanale; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.orario_settimanale (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    campanella_id uuid NOT NULL,
    giorno_settimana integer NOT NULL,
    materia_id uuid,
    docente_id uuid,
    note text,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT orario_settimanale_giorno_settimana_check CHECK (((giorno_settimana >= 1) AND (giorno_settimana <= 6)))
);


ALTER TABLE public.orario_settimanale OWNER TO postgres;

--
-- Name: pagamenti; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pagamenti (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    alunno_id uuid,
    scuola_id uuid,
    descrizione text NOT NULL,
    importo numeric(10,2) NOT NULL,
    scadenza date NOT NULL,
    stato character varying(20) DEFAULT 'da_pagare'::character varying,
    data_incasso timestamp with time zone,
    fattura_aruba_id character varying(255),
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    categoria_id uuid,
    tipo public.pagamento_tipo DEFAULT 'singolo'::public.pagamento_tipo NOT NULL,
    obbligatorio boolean DEFAULT true NOT NULL,
    parent_payment_id uuid,
    gruppo text,
    importo_pagato numeric(10,2) DEFAULT 0 NOT NULL,
    periodo_competenza date,
    fattura_stato public.fattura_stato DEFAULT 'non_richiesta'::public.fattura_stato NOT NULL,
    fattura_pdf_path text,
    fattura_emessa_il timestamp with time zone,
    creato_da uuid,
    ultimo_sollecito_il timestamp with time zone,
    aggiornato_il timestamp with time zone DEFAULT now(),
    visibile_dal date,
    fattura_causale text
);


ALTER TABLE public.pagamenti OWNER TO postgres;

--
-- Name: pagamenti_quote; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pagamenti_quote (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pagamento_id uuid NOT NULL,
    adult_id uuid NOT NULL,
    importo numeric(10,2) NOT NULL,
    etichetta text,
    creato_il timestamp with time zone DEFAULT now()
);


ALTER TABLE public.pagamenti_quote OWNER TO postgres;

--
-- Name: pagella_ricezioni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pagella_ricezioni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scrutinio_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    genitore_id uuid NOT NULL,
    firmato_il timestamp with time zone DEFAULT now(),
    firma jsonb
);


ALTER TABLE public.pagella_ricezioni OWNER TO postgres;

--
-- Name: pagelle; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pagelle (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scrutinio_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    file_url text,
    generata_il timestamp with time zone DEFAULT now(),
    generata_da uuid,
    firma_applicativa jsonb
);


ALTER TABLE public.pagelle OWNER TO postgres;

--
-- Name: parents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.parents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    gender character varying(10),
    birth_date date,
    citizenship character varying(50),
    birth_nation character varying(50),
    birth_province character varying(50),
    birth_city character varying(100),
    fiscal_code character varying(16),
    residence_address character varying(200),
    residence_city character varying(100),
    zip_code character varying(10),
    phone_numbers text[],
    emails text[],
    created_at timestamp with time zone DEFAULT now(),
    documento_path text,
    document_type character varying(50),
    document_number character varying(100),
    auth_user_id uuid,
    anonimizzato_il timestamp with time zone,
    onboarded_at timestamp with time zone,
    consensi_gdpr jsonb
);


ALTER TABLE public.parents OWNER TO postgres;

--
-- Name: COLUMN parents.auth_user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.parents.auth_user_id IS 'P0: Supabase Auth uid del genitore (login). NULL finche la Segreteria non emette le credenziali. La PK parents.id resta invariata.';


--
-- Name: COLUMN parents.anonimizzato_il; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.parents.anonimizzato_il IS 'Diritto all''oblio (DL-034): timestamp di anonimizzazione PII. NULL = attivo.';


--
-- Name: payment_categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.payment_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid,
    nome text NOT NULL,
    slug text,
    colore text DEFAULT '#006A5F'::text,
    icona text DEFAULT '💶'::text,
    is_sistema boolean DEFAULT false NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    ordine integer DEFAULT 99 NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.payment_categories OWNER TO postgres;

--
-- Name: presenze; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.presenze (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alunno_id uuid NOT NULL,
    scuola_id uuid,
    section_id uuid,
    data date DEFAULT CURRENT_DATE NOT NULL,
    stato character varying(20) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    aggiornato_il timestamp with time zone DEFAULT now(),
    orario_entrata text,
    orario_uscita text,
    panic_alert boolean DEFAULT false,
    sync_status text DEFAULT 'synced'::text,
    utente_id uuid,
    registrato_da uuid,
    note_appello text,
    giustificata boolean DEFAULT false NOT NULL,
    giustificazione_testo text,
    giustificata_da uuid,
    giustificata_il timestamp with time zone,
    giust_vista_da uuid,
    giust_vista_il timestamp with time zone,
    giustificazione_firma jsonb,
    CONSTRAINT presenze_stato_check CHECK (((stato)::text = ANY ((ARRAY['presente'::character varying, 'assente'::character varying, 'ritardo'::character varying, 'uscita_anticipata'::character varying])::text[])))
);


ALTER TABLE public.presenze OWNER TO postgres;

--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    utente_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text,
    auth text,
    user_agent text,
    creato_il timestamp with time zone DEFAULT now(),
    platform text DEFAULT 'web'::text NOT NULL,
    CONSTRAINT push_subscriptions_platform_chk CHECK ((platform = ANY (ARRAY['web'::text, 'ios'::text, 'android'::text])))
);


ALTER TABLE public.push_subscriptions OWNER TO postgres;

--
-- Name: registro_destinatari; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.registro_destinatari (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registro_id uuid NOT NULL,
    firma_id uuid,
    alunno_id uuid NOT NULL,
    creato_il timestamp with time zone DEFAULT now()
);


ALTER TABLE public.registro_destinatari OWNER TO postgres;

--
-- Name: registro_modifiche; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.registro_modifiche (
    id bigint NOT NULL,
    utente_id uuid,
    azione text NOT NULL,
    tabella_interessata character varying(100),
    record_id uuid,
    vecchio_valore jsonb,
    nuovo_valore jsonb,
    indirizzo_ip inet,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.registro_modifiche OWNER TO postgres;

--
-- Name: registro_modifiche_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.registro_modifiche_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.registro_modifiche_id_seq OWNER TO postgres;

--
-- Name: registro_modifiche_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.registro_modifiche_id_seq OWNED BY public.registro_modifiche.id;


--
-- Name: registro_orario; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.registro_orario (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid,
    classe_sezione character varying(50) NOT NULL,
    data date NOT NULL,
    ora_lezione integer NOT NULL,
    materia character varying(100),
    argomento text,
    compiti text,
    data_consegna_compiti date,
    media_url text,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    section_id uuid,
    materia_id uuid,
    da_orario boolean DEFAULT false NOT NULL,
    locked_il timestamp with time zone,
    lock_tipo text,
    CONSTRAINT registro_orario_ora_lezione_check CHECK (((ora_lezione >= 1) AND (ora_lezione <= 8)))
);


ALTER TABLE public.registro_orario OWNER TO postgres;

--
-- Name: sblocchi_audit; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sblocchi_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entita_tipo text NOT NULL,
    entita_id uuid NOT NULL,
    dirigente_id uuid,
    motivazione text NOT NULL,
    sbloccato_il timestamp with time zone DEFAULT now(),
    CONSTRAINT sblocchi_audit_entita_tipo_check CHECK ((entita_tipo = ANY (ARRAY['registro'::text, 'valutazione'::text, 'nota'::text, 'scrutinio'::text])))
);


ALTER TABLE public.sblocchi_audit OWNER TO postgres;

--
-- Name: schools; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.schools (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    nome character varying(255) NOT NULL,
    indirizzo text,
    citta character varying(100),
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.schools OWNER TO postgres;

--
-- Name: scrutini; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrutini (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    periodo_id uuid NOT NULL,
    stato text DEFAULT 'aperto'::text NOT NULL,
    chiuso_da uuid,
    chiuso_il timestamp with time zone,
    creato_il timestamp with time zone DEFAULT now(),
    pubblicato boolean DEFAULT false NOT NULL,
    pubblicato_da uuid,
    pubblicato_il timestamp with time zone,
    CONSTRAINT scrutini_stato_check CHECK ((stato = ANY (ARRAY['aperto'::text, 'chiuso'::text])))
);


ALTER TABLE public.scrutini OWNER TO postgres;

--
-- Name: scrutinio_comportamento; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrutinio_comportamento (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scrutinio_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    giudizio_testo text,
    scala_valore text,
    giudizio_globale text,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.scrutinio_comportamento OWNER TO postgres;

--
-- Name: scrutinio_giudizi; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrutinio_giudizi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scrutinio_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    materia_id uuid NOT NULL,
    giudizio_sintetico text,
    proposto_da uuid,
    proposto_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.scrutinio_giudizi OWNER TO postgres;

--
-- Name: scrutinio_giudizio_descrittivo; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrutinio_giudizio_descrittivo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    livello integer NOT NULL,
    materia_codice text NOT NULL,
    periodo_id uuid NOT NULL,
    etichetta_voto text NOT NULL,
    giudizio_descrittivo text NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT scrutinio_giudizio_descrittivo_livello_check CHECK (((livello >= 1) AND (livello <= 5)))
);


ALTER TABLE public.scrutinio_giudizio_descrittivo OWNER TO postgres;

--
-- Name: scrutinio_periodi; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrutinio_periodi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    anno_scolastico text NOT NULL,
    nome text NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    data_inizio date,
    data_fine date,
    attivo boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now()
);


ALTER TABLE public.scrutinio_periodi OWNER TO postgres;

--
-- Name: scuole; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scuole (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nome text NOT NULL,
    citta text,
    indirizzo text,
    attiva boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.scuole OWNER TO postgres;

--
-- Name: TABLE scuole; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.scuole IS 'Registry Multi-Sede (DL-033): sedi/scuole gestibili. scuola_id resta soft-reference su sections/utenti/alunni (no FK in questa slice).';


--
-- Name: sections; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    name character varying(50) NOT NULL,
    school_type public.school_type_enum DEFAULT 'infanzia'::public.school_type_enum NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.sections OWNER TO postgres;

--
-- Name: sezione_materia_obiettivo; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sezione_materia_obiettivo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    materia_id uuid NOT NULL,
    obiettivo_id uuid NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.sezione_materia_obiettivo OWNER TO postgres;

--
-- Name: sidi_import_batches; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sidi_import_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scuola_id uuid NOT NULL,
    filename text,
    stato text DEFAULT 'parsed'::text NOT NULL,
    totale_record integer DEFAULT 0 NOT NULL,
    matched integer DEFAULT 0 NOT NULL,
    creati integer DEFAULT 0 NOT NULL,
    parsed_payload jsonb,
    warnings jsonb,
    caricato_da uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT sidi_import_batches_stato_check CHECK ((stato = ANY (ARRAY['parsed'::text, 'applied'::text, 'error'::text])))
);


ALTER TABLE public.sidi_import_batches OWNER TO postgres;

--
-- Name: sidi_sync_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sidi_sync_state (
    scuola_id uuid NOT NULL,
    fase_a_stato text DEFAULT 'non_inviato'::text NOT NULL,
    fase_a_ts timestamp with time zone,
    frequentanti_stato text DEFAULT 'non_inviato'::text NOT NULL,
    frequentanti_ts timestamp with time zone,
    piattaforma_unica_stato text DEFAULT 'non_inviato'::text NOT NULL,
    piattaforma_unica_ts timestamp with time zone,
    ultimo_esito jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sidi_sync_state_fase_a_stato_check CHECK ((fase_a_stato = ANY (ARRAY['non_inviato'::text, 'in_corso'::text, 'inviato'::text, 'errore'::text]))),
    CONSTRAINT sidi_sync_state_frequentanti_stato_check CHECK ((frequentanti_stato = ANY (ARRAY['non_inviato'::text, 'in_corso'::text, 'inviato'::text, 'errore'::text]))),
    CONSTRAINT sidi_sync_state_piattaforma_unica_stato_check CHECK ((piattaforma_unica_stato = ANY (ARRAY['non_inviato'::text, 'in_corso'::text, 'inviato'::text, 'errore'::text])))
);


ALTER TABLE public.sidi_sync_state OWNER TO postgres;

--
-- Name: student_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.student_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    document_type public.document_type_enum NOT NULL,
    file_url text NOT NULL,
    expiry_date date,
    created_at timestamp with time zone DEFAULT now(),
    section_id uuid,
    caricato_da uuid,
    descrizione text,
    file_name text,
    storage_path text
);


ALTER TABLE public.student_documents OWNER TO postgres;

--
-- Name: student_parents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.student_parents (
    student_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    relation_type character varying(50),
    is_primary boolean DEFAULT false,
    validato_sidi boolean DEFAULT false,
    validato_il timestamp with time zone,
    validato_da uuid
);


ALTER TABLE public.student_parents OWNER TO postgres;

--
-- Name: task_interni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_interni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    assigned_to uuid,
    target_class character varying(50),
    titolo character varying(255) NOT NULL,
    contenuto text NOT NULL,
    completato boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    scuola_id uuid
);


ALTER TABLE public.task_interni OWNER TO postgres;

--
-- Name: tempo_scuola; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tempo_scuola (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    modello integer NOT NULL,
    giorni_settimana integer DEFAULT 5 NOT NULL,
    attivo boolean DEFAULT true NOT NULL,
    creato_il timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT tempo_scuola_giorni_settimana_check CHECK (((giorni_settimana >= 5) AND (giorni_settimana <= 6))),
    CONSTRAINT tempo_scuola_modello_check CHECK ((modello = ANY (ARRAY[27, 29, 40])))
);


ALTER TABLE public.tempo_scuola OWNER TO postgres;

--
-- Name: test_table; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.test_table (
    id integer NOT NULL,
    name text
);


ALTER TABLE public.test_table OWNER TO postgres;

--
-- Name: test_table_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.test_table_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.test_table_id_seq OWNER TO postgres;

--
-- Name: test_table_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.test_table_id_seq OWNED BY public.test_table.id;


--
-- Name: ticket_mensa; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ticket_mensa (
    alunno_id uuid NOT NULL,
    saldo_ticket integer DEFAULT 0,
    ultimo_carico timestamp with time zone
);


ALTER TABLE public.ticket_mensa OWNER TO postgres;

--
-- Name: utenti; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.utenti (
    id uuid NOT NULL,
    email character varying(255) NOT NULL,
    nome character varying(100) NOT NULL,
    cognome character varying(100) NOT NULL,
    cellulare character varying(20),
    ruolo character varying(50) NOT NULL,
    scuola_id uuid NOT NULL,
    attivo boolean DEFAULT true,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    first_name character varying GENERATED ALWAYS AS (nome) STORED,
    last_name character varying GENERATED ALWAYS AS (cognome) STORED,
    role character varying GENERATED ALWAYS AS (ruolo) STORED,
    gradi public.school_type_enum[] DEFAULT '{}'::public.school_type_enum[] NOT NULL
);


ALTER TABLE public.utenti OWNER TO postgres;

--
-- Name: COLUMN utenti.gradi; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.utenti.gradi IS 'Gradi scolastici a cui il docente è abilitato (nido/infanzia/primaria). Multi-valore: docente misto. Guida le funzioni visibili.';


--
-- Name: utenti_scuole; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.utenti_scuole (
    utente_id uuid NOT NULL,
    scuola_id uuid NOT NULL,
    creato_il timestamp with time zone DEFAULT now()
);


ALTER TABLE public.utenti_scuole OWNER TO postgres;

--
-- Name: TABLE utenti_scuole; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.utenti_scuole IS 'Ponte multi-plesso: plessi (schools) su cui un utente può operare. Usato per la Direzione (admin) che segue più sedi. Segreteria/docenti restano sul singolo utenti.scuola_id.';


--
-- Name: utenti_sezioni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.utenti_sezioni (
    utente_id uuid NOT NULL,
    section_id uuid NOT NULL,
    creato_il timestamp with time zone DEFAULT now()
);


ALTER TABLE public.utenti_sezioni OWNER TO postgres;

--
-- Name: utenti_sezioni_materie; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.utenti_sezioni_materie (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    utente_id uuid NOT NULL,
    section_id uuid NOT NULL,
    materia_id uuid NOT NULL,
    e_contitolare boolean DEFAULT false NOT NULL,
    creato_il timestamp with time zone DEFAULT now()
);


ALTER TABLE public.utenti_sezioni_materie OWNER TO postgres;

--
-- Name: valutazione_obiettivi; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.valutazione_obiettivi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    valutazione_id uuid NOT NULL,
    obiettivo_id uuid NOT NULL
);


ALTER TABLE public.valutazione_obiettivi OWNER TO postgres;

--
-- Name: valutazioni; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.valutazioni (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    alunno_id uuid,
    maestra_id uuid,
    materia character varying(100) NOT NULL,
    tipo character varying(50),
    voto_numerico numeric(4,2),
    giudizio_testo text,
    pubblicato boolean DEFAULT false,
    creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    section_id uuid,
    materia_id uuid,
    modalita text,
    dim_autonomia boolean,
    dim_continuita boolean,
    dim_tipologia text,
    dim_risorse text,
    giudizio_sintetico text,
    locked_il timestamp with time zone,
    lock_tipo text,
    argomento text,
    annotazione_numerica numeric(4,2),
    CONSTRAINT valutazioni_annotazione_numerica_check CHECK (((annotazione_numerica >= (0)::numeric) AND (annotazione_numerica <= (10)::numeric))),
    CONSTRAINT valutazioni_dim_risorse_check CHECK ((dim_risorse = ANY (ARRAY['interne'::text, 'esterne'::text, 'entrambe'::text]))),
    CONSTRAINT valutazioni_dim_tipologia_check CHECK ((dim_tipologia = ANY (ARRAY['nota'::text, 'non_nota'::text]))),
    CONSTRAINT valutazioni_modalita_check CHECK ((modalita = ANY (ARRAY['dimensioni'::text, 'sintetico'::text])))
);


ALTER TABLE public.valutazioni OWNER TO postgres;

--
-- Name: COLUMN valutazioni.annotazione_numerica; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.valutazioni.annotazione_numerica IS 'Appunto numerico privato del docente (scala /10) sulla verifica in itinere. NON è il voto ufficiale, non compare in pagella/scrutinio e non è mai visibile al genitore. Usato solo come riferimento e per suggerire (non generare) un giudizio sintetico (PRD §4).';


--
-- Name: registro_modifiche id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_modifiche ALTER COLUMN id SET DEFAULT nextval('public.registro_modifiche_id_seq'::regclass);


--
-- Name: test_table id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.test_table ALTER COLUMN id SET DEFAULT nextval('public.test_table_id_seq'::regclass);


--
-- Name: admin_settings admin_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_settings
    ADD CONSTRAINT admin_settings_pkey PRIMARY KEY (scuola_id);


--
-- Name: allegati_registro allegati_registro_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.allegati_registro
    ADD CONSTRAINT allegati_registro_pkey PRIMARY KEY (id);


--
-- Name: alunni alunni_codice_fiscale_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alunni
    ADD CONSTRAINT alunni_codice_fiscale_key UNIQUE (codice_fiscale);


--
-- Name: alunni alunni_fiscal_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alunni
    ADD CONSTRAINT alunni_fiscal_code_key UNIQUE (fiscal_code);


--
-- Name: alunni alunni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alunni
    ADD CONSTRAINT alunni_pkey PRIMARY KEY (id);


--
-- Name: armadietto armadietto_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.armadietto
    ADD CONSTRAINT armadietto_pkey PRIMARY KEY (id);


--
-- Name: audit_scritture_docente audit_scritture_docente_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_scritture_docente
    ADD CONSTRAINT audit_scritture_docente_pkey PRIMARY KEY (id);


--
-- Name: avvisi avvisi_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi
    ADD CONSTRAINT avvisi_pkey PRIMARY KEY (id);


--
-- Name: avvisi_risposte avvisi_risposte_avviso_id_parent_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi_risposte
    ADD CONSTRAINT avvisi_risposte_avviso_id_parent_id_student_id_key UNIQUE (avviso_id, parent_id, student_id);


--
-- Name: avvisi_risposte avvisi_risposte_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi_risposte
    ADD CONSTRAINT avvisi_risposte_pkey PRIMARY KEY (id);


--
-- Name: campanelle campanelle_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campanelle
    ADD CONSTRAINT campanelle_pkey PRIMARY KEY (id);


--
-- Name: campanelle campanelle_section_id_giorno_settimana_ordine_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campanelle
    ADD CONSTRAINT campanelle_section_id_giorno_settimana_ordine_key UNIQUE (section_id, giorno_settimana, ordine);


--
-- Name: certificati_competenze certificati_competenze_alunno_id_anno_scolastico_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_competenze
    ADD CONSTRAINT certificati_competenze_alunno_id_anno_scolastico_key UNIQUE (alunno_id, anno_scolastico);


--
-- Name: certificati_competenze certificati_competenze_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_competenze
    ADD CONSTRAINT certificati_competenze_pkey PRIMARY KEY (id);


--
-- Name: certificati_medici certificati_medici_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_medici
    ADD CONSTRAINT certificati_medici_pkey PRIMARY KEY (id);


--
-- Name: certificato_competenza_livelli certificato_competenza_livell_certificato_id_competenza_cod_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificato_competenza_livelli
    ADD CONSTRAINT certificato_competenza_livell_certificato_id_competenza_cod_key UNIQUE (certificato_id, competenza_codice);


--
-- Name: certificato_competenza_livelli certificato_competenza_livelli_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificato_competenza_livelli
    ADD CONSTRAINT certificato_competenza_livelli_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_threads chat_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_pkey PRIMARY KEY (id);


--
-- Name: chat_threads chat_threads_teacher_id_parent_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_teacher_id_parent_id_student_id_key UNIQUE (teacher_id, parent_id, student_id);


--
-- Name: delegates delegates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.delegates
    ADD CONSTRAINT delegates_pkey PRIMARY KEY (id);


--
-- Name: divise_articoli divise_articoli_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_articoli
    ADD CONSTRAINT divise_articoli_pkey PRIMARY KEY (id);


--
-- Name: divise_ordini divise_ordini_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_ordini
    ADD CONSTRAINT divise_ordini_pkey PRIMARY KEY (id);


--
-- Name: divise_ordini_righe divise_ordini_righe_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_ordini_righe
    ADD CONSTRAINT divise_ordini_righe_pkey PRIMARY KEY (id);


--
-- Name: enrollment_submissions enrollment_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.enrollment_submissions
    ADD CONSTRAINT enrollment_submissions_pkey PRIMARY KEY (id);


--
-- Name: eventi_agenda eventi_agenda_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_agenda
    ADD CONSTRAINT eventi_agenda_pkey PRIMARY KEY (id);


--
-- Name: eventi_diario eventi_diario_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_diario
    ADD CONSTRAINT eventi_diario_pkey PRIMARY KEY (id);


--
-- Name: fascicolo_accessi_audit fascicolo_accessi_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fascicolo_accessi_audit
    ADD CONSTRAINT fascicolo_accessi_audit_pkey PRIMARY KEY (id);


--
-- Name: fatture_emesse fatture_emesse_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fatture_emesse
    ADD CONSTRAINT fatture_emesse_pkey PRIMARY KEY (id);


--
-- Name: fatture_emesse fatture_emesse_scuola_id_anno_numero_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fatture_emesse
    ADD CONSTRAINT fatture_emesse_scuola_id_anno_numero_key UNIQUE (scuola_id, anno, numero);


--
-- Name: fatture_numerazione fatture_numerazione_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fatture_numerazione
    ADD CONSTRAINT fatture_numerazione_pkey PRIMARY KEY (scuola_id, anno);


--
-- Name: fea_audit_log fea_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fea_audit_log
    ADD CONSTRAINT fea_audit_log_pkey PRIMARY KEY (id);


--
-- Name: fea_signatures fea_signatures_entita_tipo_entita_id_slot_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fea_signatures
    ADD CONSTRAINT fea_signatures_entita_tipo_entita_id_slot_index_key UNIQUE (entita_tipo, entita_id, slot_index);


--
-- Name: fea_signatures fea_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fea_signatures
    ADD CONSTRAINT fea_signatures_pkey PRIMARY KEY (id);


--
-- Name: firme_docenti firme_docenti_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.firme_docenti
    ADD CONSTRAINT firme_docenti_pkey PRIMARY KEY (id);


--
-- Name: firme_documenti firme_documenti_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.firme_documenti
    ADD CONSTRAINT firme_documenti_pkey PRIMARY KEY (id);


--
-- Name: form_models form_models_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.form_models
    ADD CONSTRAINT form_models_pkey PRIMARY KEY (id);


--
-- Name: form_models form_models_public_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.form_models
    ADD CONSTRAINT form_models_public_token_key UNIQUE (public_token);


--
-- Name: form_submissions form_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_pkey PRIMARY KEY (id);


--
-- Name: forms_submissions forms_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.forms_submissions
    ADD CONSTRAINT forms_submissions_pkey PRIMARY KEY (id);


--
-- Name: forms_templates forms_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.forms_templates
    ADD CONSTRAINT forms_templates_pkey PRIMARY KEY (id);


--
-- Name: galleria_media galleria_media_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.galleria_media
    ADD CONSTRAINT galleria_media_pkey PRIMARY KEY (id);


--
-- Name: galleria_media_v2 galleria_media_v2_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.galleria_media_v2
    ADD CONSTRAINT galleria_media_v2_pkey PRIMARY KEY (id);


--
-- Name: giudizi_sintetici_scala giudizi_sintetici_scala_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giudizi_sintetici_scala
    ADD CONSTRAINT giudizi_sintetici_scala_pkey PRIMARY KEY (id);


--
-- Name: giudizi_sintetici_scala giudizi_sintetici_scala_scuola_id_etichetta_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giudizi_sintetici_scala
    ADD CONSTRAINT giudizi_sintetici_scala_scuola_id_etichetta_key UNIQUE (scuola_id, etichetta);


--
-- Name: giudizio_template giudizio_template_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giudizio_template
    ADD CONSTRAINT giudizio_template_pkey PRIMARY KEY (id);


--
-- Name: giustifiche_didattiche giustifiche_didattiche_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giustifiche_didattiche
    ADD CONSTRAINT giustifiche_didattiche_pkey PRIMARY KEY (id);


--
-- Name: gruppi_mensa gruppi_mensa_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.gruppi_mensa
    ADD CONSTRAINT gruppi_mensa_pkey PRIMARY KEY (id);


--
-- Name: gruppi_mensa gruppi_mensa_scuola_id_nome_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.gruppi_mensa
    ADD CONSTRAINT gruppi_mensa_scuola_id_nome_key UNIQUE (scuola_id, nome);


--
-- Name: incassi incassi_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incassi
    ADD CONSTRAINT incassi_pkey PRIMARY KEY (id);


--
-- Name: legame_genitori_alunni legame_genitori_alunni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.legame_genitori_alunni
    ADD CONSTRAINT legame_genitori_alunni_pkey PRIMARY KEY (genitore_id, alunno_id);


--
-- Name: locker_config locker_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locker_config
    ADD CONSTRAINT locker_config_pkey PRIMARY KEY (id);


--
-- Name: materie materie_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.materie
    ADD CONSTRAINT materie_pkey PRIMARY KEY (id);


--
-- Name: materie_preset materie_preset_livello_codice_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.materie_preset
    ADD CONSTRAINT materie_preset_livello_codice_key UNIQUE (livello, codice);


--
-- Name: materie_preset materie_preset_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.materie_preset
    ADD CONSTRAINT materie_preset_pkey PRIMARY KEY (id);


--
-- Name: materie materie_section_id_codice_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.materie
    ADD CONSTRAINT materie_section_id_codice_key UNIQUE (section_id, codice);


--
-- Name: mensa_class_menu_assignment mensa_class_menu_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_class_menu_assignment
    ADD CONSTRAINT mensa_class_menu_assignment_pkey PRIMARY KEY (id);


--
-- Name: mensa_menu_config mensa_menu_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_config
    ADD CONSTRAINT mensa_menu_config_pkey PRIMARY KEY (id);


--
-- Name: mensa_menu_override mensa_menu_override_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_override
    ADD CONSTRAINT mensa_menu_override_pkey PRIMARY KEY (id);


--
-- Name: mensa_menu_rotazione mensa_menu_rotazione_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_rotazione
    ADD CONSTRAINT mensa_menu_rotazione_pkey PRIMARY KEY (id);


--
-- Name: mensa_prenotazioni mensa_prenotazioni_alunno_id_data_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_prenotazioni
    ADD CONSTRAINT mensa_prenotazioni_alunno_id_data_key UNIQUE (alunno_id, data);


--
-- Name: mensa_prenotazioni mensa_prenotazioni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_prenotazioni
    ADD CONSTRAINT mensa_prenotazioni_pkey PRIMARY KEY (id);


--
-- Name: nota_ricezioni nota_ricezioni_nota_id_genitore_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nota_ricezioni
    ADD CONSTRAINT nota_ricezioni_nota_id_genitore_id_key UNIQUE (nota_id, genitore_id);


--
-- Name: nota_ricezioni nota_ricezioni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nota_ricezioni
    ADD CONSTRAINT nota_ricezioni_pkey PRIMARY KEY (id);


--
-- Name: note_disciplinari note_disciplinari_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_disciplinari
    ADD CONSTRAINT note_disciplinari_pkey PRIMARY KEY (id);


--
-- Name: notifiche notifiche_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifiche
    ADD CONSTRAINT notifiche_pkey PRIMARY KEY (id);


--
-- Name: obiettivi_apprendimento obiettivi_apprendimento_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.obiettivi_apprendimento
    ADD CONSTRAINT obiettivi_apprendimento_pkey PRIMARY KEY (id);


--
-- Name: obiettivi_apprendimento obiettivi_apprendimento_scuola_id_materia_codice_livello_co_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.obiettivi_apprendimento
    ADD CONSTRAINT obiettivi_apprendimento_scuola_id_materia_codice_livello_co_key UNIQUE (scuola_id, materia_codice, livello, codice);


--
-- Name: orario_settimanale orario_settimanale_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orario_settimanale
    ADD CONSTRAINT orario_settimanale_pkey PRIMARY KEY (id);


--
-- Name: orario_settimanale orario_settimanale_section_id_giorno_settimana_campanella_i_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orario_settimanale
    ADD CONSTRAINT orario_settimanale_section_id_giorno_settimana_campanella_i_key UNIQUE (section_id, giorno_settimana, campanella_id);


--
-- Name: pagamenti pagamenti_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti
    ADD CONSTRAINT pagamenti_pkey PRIMARY KEY (id);


--
-- Name: pagamenti_quote pagamenti_quote_pagamento_id_adult_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti_quote
    ADD CONSTRAINT pagamenti_quote_pagamento_id_adult_id_key UNIQUE (pagamento_id, adult_id);


--
-- Name: pagamenti_quote pagamenti_quote_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti_quote
    ADD CONSTRAINT pagamenti_quote_pkey PRIMARY KEY (id);


--
-- Name: pagella_ricezioni pagella_ricezioni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagella_ricezioni
    ADD CONSTRAINT pagella_ricezioni_pkey PRIMARY KEY (id);


--
-- Name: pagella_ricezioni pagella_ricezioni_scrutinio_id_alunno_id_genitore_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagella_ricezioni
    ADD CONSTRAINT pagella_ricezioni_scrutinio_id_alunno_id_genitore_id_key UNIQUE (scrutinio_id, alunno_id, genitore_id);


--
-- Name: pagelle pagelle_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagelle
    ADD CONSTRAINT pagelle_pkey PRIMARY KEY (id);


--
-- Name: pagelle pagelle_scrutinio_id_alunno_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagelle
    ADD CONSTRAINT pagelle_scrutinio_id_alunno_id_key UNIQUE (scrutinio_id, alunno_id);


--
-- Name: parents parents_auth_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_auth_user_id_key UNIQUE (auth_user_id);


--
-- Name: parents parents_fiscal_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_fiscal_code_key UNIQUE (fiscal_code);


--
-- Name: parents parents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_pkey PRIMARY KEY (id);


--
-- Name: payment_categories payment_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.payment_categories
    ADD CONSTRAINT payment_categories_pkey PRIMARY KEY (id);


--
-- Name: payment_categories payment_categories_scuola_id_nome_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.payment_categories
    ADD CONSTRAINT payment_categories_scuola_id_nome_key UNIQUE (scuola_id, nome);


--
-- Name: presenze presenze_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: registro_destinatari registro_destinatari_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_destinatari
    ADD CONSTRAINT registro_destinatari_pkey PRIMARY KEY (id);


--
-- Name: registro_destinatari registro_destinatari_registro_id_firma_id_alunno_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_destinatari
    ADD CONSTRAINT registro_destinatari_registro_id_firma_id_alunno_id_key UNIQUE (registro_id, firma_id, alunno_id);


--
-- Name: registro_modifiche registro_modifiche_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_modifiche
    ADD CONSTRAINT registro_modifiche_pkey PRIMARY KEY (id);


--
-- Name: registro_orario registro_orario_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_orario
    ADD CONSTRAINT registro_orario_pkey PRIMARY KEY (id);


--
-- Name: sblocchi_audit sblocchi_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sblocchi_audit
    ADD CONSTRAINT sblocchi_audit_pkey PRIMARY KEY (id);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: scrutini scrutini_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutini
    ADD CONSTRAINT scrutini_pkey PRIMARY KEY (id);


--
-- Name: scrutini scrutini_section_id_periodo_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutini
    ADD CONSTRAINT scrutini_section_id_periodo_id_key UNIQUE (section_id, periodo_id);


--
-- Name: scrutinio_comportamento scrutinio_comportamento_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_comportamento
    ADD CONSTRAINT scrutinio_comportamento_pkey PRIMARY KEY (id);


--
-- Name: scrutinio_comportamento scrutinio_comportamento_scrutinio_id_alunno_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_comportamento
    ADD CONSTRAINT scrutinio_comportamento_scrutinio_id_alunno_id_key UNIQUE (scrutinio_id, alunno_id);


--
-- Name: scrutinio_giudizi scrutinio_giudizi_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizi
    ADD CONSTRAINT scrutinio_giudizi_pkey PRIMARY KEY (id);


--
-- Name: scrutinio_giudizi scrutinio_giudizi_scrutinio_id_alunno_id_materia_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizi
    ADD CONSTRAINT scrutinio_giudizi_scrutinio_id_alunno_id_materia_id_key UNIQUE (scrutinio_id, alunno_id, materia_id);


--
-- Name: scrutinio_giudizio_descrittivo scrutinio_giudizio_descrittiv_scuola_id_livello_materia_cod_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizio_descrittivo
    ADD CONSTRAINT scrutinio_giudizio_descrittiv_scuola_id_livello_materia_cod_key UNIQUE (scuola_id, livello, materia_codice, periodo_id, etichetta_voto);


--
-- Name: scrutinio_giudizio_descrittivo scrutinio_giudizio_descrittivo_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizio_descrittivo
    ADD CONSTRAINT scrutinio_giudizio_descrittivo_pkey PRIMARY KEY (id);


--
-- Name: scrutinio_periodi scrutinio_periodi_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_periodi
    ADD CONSTRAINT scrutinio_periodi_pkey PRIMARY KEY (id);


--
-- Name: scrutinio_periodi scrutinio_periodi_scuola_id_anno_scolastico_nome_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_periodi
    ADD CONSTRAINT scrutinio_periodi_scuola_id_anno_scolastico_nome_key UNIQUE (scuola_id, anno_scolastico, nome);


--
-- Name: scuole scuole_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scuole
    ADD CONSTRAINT scuole_pkey PRIMARY KEY (id);


--
-- Name: sections sections_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_pkey PRIMARY KEY (id);


--
-- Name: sezione_materia_obiettivo sezione_materia_obiettivo_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sezione_materia_obiettivo
    ADD CONSTRAINT sezione_materia_obiettivo_pkey PRIMARY KEY (id);


--
-- Name: sezione_materia_obiettivo sezione_materia_obiettivo_section_id_materia_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sezione_materia_obiettivo
    ADD CONSTRAINT sezione_materia_obiettivo_section_id_materia_id_key UNIQUE (section_id, materia_id);


--
-- Name: sidi_import_batches sidi_import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sidi_import_batches
    ADD CONSTRAINT sidi_import_batches_pkey PRIMARY KEY (id);


--
-- Name: sidi_sync_state sidi_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sidi_sync_state
    ADD CONSTRAINT sidi_sync_state_pkey PRIMARY KEY (scuola_id);


--
-- Name: student_documents student_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_pkey PRIMARY KEY (id);


--
-- Name: student_parents student_parents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_pkey PRIMARY KEY (student_id, parent_id);


--
-- Name: task_interni task_interni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_interni
    ADD CONSTRAINT task_interni_pkey PRIMARY KEY (id);


--
-- Name: tempo_scuola tempo_scuola_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tempo_scuola
    ADD CONSTRAINT tempo_scuola_pkey PRIMARY KEY (id);


--
-- Name: test_table test_table_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.test_table
    ADD CONSTRAINT test_table_pkey PRIMARY KEY (id);


--
-- Name: ticket_mensa ticket_mensa_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ticket_mensa
    ADD CONSTRAINT ticket_mensa_pkey PRIMARY KEY (alunno_id);


--
-- Name: firme_docenti unique_firma_docente; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.firme_docenti
    ADD CONSTRAINT unique_firma_docente UNIQUE (registro_id, maestra_id);


--
-- Name: presenze unique_presenza_giornaliera; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT unique_presenza_giornaliera UNIQUE (alunno_id, data);


--
-- Name: registro_orario unique_registro_orario; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_orario
    ADD CONSTRAINT unique_registro_orario UNIQUE (classe_sezione, data, ora_lezione);


--
-- Name: utenti utenti_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti
    ADD CONSTRAINT utenti_email_key UNIQUE (email);


--
-- Name: utenti utenti_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti
    ADD CONSTRAINT utenti_pkey PRIMARY KEY (id);


--
-- Name: utenti_scuole utenti_scuole_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_scuole
    ADD CONSTRAINT utenti_scuole_pkey PRIMARY KEY (utente_id, scuola_id);


--
-- Name: utenti_sezioni_materie utenti_sezioni_materie_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni_materie
    ADD CONSTRAINT utenti_sezioni_materie_pkey PRIMARY KEY (id);


--
-- Name: utenti_sezioni_materie utenti_sezioni_materie_utente_id_section_id_materia_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni_materie
    ADD CONSTRAINT utenti_sezioni_materie_utente_id_section_id_materia_id_key UNIQUE (utente_id, section_id, materia_id);


--
-- Name: utenti_sezioni utenti_sezioni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni
    ADD CONSTRAINT utenti_sezioni_pkey PRIMARY KEY (utente_id, section_id);


--
-- Name: valutazione_obiettivi valutazione_obiettivi_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazione_obiettivi
    ADD CONSTRAINT valutazione_obiettivi_pkey PRIMARY KEY (id);


--
-- Name: valutazione_obiettivi valutazione_obiettivi_valutazione_id_obiettivo_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazione_obiettivi
    ADD CONSTRAINT valutazione_obiettivi_valutazione_id_obiettivo_id_key UNIQUE (valutazione_id, obiettivo_id);


--
-- Name: valutazioni valutazioni_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazioni
    ADD CONSTRAINT valutazioni_pkey PRIMARY KEY (id);


--
-- Name: idx_allegati_registro; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_allegati_registro ON public.allegati_registro USING btree (registro_id);


--
-- Name: idx_alunni_gruppo_mensa; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alunni_gruppo_mensa ON public.alunni USING btree (gruppo_mensa_id);


--
-- Name: idx_alunni_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alunni_scuola ON public.alunni USING btree (scuola_id);


--
-- Name: idx_alunni_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alunni_section ON public.alunni USING btree (section_id);


--
-- Name: idx_armadietto_alunno_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_armadietto_alunno_date ON public.armadietto USING btree (alunno_id, date);


--
-- Name: idx_armadietto_materiale; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_armadietto_materiale ON public.armadietto USING btree (materiale);


--
-- Name: idx_armadietto_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_armadietto_scuola ON public.armadietto USING btree (scuola_id);


--
-- Name: idx_audit_scritt_attore; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_scritt_attore ON public.audit_scritture_docente USING btree (attore_id, creato_il DESC);


--
-- Name: idx_audit_scritt_entita; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_scritt_entita ON public.audit_scritture_docente USING btree (entita_tipo, entita_id);


--
-- Name: idx_audit_scritt_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_scritt_section ON public.audit_scritture_docente USING btree (section_id, creato_il DESC);


--
-- Name: idx_avvisi_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_avvisi_created ON public.avvisi USING btree (created_at DESC);


--
-- Name: idx_avvisi_risposte_avviso; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_avvisi_risposte_avviso ON public.avvisi_risposte USING btree (avviso_id);


--
-- Name: idx_avvisi_risposte_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_avvisi_risposte_parent ON public.avvisi_risposte USING btree (parent_id);


--
-- Name: idx_avvisi_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_avvisi_scuola ON public.avvisi USING btree (scuola_id);


--
-- Name: idx_campanelle_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_campanelle_section ON public.campanelle USING btree (section_id);


--
-- Name: idx_cert_competenza_livelli_cert; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_cert_competenza_livelli_cert ON public.certificato_competenza_livelli USING btree (certificato_id);


--
-- Name: idx_certificati_competenze_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_certificati_competenze_alunno ON public.certificati_competenze USING btree (alunno_id);


--
-- Name: idx_certificati_competenze_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_certificati_competenze_section ON public.certificati_competenze USING btree (section_id);


--
-- Name: idx_certificati_medici_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_certificati_medici_alunno ON public.certificati_medici USING btree (alunno_id);


--
-- Name: idx_certificati_medici_stato; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_certificati_medici_stato ON public.certificati_medici USING btree (stato);


--
-- Name: idx_chat_messages_thread; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_messages_thread ON public.chat_messages USING btree (thread_id, created_at DESC);


--
-- Name: idx_chat_messages_unread; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_messages_unread ON public.chat_messages USING btree (thread_id) WHERE (read_at IS NULL);


--
-- Name: idx_chat_threads_last_msg; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_threads_last_msg ON public.chat_threads USING btree (last_message_at DESC);


--
-- Name: idx_chat_threads_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_threads_parent ON public.chat_threads USING btree (parent_id);


--
-- Name: idx_chat_threads_student; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_threads_student ON public.chat_threads USING btree (student_id);


--
-- Name: idx_chat_threads_teacher; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_threads_teacher ON public.chat_threads USING btree (teacher_id);


--
-- Name: idx_divise_articoli_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_divise_articoli_scuola ON public.divise_articoli USING btree (scuola_id, attivo);


--
-- Name: idx_divise_ordini_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_divise_ordini_alunno ON public.divise_ordini USING btree (alunno_id);


--
-- Name: idx_divise_ordini_pagamento; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_divise_ordini_pagamento ON public.divise_ordini USING btree (pagamento_id);


--
-- Name: idx_divise_ordini_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_divise_ordini_parent ON public.divise_ordini USING btree (parent_id);


--
-- Name: idx_divise_ordini_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_divise_ordini_scuola ON public.divise_ordini USING btree (scuola_id, creato_il DESC);


--
-- Name: idx_divise_righe_ordine; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_divise_righe_ordine ON public.divise_ordini_righe USING btree (ordine_id);


--
-- Name: idx_eventi_agenda_scuola_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_eventi_agenda_scuola_data ON public.eventi_agenda USING btree (scuola_id, data);


--
-- Name: idx_eventi_agenda_section_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_eventi_agenda_section_data ON public.eventi_agenda USING btree (section_id, data);


--
-- Name: idx_eventi_diario_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_eventi_diario_alunno ON public.eventi_diario USING btree (alunno_id);


--
-- Name: idx_eventi_pubblicati; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_eventi_pubblicati ON public.eventi_diario USING btree (pubblicato) WHERE (pubblicato = false);


--
-- Name: idx_fasc_audit_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fasc_audit_alunno ON public.fascicolo_accessi_audit USING btree (alunno_id, creato_il DESC);


--
-- Name: idx_fasc_audit_utente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fasc_audit_utente ON public.fascicolo_accessi_audit USING btree (utente_id);


--
-- Name: idx_fatture_emesse_pagamento; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fatture_emesse_pagamento ON public.fatture_emesse USING btree (pagamento_id);


--
-- Name: idx_fatture_emesse_pagamento_quota; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fatture_emesse_pagamento_quota ON public.fatture_emesse USING btree (pagamento_id, quota_adult_id);


--
-- Name: idx_fatture_emesse_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fatture_emesse_scuola ON public.fatture_emesse USING btree (scuola_id);


--
-- Name: idx_fatture_emesse_stato; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fatture_emesse_stato ON public.fatture_emesse USING btree (sdi_stato);


--
-- Name: idx_fea_audit_entita; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fea_audit_entita ON public.fea_audit_log USING btree (entita_tipo, entita_id);


--
-- Name: idx_fea_audit_signer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fea_audit_signer ON public.fea_audit_log USING btree (signer_user_id, creato_il DESC);


--
-- Name: idx_fea_signatures_entita; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fea_signatures_entita ON public.fea_signatures USING btree (entita_tipo, entita_id);


--
-- Name: idx_firme_docenti_maestra_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_firme_docenti_maestra_id ON public.firme_docenti USING btree (maestra_id);


--
-- Name: idx_firme_docenti_registro; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_firme_docenti_registro ON public.firme_docenti USING btree (registro_id);


--
-- Name: idx_firme_docenti_registro_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_firme_docenti_registro_id ON public.firme_docenti USING btree (registro_id);


--
-- Name: idx_form_models_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_models_active ON public.form_models USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_form_models_schema_gin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_models_schema_gin ON public.form_models USING gin (schema);


--
-- Name: idx_form_submissions_data_gin; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_submissions_data_gin ON public.form_submissions USING gin (data);


--
-- Name: idx_form_submissions_model_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_submissions_model_id ON public.form_submissions USING btree (model_id);


--
-- Name: idx_form_submissions_ranking; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_submissions_ranking ON public.form_submissions USING btree (model_id, score DESC, signed_at);


--
-- Name: idx_form_submissions_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_submissions_status ON public.form_submissions USING btree (status);


--
-- Name: idx_form_submissions_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_form_submissions_user_id ON public.form_submissions USING btree (user_id);


--
-- Name: idx_forms_submissions_form; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_forms_submissions_form ON public.forms_submissions USING btree (form_id);


--
-- Name: idx_forms_submissions_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_forms_submissions_parent ON public.forms_submissions USING btree (parent_id);


--
-- Name: idx_forms_templates_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_forms_templates_scuola ON public.forms_templates USING btree (scuola_id);


--
-- Name: idx_galleria_v2_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_galleria_v2_created ON public.galleria_media_v2 USING btree (created_at DESC);


--
-- Name: idx_galleria_v2_uploaded_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_galleria_v2_uploaded_by ON public.galleria_media_v2 USING btree (uploaded_by);


--
-- Name: idx_giust_did_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_giust_did_alunno ON public.giustifiche_didattiche USING btree (alunno_id);


--
-- Name: idx_giust_did_section_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_giust_did_section_data ON public.giustifiche_didattiche USING btree (section_id, data);


--
-- Name: idx_incassi_pagamento; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_incassi_pagamento ON public.incassi USING btree (pagamento_id);


--
-- Name: idx_incassi_quota; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_incassi_quota ON public.incassi USING btree (quota_id);


--
-- Name: idx_materie_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_materie_scuola ON public.materie USING btree (scuola_id);


--
-- Name: idx_materie_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_materie_section ON public.materie USING btree (section_id);


--
-- Name: idx_mensa_class_menu_scuola_classe; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mensa_class_menu_scuola_classe ON public.mensa_class_menu_assignment USING btree (scuola_id, classe, attivo_dal DESC);


--
-- Name: idx_mensa_pren_alunno_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mensa_pren_alunno_data ON public.mensa_prenotazioni USING btree (alunno_id, data);


--
-- Name: idx_mensa_pren_scuola_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mensa_pren_scuola_data ON public.mensa_prenotazioni USING btree (scuola_id, data);


--
-- Name: idx_nota_ricezioni_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_nota_ricezioni_lookup ON public.nota_ricezioni USING btree (nota_id, genitore_id);


--
-- Name: idx_note_disciplinari_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_note_disciplinari_alunno ON public.note_disciplinari USING btree (alunno_id);


--
-- Name: idx_note_disciplinari_alunno_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_note_disciplinari_alunno_id ON public.note_disciplinari USING btree (alunno_id);


--
-- Name: idx_note_disciplinari_maestra_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_note_disciplinari_maestra_id ON public.note_disciplinari USING btree (maestra_id);


--
-- Name: idx_note_gruppo; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_note_gruppo ON public.note_disciplinari USING btree (nota_gruppo_id);


--
-- Name: idx_notifiche_programmato; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifiche_programmato ON public.notifiche USING btree (invio_programmato_il) WHERE (push_inviata_il IS NULL);


--
-- Name: idx_notifiche_push; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifiche_push ON public.notifiche USING btree (push_inviata_il);


--
-- Name: idx_notifiche_utente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifiche_utente ON public.notifiche USING btree (utente_id, letta_il);


--
-- Name: idx_obiettivi_materia; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_obiettivi_materia ON public.obiettivi_apprendimento USING btree (scuola_id, materia_codice, livello);


--
-- Name: idx_orario_docente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_orario_docente ON public.orario_settimanale USING btree (docente_id);


--
-- Name: idx_orario_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_orario_section ON public.orario_settimanale USING btree (section_id);


--
-- Name: idx_pagamenti_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagamenti_alunno ON public.pagamenti USING btree (alunno_id);


--
-- Name: idx_pagamenti_gruppo; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagamenti_gruppo ON public.pagamenti USING btree (gruppo);


--
-- Name: idx_pagamenti_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagamenti_parent ON public.pagamenti USING btree (parent_payment_id);


--
-- Name: idx_pagamenti_scadenza; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagamenti_scadenza ON public.pagamenti USING btree (scadenza);


--
-- Name: idx_pagamenti_stato; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagamenti_stato ON public.pagamenti USING btree (stato);


--
-- Name: idx_pagamenti_visibile_dal; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagamenti_visibile_dal ON public.pagamenti USING btree (visibile_dal);


--
-- Name: idx_pagella_ric_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagella_ric_lookup ON public.pagella_ricezioni USING btree (scrutinio_id, alunno_id, genitore_id);


--
-- Name: idx_pagelle_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pagelle_alunno ON public.pagelle USING btree (alunno_id);


--
-- Name: idx_parents_auth_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_parents_auth_user_id ON public.parents USING btree (auth_user_id);


--
-- Name: idx_presenze_alunno_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_presenze_alunno_id ON public.presenze USING btree (alunno_id);


--
-- Name: idx_presenze_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_presenze_data ON public.presenze USING btree (data);


--
-- Name: idx_presenze_giustificata; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_presenze_giustificata ON public.presenze USING btree (giustificata);


--
-- Name: idx_presenze_section_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_presenze_section_data ON public.presenze USING btree (section_id, data);


--
-- Name: idx_push_sub_utente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_push_sub_utente ON public.push_subscriptions USING btree (utente_id);


--
-- Name: idx_quote_adult; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_quote_adult ON public.pagamenti_quote USING btree (adult_id);


--
-- Name: idx_quote_pagamento; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_quote_pagamento ON public.pagamenti_quote USING btree (pagamento_id);


--
-- Name: idx_registro_dest_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_registro_dest_alunno ON public.registro_destinatari USING btree (alunno_id);


--
-- Name: idx_registro_dest_registro; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_registro_dest_registro ON public.registro_destinatari USING btree (registro_id);


--
-- Name: idx_registro_orario_classe_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_registro_orario_classe_data ON public.registro_orario USING btree (classe_sezione, data);


--
-- Name: idx_registro_orario_scuola_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_registro_orario_scuola_id ON public.registro_orario USING btree (scuola_id);


--
-- Name: idx_registro_section_data; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_registro_section_data ON public.registro_orario USING btree (section_id, data);


--
-- Name: idx_sblocchi_entita; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sblocchi_entita ON public.sblocchi_audit USING btree (entita_tipo, entita_id);


--
-- Name: idx_scrut_comp_scrut; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrut_comp_scrut ON public.scrutinio_comportamento USING btree (scrutinio_id);


--
-- Name: idx_scrut_giud_descr_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrut_giud_descr_lookup ON public.scrutinio_giudizio_descrittivo USING btree (scuola_id, livello, materia_codice, periodo_id);


--
-- Name: idx_scrut_giudizi_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrut_giudizi_alunno ON public.scrutinio_giudizi USING btree (alunno_id);


--
-- Name: idx_scrut_giudizi_scrut; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrut_giudizi_scrut ON public.scrutinio_giudizi USING btree (scrutinio_id);


--
-- Name: idx_scrut_periodi_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrut_periodi_scuola ON public.scrutinio_periodi USING btree (scuola_id, anno_scolastico);


--
-- Name: idx_scrutini_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrutini_section ON public.scrutini USING btree (section_id);


--
-- Name: idx_sez_mat_ob_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sez_mat_ob_section ON public.sezione_materia_obiettivo USING btree (section_id);


--
-- Name: idx_student_documents_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_student_documents_section ON public.student_documents USING btree (section_id);


--
-- Name: idx_student_documents_student; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_student_documents_student ON public.student_documents USING btree (student_id);


--
-- Name: idx_task_interni_assigned; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_interni_assigned ON public.task_interni USING btree (assigned_to);


--
-- Name: idx_task_interni_class; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_interni_class ON public.task_interni USING btree (target_class);


--
-- Name: idx_task_interni_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_interni_scuola ON public.task_interni USING btree (scuola_id);


--
-- Name: idx_usm_materia; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_usm_materia ON public.utenti_sezioni_materie USING btree (materia_id);


--
-- Name: idx_usm_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_usm_section ON public.utenti_sezioni_materie USING btree (section_id);


--
-- Name: idx_usm_utente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_usm_utente ON public.utenti_sezioni_materie USING btree (utente_id);


--
-- Name: idx_utenti_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_utenti_scuola ON public.utenti USING btree (scuola_id);


--
-- Name: idx_utenti_scuole_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_utenti_scuole_scuola ON public.utenti_scuole USING btree (scuola_id);


--
-- Name: idx_utenti_scuole_utente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_utenti_scuole_utente ON public.utenti_scuole USING btree (utente_id);


--
-- Name: idx_utenti_sezioni_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_utenti_sezioni_section ON public.utenti_sezioni USING btree (section_id);


--
-- Name: idx_utenti_sezioni_utente; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_utenti_sezioni_utente ON public.utenti_sezioni USING btree (utente_id);


--
-- Name: idx_val_obiettivi_val; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_val_obiettivi_val ON public.valutazione_obiettivi USING btree (valutazione_id);


--
-- Name: idx_valutazioni_alunno; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_valutazioni_alunno ON public.valutazioni USING btree (alunno_id);


--
-- Name: idx_valutazioni_materia_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_valutazioni_materia_id ON public.valutazioni USING btree (materia_id);


--
-- Name: idx_valutazioni_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_valutazioni_section ON public.valutazioni USING btree (section_id);


--
-- Name: uidx_mensa_ovr_legacy; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uidx_mensa_ovr_legacy ON public.mensa_menu_override USING btree (scuola_id, data) WHERE (menu_config_id IS NULL);


--
-- Name: uidx_mensa_ovr_menu; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uidx_mensa_ovr_menu ON public.mensa_menu_override USING btree (scuola_id, menu_config_id, data) WHERE (menu_config_id IS NOT NULL);


--
-- Name: uidx_mensa_rot_legacy; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uidx_mensa_rot_legacy ON public.mensa_menu_rotazione USING btree (scuola_id, settimana, giorno_settimana) WHERE (menu_config_id IS NULL);


--
-- Name: uidx_mensa_rot_menu; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uidx_mensa_rot_menu ON public.mensa_menu_rotazione USING btree (scuola_id, menu_config_id, settimana, giorno_settimana) WHERE (menu_config_id IS NOT NULL);


--
-- Name: uq_giudizio_template_global; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_giudizio_template_global ON public.giudizio_template USING btree (dimensione, valore) WHERE (scuola_id IS NULL);


--
-- Name: uq_giudizio_template_scuola; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_giudizio_template_scuola ON public.giudizio_template USING btree (scuola_id, dimensione, valore) WHERE (scuola_id IS NOT NULL);


--
-- Name: uq_pagamenti_retta_mese; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_pagamenti_retta_mese ON public.pagamenti USING btree (alunno_id, periodo_competenza) WHERE ((categoria_id IS NOT NULL) AND (tipo = ANY (ARRAY['singolo'::public.pagamento_tipo, 'padre'::public.pagamento_tipo, 'split'::public.pagamento_tipo])) AND (periodo_competenza IS NOT NULL));


--
-- Name: uq_payment_categories_global_nome; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_payment_categories_global_nome ON public.payment_categories USING btree (nome) WHERE (scuola_id IS NULL);


--
-- Name: uq_tempo_scuola_section_attivo; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_tempo_scuola_section_attivo ON public.tempo_scuola USING btree (section_id) WHERE attivo;


--
-- Name: ux_alunni_numero_domanda_sidi; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX ux_alunni_numero_domanda_sidi ON public.alunni USING btree (scuola_id, numero_domanda_sidi) WHERE (numero_domanda_sidi IS NOT NULL);


--
-- Name: incassi incassi_ricalcola; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER incassi_ricalcola AFTER INSERT OR DELETE OR UPDATE ON public.incassi FOR EACH ROW EXECUTE FUNCTION public.trg_incassi_ricalcola();


--
-- Name: admin_settings trg_admin_settings_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_admin_settings_updated_at BEFORE UPDATE ON public.admin_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: alunni trg_alunni_sync_section; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_alunni_sync_section BEFORE INSERT OR UPDATE OF classe_sezione, section_id, scuola_id ON public.alunni FOR EACH ROW EXECUTE FUNCTION public.sync_alunno_section_id();


--
-- Name: form_models trg_form_models_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_form_models_updated_at BEFORE UPDATE ON public.form_models FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: form_submissions trg_form_submission_etl; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_form_submission_etl AFTER INSERT OR UPDATE OF status ON public.form_submissions FOR EACH ROW EXECUTE FUNCTION public.fn_form_submission_etl();


--
-- Name: form_submissions trg_form_submission_score; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_form_submission_score BEFORE INSERT OR UPDATE OF status, data, manual_adjustments ON public.form_submissions FOR EACH ROW EXECUTE FUNCTION public.fn_form_submission_score();


--
-- Name: form_submissions trg_form_submissions_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_form_submissions_updated_at BEFORE UPDATE ON public.form_submissions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: giudizio_template trg_giudizio_template_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_giudizio_template_updated_at BEFORE UPDATE ON public.giudizio_template FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: materie trg_materie_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_materie_updated_at BEFORE UPDATE ON public.materie FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: mensa_menu_override trg_mensa_override_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_mensa_override_updated_at BEFORE UPDATE ON public.mensa_menu_override FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: mensa_prenotazioni trg_mensa_pren_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_mensa_pren_updated_at BEFORE UPDATE ON public.mensa_prenotazioni FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: mensa_menu_rotazione trg_mensa_rotazione_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_mensa_rotazione_updated_at BEFORE UPDATE ON public.mensa_menu_rotazione FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: obiettivi_apprendimento trg_obiettivi_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_obiettivi_updated_at BEFORE UPDATE ON public.obiettivi_apprendimento FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orario_settimanale trg_orario_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_orario_updated_at BEFORE UPDATE ON public.orario_settimanale FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payment_categories trg_payment_categories_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_payment_categories_updated_at BEFORE UPDATE ON public.payment_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: scrutinio_comportamento trg_scrut_comp_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_scrut_comp_updated_at BEFORE UPDATE ON public.scrutinio_comportamento FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: scrutinio_giudizio_descrittivo trg_scrut_giud_descr_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_scrut_giud_descr_updated_at BEFORE UPDATE ON public.scrutinio_giudizio_descrittivo FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: scrutinio_giudizi trg_scrut_giudizi_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_scrut_giudizi_updated_at BEFORE UPDATE ON public.scrutinio_giudizi FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sezione_materia_obiettivo trg_sez_mat_ob_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_sez_mat_ob_updated_at BEFORE UPDATE ON public.sezione_materia_obiettivo FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tempo_scuola trg_tempo_scuola_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_tempo_scuola_updated_at BEFORE UPDATE ON public.tempo_scuola FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: admin_settings admin_settings_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_settings
    ADD CONSTRAINT admin_settings_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: allegati_registro allegati_registro_caricato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.allegati_registro
    ADD CONSTRAINT allegati_registro_caricato_da_fkey FOREIGN KEY (caricato_da) REFERENCES public.utenti(id);


--
-- Name: allegati_registro allegati_registro_registro_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.allegati_registro
    ADD CONSTRAINT allegati_registro_registro_id_fkey FOREIGN KEY (registro_id) REFERENCES public.registro_orario(id) ON DELETE CASCADE;


--
-- Name: alunni alunni_gruppo_mensa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alunni
    ADD CONSTRAINT alunni_gruppo_mensa_id_fkey FOREIGN KEY (gruppo_mensa_id) REFERENCES public.gruppi_mensa(id) ON DELETE SET NULL;


--
-- Name: alunni alunni_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alunni
    ADD CONSTRAINT alunni_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id);


--
-- Name: alunni alunni_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alunni
    ADD CONSTRAINT alunni_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE SET NULL;


--
-- Name: armadietto armadietto_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.armadietto
    ADD CONSTRAINT armadietto_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: armadietto armadietto_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.armadietto
    ADD CONSTRAINT armadietto_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: audit_scritture_docente audit_scritture_docente_attore_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_scritture_docente
    ADD CONSTRAINT audit_scritture_docente_attore_id_fkey FOREIGN KEY (attore_id) REFERENCES public.utenti(id);


--
-- Name: audit_scritture_docente audit_scritture_docente_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_scritture_docente
    ADD CONSTRAINT audit_scritture_docente_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id);


--
-- Name: audit_scritture_docente audit_scritture_docente_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_scritture_docente
    ADD CONSTRAINT audit_scritture_docente_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE SET NULL;


--
-- Name: avvisi avvisi_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi
    ADD CONSTRAINT avvisi_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: avvisi_risposte avvisi_risposte_avviso_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi_risposte
    ADD CONSTRAINT avvisi_risposte_avviso_id_fkey FOREIGN KEY (avviso_id) REFERENCES public.avvisi(id) ON DELETE CASCADE;


--
-- Name: avvisi_risposte avvisi_risposte_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi_risposte
    ADD CONSTRAINT avvisi_risposte_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: avvisi_risposte avvisi_risposte_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi_risposte
    ADD CONSTRAINT avvisi_risposte_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: avvisi avvisi_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.avvisi
    ADD CONSTRAINT avvisi_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: campanelle campanelle_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campanelle
    ADD CONSTRAINT campanelle_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: certificati_competenze certificati_competenze_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_competenze
    ADD CONSTRAINT certificati_competenze_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: certificati_competenze certificati_competenze_scrutinio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_competenze
    ADD CONSTRAINT certificati_competenze_scrutinio_id_fkey FOREIGN KEY (scrutinio_id) REFERENCES public.scrutini(id) ON DELETE SET NULL;


--
-- Name: certificati_competenze certificati_competenze_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_competenze
    ADD CONSTRAINT certificati_competenze_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE SET NULL;


--
-- Name: certificati_medici certificati_medici_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificati_medici
    ADD CONSTRAINT certificati_medici_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: certificato_competenza_livelli certificato_competenza_livelli_certificato_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificato_competenza_livelli
    ADD CONSTRAINT certificato_competenza_livelli_certificato_id_fkey FOREIGN KEY (certificato_id) REFERENCES public.certificati_competenze(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_threads chat_threads_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: chat_threads chat_threads_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: chat_threads chat_threads_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: delegates delegates_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.delegates
    ADD CONSTRAINT delegates_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: divise_ordini divise_ordini_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_ordini
    ADD CONSTRAINT divise_ordini_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: divise_ordini divise_ordini_pagamento_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_ordini
    ADD CONSTRAINT divise_ordini_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE SET NULL;


--
-- Name: divise_ordini_righe divise_ordini_righe_articolo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_ordini_righe
    ADD CONSTRAINT divise_ordini_righe_articolo_id_fkey FOREIGN KEY (articolo_id) REFERENCES public.divise_articoli(id) ON DELETE SET NULL;


--
-- Name: divise_ordini_righe divise_ordini_righe_ordine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.divise_ordini_righe
    ADD CONSTRAINT divise_ordini_righe_ordine_id_fkey FOREIGN KEY (ordine_id) REFERENCES public.divise_ordini(id) ON DELETE CASCADE;


--
-- Name: eventi_agenda eventi_agenda_creato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_agenda
    ADD CONSTRAINT eventi_agenda_creato_da_fkey FOREIGN KEY (creato_da) REFERENCES public.utenti(id);


--
-- Name: eventi_agenda eventi_agenda_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_agenda
    ADD CONSTRAINT eventi_agenda_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: eventi_agenda eventi_agenda_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_agenda
    ADD CONSTRAINT eventi_agenda_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: eventi_diario eventi_diario_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_diario
    ADD CONSTRAINT eventi_diario_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: eventi_diario eventi_diario_maestra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.eventi_diario
    ADD CONSTRAINT eventi_diario_maestra_id_fkey FOREIGN KEY (maestra_id) REFERENCES public.utenti(id);


--
-- Name: fascicolo_accessi_audit fascicolo_accessi_audit_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fascicolo_accessi_audit
    ADD CONSTRAINT fascicolo_accessi_audit_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: fascicolo_accessi_audit fascicolo_accessi_audit_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fascicolo_accessi_audit
    ADD CONSTRAINT fascicolo_accessi_audit_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id);


--
-- Name: fatture_emesse fatture_emesse_pagamento_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fatture_emesse
    ADD CONSTRAINT fatture_emesse_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE CASCADE;


--
-- Name: firme_docenti firme_docenti_registro_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.firme_docenti
    ADD CONSTRAINT firme_docenti_registro_id_fkey FOREIGN KEY (registro_id) REFERENCES public.registro_orario(id) ON DELETE CASCADE;


--
-- Name: firme_documenti firme_documenti_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.firme_documenti
    ADD CONSTRAINT firme_documenti_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id);


--
-- Name: form_submissions form_submissions_gestita_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_gestita_da_fkey FOREIGN KEY (gestita_da) REFERENCES public.utenti(id);


--
-- Name: form_submissions form_submissions_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.form_models(id) ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: forms_submissions forms_submissions_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.forms_submissions
    ADD CONSTRAINT forms_submissions_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.forms_templates(id) ON DELETE CASCADE;


--
-- Name: galleria_media galleria_media_caricato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.galleria_media
    ADD CONSTRAINT galleria_media_caricato_da_fkey FOREIGN KEY (caricato_da) REFERENCES public.utenti(id);


--
-- Name: galleria_media galleria_media_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.galleria_media
    ADD CONSTRAINT galleria_media_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id);


--
-- Name: galleria_media_v2 galleria_media_v2_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.galleria_media_v2
    ADD CONSTRAINT galleria_media_v2_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: giudizi_sintetici_scala giudizi_sintetici_scala_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giudizi_sintetici_scala
    ADD CONSTRAINT giudizi_sintetici_scala_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: giudizio_template giudizio_template_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giudizio_template
    ADD CONSTRAINT giudizio_template_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: giustifiche_didattiche giustifiche_didattiche_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giustifiche_didattiche
    ADD CONSTRAINT giustifiche_didattiche_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: giustifiche_didattiche giustifiche_didattiche_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giustifiche_didattiche
    ADD CONSTRAINT giustifiche_didattiche_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id) ON DELETE SET NULL;


--
-- Name: giustifiche_didattiche giustifiche_didattiche_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.giustifiche_didattiche
    ADD CONSTRAINT giustifiche_didattiche_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: incassi incassi_pagamento_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incassi
    ADD CONSTRAINT incassi_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE CASCADE;


--
-- Name: incassi incassi_quota_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incassi
    ADD CONSTRAINT incassi_quota_id_fkey FOREIGN KEY (quota_id) REFERENCES public.pagamenti_quote(id) ON DELETE SET NULL;


--
-- Name: incassi incassi_registrato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incassi
    ADD CONSTRAINT incassi_registrato_da_fkey FOREIGN KEY (registrato_da) REFERENCES public.utenti(id);


--
-- Name: legame_genitori_alunni legame_genitori_alunni_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.legame_genitori_alunni
    ADD CONSTRAINT legame_genitori_alunni_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: legame_genitori_alunni legame_genitori_alunni_genitore_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.legame_genitori_alunni
    ADD CONSTRAINT legame_genitori_alunni_genitore_id_fkey FOREIGN KEY (genitore_id) REFERENCES public.utenti(id);


--
-- Name: materie materie_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.materie
    ADD CONSTRAINT materie_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: materie materie_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.materie
    ADD CONSTRAINT materie_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: mensa_class_menu_assignment mensa_class_menu_assignment_menu_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_class_menu_assignment
    ADD CONSTRAINT mensa_class_menu_assignment_menu_config_id_fkey FOREIGN KEY (menu_config_id) REFERENCES public.mensa_menu_config(id) ON DELETE CASCADE;


--
-- Name: mensa_class_menu_assignment mensa_class_menu_assignment_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_class_menu_assignment
    ADD CONSTRAINT mensa_class_menu_assignment_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: mensa_menu_config mensa_menu_config_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_config
    ADD CONSTRAINT mensa_menu_config_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: mensa_menu_override mensa_menu_override_menu_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_override
    ADD CONSTRAINT mensa_menu_override_menu_config_id_fkey FOREIGN KEY (menu_config_id) REFERENCES public.mensa_menu_config(id) ON DELETE SET NULL;


--
-- Name: mensa_menu_override mensa_menu_override_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_override
    ADD CONSTRAINT mensa_menu_override_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: mensa_menu_rotazione mensa_menu_rotazione_menu_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_rotazione
    ADD CONSTRAINT mensa_menu_rotazione_menu_config_id_fkey FOREIGN KEY (menu_config_id) REFERENCES public.mensa_menu_config(id) ON DELETE SET NULL;


--
-- Name: mensa_menu_rotazione mensa_menu_rotazione_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_menu_rotazione
    ADD CONSTRAINT mensa_menu_rotazione_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: mensa_prenotazioni mensa_prenotazioni_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_prenotazioni
    ADD CONSTRAINT mensa_prenotazioni_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: mensa_prenotazioni mensa_prenotazioni_prenotato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_prenotazioni
    ADD CONSTRAINT mensa_prenotazioni_prenotato_da_fkey FOREIGN KEY (prenotato_da) REFERENCES public.utenti(id);


--
-- Name: mensa_prenotazioni mensa_prenotazioni_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mensa_prenotazioni
    ADD CONSTRAINT mensa_prenotazioni_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: nota_ricezioni nota_ricezioni_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nota_ricezioni
    ADD CONSTRAINT nota_ricezioni_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: nota_ricezioni nota_ricezioni_nota_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nota_ricezioni
    ADD CONSTRAINT nota_ricezioni_nota_id_fkey FOREIGN KEY (nota_id) REFERENCES public.note_disciplinari(id) ON DELETE CASCADE;


--
-- Name: note_disciplinari note_disciplinari_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_disciplinari
    ADD CONSTRAINT note_disciplinari_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: note_disciplinari note_disciplinari_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_disciplinari
    ADD CONSTRAINT note_disciplinari_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id);


--
-- Name: notifiche notifiche_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifiche
    ADD CONSTRAINT notifiche_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: obiettivi_apprendimento obiettivi_apprendimento_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.obiettivi_apprendimento
    ADD CONSTRAINT obiettivi_apprendimento_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: orario_settimanale orario_settimanale_campanella_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orario_settimanale
    ADD CONSTRAINT orario_settimanale_campanella_id_fkey FOREIGN KEY (campanella_id) REFERENCES public.campanelle(id) ON DELETE CASCADE;


--
-- Name: orario_settimanale orario_settimanale_docente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orario_settimanale
    ADD CONSTRAINT orario_settimanale_docente_id_fkey FOREIGN KEY (docente_id) REFERENCES public.utenti(id) ON DELETE SET NULL;


--
-- Name: orario_settimanale orario_settimanale_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orario_settimanale
    ADD CONSTRAINT orario_settimanale_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id) ON DELETE SET NULL;


--
-- Name: orario_settimanale orario_settimanale_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orario_settimanale
    ADD CONSTRAINT orario_settimanale_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: pagamenti pagamenti_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti
    ADD CONSTRAINT pagamenti_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: pagamenti pagamenti_categoria_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti
    ADD CONSTRAINT pagamenti_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES public.payment_categories(id);


--
-- Name: pagamenti pagamenti_creato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti
    ADD CONSTRAINT pagamenti_creato_da_fkey FOREIGN KEY (creato_da) REFERENCES public.utenti(id);


--
-- Name: pagamenti pagamenti_parent_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti
    ADD CONSTRAINT pagamenti_parent_payment_id_fkey FOREIGN KEY (parent_payment_id) REFERENCES public.pagamenti(id) ON DELETE CASCADE;


--
-- Name: pagamenti_quote pagamenti_quote_adult_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti_quote
    ADD CONSTRAINT pagamenti_quote_adult_id_fkey FOREIGN KEY (adult_id) REFERENCES public.utenti(id);


--
-- Name: pagamenti_quote pagamenti_quote_pagamento_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti_quote
    ADD CONSTRAINT pagamenti_quote_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE CASCADE;


--
-- Name: pagamenti pagamenti_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagamenti
    ADD CONSTRAINT pagamenti_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id);


--
-- Name: pagella_ricezioni pagella_ricezioni_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagella_ricezioni
    ADD CONSTRAINT pagella_ricezioni_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: pagella_ricezioni pagella_ricezioni_scrutinio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagella_ricezioni
    ADD CONSTRAINT pagella_ricezioni_scrutinio_id_fkey FOREIGN KEY (scrutinio_id) REFERENCES public.scrutini(id) ON DELETE CASCADE;


--
-- Name: pagelle pagelle_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagelle
    ADD CONSTRAINT pagelle_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: pagelle pagelle_generata_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagelle
    ADD CONSTRAINT pagelle_generata_da_fkey FOREIGN KEY (generata_da) REFERENCES public.utenti(id);


--
-- Name: pagelle pagelle_scrutinio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pagelle
    ADD CONSTRAINT pagelle_scrutinio_id_fkey FOREIGN KEY (scrutinio_id) REFERENCES public.scrutini(id) ON DELETE CASCADE;


--
-- Name: parents parents_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: payment_categories payment_categories_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.payment_categories
    ADD CONSTRAINT payment_categories_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: presenze presenze_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: presenze presenze_giust_vista_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_giust_vista_da_fkey FOREIGN KEY (giust_vista_da) REFERENCES public.utenti(id);


--
-- Name: presenze presenze_registrato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_registrato_da_fkey FOREIGN KEY (registrato_da) REFERENCES public.utenti(id);


--
-- Name: presenze presenze_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: presenze presenze_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE SET NULL;


--
-- Name: presenze presenze_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.presenze
    ADD CONSTRAINT presenze_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id);


--
-- Name: push_subscriptions push_subscriptions_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: registro_destinatari registro_destinatari_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_destinatari
    ADD CONSTRAINT registro_destinatari_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: registro_destinatari registro_destinatari_firma_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_destinatari
    ADD CONSTRAINT registro_destinatari_firma_id_fkey FOREIGN KEY (firma_id) REFERENCES public.firme_docenti(id) ON DELETE CASCADE;


--
-- Name: registro_destinatari registro_destinatari_registro_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_destinatari
    ADD CONSTRAINT registro_destinatari_registro_id_fkey FOREIGN KEY (registro_id) REFERENCES public.registro_orario(id) ON DELETE CASCADE;


--
-- Name: registro_modifiche registro_modifiche_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_modifiche
    ADD CONSTRAINT registro_modifiche_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id);


--
-- Name: registro_orario registro_orario_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_orario
    ADD CONSTRAINT registro_orario_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id);


--
-- Name: registro_orario registro_orario_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_orario
    ADD CONSTRAINT registro_orario_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id);


--
-- Name: registro_orario registro_orario_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.registro_orario
    ADD CONSTRAINT registro_orario_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id);


--
-- Name: sblocchi_audit sblocchi_audit_dirigente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sblocchi_audit
    ADD CONSTRAINT sblocchi_audit_dirigente_id_fkey FOREIGN KEY (dirigente_id) REFERENCES public.utenti(id);


--
-- Name: scrutini scrutini_chiuso_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutini
    ADD CONSTRAINT scrutini_chiuso_da_fkey FOREIGN KEY (chiuso_da) REFERENCES public.utenti(id);


--
-- Name: scrutini scrutini_periodo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutini
    ADD CONSTRAINT scrutini_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE;


--
-- Name: scrutini scrutini_pubblicato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutini
    ADD CONSTRAINT scrutini_pubblicato_da_fkey FOREIGN KEY (pubblicato_da) REFERENCES public.utenti(id);


--
-- Name: scrutini scrutini_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutini
    ADD CONSTRAINT scrutini_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: scrutinio_comportamento scrutinio_comportamento_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_comportamento
    ADD CONSTRAINT scrutinio_comportamento_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: scrutinio_comportamento scrutinio_comportamento_scrutinio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_comportamento
    ADD CONSTRAINT scrutinio_comportamento_scrutinio_id_fkey FOREIGN KEY (scrutinio_id) REFERENCES public.scrutini(id) ON DELETE CASCADE;


--
-- Name: scrutinio_giudizi scrutinio_giudizi_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizi
    ADD CONSTRAINT scrutinio_giudizi_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: scrutinio_giudizi scrutinio_giudizi_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizi
    ADD CONSTRAINT scrutinio_giudizi_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id) ON DELETE CASCADE;


--
-- Name: scrutinio_giudizi scrutinio_giudizi_proposto_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizi
    ADD CONSTRAINT scrutinio_giudizi_proposto_da_fkey FOREIGN KEY (proposto_da) REFERENCES public.utenti(id);


--
-- Name: scrutinio_giudizi scrutinio_giudizi_scrutinio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizi
    ADD CONSTRAINT scrutinio_giudizi_scrutinio_id_fkey FOREIGN KEY (scrutinio_id) REFERENCES public.scrutini(id) ON DELETE CASCADE;


--
-- Name: scrutinio_giudizio_descrittivo scrutinio_giudizio_descrittivo_periodo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizio_descrittivo
    ADD CONSTRAINT scrutinio_giudizio_descrittivo_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE;


--
-- Name: scrutinio_giudizio_descrittivo scrutinio_giudizio_descrittivo_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_giudizio_descrittivo
    ADD CONSTRAINT scrutinio_giudizio_descrittivo_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: scrutinio_periodi scrutinio_periodi_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrutinio_periodi
    ADD CONSTRAINT scrutinio_periodi_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: sections sections_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: sezione_materia_obiettivo sezione_materia_obiettivo_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sezione_materia_obiettivo
    ADD CONSTRAINT sezione_materia_obiettivo_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id) ON DELETE CASCADE;


--
-- Name: sezione_materia_obiettivo sezione_materia_obiettivo_obiettivo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sezione_materia_obiettivo
    ADD CONSTRAINT sezione_materia_obiettivo_obiettivo_id_fkey FOREIGN KEY (obiettivo_id) REFERENCES public.obiettivi_apprendimento(id) ON DELETE CASCADE;


--
-- Name: sezione_materia_obiettivo sezione_materia_obiettivo_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sezione_materia_obiettivo
    ADD CONSTRAINT sezione_materia_obiettivo_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: student_documents student_documents_caricato_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_caricato_da_fkey FOREIGN KEY (caricato_da) REFERENCES public.utenti(id);


--
-- Name: student_documents student_documents_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id);


--
-- Name: student_documents student_documents_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_documents
    ADD CONSTRAINT student_documents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: student_parents student_parents_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE CASCADE;


--
-- Name: student_parents student_parents_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.alunni(id) ON DELETE CASCADE;


--
-- Name: task_interni task_interni_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_interni
    ADD CONSTRAINT task_interni_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.utenti(id) ON DELETE SET NULL;


--
-- Name: task_interni task_interni_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_interni
    ADD CONSTRAINT task_interni_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: task_interni task_interni_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_interni
    ADD CONSTRAINT task_interni_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: tempo_scuola tempo_scuola_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tempo_scuola
    ADD CONSTRAINT tempo_scuola_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: ticket_mensa ticket_mensa_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ticket_mensa
    ADD CONSTRAINT ticket_mensa_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: utenti utenti_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti
    ADD CONSTRAINT utenti_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: utenti utenti_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti
    ADD CONSTRAINT utenti_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id);


--
-- Name: utenti_scuole utenti_scuole_scuola_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_scuole
    ADD CONSTRAINT utenti_scuole_scuola_id_fkey FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: utenti_scuole utenti_scuole_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_scuole
    ADD CONSTRAINT utenti_scuole_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: utenti_sezioni_materie utenti_sezioni_materie_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni_materie
    ADD CONSTRAINT utenti_sezioni_materie_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id) ON DELETE CASCADE;


--
-- Name: utenti_sezioni_materie utenti_sezioni_materie_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni_materie
    ADD CONSTRAINT utenti_sezioni_materie_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: utenti_sezioni_materie utenti_sezioni_materie_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni_materie
    ADD CONSTRAINT utenti_sezioni_materie_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: utenti_sezioni utenti_sezioni_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni
    ADD CONSTRAINT utenti_sezioni_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE CASCADE;


--
-- Name: utenti_sezioni utenti_sezioni_utente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.utenti_sezioni
    ADD CONSTRAINT utenti_sezioni_utente_id_fkey FOREIGN KEY (utente_id) REFERENCES public.utenti(id) ON DELETE CASCADE;


--
-- Name: valutazione_obiettivi valutazione_obiettivi_obiettivo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazione_obiettivi
    ADD CONSTRAINT valutazione_obiettivi_obiettivo_id_fkey FOREIGN KEY (obiettivo_id) REFERENCES public.obiettivi_apprendimento(id) ON DELETE CASCADE;


--
-- Name: valutazione_obiettivi valutazione_obiettivi_valutazione_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazione_obiettivi
    ADD CONSTRAINT valutazione_obiettivi_valutazione_id_fkey FOREIGN KEY (valutazione_id) REFERENCES public.valutazioni(id) ON DELETE CASCADE;


--
-- Name: valutazioni valutazioni_alunno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazioni
    ADD CONSTRAINT valutazioni_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);


--
-- Name: valutazioni valutazioni_maestra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazioni
    ADD CONSTRAINT valutazioni_maestra_id_fkey FOREIGN KEY (maestra_id) REFERENCES public.utenti(id);


--
-- Name: valutazioni valutazioni_materia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazioni
    ADD CONSTRAINT valutazioni_materia_id_fkey FOREIGN KEY (materia_id) REFERENCES public.materie(id);


--
-- Name: valutazioni valutazioni_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.valutazioni
    ADD CONSTRAINT valutazioni_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id);


--
-- Name: registro_orario Enable delete for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable delete for authenticated users" ON public.registro_orario FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: firme_docenti Enable insert for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable insert for authenticated users" ON public.firme_docenti FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: note_disciplinari Enable insert for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable insert for authenticated users" ON public.note_disciplinari FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: registro_orario Enable insert for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable insert for authenticated users" ON public.registro_orario FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: note_disciplinari Enable update for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable update for authenticated users" ON public.note_disciplinari FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: registro_orario Enable update for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable update for authenticated users" ON public.registro_orario FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: registro_orario Genitori possono vedere il registro dei figli; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Genitori possono vedere il registro dei figli" ON public.registro_orario FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.alunni a
     JOIN public.legame_genitori_alunni lga ON ((a.id = lga.alunno_id)))
  WHERE ((lga.genitore_id = auth.uid()) AND (a.scuola_id = registro_orario.scuola_id) AND ((a.classe_sezione)::text = (registro_orario.classe_sezione)::text)))));


--
-- Name: note_disciplinari Genitori possono vedere le note dei propri figli; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Genitori possono vedere le note dei propri figli" ON public.note_disciplinari FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.legame_genitori_alunni
  WHERE ((legame_genitori_alunni.genitore_id = auth.uid()) AND (legame_genitori_alunni.alunno_id = note_disciplinari.alunno_id)))));


--
-- Name: registro_orario Maestre della scuola possono gestire il registro; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Maestre della scuola possono gestire il registro" ON public.registro_orario TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti
  WHERE ((utenti.id = auth.uid()) AND (utenti.scuola_id = registro_orario.scuola_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.utenti
  WHERE ((utenti.id = auth.uid()) AND (utenti.scuola_id = registro_orario.scuola_id)))));


--
-- Name: firme_docenti Maestre della scuola possono vedere tutte le firme del registro; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Maestre della scuola possono vedere tutte le firme del registro" ON public.firme_docenti FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.registro_orario r
     JOIN public.utenti u ON ((r.scuola_id = u.scuola_id)))
  WHERE ((r.id = firme_docenti.registro_id) AND (u.id = auth.uid())))));


--
-- Name: note_disciplinari Maestre della stessa scuola possono vedere le note; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Maestre della stessa scuola possono vedere le note" ON public.note_disciplinari FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.utenti u
     JOIN public.alunni a ON ((u.scuola_id = a.scuola_id)))
  WHERE ((u.id = auth.uid()) AND (a.id = note_disciplinari.alunno_id)))));


--
-- Name: firme_docenti Maestre possono gestire le proprie firme; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Maestre possono gestire le proprie firme" ON public.firme_docenti TO authenticated USING ((maestra_id = auth.uid())) WITH CHECK ((maestra_id = auth.uid()));


--
-- Name: note_disciplinari Maestre possono gestire le proprie note; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Maestre possono gestire le proprie note" ON public.note_disciplinari TO authenticated USING ((maestra_id = auth.uid())) WITH CHECK ((maestra_id = auth.uid()));


--
-- Name: presenze Users can insert attendance in their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can insert attendance in their school" ON public.presenze FOR INSERT WITH CHECK ((scuola_id IN ( SELECT utenti.scuola_id
   FROM public.utenti
  WHERE (utenti.id = auth.uid()))));


--
-- Name: presenze Users can update attendance in their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can update attendance in their school" ON public.presenze FOR UPDATE USING ((scuola_id IN ( SELECT utenti.scuola_id
   FROM public.utenti
  WHERE (utenti.id = auth.uid()))));


--
-- Name: presenze Users can view attendance in their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can view attendance in their school" ON public.presenze FOR SELECT USING ((scuola_id IN ( SELECT utenti.scuola_id
   FROM public.utenti
  WHERE (utenti.id = auth.uid()))));


--
-- Name: admin_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: allegati_registro; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.allegati_registro ENABLE ROW LEVEL SECURITY;

--
-- Name: alunni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.alunni ENABLE ROW LEVEL SECURITY;

--
-- Name: armadietto; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.armadietto ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_scritture_docente; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.audit_scritture_docente ENABLE ROW LEVEL SECURITY;

--
-- Name: fea_audit_log auth read fea_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "auth read fea_audit" ON public.fea_audit_log FOR SELECT TO authenticated USING (true);


--
-- Name: avvisi; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.avvisi ENABLE ROW LEVEL SECURITY;

--
-- Name: avvisi_risposte; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.avvisi_risposte ENABLE ROW LEVEL SECURITY;

--
-- Name: campanelle; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.campanelle ENABLE ROW LEVEL SECURITY;

--
-- Name: certificati_competenze; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.certificati_competenze ENABLE ROW LEVEL SECURITY;

--
-- Name: certificati_medici; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.certificati_medici ENABLE ROW LEVEL SECURITY;

--
-- Name: certificati_medici certificati_medici_staff_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY certificati_medici_staff_read ON public.certificati_medici FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND ((u.ruolo)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying, 'segreteria'::character varying, 'educator'::character varying])::text[]))))));


--
-- Name: certificato_competenza_livelli; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.certificato_competenza_livelli ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages chat_messages_select_participant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY chat_messages_select_participant ON public.chat_messages FOR SELECT TO authenticated USING ((thread_id IN ( SELECT chat_threads.id
   FROM public.chat_threads
  WHERE ((chat_threads.teacher_id = auth.uid()) OR (chat_threads.parent_id = auth.uid()) OR (chat_threads.parent_id IN ( SELECT parents.id
           FROM public.parents
          WHERE (parents.auth_user_id = auth.uid())))))));


--
-- Name: chat_threads; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_threads chat_threads_select_participant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY chat_threads_select_participant ON public.chat_threads FOR SELECT TO authenticated USING (((teacher_id = auth.uid()) OR (parent_id = auth.uid()) OR (parent_id IN ( SELECT parents.id
   FROM public.parents
  WHERE (parents.auth_user_id = auth.uid())))));


--
-- Name: delegates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.delegates ENABLE ROW LEVEL SECURITY;

--
-- Name: divise_articoli; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.divise_articoli ENABLE ROW LEVEL SECURITY;

--
-- Name: divise_ordini; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.divise_ordini ENABLE ROW LEVEL SECURITY;

--
-- Name: divise_ordini_righe; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.divise_ordini_righe ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollment_submissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.enrollment_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: eventi_agenda; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.eventi_agenda ENABLE ROW LEVEL SECURITY;

--
-- Name: eventi_diario; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.eventi_diario ENABLE ROW LEVEL SECURITY;

--
-- Name: fascicolo_accessi_audit; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.fascicolo_accessi_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: fatture_emesse; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.fatture_emesse ENABLE ROW LEVEL SECURITY;

--
-- Name: fatture_emesse fatture_emesse_staff_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fatture_emesse_staff_read ON public.fatture_emesse FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND ((u.ruolo)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying, 'segreteria'::character varying])::text[]))))));


--
-- Name: fatture_numerazione; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.fatture_numerazione ENABLE ROW LEVEL SECURITY;

--
-- Name: fea_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.fea_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: fea_signatures; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.fea_signatures ENABLE ROW LEVEL SECURITY;

--
-- Name: firme_docenti; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.firme_docenti ENABLE ROW LEVEL SECURITY;

--
-- Name: firme_documenti; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.firme_documenti ENABLE ROW LEVEL SECURITY;

--
-- Name: form_models fm_delete_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fm_delete_staff ON public.form_models FOR DELETE TO authenticated USING (public.is_staff_or_admin());


--
-- Name: form_models fm_insert_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fm_insert_staff ON public.form_models FOR INSERT TO authenticated WITH CHECK (public.is_staff_or_admin());


--
-- Name: form_models fm_select_active_authenticated; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fm_select_active_authenticated ON public.form_models FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: form_models fm_select_all_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fm_select_all_staff ON public.form_models FOR SELECT TO authenticated USING (public.is_staff_or_admin());


--
-- Name: form_models fm_update_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fm_update_staff ON public.form_models FOR UPDATE TO authenticated USING (public.is_staff_or_admin()) WITH CHECK (public.is_staff_or_admin());


--
-- Name: form_models; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.form_models ENABLE ROW LEVEL SECURITY;

--
-- Name: form_submissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.form_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: forms_submissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.forms_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: forms_templates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.forms_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: form_submissions fs_delete_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fs_delete_staff ON public.form_submissions FOR DELETE TO authenticated USING (public.is_staff_or_admin());


--
-- Name: form_submissions fs_insert_authenticated; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fs_insert_authenticated ON public.form_submissions FOR INSERT TO authenticated WITH CHECK (((auth.uid() IS NOT NULL) AND ((user_id = auth.uid()) OR (user_id IS NULL))));


--
-- Name: form_submissions fs_select_owner_or_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fs_select_owner_or_staff ON public.form_submissions FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_staff_or_admin()));


--
-- Name: form_submissions fs_update_owner_or_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY fs_update_owner_or_staff ON public.form_submissions FOR UPDATE TO authenticated USING (((user_id = auth.uid()) OR public.is_staff_or_admin())) WITH CHECK (((user_id = auth.uid()) OR public.is_staff_or_admin()));


--
-- Name: galleria_media; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.galleria_media ENABLE ROW LEVEL SECURITY;

--
-- Name: galleria_media_v2; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.galleria_media_v2 ENABLE ROW LEVEL SECURITY;

--
-- Name: giudizi_sintetici_scala; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.giudizi_sintetici_scala ENABLE ROW LEVEL SECURITY;

--
-- Name: giudizio_template; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.giudizio_template ENABLE ROW LEVEL SECURITY;

--
-- Name: giustifiche_didattiche; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.giustifiche_didattiche ENABLE ROW LEVEL SECURITY;

--
-- Name: gruppi_mensa; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.gruppi_mensa ENABLE ROW LEVEL SECURITY;

--
-- Name: incassi; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.incassi ENABLE ROW LEVEL SECURITY;

--
-- Name: legame_genitori_alunni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.legame_genitori_alunni ENABLE ROW LEVEL SECURITY;

--
-- Name: locker_config; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.locker_config ENABLE ROW LEVEL SECURITY;

--
-- Name: materie; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.materie ENABLE ROW LEVEL SECURITY;

--
-- Name: materie_preset; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.materie_preset ENABLE ROW LEVEL SECURITY;

--
-- Name: mensa_class_menu_assignment; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.mensa_class_menu_assignment ENABLE ROW LEVEL SECURITY;

--
-- Name: mensa_menu_config; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.mensa_menu_config ENABLE ROW LEVEL SECURITY;

--
-- Name: mensa_menu_override; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.mensa_menu_override ENABLE ROW LEVEL SECURITY;

--
-- Name: mensa_menu_rotazione; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.mensa_menu_rotazione ENABLE ROW LEVEL SECURITY;

--
-- Name: mensa_prenotazioni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.mensa_prenotazioni ENABLE ROW LEVEL SECURITY;

--
-- Name: nota_ricezioni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.nota_ricezioni ENABLE ROW LEVEL SECURITY;

--
-- Name: note_disciplinari; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.note_disciplinari ENABLE ROW LEVEL SECURITY;

--
-- Name: notifiche; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.notifiche ENABLE ROW LEVEL SECURITY;

--
-- Name: obiettivi_apprendimento; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.obiettivi_apprendimento ENABLE ROW LEVEL SECURITY;

--
-- Name: orario_settimanale; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.orario_settimanale ENABLE ROW LEVEL SECURITY;

--
-- Name: eventi_agenda own eventi agenda; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "own eventi agenda" ON public.eventi_agenda FOR SELECT TO authenticated USING ((creato_da = auth.uid()));


--
-- Name: notifiche own notifiche; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "own notifiche" ON public.notifiche FOR SELECT TO authenticated USING ((utente_id = auth.uid()));


--
-- Name: push_subscriptions own push sub; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "own push sub" ON public.push_subscriptions TO authenticated USING ((utente_id = auth.uid())) WITH CHECK ((utente_id = auth.uid()));


--
-- Name: pagamenti; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.pagamenti ENABLE ROW LEVEL SECURITY;

--
-- Name: pagamenti_quote; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.pagamenti_quote ENABLE ROW LEVEL SECURITY;

--
-- Name: pagella_ricezioni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.pagella_ricezioni ENABLE ROW LEVEL SECURITY;

--
-- Name: pagelle; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.pagelle ENABLE ROW LEVEL SECURITY;

--
-- Name: alunni parent read alunni figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read alunni figli (parents space)" ON public.alunni FOR SELECT TO authenticated USING ((id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)));


--
-- Name: eventi_diario parent read diario figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read diario figli (parents space)" ON public.eventi_diario FOR SELECT TO authenticated USING ((alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)));


--
-- Name: galleria_media_v2 parent read galleria figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read galleria figli (parents space)" ON public.galleria_media_v2 FOR SELECT TO authenticated USING (((is_broadcast = true) OR (tag_students && ARRAY( SELECT public.current_parent_student_ids() AS current_parent_student_ids))));


--
-- Name: incassi parent read incassi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read incassi" ON public.incassi FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.pagamenti p
  WHERE ((p.id = incassi.pagamento_id) AND (p.alunno_id IN ( SELECT legame_genitori_alunni.alunno_id
           FROM public.legame_genitori_alunni
          WHERE (legame_genitori_alunni.genitore_id = auth.uid()))) AND ((p.tipo <> 'split'::public.pagamento_tipo) OR (incassi.quota_id IN ( SELECT q.id
           FROM public.pagamenti_quote q
          WHERE ((q.pagamento_id = p.id) AND (q.adult_id = auth.uid())))))))));


--
-- Name: incassi parent read incassi figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read incassi figli (parents space)" ON public.incassi FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.pagamenti pg
  WHERE ((pg.id = incassi.pagamento_id) AND (pg.alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids))))));


--
-- Name: note_disciplinari parent read note figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read note figli (parents space)" ON public.note_disciplinari FOR SELECT TO authenticated USING ((alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)));


--
-- Name: pagamenti_quote parent read own quota; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read own quota" ON public.pagamenti_quote FOR SELECT TO authenticated USING ((adult_id = auth.uid()));


--
-- Name: pagamenti parent read pagamenti figli; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read pagamenti figli" ON public.pagamenti FOR SELECT TO authenticated USING (((alunno_id IN ( SELECT legame_genitori_alunni.alunno_id
   FROM public.legame_genitori_alunni
  WHERE (legame_genitori_alunni.genitore_id = auth.uid()))) AND ((tipo <> 'split'::public.pagamento_tipo) OR (EXISTS ( SELECT 1
   FROM public.pagamenti_quote q
  WHERE ((q.pagamento_id = pagamenti.id) AND (q.adult_id = auth.uid())))))));


--
-- Name: pagamenti parent read pagamenti figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read pagamenti figli (parents space)" ON public.pagamenti FOR SELECT TO authenticated USING ((alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)));


--
-- Name: presenze parent read presenze figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read presenze figli (parents space)" ON public.presenze FOR SELECT TO authenticated USING ((alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)));


--
-- Name: pagamenti_quote parent read quote figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read quote figli (parents space)" ON public.pagamenti_quote FOR SELECT TO authenticated USING ((pagamento_id IN ( SELECT pg.id
   FROM public.pagamenti pg
  WHERE (pg.alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)))));


--
-- Name: valutazioni parent read valutazioni figli (parents space); Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "parent read valutazioni figli (parents space)" ON public.valutazioni FOR SELECT TO authenticated USING (((alunno_id IN ( SELECT public.current_parent_student_ids() AS current_parent_student_ids)) AND (pubblicato = true)));


--
-- Name: parents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_categories; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.payment_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: presenze; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.presenze ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: allegati_registro read allegati_registro; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read allegati_registro" ON public.allegati_registro FOR SELECT TO authenticated USING (true);


--
-- Name: audit_scritture_docente read audit_scritture; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read audit_scritture" ON public.audit_scritture_docente FOR SELECT TO authenticated USING (true);


--
-- Name: campanelle read campanelle; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read campanelle" ON public.campanelle FOR SELECT TO authenticated USING (true);


--
-- Name: payment_categories read categories; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read categories" ON public.payment_categories FOR SELECT TO authenticated USING (true);


--
-- Name: fascicolo_accessi_audit read fascicolo_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read fascicolo_audit" ON public.fascicolo_accessi_audit FOR SELECT TO authenticated USING (true);


--
-- Name: fea_signatures read fea_signatures; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read fea_signatures" ON public.fea_signatures FOR SELECT TO authenticated USING (true);


--
-- Name: giudizi_sintetici_scala read giudizi_sintetici_scala; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read giudizi_sintetici_scala" ON public.giudizi_sintetici_scala FOR SELECT TO authenticated USING (true);


--
-- Name: giudizio_template read giudizio_template; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read giudizio_template" ON public.giudizio_template FOR SELECT TO authenticated USING (true);


--
-- Name: giustifiche_didattiche read giustifiche_didattiche; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read giustifiche_didattiche" ON public.giustifiche_didattiche FOR SELECT TO authenticated USING (true);


--
-- Name: materie read materie; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read materie" ON public.materie FOR SELECT TO authenticated USING (true);


--
-- Name: materie_preset read materie_preset; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read materie_preset" ON public.materie_preset FOR SELECT TO authenticated USING (true);


--
-- Name: mensa_menu_override read mensa override; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read mensa override" ON public.mensa_menu_override FOR SELECT TO authenticated USING (true);


--
-- Name: mensa_menu_rotazione read mensa rotazione; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read mensa rotazione" ON public.mensa_menu_rotazione FOR SELECT TO authenticated USING (true);


--
-- Name: nota_ricezioni read nota_ricezioni; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read nota_ricezioni" ON public.nota_ricezioni FOR SELECT TO authenticated USING (true);


--
-- Name: obiettivi_apprendimento read obiettivi_apprendimento; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read obiettivi_apprendimento" ON public.obiettivi_apprendimento FOR SELECT TO authenticated USING (true);


--
-- Name: orario_settimanale read orario_settimanale; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read orario_settimanale" ON public.orario_settimanale FOR SELECT TO authenticated USING (true);


--
-- Name: pagella_ricezioni read pagella_ricezioni; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read pagella_ricezioni" ON public.pagella_ricezioni FOR SELECT TO authenticated USING (true);


--
-- Name: pagelle read pagelle; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read pagelle" ON public.pagelle FOR SELECT TO authenticated USING (true);


--
-- Name: registro_destinatari read registro_destinatari; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read registro_destinatari" ON public.registro_destinatari FOR SELECT TO authenticated USING (true);


--
-- Name: sblocchi_audit read sblocchi_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read sblocchi_audit" ON public.sblocchi_audit FOR SELECT TO authenticated USING (true);


--
-- Name: scrutini read scrutini; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read scrutini" ON public.scrutini FOR SELECT TO authenticated USING (true);


--
-- Name: scrutinio_comportamento read scrutinio_comportamento; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read scrutinio_comportamento" ON public.scrutinio_comportamento FOR SELECT TO authenticated USING (true);


--
-- Name: scrutinio_giudizi read scrutinio_giudizi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read scrutinio_giudizi" ON public.scrutinio_giudizi FOR SELECT TO authenticated USING (true);


--
-- Name: scrutinio_giudizio_descrittivo read scrutinio_giudizio_descrittivo; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo FOR SELECT TO authenticated USING (true);


--
-- Name: scrutinio_periodi read scrutinio_periodi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read scrutinio_periodi" ON public.scrutinio_periodi FOR SELECT TO authenticated USING (true);


--
-- Name: sezione_materia_obiettivo read sezione_materia_obiettivo; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo FOR SELECT TO authenticated USING (true);


--
-- Name: student_documents read student_documents; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read student_documents" ON public.student_documents FOR SELECT TO authenticated USING (true);


--
-- Name: tempo_scuola read tempo_scuola; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read tempo_scuola" ON public.tempo_scuola FOR SELECT TO authenticated USING (true);


--
-- Name: utenti_scuole read utenti_scuole; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read utenti_scuole" ON public.utenti_scuole FOR SELECT TO authenticated USING (true);


--
-- Name: utenti_sezioni read utenti_sezioni; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read utenti_sezioni" ON public.utenti_sezioni FOR SELECT TO authenticated USING (true);


--
-- Name: utenti_sezioni_materie read utenti_sezioni_materie; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read utenti_sezioni_materie" ON public.utenti_sezioni_materie FOR SELECT TO authenticated USING (true);


--
-- Name: valutazione_obiettivi read valutazione_obiettivi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "read valutazione_obiettivi" ON public.valutazione_obiettivi FOR SELECT TO authenticated USING (true);


--
-- Name: registro_destinatari; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.registro_destinatari ENABLE ROW LEVEL SECURITY;

--
-- Name: registro_modifiche; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.registro_modifiche ENABLE ROW LEVEL SECURITY;

--
-- Name: registro_orario; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.registro_orario ENABLE ROW LEVEL SECURITY;

--
-- Name: sblocchi_audit; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sblocchi_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: schools; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

--
-- Name: scrutini; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.scrutini ENABLE ROW LEVEL SECURITY;

--
-- Name: scrutinio_comportamento; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.scrutinio_comportamento ENABLE ROW LEVEL SECURITY;

--
-- Name: scrutinio_giudizi; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.scrutinio_giudizi ENABLE ROW LEVEL SECURITY;

--
-- Name: scrutinio_giudizio_descrittivo; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.scrutinio_giudizio_descrittivo ENABLE ROW LEVEL SECURITY;

--
-- Name: scrutinio_periodi; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.scrutinio_periodi ENABLE ROW LEVEL SECURITY;

--
-- Name: scuole; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.scuole ENABLE ROW LEVEL SECURITY;

--
-- Name: sections; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;

--
-- Name: allegati_registro service allegati_registro; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service allegati_registro" ON public.allegati_registro TO service_role USING (true) WITH CHECK (true);


--
-- Name: campanelle service campanelle; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service campanelle" ON public.campanelle TO service_role USING (true) WITH CHECK (true);


--
-- Name: payment_categories service categories; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service categories" ON public.payment_categories TO service_role USING (true) WITH CHECK (true);


--
-- Name: divise_articoli service divise_articoli; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service divise_articoli" ON public.divise_articoli TO service_role USING (true) WITH CHECK (true);


--
-- Name: divise_ordini service divise_ordini; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service divise_ordini" ON public.divise_ordini TO service_role USING (true) WITH CHECK (true);


--
-- Name: divise_ordini_righe service divise_ordini_righe; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service divise_ordini_righe" ON public.divise_ordini_righe TO service_role USING (true) WITH CHECK (true);


--
-- Name: eventi_agenda service eventi agenda; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service eventi agenda" ON public.eventi_agenda TO service_role USING (true) WITH CHECK (true);


--
-- Name: fea_signatures service fea_signatures; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service fea_signatures" ON public.fea_signatures TO service_role USING (true) WITH CHECK (true);


--
-- Name: giudizi_sintetici_scala service giudizi_sintetici_scala; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service giudizi_sintetici_scala" ON public.giudizi_sintetici_scala TO service_role USING (true) WITH CHECK (true);


--
-- Name: giudizio_template service giudizio_template; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service giudizio_template" ON public.giudizio_template TO service_role USING (true) WITH CHECK (true);


--
-- Name: giustifiche_didattiche service giustifiche_didattiche; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service giustifiche_didattiche" ON public.giustifiche_didattiche TO service_role USING (true) WITH CHECK (true);


--
-- Name: incassi service incassi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service incassi" ON public.incassi TO service_role USING (true) WITH CHECK (true);


--
-- Name: audit_scritture_docente service insert audit_scritture; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service insert audit_scritture" ON public.audit_scritture_docente FOR INSERT TO service_role WITH CHECK (true);


--
-- Name: fascicolo_accessi_audit service insert fascicolo_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service insert fascicolo_audit" ON public.fascicolo_accessi_audit FOR INSERT TO service_role WITH CHECK (true);


--
-- Name: fea_audit_log service insert fea_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service insert fea_audit" ON public.fea_audit_log FOR INSERT TO service_role WITH CHECK (true);


--
-- Name: materie service materie; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service materie" ON public.materie TO service_role USING (true) WITH CHECK (true);


--
-- Name: materie_preset service materie_preset; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service materie_preset" ON public.materie_preset TO service_role USING (true) WITH CHECK (true);


--
-- Name: mensa_menu_override service mensa override; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service mensa override" ON public.mensa_menu_override TO service_role USING (true) WITH CHECK (true);


--
-- Name: mensa_prenotazioni service mensa pren; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service mensa pren" ON public.mensa_prenotazioni TO service_role USING (true) WITH CHECK (true);


--
-- Name: mensa_menu_rotazione service mensa rotazione; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service mensa rotazione" ON public.mensa_menu_rotazione TO service_role USING (true) WITH CHECK (true);


--
-- Name: nota_ricezioni service nota_ricezioni; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service nota_ricezioni" ON public.nota_ricezioni TO service_role USING (true) WITH CHECK (true);


--
-- Name: notifiche service notifiche; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service notifiche" ON public.notifiche TO service_role USING (true) WITH CHECK (true);


--
-- Name: obiettivi_apprendimento service obiettivi_apprendimento; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service obiettivi_apprendimento" ON public.obiettivi_apprendimento TO service_role USING (true) WITH CHECK (true);


--
-- Name: orario_settimanale service orario_settimanale; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service orario_settimanale" ON public.orario_settimanale TO service_role USING (true) WITH CHECK (true);


--
-- Name: pagamenti service pagamenti; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service pagamenti" ON public.pagamenti TO service_role USING (true) WITH CHECK (true);


--
-- Name: pagella_ricezioni service pagella_ricezioni; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service pagella_ricezioni" ON public.pagella_ricezioni TO service_role USING (true) WITH CHECK (true);


--
-- Name: pagelle service pagelle; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service pagelle" ON public.pagelle TO service_role USING (true) WITH CHECK (true);


--
-- Name: push_subscriptions service push sub; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service push sub" ON public.push_subscriptions TO service_role USING (true) WITH CHECK (true);


--
-- Name: pagamenti_quote service quote; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service quote" ON public.pagamenti_quote TO service_role USING (true) WITH CHECK (true);


--
-- Name: audit_scritture_docente service read audit_scritture; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service read audit_scritture" ON public.audit_scritture_docente FOR SELECT TO service_role USING (true);


--
-- Name: fascicolo_accessi_audit service read fascicolo_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service read fascicolo_audit" ON public.fascicolo_accessi_audit FOR SELECT TO service_role USING (true);


--
-- Name: fea_audit_log service read fea_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service read fea_audit" ON public.fea_audit_log FOR SELECT TO service_role USING (true);


--
-- Name: registro_destinatari service registro_destinatari; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service registro_destinatari" ON public.registro_destinatari TO service_role USING (true) WITH CHECK (true);


--
-- Name: sblocchi_audit service sblocchi_audit; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service sblocchi_audit" ON public.sblocchi_audit TO service_role USING (true) WITH CHECK (true);


--
-- Name: scrutini service scrutini; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service scrutini" ON public.scrutini TO service_role USING (true) WITH CHECK (true);


--
-- Name: scrutinio_comportamento service scrutinio_comportamento; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service scrutinio_comportamento" ON public.scrutinio_comportamento TO service_role USING (true) WITH CHECK (true);


--
-- Name: scrutinio_giudizi service scrutinio_giudizi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service scrutinio_giudizi" ON public.scrutinio_giudizi TO service_role USING (true) WITH CHECK (true);


--
-- Name: scrutinio_giudizio_descrittivo service scrutinio_giudizio_descrittivo; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo TO service_role USING (true) WITH CHECK (true);


--
-- Name: scrutinio_periodi service scrutinio_periodi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service scrutinio_periodi" ON public.scrutinio_periodi TO service_role USING (true) WITH CHECK (true);


--
-- Name: admin_settings service settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service settings" ON public.admin_settings TO service_role USING (true) WITH CHECK (true);


--
-- Name: sezione_materia_obiettivo service sezione_materia_obiettivo; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service sezione_materia_obiettivo" ON public.sezione_materia_obiettivo TO service_role USING (true) WITH CHECK (true);


--
-- Name: student_documents service student_documents; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service student_documents" ON public.student_documents TO service_role USING (true) WITH CHECK (true);


--
-- Name: tempo_scuola service tempo_scuola; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service tempo_scuola" ON public.tempo_scuola TO service_role USING (true) WITH CHECK (true);


--
-- Name: utenti_scuole service utenti_scuole; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service utenti_scuole" ON public.utenti_scuole TO service_role USING (true) WITH CHECK (true);


--
-- Name: utenti_sezioni service utenti_sezioni; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service utenti_sezioni" ON public.utenti_sezioni TO service_role USING (true) WITH CHECK (true);


--
-- Name: utenti_sezioni_materie service utenti_sezioni_materie; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service utenti_sezioni_materie" ON public.utenti_sezioni_materie TO service_role USING (true) WITH CHECK (true);


--
-- Name: valutazione_obiettivi service valutazione_obiettivi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "service valutazione_obiettivi" ON public.valutazione_obiettivi TO service_role USING (true) WITH CHECK (true);


--
-- Name: locker_config service_role_locker_config; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY service_role_locker_config ON public.locker_config TO service_role USING (true) WITH CHECK (true);


--
-- Name: sezione_materia_obiettivo; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sezione_materia_obiettivo ENABLE ROW LEVEL SECURITY;

--
-- Name: sidi_import_batches; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sidi_import_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: sidi_sync_state; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sidi_sync_state ENABLE ROW LEVEL SECURITY;

--
-- Name: incassi staff full incassi; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff full incassi" ON public.incassi TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: pagamenti staff full pagamenti; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff full pagamenti" ON public.pagamenti TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: pagamenti_quote staff full quote; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff full quote" ON public.pagamenti_quote TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: admin_settings staff full settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff full settings" ON public.admin_settings TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: eventi_agenda staff read eventi agenda; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff read eventi agenda" ON public.eventi_agenda FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: notifiche staff read notifiche; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff read notifiche" ON public.notifiche FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: payment_categories staff write categories; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff write categories" ON public.payment_categories TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.utenti u
  WHERE ((u.id = auth.uid()) AND ((u.role)::text = ANY ((ARRAY['admin'::character varying, 'coordinator'::character varying])::text[]))))));


--
-- Name: student_documents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.student_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: student_parents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.student_parents ENABLE ROW LEVEL SECURITY;

--
-- Name: task_interni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.task_interni ENABLE ROW LEVEL SECURITY;

--
-- Name: tempo_scuola; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tempo_scuola ENABLE ROW LEVEL SECURITY;

--
-- Name: test_table; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.test_table ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_mensa; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.ticket_mensa ENABLE ROW LEVEL SECURITY;

--
-- Name: utenti; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.utenti ENABLE ROW LEVEL SECURITY;

--
-- Name: utenti_scuole; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.utenti_scuole ENABLE ROW LEVEL SECURITY;

--
-- Name: utenti_sezioni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.utenti_sezioni ENABLE ROW LEVEL SECURITY;

--
-- Name: utenti_sezioni_materie; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.utenti_sezioni_materie ENABLE ROW LEVEL SECURITY;

--
-- Name: valutazione_obiettivi; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.valutazione_obiettivi ENABLE ROW LEVEL SECURITY;

--
-- Name: valutazioni; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.valutazioni ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION calc_form_base_score(p_schema jsonb, p_data jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.calc_form_base_score(p_schema jsonb, p_data jsonb) TO anon;
GRANT ALL ON FUNCTION public.calc_form_base_score(p_schema jsonb, p_data jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.calc_form_base_score(p_schema jsonb, p_data jsonb) TO service_role;


--
-- Name: FUNCTION calc_manual_delta(p_adjustments jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.calc_manual_delta(p_adjustments jsonb) TO anon;
GRANT ALL ON FUNCTION public.calc_manual_delta(p_adjustments jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.calc_manual_delta(p_adjustments jsonb) TO service_role;


--
-- Name: FUNCTION crea_quote_da_config(p_pagamento_id uuid, p_alunno_id uuid, p_importo numeric, p_config jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.crea_quote_da_config(p_pagamento_id uuid, p_alunno_id uuid, p_importo numeric, p_config jsonb) TO anon;
GRANT ALL ON FUNCTION public.crea_quote_da_config(p_pagamento_id uuid, p_alunno_id uuid, p_importo numeric, p_config jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.crea_quote_da_config(p_pagamento_id uuid, p_alunno_id uuid, p_importo numeric, p_config jsonb) TO service_role;


--
-- Name: FUNCTION current_parent_student_ids(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.current_parent_student_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_parent_student_ids() TO authenticated;
GRANT ALL ON FUNCTION public.current_parent_student_ids() TO service_role;


--
-- Name: FUNCTION exec_sql(sql text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.exec_sql(sql text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.exec_sql(sql text) TO service_role;


--
-- Name: FUNCTION fatture_sdi_sync_tick(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.fatture_sdi_sync_tick() FROM PUBLIC;
GRANT ALL ON FUNCTION public.fatture_sdi_sync_tick() TO service_role;


--
-- Name: FUNCTION fn_form_submission_etl(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.fn_form_submission_etl() TO anon;
GRANT ALL ON FUNCTION public.fn_form_submission_etl() TO authenticated;
GRANT ALL ON FUNCTION public.fn_form_submission_etl() TO service_role;


--
-- Name: FUNCTION fn_form_submission_score(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.fn_form_submission_score() TO anon;
GRANT ALL ON FUNCTION public.fn_form_submission_score() TO authenticated;
GRANT ALL ON FUNCTION public.fn_form_submission_score() TO service_role;


--
-- Name: FUNCTION genera_rette_anno(p_anno_inizio integer); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.genera_rette_anno(p_anno_inizio integer) TO anon;
GRANT ALL ON FUNCTION public.genera_rette_anno(p_anno_inizio integer) TO authenticated;
GRANT ALL ON FUNCTION public.genera_rette_anno(p_anno_inizio integer) TO service_role;


--
-- Name: FUNCTION genera_rette_mensili(p_periodo date); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.genera_rette_mensili(p_periodo date) TO anon;
GRANT ALL ON FUNCTION public.genera_rette_mensili(p_periodo date) TO authenticated;
GRANT ALL ON FUNCTION public.genera_rette_mensili(p_periodo date) TO service_role;


--
-- Name: FUNCTION genera_solleciti(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.genera_solleciti() TO anon;
GRANT ALL ON FUNCTION public.genera_solleciti() TO authenticated;
GRANT ALL ON FUNCTION public.genera_solleciti() TO service_role;


--
-- Name: FUNCTION is_staff_or_admin(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.is_staff_or_admin() TO anon;
GRANT ALL ON FUNCTION public.is_staff_or_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_staff_or_admin() TO service_role;


--
-- Name: FUNCTION mensa_check_allergie_giornaliero(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.mensa_check_allergie_giornaliero() TO anon;
GRANT ALL ON FUNCTION public.mensa_check_allergie_giornaliero() TO authenticated;
GRANT ALL ON FUNCTION public.mensa_check_allergie_giornaliero() TO service_role;


--
-- Name: FUNCTION notifiche_dispatch_tick(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.notifiche_dispatch_tick() TO anon;
GRANT ALL ON FUNCTION public.notifiche_dispatch_tick() TO authenticated;
GRANT ALL ON FUNCTION public.notifiche_dispatch_tick() TO service_role;


--
-- Name: FUNCTION prossimo_numero_fattura(p_scuola uuid, p_anno integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.prossimo_numero_fattura(p_scuola uuid, p_anno integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prossimo_numero_fattura(p_scuola uuid, p_anno integer) TO service_role;


--
-- Name: FUNCTION ricalcola_stato_padre(p_parent uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.ricalcola_stato_padre(p_parent uuid) TO anon;
GRANT ALL ON FUNCTION public.ricalcola_stato_padre(p_parent uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ricalcola_stato_padre(p_parent uuid) TO service_role;


--
-- Name: FUNCTION ricalcola_stato_pagamento(p_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.ricalcola_stato_pagamento(p_id uuid) TO anon;
GRANT ALL ON FUNCTION public.ricalcola_stato_pagamento(p_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ricalcola_stato_pagamento(p_id uuid) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION sync_alunno_section_id(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.sync_alunno_section_id() TO anon;
GRANT ALL ON FUNCTION public.sync_alunno_section_id() TO authenticated;
GRANT ALL ON FUNCTION public.sync_alunno_section_id() TO service_role;


--
-- Name: FUNCTION trg_incassi_ricalcola(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.trg_incassi_ricalcola() TO anon;
GRANT ALL ON FUNCTION public.trg_incassi_ricalcola() TO authenticated;
GRANT ALL ON FUNCTION public.trg_incassi_ricalcola() TO service_role;


--
-- Name: TABLE admin_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.admin_settings TO anon;
GRANT ALL ON TABLE public.admin_settings TO authenticated;
GRANT ALL ON TABLE public.admin_settings TO service_role;


--
-- Name: TABLE allegati_registro; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.allegati_registro TO anon;
GRANT ALL ON TABLE public.allegati_registro TO authenticated;
GRANT ALL ON TABLE public.allegati_registro TO service_role;


--
-- Name: TABLE alunni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.alunni TO anon;
GRANT ALL ON TABLE public.alunni TO authenticated;
GRANT ALL ON TABLE public.alunni TO service_role;


--
-- Name: TABLE armadietto; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.armadietto TO anon;
GRANT ALL ON TABLE public.armadietto TO authenticated;
GRANT ALL ON TABLE public.armadietto TO service_role;


--
-- Name: TABLE audit_scritture_docente; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.audit_scritture_docente TO anon;
GRANT ALL ON TABLE public.audit_scritture_docente TO authenticated;
GRANT ALL ON TABLE public.audit_scritture_docente TO service_role;


--
-- Name: TABLE avvisi; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.avvisi TO anon;
GRANT ALL ON TABLE public.avvisi TO authenticated;
GRANT ALL ON TABLE public.avvisi TO service_role;


--
-- Name: TABLE avvisi_risposte; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.avvisi_risposte TO anon;
GRANT ALL ON TABLE public.avvisi_risposte TO authenticated;
GRANT ALL ON TABLE public.avvisi_risposte TO service_role;


--
-- Name: TABLE campanelle; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.campanelle TO anon;
GRANT ALL ON TABLE public.campanelle TO authenticated;
GRANT ALL ON TABLE public.campanelle TO service_role;


--
-- Name: TABLE certificati_competenze; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.certificati_competenze TO anon;
GRANT ALL ON TABLE public.certificati_competenze TO authenticated;
GRANT ALL ON TABLE public.certificati_competenze TO service_role;


--
-- Name: TABLE certificati_medici; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.certificati_medici TO anon;
GRANT ALL ON TABLE public.certificati_medici TO authenticated;
GRANT ALL ON TABLE public.certificati_medici TO service_role;


--
-- Name: TABLE certificato_competenza_livelli; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.certificato_competenza_livelli TO anon;
GRANT ALL ON TABLE public.certificato_competenza_livelli TO authenticated;
GRANT ALL ON TABLE public.certificato_competenza_livelli TO service_role;


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.chat_messages TO anon;
GRANT ALL ON TABLE public.chat_messages TO authenticated;
GRANT ALL ON TABLE public.chat_messages TO service_role;


--
-- Name: TABLE chat_threads; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.chat_threads TO anon;
GRANT ALL ON TABLE public.chat_threads TO authenticated;
GRANT ALL ON TABLE public.chat_threads TO service_role;


--
-- Name: TABLE delegates; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.delegates TO anon;
GRANT ALL ON TABLE public.delegates TO authenticated;
GRANT ALL ON TABLE public.delegates TO service_role;


--
-- Name: TABLE divise_articoli; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.divise_articoli TO anon;
GRANT ALL ON TABLE public.divise_articoli TO authenticated;
GRANT ALL ON TABLE public.divise_articoli TO service_role;


--
-- Name: TABLE divise_ordini; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.divise_ordini TO anon;
GRANT ALL ON TABLE public.divise_ordini TO authenticated;
GRANT ALL ON TABLE public.divise_ordini TO service_role;


--
-- Name: TABLE divise_ordini_righe; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.divise_ordini_righe TO anon;
GRANT ALL ON TABLE public.divise_ordini_righe TO authenticated;
GRANT ALL ON TABLE public.divise_ordini_righe TO service_role;


--
-- Name: TABLE enrollment_submissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.enrollment_submissions TO anon;
GRANT ALL ON TABLE public.enrollment_submissions TO authenticated;
GRANT ALL ON TABLE public.enrollment_submissions TO service_role;


--
-- Name: TABLE eventi_agenda; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.eventi_agenda TO anon;
GRANT ALL ON TABLE public.eventi_agenda TO authenticated;
GRANT ALL ON TABLE public.eventi_agenda TO service_role;


--
-- Name: TABLE eventi_diario; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.eventi_diario TO anon;
GRANT ALL ON TABLE public.eventi_diario TO authenticated;
GRANT ALL ON TABLE public.eventi_diario TO service_role;


--
-- Name: TABLE fascicolo_accessi_audit; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.fascicolo_accessi_audit TO anon;
GRANT ALL ON TABLE public.fascicolo_accessi_audit TO authenticated;
GRANT ALL ON TABLE public.fascicolo_accessi_audit TO service_role;


--
-- Name: TABLE fatture_emesse; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.fatture_emesse TO anon;
GRANT ALL ON TABLE public.fatture_emesse TO authenticated;
GRANT ALL ON TABLE public.fatture_emesse TO service_role;


--
-- Name: TABLE fatture_numerazione; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.fatture_numerazione TO anon;
GRANT ALL ON TABLE public.fatture_numerazione TO authenticated;
GRANT ALL ON TABLE public.fatture_numerazione TO service_role;


--
-- Name: TABLE fea_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.fea_audit_log TO anon;
GRANT ALL ON TABLE public.fea_audit_log TO authenticated;
GRANT ALL ON TABLE public.fea_audit_log TO service_role;


--
-- Name: TABLE fea_signatures; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.fea_signatures TO anon;
GRANT ALL ON TABLE public.fea_signatures TO authenticated;
GRANT ALL ON TABLE public.fea_signatures TO service_role;


--
-- Name: TABLE firme_docenti; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.firme_docenti TO anon;
GRANT ALL ON TABLE public.firme_docenti TO authenticated;
GRANT ALL ON TABLE public.firme_docenti TO service_role;


--
-- Name: TABLE firme_documenti; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.firme_documenti TO anon;
GRANT ALL ON TABLE public.firme_documenti TO authenticated;
GRANT ALL ON TABLE public.firme_documenti TO service_role;


--
-- Name: TABLE form_models; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.form_models TO anon;
GRANT ALL ON TABLE public.form_models TO authenticated;
GRANT ALL ON TABLE public.form_models TO service_role;


--
-- Name: TABLE form_submissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.form_submissions TO anon;
GRANT ALL ON TABLE public.form_submissions TO authenticated;
GRANT ALL ON TABLE public.form_submissions TO service_role;


--
-- Name: TABLE forms_submissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.forms_submissions TO anon;
GRANT ALL ON TABLE public.forms_submissions TO authenticated;
GRANT ALL ON TABLE public.forms_submissions TO service_role;


--
-- Name: TABLE forms_templates; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.forms_templates TO anon;
GRANT ALL ON TABLE public.forms_templates TO authenticated;
GRANT ALL ON TABLE public.forms_templates TO service_role;


--
-- Name: TABLE galleria_media; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.galleria_media TO anon;
GRANT ALL ON TABLE public.galleria_media TO authenticated;
GRANT ALL ON TABLE public.galleria_media TO service_role;


--
-- Name: TABLE galleria_media_v2; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.galleria_media_v2 TO anon;
GRANT ALL ON TABLE public.galleria_media_v2 TO authenticated;
GRANT ALL ON TABLE public.galleria_media_v2 TO service_role;


--
-- Name: TABLE giudizi_sintetici_scala; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.giudizi_sintetici_scala TO anon;
GRANT ALL ON TABLE public.giudizi_sintetici_scala TO authenticated;
GRANT ALL ON TABLE public.giudizi_sintetici_scala TO service_role;


--
-- Name: TABLE giudizio_template; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.giudizio_template TO anon;
GRANT ALL ON TABLE public.giudizio_template TO authenticated;
GRANT ALL ON TABLE public.giudizio_template TO service_role;


--
-- Name: TABLE giustifiche_didattiche; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.giustifiche_didattiche TO anon;
GRANT ALL ON TABLE public.giustifiche_didattiche TO authenticated;
GRANT ALL ON TABLE public.giustifiche_didattiche TO service_role;


--
-- Name: TABLE gruppi_mensa; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.gruppi_mensa TO anon;
GRANT ALL ON TABLE public.gruppi_mensa TO authenticated;
GRANT ALL ON TABLE public.gruppi_mensa TO service_role;


--
-- Name: TABLE incassi; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.incassi TO anon;
GRANT ALL ON TABLE public.incassi TO authenticated;
GRANT ALL ON TABLE public.incassi TO service_role;


--
-- Name: TABLE legame_genitori_alunni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.legame_genitori_alunni TO anon;
GRANT ALL ON TABLE public.legame_genitori_alunni TO authenticated;
GRANT ALL ON TABLE public.legame_genitori_alunni TO service_role;


--
-- Name: TABLE locker_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.locker_config TO anon;
GRANT ALL ON TABLE public.locker_config TO authenticated;
GRANT ALL ON TABLE public.locker_config TO service_role;


--
-- Name: TABLE materie; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.materie TO anon;
GRANT ALL ON TABLE public.materie TO authenticated;
GRANT ALL ON TABLE public.materie TO service_role;


--
-- Name: TABLE materie_preset; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.materie_preset TO anon;
GRANT ALL ON TABLE public.materie_preset TO authenticated;
GRANT ALL ON TABLE public.materie_preset TO service_role;


--
-- Name: TABLE mensa_class_menu_assignment; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.mensa_class_menu_assignment TO anon;
GRANT ALL ON TABLE public.mensa_class_menu_assignment TO authenticated;
GRANT ALL ON TABLE public.mensa_class_menu_assignment TO service_role;


--
-- Name: TABLE mensa_menu_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.mensa_menu_config TO anon;
GRANT ALL ON TABLE public.mensa_menu_config TO authenticated;
GRANT ALL ON TABLE public.mensa_menu_config TO service_role;


--
-- Name: TABLE mensa_menu_override; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.mensa_menu_override TO anon;
GRANT ALL ON TABLE public.mensa_menu_override TO authenticated;
GRANT ALL ON TABLE public.mensa_menu_override TO service_role;


--
-- Name: TABLE mensa_menu_rotazione; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.mensa_menu_rotazione TO anon;
GRANT ALL ON TABLE public.mensa_menu_rotazione TO authenticated;
GRANT ALL ON TABLE public.mensa_menu_rotazione TO service_role;


--
-- Name: TABLE mensa_prenotazioni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.mensa_prenotazioni TO anon;
GRANT ALL ON TABLE public.mensa_prenotazioni TO authenticated;
GRANT ALL ON TABLE public.mensa_prenotazioni TO service_role;


--
-- Name: TABLE nota_ricezioni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.nota_ricezioni TO anon;
GRANT ALL ON TABLE public.nota_ricezioni TO authenticated;
GRANT ALL ON TABLE public.nota_ricezioni TO service_role;


--
-- Name: TABLE note_disciplinari; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.note_disciplinari TO anon;
GRANT ALL ON TABLE public.note_disciplinari TO authenticated;
GRANT ALL ON TABLE public.note_disciplinari TO service_role;


--
-- Name: TABLE notifiche; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.notifiche TO anon;
GRANT ALL ON TABLE public.notifiche TO authenticated;
GRANT ALL ON TABLE public.notifiche TO service_role;


--
-- Name: TABLE obiettivi_apprendimento; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.obiettivi_apprendimento TO anon;
GRANT ALL ON TABLE public.obiettivi_apprendimento TO authenticated;
GRANT ALL ON TABLE public.obiettivi_apprendimento TO service_role;


--
-- Name: TABLE orario_settimanale; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.orario_settimanale TO anon;
GRANT ALL ON TABLE public.orario_settimanale TO authenticated;
GRANT ALL ON TABLE public.orario_settimanale TO service_role;


--
-- Name: TABLE pagamenti; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.pagamenti TO anon;
GRANT ALL ON TABLE public.pagamenti TO authenticated;
GRANT ALL ON TABLE public.pagamenti TO service_role;


--
-- Name: TABLE pagamenti_quote; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.pagamenti_quote TO anon;
GRANT ALL ON TABLE public.pagamenti_quote TO authenticated;
GRANT ALL ON TABLE public.pagamenti_quote TO service_role;


--
-- Name: TABLE pagella_ricezioni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.pagella_ricezioni TO anon;
GRANT ALL ON TABLE public.pagella_ricezioni TO authenticated;
GRANT ALL ON TABLE public.pagella_ricezioni TO service_role;


--
-- Name: TABLE pagelle; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.pagelle TO anon;
GRANT ALL ON TABLE public.pagelle TO authenticated;
GRANT ALL ON TABLE public.pagelle TO service_role;


--
-- Name: TABLE parents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.parents TO anon;
GRANT ALL ON TABLE public.parents TO authenticated;
GRANT ALL ON TABLE public.parents TO service_role;


--
-- Name: TABLE payment_categories; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.payment_categories TO anon;
GRANT ALL ON TABLE public.payment_categories TO authenticated;
GRANT ALL ON TABLE public.payment_categories TO service_role;


--
-- Name: TABLE presenze; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.presenze TO anon;
GRANT ALL ON TABLE public.presenze TO authenticated;
GRANT ALL ON TABLE public.presenze TO service_role;


--
-- Name: TABLE push_subscriptions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.push_subscriptions TO anon;
GRANT ALL ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;


--
-- Name: TABLE registro_destinatari; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.registro_destinatari TO anon;
GRANT ALL ON TABLE public.registro_destinatari TO authenticated;
GRANT ALL ON TABLE public.registro_destinatari TO service_role;


--
-- Name: TABLE registro_modifiche; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.registro_modifiche TO anon;
GRANT ALL ON TABLE public.registro_modifiche TO authenticated;
GRANT ALL ON TABLE public.registro_modifiche TO service_role;


--
-- Name: SEQUENCE registro_modifiche_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.registro_modifiche_id_seq TO anon;
GRANT ALL ON SEQUENCE public.registro_modifiche_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.registro_modifiche_id_seq TO service_role;


--
-- Name: TABLE registro_orario; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.registro_orario TO anon;
GRANT ALL ON TABLE public.registro_orario TO authenticated;
GRANT ALL ON TABLE public.registro_orario TO service_role;


--
-- Name: TABLE sblocchi_audit; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sblocchi_audit TO anon;
GRANT ALL ON TABLE public.sblocchi_audit TO authenticated;
GRANT ALL ON TABLE public.sblocchi_audit TO service_role;


--
-- Name: TABLE schools; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.schools TO anon;
GRANT ALL ON TABLE public.schools TO authenticated;
GRANT ALL ON TABLE public.schools TO service_role;


--
-- Name: TABLE scrutini; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.scrutini TO anon;
GRANT ALL ON TABLE public.scrutini TO authenticated;
GRANT ALL ON TABLE public.scrutini TO service_role;


--
-- Name: TABLE scrutinio_comportamento; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.scrutinio_comportamento TO anon;
GRANT ALL ON TABLE public.scrutinio_comportamento TO authenticated;
GRANT ALL ON TABLE public.scrutinio_comportamento TO service_role;


--
-- Name: TABLE scrutinio_giudizi; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.scrutinio_giudizi TO anon;
GRANT ALL ON TABLE public.scrutinio_giudizi TO authenticated;
GRANT ALL ON TABLE public.scrutinio_giudizi TO service_role;


--
-- Name: TABLE scrutinio_giudizio_descrittivo; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.scrutinio_giudizio_descrittivo TO anon;
GRANT ALL ON TABLE public.scrutinio_giudizio_descrittivo TO authenticated;
GRANT ALL ON TABLE public.scrutinio_giudizio_descrittivo TO service_role;


--
-- Name: TABLE scrutinio_periodi; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.scrutinio_periodi TO anon;
GRANT ALL ON TABLE public.scrutinio_periodi TO authenticated;
GRANT ALL ON TABLE public.scrutinio_periodi TO service_role;


--
-- Name: TABLE scuole; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.scuole TO anon;
GRANT ALL ON TABLE public.scuole TO authenticated;
GRANT ALL ON TABLE public.scuole TO service_role;


--
-- Name: TABLE sections; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sections TO anon;
GRANT ALL ON TABLE public.sections TO authenticated;
GRANT ALL ON TABLE public.sections TO service_role;


--
-- Name: TABLE sezione_materia_obiettivo; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sezione_materia_obiettivo TO anon;
GRANT ALL ON TABLE public.sezione_materia_obiettivo TO authenticated;
GRANT ALL ON TABLE public.sezione_materia_obiettivo TO service_role;


--
-- Name: TABLE sidi_import_batches; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sidi_import_batches TO anon;
GRANT ALL ON TABLE public.sidi_import_batches TO authenticated;
GRANT ALL ON TABLE public.sidi_import_batches TO service_role;


--
-- Name: TABLE sidi_sync_state; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sidi_sync_state TO anon;
GRANT ALL ON TABLE public.sidi_sync_state TO authenticated;
GRANT ALL ON TABLE public.sidi_sync_state TO service_role;


--
-- Name: TABLE student_documents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.student_documents TO anon;
GRANT ALL ON TABLE public.student_documents TO authenticated;
GRANT ALL ON TABLE public.student_documents TO service_role;


--
-- Name: TABLE student_parents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.student_parents TO anon;
GRANT ALL ON TABLE public.student_parents TO authenticated;
GRANT ALL ON TABLE public.student_parents TO service_role;


--
-- Name: TABLE task_interni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.task_interni TO anon;
GRANT ALL ON TABLE public.task_interni TO authenticated;
GRANT ALL ON TABLE public.task_interni TO service_role;


--
-- Name: TABLE tempo_scuola; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tempo_scuola TO anon;
GRANT ALL ON TABLE public.tempo_scuola TO authenticated;
GRANT ALL ON TABLE public.tempo_scuola TO service_role;


--
-- Name: TABLE test_table; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.test_table TO anon;
GRANT ALL ON TABLE public.test_table TO authenticated;
GRANT ALL ON TABLE public.test_table TO service_role;


--
-- Name: SEQUENCE test_table_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.test_table_id_seq TO anon;
GRANT ALL ON SEQUENCE public.test_table_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.test_table_id_seq TO service_role;


--
-- Name: TABLE ticket_mensa; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.ticket_mensa TO anon;
GRANT ALL ON TABLE public.ticket_mensa TO authenticated;
GRANT ALL ON TABLE public.ticket_mensa TO service_role;


--
-- Name: TABLE utenti; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.utenti TO anon;
GRANT ALL ON TABLE public.utenti TO authenticated;
GRANT ALL ON TABLE public.utenti TO service_role;


--
-- Name: TABLE utenti_scuole; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.utenti_scuole TO anon;
GRANT ALL ON TABLE public.utenti_scuole TO authenticated;
GRANT ALL ON TABLE public.utenti_scuole TO service_role;


--
-- Name: TABLE utenti_sezioni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.utenti_sezioni TO anon;
GRANT ALL ON TABLE public.utenti_sezioni TO authenticated;
GRANT ALL ON TABLE public.utenti_sezioni TO service_role;


--
-- Name: TABLE utenti_sezioni_materie; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.utenti_sezioni_materie TO anon;
GRANT ALL ON TABLE public.utenti_sezioni_materie TO authenticated;
GRANT ALL ON TABLE public.utenti_sezioni_materie TO service_role;


--
-- Name: TABLE valutazione_obiettivi; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.valutazione_obiettivi TO anon;
GRANT ALL ON TABLE public.valutazione_obiettivi TO authenticated;
GRANT ALL ON TABLE public.valutazione_obiettivi TO service_role;


--
-- Name: TABLE valutazioni; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.valutazioni TO anon;
GRANT ALL ON TABLE public.valutazioni TO authenticated;
GRANT ALL ON TABLE public.valutazioni TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- PostgreSQL database dump complete
--


