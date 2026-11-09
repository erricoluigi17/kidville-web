-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.6 · «Rette e servizi dal listino» · M46b (compito 4.6.2)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- CONTIENE:
--   · `anno_listino_retta_imposta(anno_sede, voce, fascia, categoria, importo, mesi) → jsonb`: la segreteria scrive la
--     retta (o il servizio) del listino dell'anno e i mesi in cui si genera.
--
-- Sta DOPO M46a e non dipende da lei. Nessun UPDATE di dati, nessun uuid di sede, nessun interruttore del freno.
--
-- LE REGOLE
--   · `voce` solo `retta` | `servizio` (le quote sono di `anno_listino_quota_imposta`). `fascia` NULL = «per tutte le fasce».
--   · L'anno dev'essere `in_preparazione`, `iscrizioni_aperte` o `corrente` (ANNO_NON_MODIFICABILE): in un anno in corso la retta
--     si può correggere, e le voci già create NON cambiano importo (la generazione legge il listino quando genera).
--   · `importo` NULL toglie la riga (`cambiato` dice se c'era). Altrimenti dev'essere > 0 anche dopo l'arrotondamento ai
--     centesimi (IMPORTO_NON_VALIDO): lo zero non esiste.
--   · `mesi` NULL = non toccare i mesi (una riga nuova resta a NULL = settembre-giugno). Ammessi solo con `fascia` NULL (i mesi
--     per fascia non esistono: PARAMETRO_MANCANTE, campo `mesi`), non vuoti e dentro 1..12.
--   · La categoria: quella della riga che c'è già per la stessa voce e fascia, altrimenti quella della riga senza fascia dello
--     stesso anno, altrimenti — per la `retta` — la categoria di sistema `retta` (quella della sede ha la precedenza sulla
--     globale). Per un `servizio` la categoria va dichiarata (PARAMETRO_MANCANTE, campo `categoria`).
--   · SPECCHIO: la retta SENZA fascia di un anno `corrente` si riscrive anche in `admin_settings.retta_default_importo` della
--     sede, se la colonna c'è. Quel numero lo leggono ancora la stima dell'importo nell'approvazione delle domande e il commento
--     dell'import: senza specchio direbbero il falso. Un anno in preparazione NON lo tocca. Si toglie nella PR 5.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.anno_listino_retta_imposta(
  p_anno_sede uuid,
  p_voce      text,
  p_fascia    text,
  p_categoria uuid,
  p_importo   numeric,
  p_mesi      smallint[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a      public.anni_sede%ROWTYPE;
  v_r      public.listino_voci%ROWTYPE;
  v_cat    uuid;
  v_n      integer;
  v_m      smallint;
  v_imp    numeric;
  v_mesi   smallint[];
  v_camb   boolean;
BEGIN
  IF p_voce IS NULL OR p_voce NOT IN ('retta', 'servizio') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'voce')::text;
  END IF;
  IF p_fascia IS NOT NULL AND p_fascia NOT IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'fascia')::text;
  END IF;
  -- togliere una riga e dare dei mesi insieme non ha senso: i mesi si perderebbero in silenzio
  IF p_importo IS NULL AND p_mesi IS NOT NULL THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'mesi')::text;
  END IF;
  -- i mesi: solo sulla riga senza fascia, non vuoti, dentro 1..12
  IF p_mesi IS NOT NULL THEN
    IF p_fascia IS NOT NULL OR cardinality(p_mesi) = 0 THEN
      RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'mesi')::text;
    END IF;
    FOREACH v_m IN ARRAY p_mesi LOOP
      IF v_m IS NULL OR v_m < 1 OR v_m > 12 THEN
        RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'mesi')::text;
      END IF;
    END LOOP;
    -- ordinati e senza doppioni: due scritture dello stesso elenco non risultano «cambiate»
    SELECT array_agg(DISTINCT x ORDER BY x) INTO v_mesi FROM unnest(p_mesi) AS x;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte', 'corrente') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  -- la categoria della riga
  v_cat := p_categoria;
  IF v_cat IS NULL THEN
    SELECT l.payment_category_id INTO v_cat FROM public.listino_voci l
     WHERE l.anno_sede_id = v_a.id AND l.voce = p_voce AND l.fascia IS NOT DISTINCT FROM p_fascia
       AND l.payment_category_id IS NOT NULL
     ORDER BY l.id LIMIT 1;
  END IF;
  IF v_cat IS NULL AND p_fascia IS NOT NULL THEN
    SELECT l.payment_category_id INTO v_cat FROM public.listino_voci l
     WHERE l.anno_sede_id = v_a.id AND l.voce = p_voce AND l.fascia IS NULL AND l.payment_category_id IS NOT NULL
     ORDER BY l.id LIMIT 1;
  END IF;
  IF v_cat IS NULL AND p_voce = 'retta' THEN
    SELECT pc.id INTO v_cat FROM public.payment_categories pc
     WHERE pc.slug = 'retta' AND (pc.scuola_id = v_a.scuola_id OR pc.scuola_id IS NULL)
     ORDER BY pc.scuola_id NULLS LAST LIMIT 1;
  END IF;
  IF v_cat IS NULL THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'categoria')::text;
  END IF;

  -- NULL toglie la riga
  IF p_importo IS NULL THEN
    DELETE FROM public.listino_voci
     WHERE anno_sede_id = v_a.id AND voce = p_voce
       AND fascia IS NOT DISTINCT FROM p_fascia AND payment_category_id = v_cat;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('cambiato', v_n > 0, 'voce', p_voce, 'fascia', p_fascia, 'importo', NULL);
  END IF;

  IF p_importo <= 0 OR p_importo >= 100000000 THEN
    RAISE EXCEPTION 'IMPORTO_NON_VALIDO' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  v_imp := round(p_importo, 2);
  IF v_imp <= 0 THEN
    RAISE EXCEPTION 'IMPORTO_NON_VALIDO' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;

  SELECT * INTO v_r FROM public.listino_voci
   WHERE anno_sede_id = v_a.id AND voce = p_voce
     AND fascia IS NOT DISTINCT FROM p_fascia AND payment_category_id = v_cat;
  IF NOT FOUND THEN
    INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, payment_category_id, importo, mesi)
    VALUES (v_a.id, p_voce, p_fascia, v_cat, v_imp, v_mesi);
    v_camb := true;
  ELSIF v_r.importo IS DISTINCT FROM v_imp OR (v_mesi IS NOT NULL AND v_r.mesi IS DISTINCT FROM v_mesi) THEN
    UPDATE public.listino_voci
       SET importo = v_imp, mesi = COALESCE(v_mesi, mesi)
     WHERE id = v_r.id;
    v_camb := true;
  ELSE
    v_camb := false;
  END IF;

  -- lo specchio del default di sede: solo la retta senza fascia dell'anno in corso, e solo se la colonna c'è
  IF p_voce = 'retta' AND p_fascia IS NULL AND v_a.stato = 'corrente'
     AND to_regclass('public.admin_settings') IS NOT NULL
     AND public.anno_ha_colonna('admin_settings', 'retta_default_importo') THEN
    EXECUTE 'UPDATE public.admin_settings SET retta_default_importo = $1 WHERE scuola_id = $2' USING v_imp, v_a.scuola_id;
  END IF;

  RETURN jsonb_build_object('cambiato', v_camb, 'voce', p_voce, 'fascia', p_fascia, 'importo', v_imp);
END
$$;

REVOKE ALL ON FUNCTION public.anno_listino_retta_imposta(uuid, text, text, uuid, numeric, smallint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_listino_retta_imposta(uuid, text, text, uuid, numeric, smallint[]) TO service_role;
