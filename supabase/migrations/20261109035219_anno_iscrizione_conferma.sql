-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.5 · «Preparare e aprire l'anno prossimo» · M45c, iscrizione e conferma (compiti 4.5.5 e 4.5.6)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- TESTATA: il file nasce vuoto nel compito 4.5.0 (scheletro) e lo riempiono i compiti 4.5.5 (parte 1) e 4.5.6 (parte 2,
-- in fondo al file). Nessuna logica qui. Sta DOPO M45d: `anno_quota_voce` legge `listino_voci.scadenza`, che nasce lì.
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
-- Per ogni fascia: quanti `in_attesa` e `iscritto` ci sono (fascia della SEZIONE della frequenza; senza sezione `senza_sezione`),
-- quanti posti autorizzati ci sono (NULL se nessuno li ha dichiarati) e se i primi superano i secondi. Un avviso, mai un blocco.
CREATE OR REPLACE FUNCTION public.anno_conta_posti(p_anno_sede uuid)
RETURNS TABLE (fascia text, iscritti bigint, posti integer, oltre boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH conteggio AS (
    SELECT coalesce(s.fascia, 'senza_sezione')::text AS fascia, count(*) AS n
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
-- domanda e la riga non ne ha una, la collega: una frequenza ritirata non si riapre e non riceve una voce (`quota` NULL).
-- MAI blocca per i posti: `posti_oltre` è un avviso.
-- Risposta: {frequenza_id, creata, quota, pagamento_id, posti_oltre}.
CREATE OR REPLACE FUNCTION public.anno_registra_frequenza(
  p_alunno uuid, p_anno_sede uuid, p_tipo text, p_origine text, p_domanda uuid,
  p_section uuid, p_data_ingresso date, p_campi jsonb)
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
    v_quota := public.anno_quota_voce(v_f.id, NULL);
  ELSE
    v_quota := jsonb_build_object('esito', NULL, 'pagamento_id', v_f.quota_pagamento_id);
  END IF;

  SELECT coalesce(s.fascia, 'senza_sezione') INTO v_fascia
    FROM public.frequenze f LEFT JOIN public.sections s ON s.id = f.section_id
   WHERE f.id = v_f.id;
  SELECT coalesce(bool_or(c.oltre), false) INTO v_oltre
    FROM public.anno_conta_posti(v_a.id) c WHERE c.fascia = v_fascia;

  RETURN jsonb_build_object('frequenza_id', v_f.id, 'creata', v_creata,
                            'quota', v_quota -> 'esito', 'pagamento_id', v_quota -> 'pagamento_id',
                            'posti_oltre', v_oltre);
END
$$;

REVOKE ALL ON FUNCTION public.anno_conta_posti(uuid)                                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_quota_voce(uuid, uuid, date)                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_quota_collega(uuid, uuid)                                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_registra_frequenza(uuid, uuid, text, text, uuid, uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_conta_posti(uuid)                                                   TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_quota_voce(uuid, uuid, date)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_quota_collega(uuid, uuid)                                           TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_registra_frequenza(uuid, uuid, text, text, uuid, uuid, date, jsonb) TO service_role;
