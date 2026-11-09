-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.8 · «Il passaggio d'anno» · M48c, la didattica della classe nuova (compito 4.8.2)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- `passaggio_copia_didattica`: materie, campanelle, orario, tempo scuola e obiettivi della sezione vecchia verso la sua continuazione
-- (`sections.continua_da`). Le cinque tabelle e le assegnazioni per materia seguono la sezione per `section_id`, non hanno `anno_id`
-- e non stanno nel registro `anno_tabelle`: senza questa copia la classe nuova nasce senza orario e senza materie.
-- Si applica dopo M48a e prima di M48b (che la chiama). La migrazione definisce solo la funzione: nessuna scrittura su dati,
-- nessun uuid di sede, nessun valore del 2027/28.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Regole (scelte del piano, 4.8.2):
--   · PER OGNI TABELLA separatamente, si copia dalla classe vecchia SOLO SE la nuova non ha già righe in quella tabella: mai
--     un'unione (una segreteria che ha già preparato le materie nuove non se le ritrova mescolate a quelle vecchie);
--   · le chiavi si rimappano: `materia_id` per `(sezione nuova, codice)`, `campanella_id` per `(sezione nuova, giorno, ordine)`.
--     Un'ora d'orario senza la campanella corrispondente nella classe nuova non si copia; una materia senza corrispondente diventa NULL;
--   · `orario_settimanale.docente_id` e `utenti_sezioni_materie` solo per i docenti che la segreteria NON ha tolto
--     (`passaggi_anno_docenti.origine = 'tolta'` sulla classe nuova): l'ora resta, senza docente;
--   · una sezione vecchia senza continuazione è saltata e contata (`sezioni_saltate`);
--   · idempotente: rifatta, ogni tabella ha già righe e non si copia niente. Le tabelle della classe vecchia non si toccano mai.
-- Risposta: {materie, campanelle, orario, tempo_scuola, obiettivi, docenti_materie, sezioni_saltate}.
-- Errori: PASSAGGIO_NON_TROVATO; PASSAGGIO_NON_MODIFICABILE se il passaggio è annullato.
CREATE OR REPLACE FUNCTION public.passaggio_copia_didattica(p_passaggio uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p     public.passaggi_anno%ROWTYPE;
  v_da    public.anni_sede%ROWTYPE;
  v_a     public.anni_sede%ROWTYPE;
  v_s     record;
  v_n     integer;
  v_materie integer := 0;
  v_campanelle integer := 0;
  v_orario integer := 0;
  v_tempo integer := 0;
  v_obiettivi integer := 0;
  v_docenti_materie integer := 0;
  v_saltate integer := 0;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  IF v_p.stato = 'annullato' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_MODIFICABILE' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
  END IF;
  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  FOR v_s IN
    SELECT so.id AS so_id, sn.id AS sn_id
      FROM public.sections sn
      JOIN public.sections so ON so.id = sn.continua_da
     WHERE sn.anno_id = v_a.anno_id AND sn.scuola_id = v_a.scuola_id AND so.anno_id = v_da.anno_id
     ORDER BY sn.id
  LOOP
    -- materie
    IF NOT EXISTS (SELECT 1 FROM public.materie x WHERE x.section_id = v_s.sn_id) THEN
      INSERT INTO public.materie (scuola_id, section_id, nome, codice, e_civica, turno_mensa, ordine, attiva)
      SELECT m.scuola_id, v_s.sn_id, m.nome, m.codice, m.e_civica, m.turno_mensa, m.ordine, m.attiva
        FROM public.materie m WHERE m.section_id = v_s.so_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_materie := v_materie + v_n;
    END IF;

    -- campanelle
    IF NOT EXISTS (SELECT 1 FROM public.campanelle x WHERE x.section_id = v_s.sn_id) THEN
      INSERT INTO public.campanelle (section_id, giorno_settimana, ordine, ora_inizio, ora_fine, tipo)
      SELECT v_s.sn_id, c.giorno_settimana, c.ordine, c.ora_inizio, c.ora_fine, c.tipo
        FROM public.campanelle c WHERE c.section_id = v_s.so_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_campanelle := v_campanelle + v_n;
    END IF;

    -- orario: le campanelle e le materie nuove si trovano per chiave naturale; il docente "tolto" non passa
    IF NOT EXISTS (SELECT 1 FROM public.orario_settimanale x WHERE x.section_id = v_s.sn_id) THEN
      INSERT INTO public.orario_settimanale (section_id, campanella_id, giorno_settimana, materia_id, docente_id, note)
      SELECT v_s.sn_id, cn.id, cn.giorno_settimana, mn.id,
             CASE WHEN o.docente_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM public.passaggi_anno_docenti t
                                WHERE t.passaggio_id = v_p.id AND t.utente_id = o.docente_id
                                  AND t.sezione_a_id = v_s.sn_id AND t.origine = 'tolta')
                  THEN NULL ELSE o.docente_id END,
             o.note
        FROM public.orario_settimanale o
        JOIN public.campanelle co ON co.id = o.campanella_id
        JOIN public.campanelle cn ON cn.section_id = v_s.sn_id AND cn.giorno_settimana = co.giorno_settimana AND cn.ordine = co.ordine
        LEFT JOIN public.materie mo ON mo.id = o.materia_id
        LEFT JOIN public.materie mn ON mn.section_id = v_s.sn_id AND mn.codice = mo.codice
       WHERE o.section_id = v_s.so_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_orario := v_orario + v_n;
    END IF;

    -- tempo scuola
    IF NOT EXISTS (SELECT 1 FROM public.tempo_scuola x WHERE x.section_id = v_s.sn_id) THEN
      INSERT INTO public.tempo_scuola (section_id, modello, giorni_settimana, attivo)
      SELECT v_s.sn_id, t.modello, t.giorni_settimana, t.attivo
        FROM public.tempo_scuola t WHERE t.section_id = v_s.so_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_tempo := v_tempo + v_n;
    END IF;

    -- obiettivi per materia (la materia nuova si trova per codice; senza corrispondente non si copia)
    IF NOT EXISTS (SELECT 1 FROM public.sezione_materia_obiettivo x WHERE x.section_id = v_s.sn_id) THEN
      INSERT INTO public.sezione_materia_obiettivo (section_id, materia_id, obiettivo_id)
      SELECT v_s.sn_id, mn.id, so.obiettivo_id
        FROM public.sezione_materia_obiettivo so
        JOIN public.materie mo ON mo.id = so.materia_id
        JOIN public.materie mn ON mn.section_id = v_s.sn_id AND mn.codice = mo.codice
       WHERE so.section_id = v_s.so_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_obiettivi := v_obiettivi + v_n;
    END IF;

    -- assegnazioni docente-materia: solo i docenti non tolti
    IF NOT EXISTS (SELECT 1 FROM public.utenti_sezioni_materie x WHERE x.section_id = v_s.sn_id) THEN
      INSERT INTO public.utenti_sezioni_materie (utente_id, section_id, materia_id, e_contitolare)
      SELECT um.utente_id, v_s.sn_id, mn.id, um.e_contitolare
        FROM public.utenti_sezioni_materie um
        JOIN public.materie mo ON mo.id = um.materia_id
        JOIN public.materie mn ON mn.section_id = v_s.sn_id AND mn.codice = mo.codice
       WHERE um.section_id = v_s.so_id
         AND NOT EXISTS (SELECT 1 FROM public.passaggi_anno_docenti t
                          WHERE t.passaggio_id = v_p.id AND t.utente_id = um.utente_id
                            AND t.sezione_a_id = v_s.sn_id AND t.origine = 'tolta');
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_docenti_materie := v_docenti_materie + v_n;
    END IF;
  END LOOP;

  -- Le sezioni vecchie che non hanno una continuazione nell'anno nuovo.
  SELECT count(*) INTO v_saltate
    FROM public.sections so
   WHERE so.anno_id = v_da.anno_id AND so.scuola_id = v_da.scuola_id
     AND NOT EXISTS (SELECT 1 FROM public.sections sn
                      WHERE sn.continua_da = so.id AND sn.anno_id = v_a.anno_id AND sn.scuola_id = v_a.scuola_id);

  RETURN jsonb_build_object(
    'materie', v_materie, 'campanelle', v_campanelle, 'orario', v_orario, 'tempo_scuola', v_tempo,
    'obiettivi', v_obiettivi, 'docenti_materie', v_docenti_materie, 'sezioni_saltate', v_saltate);
END
$$;

REVOKE ALL ON FUNCTION public.passaggio_copia_didattica(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_copia_didattica(uuid) TO service_role;
