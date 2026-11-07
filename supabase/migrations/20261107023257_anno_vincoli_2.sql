-- Anno scolastico · PR 2 · V2 · il riempimento finale, la convalida, NOT NULL, i controlli rigidi.
--
-- ATOMICA: una transazione sola. Se UNA riga non è riempibile (un giorno fuori da ogni anno della sede) il file si
-- ferma con ANNO_RIEMPIMENTO_INCOMPLETO e NIENTE cambia (`controlli_rigidi` ancora spento, nessun NOT NULL, `anno_riempi`
-- ancora presente). Nell'ordine:
--   1. l'ultimo `anno_riempi()`: le righe nate fra F1 e questo file (l'app scrive anche mentre si migra);
--   2. il controllo: nessuna riga senza anno e con una sede (`anno_righe_senza_anno_con_sede`);
--   3. `VALIDATE CONSTRAINT` del `<tabella>_anno_id_presente` messo da V1 (non blocca le scritture);
--   4. dove la colonna-sede non può mancare: `SET NOT NULL` (non scandisce: il CHECK convalidato lo dimostra, Postgres >= 12)
--      e `DROP CONSTRAINT` del CHECK, ormai doppio. Sulle tabelle `sede_facoltativa` il CHECK RESTA (è l'unico modo di
--      dire «senza anno solo se senza sede»);
--   5. `controlli_rigidi = true` (il `_dal` lo scrive il trigger della PR 1);
--   6. `anno_invarianti()` con la 12, la 13 e la riga `alunni (senza frequenza)` della 11;
--   7. `DROP FUNCTION anno_riempi`: accende due interruttori e non deve restare una funzione chiamabile;
--   8. la fotografia `finale` del rapporto.
--
-- Rieseguibile: nessun errore, nessuna modifica (`anno_riempi` non c'è più, i CHECK e i NOT NULL sono già a posto,
-- la fotografia finale non si ripete).
-- Nessun uuid di sede, nessuna lettura di `schools.operativa`, ogni tabella dietro `to_regclass`.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

-- 1 · L'ultimo riempimento (se la funzione c'è ancora: alla seconda esecuzione non c'è più).
DO $mig$
DECLARE
  v_t text;
BEGIN
  IF to_regprocedure('public.anno_riempi(text[],date)') IS NOT NULL THEN
    BEGIN
      PERFORM public.anno_riempi();
    EXCEPTION WHEN check_violation THEN
      -- Dopo V1 anche un UPDATE che lascia l'anno NULL è respinto dal CHECK `<tabella>_anno_id_presente`: è lo stesso
      -- caso di una riga non riempibile, e ha lo stesso codice. Si riporta solo il NOME della tabella.
      GET STACKED DIAGNOSTICS v_t = TABLE_NAME;
      RAISE EXCEPTION 'ANNO_RIEMPIMENTO_INCOMPLETO'
        USING DETAIL = json_build_object('tabella', v_t)::text;
    END;
    -- la «prima volta»: solo allora il rapporto riceve la fotografia finale (una riesecuzione non scrive niente)
    PERFORM set_config('anno_scolastico.v2_prima_volta', 'on', true);
  END IF;
END
$mig$;

-- 2 · Il controllo, tabella per tabella. Un conteggio e un nome di tabella: nessun dato.
DO $mig$
DECLARE
  r record;
  v_n bigint;
BEGIN
  FOR r IN SELECT t.tabella FROM public.anno_tabelle t ORDER BY t.tabella LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', r.tabella)) AND c.relkind IN ('r', 'p'))
               OR NOT public.anno_ha_colonna(r.tabella, 'anno_id');
    v_n := public.anno_righe_senza_anno_con_sede(r.tabella);
    IF v_n > 0 THEN
      RAISE EXCEPTION 'ANNO_RIEMPIMENTO_INCOMPLETO'
        USING DETAIL = json_build_object('tabella', r.tabella, 'righe', v_n)::text;
    END IF;
  END LOOP;
END
$mig$;

-- 3 + 4 · Convalida e NOT NULL, in DUE giri. \`SET NOT NULL\` prende \`ACCESS EXCLUSIVE\` e lo tiene fino al commit della
-- migrazione: se stesse nello stesso giro dei \`VALIDATE\` (scansioni complete), le tabelle già bloccate non servirebbero
-- nemmeno le letture mentre si scandiscono quelle dopo. Giro 1: tutte le convalide (\`SHARE UPDATE EXCLUSIVE\`, le
-- scritture e le letture passano). Giro 2, breve: \`SET NOT NULL\` (senza scansione, il CHECK convalidato lo dimostra) e
-- \`DROP CONSTRAINT\`.
DO $mig$
DECLARE
  r       record;
  v_nome  text;
  v_rel   regclass;
  v_nn    boolean;
  v_giro  integer;
BEGIN
  FOR v_giro IN 1..2 LOOP
    FOR r IN SELECT t.* FROM public.anno_tabelle t ORDER BY t.tabella LOOP
      v_rel := to_regclass(format('public.%I', r.tabella));
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_rel AND c.relkind IN ('r', 'p'))
                 OR NOT public.anno_ha_colonna(r.tabella, 'anno_id');
      v_nome := r.tabella || '_anno_id_presente';
      SELECT a.attnotnull INTO v_nn FROM pg_attribute a WHERE a.attrelid = v_rel AND a.attname = 'anno_id' AND NOT a.attisdropped;

      IF v_giro = 1 THEN
        IF r.sede_facoltativa THEN
          -- il CHECK resta: se manca (V1 non applicato) lo si mette ora, poi si convalida
          IF NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = v_rel AND k.conname = v_nome) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (anno_id IS NOT NULL OR %I IS NULL) NOT VALID',
                           r.tabella, v_nome, r.via_sede);
          END IF;
        ELSIF NOT v_nn THEN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = v_rel AND k.conname = v_nome) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (anno_id IS NOT NULL) NOT VALID', r.tabella, v_nome);
          END IF;
        ELSE
          CONTINUE;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = v_rel AND k.conname = v_nome AND NOT k.convalidated) THEN
          EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.tabella, v_nome);
        END IF;
      ELSE
        IF r.sede_facoltativa THEN
          CONTINUE;                       -- il CHECK resta, la colonna ammette NULL
        ELSIF NOT v_nn THEN
          EXECUTE format('ALTER TABLE public.%I ALTER COLUMN anno_id SET NOT NULL', r.tabella);
        END IF;
        -- già NOT NULL (di V2 rieseguita, o di sections e frequenze): un CHECK doppio non serve
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', r.tabella, v_nome);
      END IF;
    END LOOP;
  END LOOP;
END
$mig$;

-- 5 · I controlli rigidi: da qui in poi una scrittura senza anno, o con un anno incoerente, è rifiutata.
UPDATE public.anno_regole SET controlli_rigidi = true WHERE NOT controlli_rigidi;

-- 6 · Le invarianti, con la 12, la 13 e la riga `alunni (senza frequenza)` della 11.
--   12  righe senza anno e con una sede (`anno_righe_senza_anno_con_sede`)                     · per tabella
--   13  nomi di classe e uuid di sezione che non dicono la stessa cosa (`anno_target_divergenti`) · per tabella
--   11  (bis) alunni con una sede che nell'anno attivo non hanno nessuna frequenza              · `alunni (senza frequenza)`
-- Il file di riferimento docs/superpowers/specs/2026-11-06-anno-scolastico-invarianti.sql dice la stessa cosa.
CREATE OR REPLACE FUNCTION public.anno_invarianti()
RETURNS TABLE (invariante text, tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r             public.anno_tabelle%ROWTYPE;
  v_guardia_dal timestamptz;
  v_mappa6      jsonb := '{}'::jsonb;
  v_ha_nera     boolean;
  v_ha_anno     boolean;
  v_fuori       text[];
  v_cond        text[];
  v_col         text;
  v_n           bigint;
  v_trovata     boolean := false;
  d             record;
BEGIN
  -- 1. Nessun giorno senza anno, nessun giorno in due anni.
  SELECT count(*) INTO v_n FROM (
    SELECT s.scuola_id, g::date
      FROM (SELECT a.scuola_id, min(a.inizio) AS da, max(a.fine) AS al
              FROM public.anni_sede a GROUP BY a.scuola_id) s
     CROSS JOIN LATERAL generate_series(s.da::timestamp, s.al::timestamp, interval '1 day') g
      LEFT JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND g::date <@ a.periodo
     GROUP BY s.scuola_id, g::date
    HAVING count(a.id) <> 1) x;
  invariante := '1'; tabella := 'anni_sede'; righe := v_n; RETURN NEXT;

  -- 6, prima parte: le violazioni di tutte le tabelle in una volta sola (poi si distribuiscono).
  SELECT g.guardia_attiva_dal INTO v_guardia_dal FROM public.anno_regole g;
  v_ha_nera := to_regclass('scatola_nera.modifiche') IS NOT NULL;
  IF v_ha_nera AND v_guardia_dal IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_object_agg(x.tabella, x.n), '{}'::jsonb) FROM (
        SELECT m.tabella, count(*) AS n
          FROM scatola_nera.modifiche m
          JOIN public.anno_tabelle t ON t.tabella = m.tabella
         CROSS JOIN LATERAL (SELECT public.anno_guardia_sede(m.tabella, m.prima) AS sede) s
          JOIN public.anni_sede a ON a.scuola_id = s.sede AND a.anno_id = (m.prima ->> 'anno_id')::uuid
         CROSS JOIN LATERAL (SELECT min(st.dal) AS dal FROM public.anni_sede_stati st
                              WHERE st.anno_sede_id = a.id AND st.stato IN ('in_chiusura', 'chiuso')) ch
         WHERE m.modificata_il >= $1
           AND ch.dal IS NOT NULL
           AND m.modificata_il >= ch.dal
           -- le modifiche che la guardia lascia passare apposta non sono un difetto
           AND NOT (
             coalesce((SELECT bool_and(
                         c = ANY (public.anno_colonne_esenti(m.tabella))
                         OR (m.tabella = 'pagamenti' AND c LIKE 'fattura\_%')
                         OR (m.tabella = 'frequenze' AND c IN ('stato', 'quota_pagamento_id')))
                         FROM unnest(m.cambiate) c), false)
             AND (m.tabella <> 'frequenze'
                  OR NOT ('stato' = ANY (m.cambiate))
                  OR m.cambiate && ARRAY['moduli_completi', 'quota_saldata']))
           AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                            WHERE u.transazione = m.transazione AND u.tabella = m.tabella
                              AND (u.riga_id IS NULL OR u.riga_id = m.riga_id))
         GROUP BY m.tabella) x
    $q$ INTO v_mappa6 USING v_guardia_dal;
  END IF;

  FOR r IN SELECT * FROM public.anno_tabelle ORDER BY tabella LOOP
    CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL;
    v_ha_anno := public.anno_ha_colonna(r.tabella, 'anno_id');

    -- 2. Nessuna riga fuori dal suo anno (modo `data`).
    IF r.modo = 'data' THEN
      invariante := '2'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_fuori_periodo(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 6, seconda parte: una riga per tabella (se c'è la scatola nera).
    IF v_ha_nera THEN
      invariante := '6'; tabella := r.tabella; righe := coalesce((v_mappa6 ->> r.tabella)::bigint, 0);
      RETURN NEXT;
    END IF;

    -- 9. Nessuna riga nuova con una sezione di un altro anno.
    IF public.anno_ha_colonna(r.tabella, 'section_id') THEN
      invariante := '9'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_sezione_altro_anno(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 10a. La colonna e il trigger generico (una riga per tabella: 0, 1 o 2 difetti).
    invariante := '10a'; tabella := r.tabella;
    righe := (CASE WHEN v_ha_anno THEN 0 ELSE 1 END)
           + (CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc pr ON pr.oid = tg.tgfoid
                                 WHERE tg.tgrelid = to_regclass(format('public.%I', r.tabella))
                                   AND pr.proname = 'anno_assegna_e_verifica' AND NOT tg.tgisinternal)
                   THEN 0 ELSE 1 END);
    RETURN NEXT;

    -- 12. Nessuna riga senza anno e con una sede da cui ricavarlo.
    invariante := '12'; tabella := r.tabella;
    righe := CASE WHEN v_ha_anno THEN public.anno_righe_senza_anno_con_sede(r.tabella) ELSE 0 END;
    RETURN NEXT;
  END LOOP;

  IF NOT v_ha_nera THEN
    invariante := '6'; tabella := '(scatola_nera assente)'; righe := 0; RETURN NEXT;
  END IF;

  -- 3. Nessuna doppia frequenza viva per lo stesso bambino nello stesso anno.
  SELECT count(*) INTO v_n FROM (
    SELECT f.alunno_id, f.anno_id FROM public.frequenze f
     WHERE f.stato IN ('in_attesa', 'iscritto')
     GROUP BY f.alunno_id, f.anno_id HAVING count(*) > 1) x;
  invariante := '3'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;

  -- 4. Nessun «iscritto» senza moduli o senza quota, ricalcolato dalla verità e non dai flag.
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.stato = 'iscritto' AND f.origine <> 'recupero'
     AND (EXISTS (SELECT 1 FROM public.moduli_richiesti m
                   WHERE m.anno_sede_id = f.anno_sede_id AND m.lista = f.tipo
                     AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                                      WHERE fm.frequenza_id = f.id AND fm.modulo_id = m.id))
          OR q.id IS NULL OR q.stato <> 'pagato');
  invariante := '4'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;
  --    4-bis. I flag dicono la verità (vale anche per chi non è «iscritto»).
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.quota_saldata IS DISTINCT FROM (q.id IS NOT NULL AND q.stato = 'pagato');
  invariante := '4'; tabella := 'frequenze (flag)'; righe := v_n; RETURN NEXT;

  -- 5. Nessuna competenza fuori dal periodo del suo anno.
  v_n := 0;
  IF to_regclass('public.pagamenti') IS NOT NULL AND public.anno_ha_colonna('pagamenti', 'anno_id') THEN
    EXECUTE 'SELECT count(*) FROM public.pagamenti p '
            'JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id '
            'WHERE p.periodo_competenza IS NOT NULL AND NOT (p.periodo_competenza <@ a.periodo)'
    INTO v_n;
  END IF;
  invariante := '5'; tabella := 'pagamenti'; righe := v_n; RETURN NEXT;

  -- 10b. Una tabella con `anno_id` che il registro non conosce.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_fuori
    FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND at.attname = 'anno_id' AND at.attnum > 0 AND NOT at.attisdropped
     AND c.relname NOT IN ('anni_sede', 'riconciliazione_anno')
     AND c.relname NOT IN (SELECT t.tabella FROM public.anno_tabelle t);
  IF v_fuori IS NULL THEN
    invariante := '10b'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  ELSE
    FOREACH v_col IN ARRAY v_fuori LOOP
      invariante := '10b'; tabella := v_col; righe := 1; RETURN NEXT;
    END LOOP;
  END IF;

  -- 11. La scheda alunno e la frequenza dell'anno attivo dicono la stessa cosa (solo chi ha la frequenza).
  --     Si confrontano `section_id` e i campi con lo STESSO nome e lo STESSO tipo su `alunni` e
  --     `frequenze`; lo stato e la retta hanno nomi e significati diversi e restano fuori.
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL THEN
    v_cond := ARRAY['al.section_id IS DISTINCT FROM f.section_id'];
    FOREACH v_col IN ARRAY ARRAY['retta_a_carico_di', 'gruppo_mensa_id', 'giorno_scadenza_pagamenti',
                                 'usa_pannolino', 'retta_split_config', 'intestatario_fatture'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute x JOIN pg_attribute y ON y.attname = x.attname AND y.atttypid = x.atttypid
                  WHERE x.attrelid = 'public.alunni'::regclass AND y.attrelid = 'public.frequenze'::regclass
                    AND x.attname = v_col AND x.attnum > 0 AND y.attnum > 0
                    AND NOT x.attisdropped AND NOT y.attisdropped) THEN
        v_cond := v_cond || format('al.%I IS DISTINCT FROM f.%I', v_col, v_col);
      END IF;
    END LOOP;
    EXECUTE 'SELECT count(*) FROM public.alunni al '
            'JOIN public.frequenze f ON f.alunno_id = al.id AND f.anno_sede_id = public.anno_attivo(al.scuola_id) '
            'WHERE ' || array_to_string(v_cond, ' OR ')
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni'; righe := v_n; RETURN NEXT;

  --     11-bis. Un alunno con una sede deve avere la frequenza dell'anno attivo (lo specchio la crea).
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.scuola_id IS NOT NULL '
            'AND public.anno_attivo(al.scuola_id) IS NOT NULL '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = al.id '
            'AND f.anno_sede_id = public.anno_attivo(al.scuola_id))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (senza frequenza)'; righe := v_n; RETURN NEXT;

  -- 13. I nomi di classe e gli uuid di sezione dicono la stessa cosa (una riga per tabella che ha le due colonne).
  FOR d IN SELECT x.tabella AS t, x.righe AS n FROM public.anno_target_divergenti() x LOOP
    v_trovata := true;
    invariante := '13'; tabella := d.t; righe := d.n; RETURN NEXT;
  END LOOP;
  IF NOT v_trovata THEN
    invariante := '13'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  END IF;

  RETURN;
END
$$;

REVOKE ALL ON FUNCTION public.anno_invarianti() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_invarianti() TO service_role;

-- 7 · `anno_riempi` non c'è più.
DROP FUNCTION IF EXISTS public.anno_riempi(text[], date);

-- 8 · La fotografia FINALE del rapporto: `anno_riconciliazione_differenze()` la confronta con la `prima`.
DO $mig$
BEGIN
  IF current_setting('anno_scolastico.v2_prima_volta', true) = 'on' THEN
    PERFORM public.anno_fotografa('finale');
  END IF;
END
$mig$;
