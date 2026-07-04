-- =============================================================================
-- PRIMARIA — F1.11 Seed demo: una classe primaria completa per test end-to-end.
-- =============================================================================
-- Riusa la scuola demo (11111111…), la docente Anna (22222222…2222) e il
-- genitore demo (33333333…3333). Idempotente (ON CONFLICT / WHERE NOT EXISTS).
-- =============================================================================

DO $$
DECLARE
  v_scuola  UUID := '11111111-1111-1111-1111-111111111111';
  v_anna    UUID := '22222222-2222-2222-2222-222222222222';
  v_admin   UUID := '22222222-2222-2222-2222-555555555555';
  v_parent  UUID := '33333333-3333-3333-3333-333333333333';
  v_sez     UUID := 'aaaa1111-0000-4000-8000-000000000001';
  v_ita     UUID := 'aaaa3333-0000-4000-8000-000000000001';
  v_mat     UUID := 'aaaa3333-0000-4000-8000-000000000002';
  v_obj     UUID := 'aaaa4444-0000-4000-8000-000000000001';
  v_stud1   UUID := 'aaaa2222-0000-4000-8000-000000000001';
  v_stud2   UUID := 'aaaa2222-0000-4000-8000-000000000002';
BEGIN
  -- Salta se la scuola demo non esiste.
  IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_scuola) THEN
    RAISE NOTICE 'Scuola demo assente: seed primaria saltato.';
    RETURN;
  END IF;

  -- Admin demo (per le route admin protette da requireStaff).
  INSERT INTO public.utenti (id, email, nome, cognome, ruolo, scuola_id)
  VALUES (v_admin, 'admin.demo@kidville.it', 'Admin', 'Demo', 'admin', v_scuola)
  ON CONFLICT (id) DO NOTHING;

  -- Docente Anna: abilitata a infanzia + primaria (docente misto → switch).
  UPDATE public.utenti SET gradi = ARRAY['infanzia','primaria']::school_type_enum[] WHERE id = v_anna;

  -- Sezione primaria 3A.
  INSERT INTO public.sections (id, scuola_id, name, school_type)
  VALUES (v_sez, v_scuola, '3A', 'primaria')
  ON CONFLICT (id) DO NOTHING;

  -- Alunni primaria (section_id canonico).
  INSERT INTO public.alunni (id, scuola_id, nome, cognome, data_nascita, classe_sezione, section_id, stato)
  VALUES
    (v_stud1, v_scuola, 'Luca',  'Bianchi', '2017-04-12', '3A', v_sez, 'iscritto'),
    (v_stud2, v_scuola, 'Sofia', 'Verdi',   '2017-09-03', '3A', v_sez, 'iscritto')
  ON CONFLICT (id) DO NOTHING;

  -- Legame con il genitore demo.
  INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id)
  VALUES (v_parent, v_stud1), (v_parent, v_stud2)
  ON CONFLICT (genitore_id, alunno_id) DO NOTHING;

  -- Materie della classe (preset livello 3 applicato in modo minimale).
  INSERT INTO public.materie (id, scuola_id, section_id, nome, codice, ordine)
  VALUES
    (v_ita, v_scuola, v_sez, 'Italiano',   'italiano',   1),
    (v_mat, v_scuola, v_sez, 'Matematica', 'matematica', 2)
  ON CONFLICT (section_id, codice) DO NOTHING;

  -- Obiettivo di apprendimento (Italiano, livello 3).
  INSERT INTO public.obiettivi_apprendimento (id, scuola_id, materia_codice, livello, codice, descrizione)
  VALUES (v_obj, v_scuola, 'italiano', 3, 'ITA-3.1', 'Legge e comprende testi di vario tipo')
  ON CONFLICT (scuola_id, materia_codice, livello, codice) DO NOTHING;

  -- Assegnazione docente↔sezione + materie.
  INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES (v_anna, v_sez)
  ON CONFLICT (utente_id, section_id) DO NOTHING;
  INSERT INTO public.utenti_sezioni_materie (utente_id, section_id, materia_id, e_contitolare)
  VALUES (v_anna, v_sez, v_ita, true), (v_anna, v_sez, v_mat, false)
  ON CONFLICT (utente_id, section_id, materia_id) DO NOTHING;

  -- Tempo scuola 27h/5gg.
  INSERT INTO public.tempo_scuola (section_id, modello, giorni_settimana, attivo)
  SELECT v_sez, 27, 5, true
  WHERE NOT EXISTS (SELECT 1 FROM public.tempo_scuola WHERE section_id = v_sez AND attivo);

  -- Campanelle: 5 lezioni Lun-Ven (08:30→13:30).
  INSERT INTO public.campanelle (section_id, giorno_settimana, ordine, ora_inizio, ora_fine, tipo)
  SELECT v_sez, g.giorno, o.ordine,
         (TIME '08:30' + ((o.ordine - 1) * INTERVAL '1 hour')),
         (TIME '08:30' + (o.ordine * INTERVAL '1 hour')),
         'lezione'
  FROM generate_series(1, 5) AS g(giorno)
  CROSS JOIN generate_series(1, 5) AS o(ordine)
  ON CONFLICT (section_id, giorno_settimana, ordine) DO NOTHING;

  -- Orario: 1ª ora Italiano, 2ª ora Matematica (Anna) ogni giorno.
  INSERT INTO public.orario_settimanale (section_id, campanella_id, giorno_settimana, materia_id, docente_id)
  SELECT v_sez, c.id, c.giorno_settimana,
         CASE WHEN c.ordine = 1 THEN v_ita WHEN c.ordine = 2 THEN v_mat ELSE NULL END,
         v_anna
  FROM public.campanelle c
  WHERE c.section_id = v_sez AND c.ordine IN (1, 2)
  ON CONFLICT (section_id, giorno_settimana, campanella_id) DO NOTHING;

  -- Valutazione in itinere d'esempio (Luca, Italiano, per dimensioni).
  IF NOT EXISTS (
    SELECT 1 FROM public.valutazioni WHERE alunno_id = v_stud1 AND materia_id = v_ita AND modalita IS NOT NULL
  ) THEN
    WITH nuova AS (
      INSERT INTO public.valutazioni
        (alunno_id, maestra_id, section_id, materia, materia_id, tipo, modalita,
         dim_autonomia, dim_continuita, dim_tipologia, dim_risorse, giudizio_testo, pubblicato)
      VALUES
        (v_stud1, v_anna, v_sez, 'Italiano', v_ita, 'orale', 'dimensioni',
         true, true, 'nota', 'interne',
         'L''alunno porta a termine le attività in autonomia, in modo continuo e costante, in situazioni note, utilizzando risorse proprie.',
         true)
      RETURNING id
    )
    INSERT INTO public.valutazione_obiettivi (valutazione_id, obiettivo_id)
    SELECT id, v_obj FROM nuova;
  END IF;

  RAISE NOTICE 'Seed primaria demo completato (sezione 3A).';
END $$;

NOTIFY pgrst, 'reload schema';
