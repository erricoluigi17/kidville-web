-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.5 · «Preparare e aprire l'anno prossimo» · M45c, iscrizione e conferma (compiti 4.5.5 e 4.5.6)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- TESTATA: il file nasce vuoto nel compito 4.5.0 (scheletro) e lo riempiono i compiti 4.5.5 (parte 1) e 4.5.6 (parte 2,
-- in fondo al file). Sta DOPO M45d: `anno_quota_voce` legge `listino_voci.scadenza`, che nasce lì.
--
-- CONTERRÀ:
--   · 4.5.5: `anno_registra_frequenza`, `anno_quota_voce`, `anno_quota_collega`, `anno_conta_posti`;
--   · 4.5.6: `anno_conferma` e `anno_non_rinnova`. `anno_conferma` riceve `p_cambia_grado boolean DEFAULT false`, in fondo
--     alla firma: con `p_cambia_grado = true` e `p_section` NULL solleva `SEZIONE_OBBLIGATORIA`; senza continuazione la
--     sezione è NULL e la conferma passa. Nel risultato `cambia_grado` è `p_cambia_grado` oppure `school_type`/`fascia`
--     diverse fra partenza e arrivo.
--
-- Una conferma 2027/28 non cambia mai `alunni.section_id`, `classe_sezione` né `importo_retta_mensile`.
-- Nessun uuid di sede, nessun valore del 2027/28.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- COMPITO 4.5.5 · la frequenza dell'anno aperto e la voce della sua quota
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Quattro funzioni. Nessuna scrive `alunni`, `section_id`, `classe_sezione` o `importo_retta_mensile`, né la frequenza dell'anno
-- attivo: una conferma o una domanda dell'anno prossimo non cambia un dato dell'anno in corso. I due flag della frequenza
-- (`moduli_completi`, `quota_saldata`) e la promozione a `iscritto` li fa `frequenze_assegna_e_calcola`: qui non si scrivono mai.
-- Nessun uuid di sede, nessun valore del 2027/28: date, importi e descrizioni vengono da `anni_sede` e `listino_voci`.

-- ── anno_conta_posti ─────────────────────────────────────────────────────────────────────────────
-- Per ogni fascia: quanti `in_attesa` e `iscritto` ci sono (fascia della SEZIONE della frequenza; senza sezione `senza_sezione`;
-- con una sezione che non ha la fascia `senza_fascia` — 4.5.15: prima finiva in `senza_sezione` anche se la classe c'era),
-- quanti posti autorizzati ci sono (NULL se nessuno li ha dichiarati) e se i primi superano i secondi. Un avviso, mai un blocco.
CREATE OR REPLACE FUNCTION public.anno_conta_posti(p_anno_sede uuid)
RETURNS TABLE (fascia text, iscritti bigint, posti integer, oltre boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH conteggio AS (
    SELECT coalesce(s.fascia, CASE WHEN f.section_id IS NULL THEN 'senza_sezione' ELSE 'senza_fascia' END)::text AS fascia, count(*) AS n
      FROM public.frequenze f
      LEFT JOIN public.sections s ON s.id = f.section_id
     WHERE f.anno_sede_id = p_anno_sede AND f.stato IN ('in_attesa', 'iscritto')
     GROUP BY 1
  ), autorizzati AS (
    SELECT p.fascia::text AS fascia, p.posti
      FROM public.posti_autorizzati p
     WHERE p.anno_sede_id = p_anno_sede
  )
  SELECT coalesce(c.fascia, a.fascia)::text,
         coalesce(c.n, 0)::bigint,
         a.posti,
         (a.posti IS NOT NULL AND coalesce(c.n, 0) > a.posti)
    FROM conteggio c
    FULL JOIN autorizzati a ON a.fascia = c.fascia
   ORDER BY 1
$$;

-- ── anno_quota_voce ──────────────────────────────────────────────────────────────────────────────
-- La voce «Iscrizione» della frequenza dell'anno prossimo. `p_oggi` NULL = oggi a Roma; serve a una prova con una data fissa
-- (cambia solo la `scadenza` di ripiego e `visibile_dal`).
--   · `quota_pagamento_id` già c'è                          → `gia_collegata`;
--   · la frequenza non è viva (`ritirato`…)                  → FREQUENZA_NON_VIVA: a un ritirato non nasce una voce;
--   · le voci «Iscrizione» dell'alunno per quell'anno: stessa regola di `crm_quota_passa` (categoria di sistema `iscrizione` o
--     quella della riga di listino; competenza = inizio dell'anno di sede, oppure senza competenza con scadenza dentro il periodo):
--       una → la collega (`collegata`); più di una → `piu_voci`, non sceglie; nessuna → la crea dal listino;
--   · il listino: `quota_conferma` o `quota_nuova` secondo `tipo`; prima la riga della fascia della sezione, poi quella senza
--     fascia; senza riga con importo → `senza_listino` e niente voce.
-- La voce nasce `da_pagare`, `singolo`, obbligatoria, competenza = inizio dell'anno, scadenza = quella del listino o oggi + 30,
-- visibile da oggi. Categoria: quella della riga di listino, altrimenti quella di sistema `iscrizione` (mai un uuid scritto a mano).
CREATE OR REPLACE FUNCTION public.anno_quota_voce(p_frequenza uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi      date := coalesce(p_oggi, public.giorno_roma(now()));
  v_f         public.frequenze%ROWTYPE;
  v_a         public.anni_sede%ROWTYPE;
  v_etichetta text;
  v_voce      text;
  v_fascia    text;
  v_riga      public.listino_voci%ROWTYPE;
  v_trovata   boolean;
  v_sistema   uuid;
  v_categoria uuid;
  v_voci      uuid[];
  v_pagamento uuid;
BEGIN
  SELECT * INTO v_f FROM public.frequenze WHERE id = p_frequenza FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'frequenza')::text;
  END IF;
  IF v_f.quota_pagamento_id IS NOT NULL THEN
    RETURN jsonb_build_object('esito', 'gia_collegata', 'pagamento_id', v_f.quota_pagamento_id);
  END IF;
  IF v_f.stato NOT IN ('in_attesa', 'iscritto') THEN
    RAISE EXCEPTION 'FREQUENZA_NON_VIVA' USING DETAIL = json_build_object('frequenza_id', v_f.id, 'stato', v_f.stato)::text;
  END IF;
  -- Una scheda archiviata o anonimizzata non riceve una voce nuova (4.5.15, minore 4.5.5): l'esito lo dice, la frequenza resta com'è.
  IF EXISTS (SELECT 1 FROM public.alunni a WHERE a.id = v_f.alunno_id AND (a.archiviato_il IS NOT NULL OR a.anonimizzato_il IS NOT NULL)) THEN
    RETURN jsonb_build_object('esito', 'scheda_archiviata', 'pagamento_id', NULL);
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = v_f.anno_sede_id;
  SELECT y.etichetta_breve INTO v_etichetta FROM public.anni_scolastici y WHERE y.id = v_a.anno_id;

  -- La riga di listino: la fascia della sezione batte «tutte le fasce».
  v_voce := CASE v_f.tipo WHEN 'conferma' THEN 'quota_conferma' WHEN 'nuova' THEN 'quota_nuova' END;
  SELECT s.fascia INTO v_fascia FROM public.sections s WHERE s.id = v_f.section_id;
  SELECT l.* INTO v_riga
    FROM public.listino_voci l
   WHERE l.anno_sede_id = v_a.id AND l.voce = v_voce AND l.importo IS NOT NULL
     AND (l.fascia IS NULL OR l.fascia = v_fascia)
   ORDER BY (l.fascia IS NOT NULL) DESC, (l.payment_category_id IS NOT NULL) DESC, l.id
   LIMIT 1;
  v_trovata := FOUND;

  SELECT c.id INTO v_sistema
    FROM public.payment_categories c
   WHERE c.slug = 'iscrizione' AND c.is_sistema AND c.scuola_id IS NULL
   ORDER BY c.id
   LIMIT 1;
  v_categoria := coalesce(v_riga.payment_category_id, v_sistema);

  -- Le voci «Iscrizione» che l'alunno ha già per quell'anno, bloccate mentre si decide.
  SELECT array_agg(x.id ORDER BY x.id) INTO v_voci
    FROM (
      SELECT p.id
        FROM public.pagamenti p
       WHERE p.alunno_id = v_f.alunno_id
         AND p.categoria_id IN (v_sistema, v_categoria)
         AND (p.periodo_competenza = v_a.inizio
              OR (p.periodo_competenza IS NULL AND p.scadenza BETWEEN v_a.inizio AND v_a.fine))
       ORDER BY p.id
         FOR UPDATE
    ) x;

  IF coalesce(cardinality(v_voci), 0) > 1 THEN
    RETURN jsonb_build_object('esito', 'piu_voci', 'pagamento_id', NULL);
  END IF;
  IF coalesce(cardinality(v_voci), 0) = 1 THEN
    UPDATE public.frequenze SET quota_pagamento_id = v_voci[1] WHERE id = v_f.id;
    RETURN jsonb_build_object('esito', 'collegata', 'pagamento_id', v_voci[1]);
  END IF;

  IF NOT v_trovata THEN
    RETURN jsonb_build_object('esito', 'senza_listino', 'pagamento_id', NULL);
  END IF;
  IF v_categoria IS NULL THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'categoria')::text;
  END IF;

  INSERT INTO public.pagamenti
    (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, tipo, obbligatorio,
     periodo_competenza, gruppo, creato_da, stato, visibile_dal)
  VALUES
    (v_f.alunno_id, v_f.scuola_id, 'Iscrizione ' || v_etichetta, v_riga.importo,
     coalesce(v_riga.scadenza, v_oggi + 30),
     v_categoria, 'singolo', true,
     v_a.inizio, NULL, p_da, 'da_pagare', v_oggi)
  RETURNING id INTO v_pagamento;

  UPDATE public.frequenze SET quota_pagamento_id = v_pagamento WHERE id = v_f.id;
  RETURN jsonb_build_object('esito', 'creata', 'pagamento_id', v_pagamento);
END
$$;

-- ── anno_quota_collega ───────────────────────────────────────────────────────────────────────────
-- Per il CRM (4.5.9): dopo aver trovato o creato la voce di un bambino, la lega alla sua frequenza dell'anno prossimo. Imposta
-- `quota_pagamento_id` solo se è vuoto e solo se la voce è dello stesso alunno. Vero se alla fine la frequenza punta a quella
-- voce (anche se già ci puntava: rilanciarla è innocuo), falso in ogni altro caso, senza errori.
CREATE OR REPLACE FUNCTION public.anno_quota_collega(p_frequenza uuid, p_pagamento uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_f public.frequenze%ROWTYPE;
BEGIN
  SELECT * INTO v_f FROM public.frequenze WHERE id = p_frequenza FOR UPDATE;
  IF NOT FOUND OR p_pagamento IS NULL THEN
    RETURN false;
  END IF;
  IF v_f.quota_pagamento_id IS NOT NULL THEN
    RETURN v_f.quota_pagamento_id = p_pagamento;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pagamenti p WHERE p.id = p_pagamento AND p.alunno_id = v_f.alunno_id) THEN
    RETURN false;
  END IF;
  UPDATE public.frequenze SET quota_pagamento_id = p_pagamento WHERE id = v_f.id;
  RETURN true;
END
$$;

-- ── anno_registra_frequenza ──────────────────────────────────────────────────────────────────────
-- Scrive la frequenza `(alunno, anno aperto)` e ne chiama la voce. Lo stato nasce SEMPRE `in_attesa`: `iscritto` lo decide il
-- trigger quando moduli e quota sono a posto. `p_anno_sede` dev'essere `iscrizioni_aperte` (ANNO_NON_APERTO) e della sede
-- dell'alunno (SEDE_DIVERSA). `p_campi` è una LISTA BIANCA: `retta_mensile`, `retta_esente`, `retta_a_carico_di`,
-- `retta_split_config`, `intestatario_fatture`, `giorno_scadenza_pagamenti`, `gruppo_mensa_id`, `usa_pannolino`; ogni altra
-- chiave (la sospensione, lo stato) è ignorata. Se la frequenza c'è già la restituisce (`creata:false`) e, se arriva una
-- domanda e la riga non ne ha una, la collega. Una frequenza `ritirato` si RIAPRE qui, e solo qui (4.5.16): torna `in_attesa` senza uscita
-- (mai `iscritto` a mano: lo porta il trigger), con la sezione chiesta se c'e', la domanda nuova al posto della vecchia e i `p_campi`
-- presenti (le chiavi assenti restano); `tipo` e `origine` restano quelli della riga; la voce la fa `anno_quota_voce` perche' la riga
-- e' di nuovo viva. Una frequenza `trasferito` o `uscito` non si riapre: `chiusa: true`, `quota` NULL.
-- MAI blocca per i posti: `posti_oltre` è un avviso. `p_da` (4.5.6) è chi ha fatto il gesto: finisce in `pagamenti.creato_da` della voce
-- nuova; chi non lo passa (la domanda pubblica) lascia l'autore vuoto, come prima.
-- Risposta: {frequenza_id, creata, quota, pagamento_id, posti_oltre} e, SOLO se la frequenza c'era gia' con un'altra sezione,
-- `sezione_ignorata: true` (la sezione chiesta non e' stata applicata: la classe non cambia da qui); `riaperta: true` se era ritirata
-- e l'ha riaperta; `chiusa: true` se e' trasferita o uscita e non si e' toccata.
CREATE OR REPLACE FUNCTION public.anno_registra_frequenza(
  p_alunno uuid, p_anno_sede uuid, p_tipo text, p_origine text, p_domanda uuid,
  p_section uuid, p_data_ingresso date, p_campi jsonb, p_da uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a      public.anni_sede%ROWTYPE;
  v_scuola uuid;
  v_f      public.frequenze%ROWTYPE;
  v_creata boolean := false;
  v_campi  jsonb := coalesce(p_campi, '{}'::jsonb);
  v_retta  numeric;
  v_giorno integer;
  v_quota  jsonb;
  v_fascia text;
  v_oltre  boolean;
  v_ignorata boolean := false;
  v_riaperta boolean := false;
  v_chiusa   boolean := false;
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('conferma', 'nuova') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'tipo')::text;
  END IF;
  IF p_origine IS NULL OR p_origine NOT IN ('domanda', 'conferma', 'segreteria', 'import') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'origine')::text;
  END IF;
  IF jsonb_typeof(v_campi) <> 'object' THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'campi')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato <> 'iscrizioni_aperte' THEN
    RAISE EXCEPTION 'ANNO_NON_APERTO'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  SELECT a.scuola_id INTO v_scuola FROM public.alunni a WHERE a.id = p_alunno;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'alunno')::text;
  END IF;
  IF v_scuola IS DISTINCT FROM v_a.scuola_id THEN
    RAISE EXCEPTION 'SEDE_DIVERSA' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;

  SELECT * INTO v_f FROM public.frequenze WHERE alunno_id = p_alunno AND anno_sede_id = p_anno_sede FOR UPDATE;
  IF FOUND THEN
    IF p_domanda IS NOT NULL AND v_f.domanda_id IS NULL THEN
      UPDATE public.frequenze SET domanda_id = p_domanda WHERE id = v_f.id;
    END IF;
    -- 4.5.15 (M4): la frequenza c'e' gia' e la sezione NON si cambia da qui (la classe la sposta la segreteria, con il suo gesto).
    -- Ma chi ha chiesto una sezione diversa deve saperlo: il silenzio farebbe credere che sia stata applicata.
    IF v_f.stato = 'ritirato' THEN
      -- 4.5.16: la STESSA riga (la coppia bambino-anno e' unica) si riapre. Le chiavi presenti in `p_campi` valgono, con la lista
      -- bianca dell'INSERT; quelle assenti restano come sono. `tipo` e `origine` non cambiano.
      UPDATE public.frequenze f SET
        stato = 'in_attesa',
        data_uscita = NULL,
        section_id = coalesce(p_section, f.section_id),
        domanda_id = coalesce(p_domanda, f.domanda_id),
        retta_mensile = CASE WHEN v_campi ? 'retta_mensile'
          THEN CASE WHEN nullif(v_campi ->> 'retta_mensile', '')::numeric > 0 THEN nullif(v_campi ->> 'retta_mensile', '')::numeric END
          ELSE f.retta_mensile END,
        retta_esente = CASE WHEN v_campi ? 'retta_esente' THEN coalesce((v_campi ->> 'retta_esente')::boolean, false) ELSE f.retta_esente END,
        retta_a_carico_di = CASE WHEN v_campi ? 'retta_a_carico_di' THEN (v_campi ->> 'retta_a_carico_di')::uuid ELSE f.retta_a_carico_di END,
        retta_split_config = CASE WHEN v_campi ? 'retta_split_config' THEN nullif(v_campi -> 'retta_split_config', 'null'::jsonb) ELSE f.retta_split_config END,
        intestatario_fatture = CASE WHEN v_campi ? 'intestatario_fatture' THEN nullif(v_campi -> 'intestatario_fatture', 'null'::jsonb) ELSE f.intestatario_fatture END,
        giorno_scadenza_pagamenti = CASE WHEN v_campi ? 'giorno_scadenza_pagamenti'
          THEN CASE WHEN nullif(v_campi ->> 'giorno_scadenza_pagamenti', '')::integer BETWEEN 1 AND 28 THEN nullif(v_campi ->> 'giorno_scadenza_pagamenti', '')::integer END
          ELSE f.giorno_scadenza_pagamenti END,
        gruppo_mensa_id = CASE WHEN v_campi ? 'gruppo_mensa_id' THEN (v_campi ->> 'gruppo_mensa_id')::uuid ELSE f.gruppo_mensa_id END,
        usa_pannolino = CASE WHEN v_campi ? 'usa_pannolino' THEN coalesce((v_campi ->> 'usa_pannolino')::boolean, false) ELSE f.usa_pannolino END
       WHERE f.id = v_f.id;
      SELECT * INTO v_f FROM public.frequenze WHERE id = v_f.id;
      v_riaperta := true;
    ELSIF v_f.stato IN ('in_attesa', 'iscritto') THEN
      v_ignorata := p_section IS NOT NULL AND v_f.section_id IS DISTINCT FROM p_section;
    ELSE
      -- `trasferito` o `uscito`: non si riapre da qui. La domanda e' stata collegata (sopra); la voce non nasce.
      v_chiusa := true;
    END IF;
  ELSE
    v_retta := nullif(v_campi ->> 'retta_mensile', '')::numeric;
    v_giorno := nullif(v_campi ->> 'giorno_scadenza_pagamenti', '')::integer;
    INSERT INTO public.frequenze
      (alunno_id, anno_sede_id, section_id, domanda_id, tipo, stato, origine, data_ingresso,
       retta_mensile, retta_esente, retta_a_carico_di, retta_split_config, intestatario_fatture,
       giorno_scadenza_pagamenti, gruppo_mensa_id, usa_pannolino)
    VALUES
      (p_alunno, v_a.id, p_section, p_domanda, p_tipo, 'in_attesa', p_origine, coalesce(p_data_ingresso, v_a.inizio),
       CASE WHEN v_retta > 0 THEN v_retta END,
       coalesce((v_campi ->> 'retta_esente')::boolean, false),
       (v_campi ->> 'retta_a_carico_di')::uuid,
       nullif(v_campi -> 'retta_split_config', 'null'::jsonb),
       nullif(v_campi -> 'intestatario_fatture', 'null'::jsonb),
       CASE WHEN v_giorno BETWEEN 1 AND 28 THEN v_giorno END,
       (v_campi ->> 'gruppo_mensa_id')::uuid,
       coalesce((v_campi ->> 'usa_pannolino')::boolean, false))
    ON CONFLICT (alunno_id, anno_sede_id) DO NOTHING
    RETURNING * INTO v_f;
    IF FOUND THEN
      v_creata := true;
    ELSE
      -- Un'altra transazione l'ha scritta un attimo prima: è quella.
      SELECT * INTO v_f FROM public.frequenze WHERE alunno_id = p_alunno AND anno_sede_id = p_anno_sede FOR UPDATE;
    END IF;
  END IF;

  IF v_f.stato IN ('in_attesa', 'iscritto') THEN
    v_quota := public.anno_quota_voce(v_f.id, p_da);
  ELSE
    v_quota := jsonb_build_object('esito', NULL, 'pagamento_id', v_f.quota_pagamento_id);
  END IF;

  SELECT coalesce(s.fascia, CASE WHEN f.section_id IS NULL THEN 'senza_sezione' ELSE 'senza_fascia' END) INTO v_fascia
    FROM public.frequenze f LEFT JOIN public.sections s ON s.id = f.section_id
   WHERE f.id = v_f.id;
  SELECT coalesce(bool_or(c.oltre), false) INTO v_oltre
    FROM public.anno_conta_posti(v_a.id) c WHERE c.fascia = v_fascia;

  RETURN jsonb_build_object('frequenza_id', v_f.id, 'creata', v_creata,
                            'quota', v_quota -> 'esito', 'pagamento_id', v_quota -> 'pagamento_id',
                            'posti_oltre', v_oltre)
         || CASE WHEN v_ignorata THEN jsonb_build_object('sezione_ignorata', true) ELSE '{}'::jsonb END
         || CASE WHEN v_riaperta THEN jsonb_build_object('riaperta', true) ELSE '{}'::jsonb END
         || CASE WHEN v_chiusa THEN jsonb_build_object('chiusa', true) ELSE '{}'::jsonb END;
END
$$;

REVOKE ALL ON FUNCTION public.anno_conta_posti(uuid)                                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_quota_voce(uuid, uuid, date)                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_quota_collega(uuid, uuid)                                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_registra_frequenza(uuid, uuid, text, text, uuid, uuid, date, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_conta_posti(uuid)                                                   TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_quota_voce(uuid, uuid, date)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_quota_collega(uuid, uuid)                                           TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_registra_frequenza(uuid, uuid, text, text, uuid, uuid, date, jsonb, uuid) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- COMPITO 4.5.6 · la conferma per l'anno prossimo e il «non rinnova»
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Due funzioni. Nessuna scrive `alunni`, `section_id`, `classe_sezione` o `importo_retta_mensile`, né la frequenza dell'anno
-- attivo (salvo i due campi del «no» in `anno_non_rinnova`, che sono PROPRIO di quella frequenza): una conferma per l'anno
-- prossimo non cambia un dato dell'anno in corso. La frequenza nuova e la sua voce le scrive `anno_registra_frequenza`.

-- ── anno_conferma ────────────────────────────────────────────────────────────────────────────────
-- La famiglia conferma: dalla frequenza VIVA di partenza (`in_attesa`/`iscritto`, FREQUENZA_NON_VIVA altrimenti) nasce la
-- frequenza `in_attesa` di tipo `conferma`, origine `conferma`, `continua_da` = la partenza, nell'anno aperto della STESSA sede
-- (SEDE_DIVERSA; ANNO_NON_APERTO se non ha le iscrizioni aperte; ANNO_NON_COERENTE se è l'anno della partenza stessa).
--   · sezione: `p_section` se data; altrimenti la CONTINUAZIONE della sezione di partenza (`sections.continua_da`, nell'anno nuovo);
--     senza continuazione resta NULL e la conferma passa;
--   · `p_cambia_grado = true` (la spunta «va alla primaria» della pagina) esige `p_section`: SEZIONE_OBBLIGATORIA. Nessuna sezione
--     può dire da sola che il bambino cambia scuola, per questo è una spunta;
--   · `cambia_grado` nel risultato: `p_cambia_grado`, oppure `school_type` diverso fra la sezione di partenza e quella d'arrivo,
--     oppure `fascia` diversa quando le sezioni ne hanno una tutte e due;
--   · si riportano i campi di famiglia (`retta_esente`, `retta_a_carico_di`, `retta_split_config`, `intestatario_fatture`,
--     `giorno_scadenza_pagamenti`, `gruppo_mensa_id`, `usa_pannolino`); NON si riportano `retta_mensile` (la retta personalizzata
--     di un anno non vale per il successivo: il risultato dice se c'era, `retta_personalizzata_precedente`) né la sospensione;
--   · la quota la fa `anno_registra_frequenza` → `anno_quota_voce`, `tipo 'conferma'`, con la fascia della sezione d'arrivo;
--   · idempotente: rifatta restituisce la stessa frequenza (`creata:false`). Se quella dell'anno prossimo è stata ritirata non si
--     riapre da qui: FREQUENZA_NON_VIVA. «Non rinnova» già segnato non impedisce la conferma (la famiglia ha cambiato idea) e la
--     partenza non viene toccata.
-- Risposta: {frequenza_id, creata, cambia_grado, retta_personalizzata_precedente, quota, pagamento_id, posti_oltre}.
CREATE OR REPLACE FUNCTION public.anno_conferma(
  p_frequenza uuid, p_anno_sede_nuovo uuid, p_section uuid, p_da uuid, p_cambia_grado boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p        public.frequenze%ROWTYPE;
  v_n        public.anni_sede%ROWTYPE;
  v_sezione  uuid := p_section;
  v_tipo_p   text;
  v_fascia_p text;
  v_tipo_n   text;
  v_fascia_n text;
  v_cambia   boolean;
  v_campi    jsonb;
  v_r        jsonb;
  v_nuova    uuid;
  v_stato    text;
  v_sez_reale uuid;
BEGIN
  SELECT * INTO v_p FROM public.frequenze WHERE id = p_frequenza FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'frequenza')::text;
  END IF;
  IF v_p.stato NOT IN ('in_attesa', 'iscritto') THEN
    RAISE EXCEPTION 'FREQUENZA_NON_VIVA' USING DETAIL = json_build_object('frequenza_id', v_p.id, 'stato', v_p.stato)::text;
  END IF;

  SELECT * INTO v_n FROM public.anni_sede WHERE id = p_anno_sede_nuovo FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede_nuovo)::text;
  END IF;
  IF v_n.scuola_id IS DISTINCT FROM v_p.scuola_id THEN
    RAISE EXCEPTION 'SEDE_DIVERSA' USING DETAIL = json_build_object('anno_sede_id', v_n.id)::text;
  END IF;
  IF v_n.id = v_p.anno_sede_id THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE' USING DETAIL = json_build_object('anno_sede_id', v_n.id)::text;
  END IF;
  IF v_n.stato <> 'iscrizioni_aperte' THEN
    RAISE EXCEPTION 'ANNO_NON_APERTO' USING DETAIL = json_build_object('anno_sede_id', v_n.id, 'stato', v_n.stato)::text;
  END IF;

  IF v_sezione IS NULL THEN
    IF coalesce(p_cambia_grado, false) THEN
      RAISE EXCEPTION 'SEZIONE_OBBLIGATORIA' USING DETAIL = json_build_object('frequenza_id', v_p.id)::text;
    END IF;
    -- la continuazione della sezione di partenza, se l'anno nuovo ce l'ha
    IF v_p.section_id IS NOT NULL THEN
      SELECT s.id INTO v_sezione
        FROM public.sections s
       WHERE s.continua_da = v_p.section_id AND s.anno_id = v_n.anno_id AND s.scuola_id = v_n.scuola_id
       ORDER BY s.id
       LIMIT 1;
    END IF;
  END IF;

  -- I campi di famiglia (la lista bianca di `anno_registra_frequenza`); la retta e la sospensione restano fuori.
  v_campi := jsonb_build_object(
    'retta_esente', v_p.retta_esente,
    'retta_a_carico_di', v_p.retta_a_carico_di,
    'retta_split_config', v_p.retta_split_config,
    'intestatario_fatture', v_p.intestatario_fatture,
    'giorno_scadenza_pagamenti', v_p.giorno_scadenza_pagamenti,
    'gruppo_mensa_id', v_p.gruppo_mensa_id,
    'usa_pannolino', v_p.usa_pannolino);

  -- Una frequenza ritirata (4.5.15, «Ritira la conferma») si rifà: la riapre `anno_registra_frequenza`, e solo lui (4.5.16), con la
  -- sezione calcolata qui sopra. Una frequenza chiusa per altro (`trasferito`, `uscito`) non si riapre: FREQUENZA_NON_VIVA, più sotto.
  v_r := public.anno_registra_frequenza(v_p.alunno_id, v_n.id, 'conferma', 'conferma', NULL, v_sezione, NULL, v_campi, p_da);
  v_nuova := (v_r ->> 'frequenza_id')::uuid;

  SELECT f.stato, f.section_id INTO v_stato, v_sez_reale FROM public.frequenze f WHERE f.id = v_nuova;
  IF v_stato NOT IN ('in_attesa', 'iscritto') THEN
    -- la frequenza dell'anno prossimo è stata ritirata: da qui non si riapre (e `registra` non le ha dato una voce)
    RAISE EXCEPTION 'FREQUENZA_NON_VIVA' USING DETAIL = json_build_object('frequenza_id', v_nuova, 'stato', v_stato)::text;
  END IF;

  UPDATE public.frequenze SET continua_da = v_p.id WHERE id = v_nuova AND continua_da IS NULL;

  -- 4.5.16: `cambia_grado` si calcola dalla sezione che la riga ha DAVVERO dopo la registrazione, non da quella chiesta: se la
  -- sezione e' stata ignorata (la riga c'era viva con un'altra) non si dice che cambia grado, a meno della spunta `p_cambia_grado`.
  SELECT s.school_type::text, s.fascia INTO v_tipo_p, v_fascia_p FROM public.sections s WHERE s.id = v_p.section_id;
  SELECT s.school_type::text, s.fascia INTO v_tipo_n, v_fascia_n FROM public.sections s WHERE s.id = v_sez_reale;
  v_cambia := coalesce(p_cambia_grado, false)
    OR (v_p.section_id IS NOT NULL AND v_sez_reale IS NOT NULL
        AND (v_tipo_p IS DISTINCT FROM v_tipo_n
             OR (v_fascia_p IS NOT NULL AND v_fascia_n IS NOT NULL AND v_fascia_p <> v_fascia_n)));

  RETURN jsonb_build_object(
    'frequenza_id', v_nuova,
    'creata', (v_r ->> 'creata')::boolean,
    'cambia_grado', v_cambia,
    'retta_personalizzata_precedente', v_p.retta_mensile IS NOT NULL,
    'quota', v_r -> 'quota',
    'pagamento_id', v_r -> 'pagamento_id',
    'posti_oltre', (v_r ->> 'posti_oltre')::boolean)
    || CASE WHEN (v_r ->> 'sezione_ignorata')::boolean THEN jsonb_build_object('sezione_ignorata', true) ELSE '{}'::jsonb END
    || CASE WHEN (v_r ->> 'riaperta')::boolean THEN jsonb_build_object('riaperta', true) ELSE '{}'::jsonb END;
END
$$;

-- ── anno_non_rinnova ─────────────────────────────────────────────────────────────────────────────
-- Il «no» della famiglia, scritto sulla frequenza di PARTENZA (`non_rinnova_il`, `non_rinnova_motivo`). Il motivo è un codice di
-- un elenco chiuso (`altra_scuola`, `trasloco`, `fine_ciclo`, `motivi_economici`, `altro`) o NULL; altro → PARAMETRO_MANCANTE.
-- `p_attivo = false` azzera tutti e due i campi. Segnare il «no» su una frequenza non viva → FREQUENZA_NON_VIVA. Non toglie né
-- impedisce la conferma. `p_da` è chi ha fatto il gesto: oggi non c'è una colonna dove scriverlo (lo registra il log della route).
-- Risposta: {frequenza_id, non_rinnova, cambiato}.
CREATE OR REPLACE FUNCTION public.anno_non_rinnova(p_frequenza uuid, p_attivo boolean, p_motivo text, p_da uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_f      public.frequenze%ROWTYPE;
BEGIN
  IF p_attivo IS NULL THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'attivo')::text;
  END IF;
  SELECT * INTO v_f FROM public.frequenze WHERE id = p_frequenza FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'frequenza')::text;
  END IF;

  IF NOT p_attivo THEN
    IF v_f.non_rinnova_il IS NULL AND v_f.non_rinnova_motivo IS NULL THEN
      RETURN jsonb_build_object('frequenza_id', v_f.id, 'non_rinnova', false, 'cambiato', false);
    END IF;
    UPDATE public.frequenze SET non_rinnova_il = NULL, non_rinnova_motivo = NULL WHERE id = v_f.id;
    RETURN jsonb_build_object('frequenza_id', v_f.id, 'non_rinnova', false, 'cambiato', true);
  END IF;

  IF p_motivo IS NOT NULL AND p_motivo NOT IN ('altra_scuola', 'trasloco', 'fine_ciclo', 'motivi_economici', 'altro') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'motivo')::text;
  END IF;
  IF v_f.stato NOT IN ('in_attesa', 'iscritto') THEN
    RAISE EXCEPTION 'FREQUENZA_NON_VIVA' USING DETAIL = json_build_object('frequenza_id', v_f.id, 'stato', v_f.stato)::text;
  END IF;

  IF v_f.non_rinnova_il IS NOT NULL AND v_f.non_rinnova_motivo IS NOT DISTINCT FROM p_motivo THEN
    RETURN jsonb_build_object('frequenza_id', v_f.id, 'non_rinnova', true, 'cambiato', false);
  END IF;
  -- la data del primo «no» resta quella: cambiare il motivo non la sposta
  UPDATE public.frequenze
     SET non_rinnova_il = coalesce(non_rinnova_il, now()), non_rinnova_motivo = p_motivo
   WHERE id = v_f.id;
  RETURN jsonb_build_object('frequenza_id', v_f.id, 'non_rinnova', true, 'cambiato', true);
END
$$;

REVOKE ALL ON FUNCTION public.anno_conferma(uuid, uuid, uuid, uuid, boolean)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_non_rinnova(uuid, boolean, text, uuid)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_conferma(uuid, uuid, uuid, uuid, boolean)  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_non_rinnova(uuid, boolean, text, uuid)      TO service_role;
