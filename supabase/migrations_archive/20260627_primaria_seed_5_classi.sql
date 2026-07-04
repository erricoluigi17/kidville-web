-- =============================================================================
-- PRIMARIA — Seed completo: 5 classi (1A→5A), docenti, alunni collocati, materie
-- =============================================================================
-- Riusa la scuola demo (11111111…) e la docente Anna (22222222…2222). La sezione
-- 3A riusa l'UUID del seed demo precedente (20260622) per non duplicarla.
-- Idempotente: UUID deterministici (md5) + ON CONFLICT DO NOTHING.
-- Le valutazioni usano ora l'argomento libero, quindi gli obiettivi non sono
-- necessari al seed.
-- =============================================================================

DO $$
DECLARE
  v_scuola UUID := '11111111-1111-1111-1111-111111111111';
  v_anna   UUID := '22222222-2222-2222-2222-222222222222';

  -- (nome_classe, section_uuid, livello, titolare). Titolare = Anna per tutte
  -- (utenti.id ha FK su auth.users: non si possono creare docenti arbitrari nel seed).
  v_classi JSONB := jsonb_build_array(
    jsonb_build_object('name','1A','sez', md5('kidville-primaria-section-1A')::uuid, 'liv',1,'tit', '22222222-2222-2222-2222-222222222222'),
    jsonb_build_object('name','2A','sez', md5('kidville-primaria-section-2A')::uuid, 'liv',2,'tit', '22222222-2222-2222-2222-222222222222'),
    jsonb_build_object('name','3A','sez', 'aaaa1111-0000-4000-8000-000000000001',   'liv',3,'tit', '22222222-2222-2222-2222-222222222222'),
    jsonb_build_object('name','4A','sez', md5('kidville-primaria-section-4A')::uuid, 'liv',4,'tit', '22222222-2222-2222-2222-222222222222'),
    jsonb_build_object('name','5A','sez', md5('kidville-primaria-section-5A')::uuid, 'liv',5,'tit', '22222222-2222-2222-2222-222222222222')
  );

  -- (nome, codice, ordine)
  v_materie JSONB := jsonb_build_array(
    jsonb_build_object('nome','Italiano',          'codice','italiano',   'ord',1),
    jsonb_build_object('nome','Matematica',        'codice','matematica', 'ord',2),
    jsonb_build_object('nome','Storia',            'codice','storia',     'ord',3),
    jsonb_build_object('nome','Geografia',         'codice','geografia',  'ord',4),
    jsonb_build_object('nome','Scienze',           'codice','scienze',    'ord',5),
    jsonb_build_object('nome','Inglese',           'codice','inglese',    'ord',6),
    jsonb_build_object('nome','Arte e immagine',   'codice','arte',       'ord',7),
    jsonb_build_object('nome','Musica',            'codice','musica',     'ord',8),
    jsonb_build_object('nome','Educazione fisica', 'codice','ed_fisica',  'ord',9),
    jsonb_build_object('nome','Tecnologia',        'codice','tecnologia', 'ord',10),
    jsonb_build_object('nome','Religione',         'codice','religione',  'ord',11)
  );

  v_nomi    TEXT[] := ARRAY['Luca','Sofia','Matteo','Giulia','Marco','Aurora','Leonardo','Emma','Tommaso','Giorgia','Francesco','Alice','Edoardo','Beatrice','Riccardo'];
  v_cognomi TEXT[] := ARRAY['Bianchi','Verdi','Russo','Ferrari','Esposito','Romano','Colombo','Ricci','Marino','Greco','Bruno','Gallo','Conti','De Luca','Mancini'];

  v_classe   JSONB;
  v_materia  JSONB;
  v_sez      UUID;
  v_liv      INTEGER;
  v_tit      UUID;
  v_name     TEXT;
  v_mat_id   UUID;
  i          INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_scuola) THEN
    RAISE NOTICE 'Scuola demo assente: seed primaria 5 classi saltato.';
    RETURN;
  END IF;

  -- Anna abilitata a infanzia + primaria (docente misto).
  UPDATE public.utenti SET gradi = ARRAY['infanzia','primaria']::school_type_enum[] WHERE id = v_anna;

  -- ---------------------------------------------------------------------------
  FOR v_classe IN SELECT * FROM jsonb_array_elements(v_classi)
  LOOP
    v_name := v_classe->>'name';
    v_sez  := (v_classe->>'sez')::uuid;
    v_liv  := (v_classe->>'liv')::int;
    v_tit  := (v_classe->>'tit')::uuid;

    -- Sezione.
    INSERT INTO public.sections (id, scuola_id, name, school_type)
    VALUES (v_sez, v_scuola, v_name, 'primaria')
    ON CONFLICT (id) DO NOTHING;

    -- Tempo scuola 27h/5gg.
    INSERT INTO public.tempo_scuola (section_id, modello, giorni_settimana, attivo)
    SELECT v_sez, 27, 5, true
    WHERE NOT EXISTS (SELECT 1 FROM public.tempo_scuola WHERE section_id = v_sez AND attivo);

    -- Materie della classe + assegnazione al docente titolare.
    FOR v_materia IN SELECT * FROM jsonb_array_elements(v_materie)
    LOOP
      v_mat_id := md5('kidville-primaria-materia-' || v_name || '-' || (v_materia->>'codice'))::uuid;
      INSERT INTO public.materie (id, scuola_id, section_id, nome, codice, ordine)
      VALUES (v_mat_id, v_scuola, v_sez, v_materia->>'nome', v_materia->>'codice', (v_materia->>'ord')::int)
      ON CONFLICT (section_id, codice) DO NOTHING;

      -- Recupera l'id reale (in caso la materia preesistesse con altro id).
      SELECT id INTO v_mat_id FROM public.materie WHERE section_id = v_sez AND codice = v_materia->>'codice';

      INSERT INTO public.utenti_sezioni_materie (utente_id, section_id, materia_id, e_contitolare)
      VALUES (v_tit, v_sez, v_mat_id, (v_materia->>'codice') = 'italiano')
      ON CONFLICT (utente_id, section_id, materia_id) DO NOTHING;
    END LOOP;

    -- Docente titolare ↔ sezione.
    INSERT INTO public.utenti_sezioni (utente_id, section_id)
    VALUES (v_tit, v_sez)
    ON CONFLICT (utente_id, section_id) DO NOTHING;

    -- ~15 alunni collocati nella sezione (section_id + classe_sezione coerenti).
    FOR i IN 1..15 LOOP
      INSERT INTO public.alunni (id, scuola_id, nome, cognome, data_nascita, classe_sezione, section_id, stato)
      VALUES (
        md5('kidville-primaria-alunno-' || v_name || '-' || i)::uuid,
        v_scuola,
        v_nomi[i],
        v_cognomi[i],
        make_date(2026 - 5 - v_liv, 1 + (i % 12), 1 + (i % 27)),
        v_name,
        v_sez,
        'iscritto'
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;

    -- Campanelle: 5 lezioni Lun-Ven (08:30→13:30).
    INSERT INTO public.campanelle (section_id, giorno_settimana, ordine, ora_inizio, ora_fine, tipo)
    SELECT v_sez, g.giorno, o.ordine,
           (TIME '08:30' + ((o.ordine - 1) * INTERVAL '1 hour')),
           (TIME '08:30' + (o.ordine * INTERVAL '1 hour')),
           'lezione'
    FROM generate_series(1, 5) AS g(giorno)
    CROSS JOIN generate_series(1, 5) AS o(ordine)
    ON CONFLICT (section_id, giorno_settimana, ordine) DO NOTHING;

    -- Orario: 1ª ora Italiano, 2ª ora Matematica del titolare, ogni giorno.
    INSERT INTO public.orario_settimanale (section_id, campanella_id, giorno_settimana, materia_id, docente_id)
    SELECT v_sez, c.id, c.giorno_settimana,
           CASE
             WHEN c.ordine = 1 THEN (SELECT id FROM public.materie WHERE section_id = v_sez AND codice = 'italiano')
             WHEN c.ordine = 2 THEN (SELECT id FROM public.materie WHERE section_id = v_sez AND codice = 'matematica')
             ELSE NULL
           END,
           v_tit
    FROM public.campanelle c
    WHERE c.section_id = v_sez AND c.ordine IN (1, 2)
    ON CONFLICT (section_id, giorno_settimana, campanella_id) DO NOTHING;
  END LOOP;

  RAISE NOTICE 'Seed primaria 5 classi completato (1A-5A, ~15 alunni/classe, materie complete).';
END $$;

NOTIFY pgrst, 'reload schema';
