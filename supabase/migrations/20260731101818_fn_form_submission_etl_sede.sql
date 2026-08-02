-- =============================================================================
-- 20260731101818 — L'ETL dell'iscrizione archivia il minore nella sede DICHIARATA
--
-- IL DIFETTO (R92, audit globale multi-sede del 2026-07-31 — bloccante).
-- `public.fn_form_submission_etl()` è il trigger SECURITY DEFINER che, quando un
-- modulo d'iscrizione passa a `status='completed'`, riversa il payload nelle
-- anagrafiche `alunni` / `parents` / `student_parents`. La route `forms/submit`
-- risolve la sede con onestà (utente → modello → unica sede reale, altrimenti
-- NULL) e la scrive in `form_submissions.scuola_id`. Il trigger la ignorava:
--
--     -- mono-sede in prod
--     SELECT id INTO c_scuola_id FROM public.schools ORDER BY id LIMIT 1;
--
-- Dal 2026-07-29 le sedi sono tre e quell'ordinamento restituisce Kidville Cesa:
-- OGNI minore iscritto sarebbe nato a Cesa, qualunque plesso avesse scelto la
-- famiglia. Un uuid cablato travestito da query — e nessun test poteva vederlo,
-- perché la funzione non fallisce: archivia nel posto sbagliato, in silenzio.
-- Verificato in produzione prima di questa migrazione: una compilazione con
-- `scuola_id` della sede E2E faceva nascere l'alunno a Cesa (prova eseguita in
-- una transazione annullata, nessun dato lasciato indietro).
--
-- DANNO GIÀ PRODOTTO: nessuno. Le 4 righe di `form_submissions` sono
-- autorizzazioni gita (chiave `note`), su modelli che NON sono d'iscrizione: il
-- ramo anagrafico non è mai partito. Cesa ha 0 alunni. Non serve un rimedio sui
-- dati, serve che non accada domani — quando Cesa avrà alunni veri e un codice
-- fiscale corretto indirizzerà un UPDATE su un minore vero.
--
-- COSA CAMBIA QUI.
--  1. La sede viene dal DATO: `c_scuola_id := NEW.scuola_id`. Il dato la porta
--     con sé; dedurla di nuovo significa contraddire chi la sapeva.
--  2. Senza sede si NEGA: `RAISE EXCEPTION` (SQLSTATE KV001), non un ripiego.
--     Un'anagrafica di minore archiviata nel plesso sbagliato è peggio di un
--     errore visibile. Si solleva solo se c'è davvero qualcosa da riversare: una
--     compilazione senza dati anagrafici non crea nulla e non deve far fallire
--     nessun invio.
--  3. La deduplica dell'alunno è vincolata alla sede risolta (`AND scuola_id =
--     c_scuola_id`), in ENTRAMBE le ricerche. Senza, un'omonimia fra plessi (o
--     un CF già presente altrove) faceva eseguire `UPDATE` su sezione e note
--     mediche del minore di un'ALTRA sede: il caso peggiore.
--     NB: il vincolo UNIQUE GLOBALE su `alunni.codice_fiscale` resta e resta
--     voluto — la politica cross-sede sul CF è presidiata, in modo esplicito, da
--     `src/app/api/admin/iscrizioni`. Qui l'effetto è che un CF già registrato in
--     un altro plesso fa fallire l'INSERT: non più in silenzio (punto 4).
--  4. I `RAISE NOTICE` best-effort — che non arrivano da nessuna parte —
--     diventano righe in `app_log` via `public.app_log_registra`, e il SUCCESSO
--     viene loggato quanto l'errore (AGENTS.md §Logging 5: con i soli errori,
--     «nessun log» non distingue «tutto ok» da «non è mai partito niente»).
--
-- PERCHÉ NEI LOG NON C'È `SQLERRM`. Il messaggio di un errore Postgres può
-- contenere il valore che lo ha causato (`invalid input syntax for type date:
-- "…"`): qui i valori sono la data di nascita, il nome e il codice fiscale di un
-- minore. Si registrano SQLSTATE, nome del vincolo, colonna e tabella — che
-- dicono esattamente perché è fallito — più gli uuid per correlare. Nessuna PII.
-- (AGENTS.md §Logging 8: la redazione è a lista bianca.)
--
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT. Il trigger
-- `trg_form_submission_etl` resta quello che è (AFTER INSERT OR UPDATE OF status).
-- =============================================================================

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
  c_scuola_id  uuid;
  -- Aggiunte 20260731: la sede dal dato, il diniego e i log.
  v_ha_alunno       boolean;
  v_ha_genitore     boolean;
  v_alunno_creato   boolean := false;
  v_genitore_creato boolean := false;
  v_sqlstate   text;
  v_vincolo    text;
  v_colonna    text;
  v_tabella    text;
BEGIN
  IF NEW.status <> 'completed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN RETURN NEW; END IF;

  SELECT * INTO v_model FROM public.form_models WHERE id = NEW.model_id;
  v_is_enrollment :=
       COALESCE(v_model.is_enrollment_form, false)
    OR COALESCE((v_model.schema->>'is_enrollment_form')::boolean, false)
    OR v_model.title ILIKE '%iscriz%';
  IF NOT v_is_enrollment THEN RETURN NEW; END IF;

  -- La sede viene dal DATO, non da un ordinamento di uuid: `scuola_id` esiste su
  -- `form_submissions` esattamente per questo, ed è la route ad averlo risolto
  -- quando ancora c'era il contesto per farlo (chi compila, il modello, le sedi).
  c_scuola_id := NEW.scuola_id;

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

  v_ha_alunno   := (alunno_obj ? 'nome') AND (alunno_obj ? 'cognome') AND (alunno_obj ? 'data_nascita');
  v_ha_genitore := (parent_obj ? 'first_name') OR (parent_obj ? 'fiscal_code');

  -- Niente da riversare: nessuna anagrafica, nessun rischio, nessun motivo di
  -- far fallire l'invio del modulo.
  IF NOT (v_ha_alunno OR v_ha_genitore) THEN RETURN NEW; END IF;

  -- Scope vuoto ⇒ NEGA. Qui c'è un minore da archiviare e non si sa dove: la
  -- risposta onesta è fermarsi, non scegliere una sede al posto della famiglia.
  -- Il chiamante riceve l'errore e la riga NON viene registrata a metà.
  IF c_scuola_id IS NULL THEN
    RAISE EXCEPTION
      'ETL iscrizione: la compilazione % non dichiara la sede (form_submissions.scuola_id NULL): nessuna anagrafica creata',
      NEW.id
      USING ERRCODE = 'KV001',
            DETAIL  = format('model_id=%s', NEW.model_id),
            HINT    = 'La sede va risolta e scritta al momento dell invio (form_submissions.scuola_id): il trigger non la deduce.';
  END IF;

  IF v_ha_alunno THEN
    BEGIN
      -- Ricerca dell'alunno già esistente: SEMPRE dentro la sede della
      -- compilazione. Fuori da qui c'è il minore di un altro plesso.
      IF alunno_obj ? 'codice_fiscale' THEN
        SELECT id INTO v_student_id FROM public.alunni
        WHERE upper(trim(codice_fiscale)) = upper(trim(alunno_obj->>'codice_fiscale'))
          AND scuola_id = c_scuola_id
        LIMIT 1;
      END IF;
      IF v_student_id IS NULL THEN
        SELECT id INTO v_student_id FROM public.alunni
        WHERE lower(nome) = lower(alunno_obj->>'nome')
          AND lower(cognome) = lower(alunno_obj->>'cognome')
          AND data_nascita = (alunno_obj->>'data_nascita')::date
          AND scuola_id = c_scuola_id
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
        v_alunno_creato := true;
      ELSE
        UPDATE public.alunni SET
          classe_sezione = COALESCE(alunno_obj->>'classe_sezione', classe_sezione),
          note_mediche   = COALESCE(alunno_obj->>'note_mediche', note_mediche)
        WHERE id = v_student_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Era `RAISE NOTICE`: un messaggio che non arriva in nessun log e che ha
      -- tenuto invisibile ogni fallimento dell'ETL. Il caso più probabile è il
      -- codice fiscale già registrato in un ALTRO plesso (UNIQUE globale
      -- `alunni_codice_fiscale_key`): va visto, non ingoiato.
      GET STACKED DIAGNOSTICS
        v_sqlstate = RETURNED_SQLSTATE, v_vincolo = CONSTRAINT_NAME,
        v_colonna  = COLUMN_NAME,       v_tabella = TABLE_NAME;
      BEGIN
        PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
          'livello',   'error',
          'evento',    'modulistica',
          'sorgente',  'server',
          'messaggio', 'ETL iscrizione: anagrafica alunno non scritta',
          'codice',    v_sqlstate,
          'scuola_id', c_scuola_id,
          'fingerprint', left('etl-iscrizione-alunno-ko:' || NEW.id::text, 64),
          'contesto',  jsonb_build_object(
            'operazione',    'fn_form_submission_etl',
            'submission_id', NEW.id,
            'model_id',      NEW.model_id,
            'vincolo',       v_vincolo,
            'colonna',       v_colonna,
            'tabella',       v_tabella)
        )));
      EXCEPTION WHEN OTHERS THEN
        -- Fail-open dell'osservabilità (AGENTS.md §Logging 9): un guasto del log
        -- non può diventare un guasto del prodotto, e il fallimento del logger
        -- non è loggabile senza ricorsione.
        NULL;
      END;
    END;
  END IF;

  IF v_ha_genitore THEN
    BEGIN
      -- `parents` non ha `scuola_id` (la sede del genitore si deriva dai FIGLI):
      -- la deduplica per codice fiscale resta globale, ed è corretta così.
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
        v_genitore_creato := true;
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
      GET STACKED DIAGNOSTICS
        v_sqlstate = RETURNED_SQLSTATE, v_vincolo = CONSTRAINT_NAME,
        v_colonna  = COLUMN_NAME,       v_tabella = TABLE_NAME;
      BEGIN
        PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
          'livello',   'error',
          'evento',    'modulistica',
          'sorgente',  'server',
          'messaggio', 'ETL iscrizione: anagrafica genitore non scritta',
          'codice',    v_sqlstate,
          'scuola_id', c_scuola_id,
          'fingerprint', left('etl-iscrizione-genitore-ko:' || NEW.id::text, 64),
          'contesto',  jsonb_build_object(
            'operazione',    'fn_form_submission_etl',
            'submission_id', NEW.id,
            'model_id',      NEW.model_id,
            'vincolo',       v_vincolo,
            'colonna',       v_colonna,
            'tabella',       v_tabella)
        )));
      EXCEPTION WHEN OTHERS THEN NULL; -- fail-open, vedi sopra
      END;
    END;
  END IF;

  IF v_student_id IS NOT NULL AND v_parent_id IS NOT NULL THEN
    INSERT INTO public.student_parents (student_id, parent_id, relation_type, is_primary)
    VALUES (v_student_id, v_parent_id, 'parent', true)
    ON CONFLICT (student_id, parent_id) DO NOTHING;
  END IF;

  -- Il SUCCESSO si logga quanto l'errore: senza, «nessun log» non distingue
  -- «nessuna iscrizione» da «l ETL non è mai partito». Solo uuid e booleani.
  IF v_student_id IS NOT NULL OR v_parent_id IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello',   'info',
        'evento',    'modulistica',
        'sorgente',  'server',
        'messaggio', 'ETL iscrizione: anagrafiche riversate',
        'scuola_id', c_scuola_id,
        'fingerprint', left('etl-iscrizione-ok:' || NEW.id::text, 64),
        'contesto',  jsonb_build_object(
          'operazione',       'fn_form_submission_etl',
          'submission_id',    NEW.id,
          'model_id',         NEW.model_id,
          'alunno_id',        v_student_id,
          'genitore_id',      v_parent_id,
          'alunno_creato',    v_alunno_creato,
          'genitore_creato',  v_genitore_creato)
      )));
    EXCEPTION WHEN OTHERS THEN NULL; -- fail-open, vedi sopra
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- Invariato dal 20260706210352, ripetuto per idempotenza: la funzione è SOLO un
-- trigger, nessun ruolo client la esegue.
REVOKE EXECUTE ON FUNCTION public.fn_form_submission_etl() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_form_submission_etl() TO service_role;
