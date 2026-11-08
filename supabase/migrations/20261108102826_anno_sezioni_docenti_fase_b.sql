-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.3 · «Sezioni e docenti per anno, fase B»
-- Un solo file per la PR; ogni compito SQL aggiunge una sezione in coda, con la sua testata.
-- Qui arrivano, nell'ordine: (4.3.1) la visibilità delle sezioni per i docenti e (4.3.2) l'invariante 8.
-- In coda arriveranno la rinomina delle sezioni per anno e la fase B dello specchio fra `alunni` e `frequenze`.
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 4.3.1 Le sezioni che un docente vede ──────────────────────────────────────────────────────────
--
-- Un docente vede le sezioni a cui è assegnato — direttamente (`utenti_sezioni`) o per materia
-- (`utenti_sezioni_materie`), senza doppioni: la regola «contano sia le assegnazioni dirette sia quelle per materia»
-- sta SOLO qui, e il codice (anagrafica, fascicolo, avvisi…) chiama la funzione. L'anno della sezione, PER LA SEDE DELLA
-- SEZIONE, è `corrente` (scrivibile), `in_chiusura` o `chiuso` (sola lettura). Un anno `in_preparazione` o con
-- `iscrizioni_aperte` non compare MAI: le sezioni del prossimo anno si preparano, ma i docenti non le vedono
-- finché l'anno non è iniziato. Un anno `chiuso` compare solo se il docente è assegnato a quella sezione.
-- La sola lettura la impone il codice applicativo (la guardia dell'anno chiuso è ancora spenta): qui la si dichiara.
CREATE OR REPLACE FUNCTION public.sezioni_visibili_docente(p_utente uuid)
RETURNS TABLE (section_id uuid, sola_lettura boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH assegnate AS (
    SELECT us.section_id FROM public.utenti_sezioni us WHERE us.utente_id = p_utente
    UNION
    SELECT um.section_id FROM public.utenti_sezioni_materie um WHERE um.utente_id = p_utente
  )
  SELECT x.section_id, (a.stato::text <> 'corrente')
    FROM assegnate x
    JOIN public.sections s    ON s.id = x.section_id
    JOIN public.anni_sede a   ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
   WHERE a.stato::text IN ('corrente', 'in_chiusura', 'chiuso')
$$;

-- Le sole sezioni SCRIVIBILI (quelle dell'anno attivo della loro sede): servono alle liste. Stessa regola di
-- assegnazione (dirette + per materia).
CREATE OR REPLACE FUNCTION public.sezioni_docente_anno_attivo(p_utente uuid)
RETURNS TABLE (section_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH assegnate AS (
    SELECT us.section_id FROM public.utenti_sezioni us WHERE us.utente_id = p_utente
    UNION
    SELECT um.section_id FROM public.utenti_sezioni_materie um WHERE um.utente_id = p_utente
  )
  SELECT x.section_id
    FROM assegnate x
    JOIN public.sections s ON s.id = x.section_id
    JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
   WHERE a.id = public.anno_attivo(s.scuola_id)
$$;

REVOKE ALL ON FUNCTION public.sezioni_visibili_docente(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sezioni_docente_anno_attivo(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sezioni_visibili_docente(uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.sezioni_docente_anno_attivo(uuid) TO service_role;

-- ── 4.3.2 anno_invarianti: la riga 8 ──────────────────────────────────────────────────────────────
--
-- La definizione di `20261108052944_anno_impostazioni_sede.sql` (M-2), identica salvo la riga 8:
-- «i docenti vedono solo sezioni di anni attivi o passati». `righe` = quante delle sezioni che
-- `sezioni_visibili_docente` RESTITUISCE (per ogni docente assegnato) appartengono a un anno `in_preparazione` o
-- `iscrizioni_aperte`, letto dal catalogo (`anni_sede.stato`) e non dalla funzione di visibilità: se questa perde il
-- filtro sullo stato la riga sale sopra zero, altrimenti sarebbe vera per costruzione. Emessa sempre, anche a zero.
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
          -- `nessuna` e `solo_contenuto` non guardano gli UPDATE (la scatola nera registra solo UPDATE): non sono un difetto
          JOIN public.anno_tabelle t ON t.tabella = m.tabella AND t.guardia = 'piena'
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

    -- 14. «madre ⇒ FK» (Ruling P5; corretta in 4.2.M): ogni tabella `madre` ha una chiave esterna vera dalla colonna
    --     `madre_colonna` alla tabella madre. La chiave può essere COMPOSTA (le `votazioni_*` hanno
    --     `(votazione_id, scuola_id)`): conta se contiene la `madre_colonna` E garantisce davvero la madre, cioè ha una
    --     colonna sola, oppure è MATCH FULL, oppure tutte le sue colonne sono NOT NULL. Una composta MATCH SIMPLE con una
    --     colonna che ammette NULL non basta: con quella colonna NULL Postgres non controlla la chiave.
    IF r.modo = 'madre' THEN
      invariante := '14'; tabella := r.tabella;
      righe := CASE WHEN EXISTS (
                 SELECT 1 FROM pg_constraint c
                  WHERE c.contype = 'f'
                    AND c.conrelid = to_regclass(format('public.%I', r.tabella))
                    AND c.confrelid = to_regclass(format('public.%I', r.madre_tabella))
                    AND EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                  JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                 WHERE at.attname = r.madre_colonna)
                    AND (cardinality(c.conkey) = 1
                         OR c.confmatchtype = 'f'
                         OR NOT EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                          JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                         WHERE NOT at.attnotnull))) THEN 0 ELSE 1 END;
      RETURN NEXT;
    END IF;
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
    -- Fase B (4.3.4): l'invariante guarda anche ciò che lo specchio inverso scrive in più (sospensione).
    FOREACH v_col IN ARRAY ARRAY['retta_a_carico_di', 'gruppo_mensa_id', 'giorno_scadenza_pagamenti',
                                 'usa_pannolino', 'retta_split_config', 'intestatario_fatture',
                                 'sospeso', 'sospeso_causa', 'sospeso_motivo', 'sospeso_il', 'sospeso_da'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute x JOIN pg_attribute y ON y.attname = x.attname AND y.atttypid = x.atttypid
                  WHERE x.attrelid = 'public.alunni'::regclass AND y.attrelid = 'public.frequenze'::regclass
                    AND x.attname = v_col AND x.attnum > 0 AND y.attnum > 0
                    AND NOT x.attisdropped AND NOT y.attisdropped) THEN
        v_cond := v_cond || format('al.%I IS DISTINCT FROM f.%I', v_col, v_col);
      END IF;
    END LOOP;
    -- archiviato ↔ frequenza chiusa (NON `alunni.stato`: la tendina può dire «ritirato» senza archiviare) e retta
    -- (lo zero di `alunni` è NULL nella frequenza).
    IF EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = 'public.alunni'::regclass
                  AND x.attname = 'archiviato_il' AND x.attnum > 0 AND NOT x.attisdropped) THEN
      v_cond := v_cond || ARRAY['(al.archiviato_il IS NOT NULL) IS DISTINCT FROM (f.stato IN (''ritirato'', ''trasferito'', ''uscito''))'];
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = 'public.alunni'::regclass
                  AND x.attname = 'importo_retta_mensile' AND x.attnum > 0 AND NOT x.attisdropped) THEN
      v_cond := v_cond || ARRAY['nullif(al.importo_retta_mensile, 0) IS DISTINCT FROM f.retta_mensile'];
    END IF;
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

  -- 8. I docenti vedono solo sezioni di anni attivi o passati (PR 4.3). Si passa dalla funzione di visibilità
  --    per ogni docente assegnato e si conta quante delle sezioni che restituisce hanno, nel catalogo
  --    (`anni_sede.stato`), un anno ancora in preparazione o con le iscrizioni aperte: deve essere zero.
  v_n := 0;
  IF to_regclass('public.utenti_sezioni') IS NOT NULL AND to_regclass('public.sections') IS NOT NULL THEN
    SELECT count(*) INTO v_n
      FROM (SELECT us.utente_id FROM public.utenti_sezioni us
             UNION SELECT um.utente_id FROM public.utenti_sezioni_materie um) u
     CROSS JOIN LATERAL public.sezioni_visibili_docente(u.utente_id) v
      JOIN public.sections s  ON s.id = v.section_id
      JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
     WHERE a.stato::text IN ('in_preparazione', 'iscrizioni_aperte');
  END IF;
  invariante := '8'; tabella := 'utenti_sezioni'; righe := v_n; RETURN NEXT;

  RETURN;
END
$$;

REVOKE ALL ON FUNCTION public.anno_invarianti() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_invarianti() TO service_role;

-- ══ 4.3.3 · la rinomina di una sezione propaga PER ANNO (Ruling R-43-4) ═══════════════════════════════
-- Prima (PR 1, R17) la funzione usciva subito se la sezione non era dell'anno attivo: rinominare una
-- sezione del 2027/28 non toccava nemmeno gli avvisi e la galleria del 2027/28. Ora:
--  · le tabelle con `anno_id` (registro_orario, avvisi, galleria_media_v2) propagano SEMPRE, alle sole
--    righe dell'anno della sezione (le righe senza anno, solo se la sezione è dell'anno attivo);
--  · le tabelle senza `anno_id` (alunni, news_posts, forms_templates, mensa_class_menu_assignment)
--    propagano SOLO se la sezione è dell'anno attivo: il loro testo descrive la classe di oggi.
CREATE OR REPLACE FUNCTION public.propaga_rinomina_sezione()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- La forma normalizzata: la stessa dell'indice `sections_forma_normalizzata_per_sede`.
  v_forma_vecchia text;
  v_forma_nuova   text;

  -- La sezione è dell'anno attivo della sua sede?
  v_attivo boolean;

  -- Le tabelle che sul database E2E della CI possono non esserci.
  v_ha_registro_orario             boolean;
  v_ha_avvisi                      boolean;
  v_ha_news_posts                  boolean;
  v_ha_galleria_media_v2           boolean;
  v_ha_forms_templates             boolean;
  v_ha_mensa_class_menu_assignment boolean;

  -- Quante righe sono state riscritte, tabella per tabella.
  v_alunni          integer := 0;
  v_orfani_ids      uuid[] := '{}';
  v_alunni_orfani   integer := 0;
  v_registro        integer := 0;
  v_avvisi          integer := 0;
  v_news            integer := 0;
  v_galleria        integer := 0;
  v_forms           integer := 0;
  v_mensa           integer := 0;

  -- Quante sono state SALTATE perché la chiave col nome nuovo era già occupata.
  v_registro_attese  integer := 0;
  v_registro_saltate integer := 0;
  v_mensa_attese     integer := 0;
  v_mensa_saltate    integer := 0;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM public.anni_sede a
            WHERE a.id = public.anno_attivo(NEW.scuola_id)
              AND a.anno_id = NEW.anno_id)
    INTO v_attivo;

  v_forma_vecchia := lower(replace(OLD.name::text, ' ', ''));
  v_forma_nuova   := lower(replace(NEW.name::text, ' ', ''));

  -- ─── Le guardie: la tabella c'è, e ha le colonne che servono ────────────────
  -- Si legge `pg_attribute` e non `information_schema`: quest'ultimo nasconde le
  -- colonne su cui il ruolo corrente non ha privilegi, e una guardia che dice
  -- «assente» invece di «non ti è permesso vederla» salterebbe la propagazione
  -- senza che nessuno capisca perché.
  SELECT count(*) = 6 INTO v_ha_registro_orario
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.registro_orario')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = attrelid AND c.relkind IN ('r', 'p'))
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'classe_sezione', 'section_id', 'data', 'ora_lezione', 'anno_id');

  SELECT count(*) = 3 INTO v_ha_avvisi
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.avvisi')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = attrelid AND c.relkind IN ('r', 'p'))
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes', 'anno_id');

  SELECT count(*) = 2 INTO v_ha_news_posts
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.news_posts')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = attrelid AND c.relkind IN ('r', 'p'))
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 3 INTO v_ha_galleria_media_v2
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.galleria_media_v2')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = attrelid AND c.relkind IN ('r', 'p'))
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes', 'anno_id');

  SELECT count(*) = 2 INTO v_ha_forms_templates
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.forms_templates')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = attrelid AND c.relkind IN ('r', 'p'))
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 3 INTO v_ha_mensa_class_menu_assignment
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.mensa_class_menu_assignment')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = attrelid AND c.relkind IN ('r', 'p'))
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'classe', 'attivo_dal');

  -- ─── 1. Gli alunni agganciati alla sezione per uuid ─────────────────────────
  -- ⚠️ Questo UPDATE risveglia `trg_alunni_sync_section`, che ricalcola
  -- `section_id` sul nome nuovo e ritrova la stessa riga. Nessun ciclo: quel
  -- trigger non scrive su `sections`.
  UPDATE public.alunni a
     SET classe_sezione = NEW.name
   WHERE a.scuola_id = NEW.scuola_id
     AND a.section_id = NEW.id
     AND v_attivo
     AND a.classe_sezione IS DISTINCT FROM NEW.name;
  GET DIAGNOSTICS v_alunni = ROW_COUNT;

  -- ─── 2. Gli alunni SENZA section_id, riconosciuti per forma normalizzata ────
  -- Sono quelli che il ramo qui sopra non può vedere. Si riaggancia anche
  -- `section_id`: l'indice unico sulla forma normalizzata garantisce che per una
  -- sede e una forma ci sia al massimo una sezione, quindi «la sua» non è una
  -- scelta arbitraria.
  -- 4.3.5: questo ramo CAMBIA `section_id` di `alunni` (da NULL alla sezione), quindi in fase B la frequenza dell'anno
  -- attivo deve seguirla, altrimenti la prossima scrittura della frequenza annullerebbe il riaggancio.
  WITH riagganciati AS (
    UPDATE public.alunni a
       SET classe_sezione = NEW.name,
           section_id     = NEW.id
     WHERE a.scuola_id = NEW.scuola_id
       AND v_attivo
       AND a.section_id IS NULL
       AND a.classe_sezione IS NOT NULL
       AND lower(replace(a.classe_sezione::text, ' ', '')) IN (v_forma_vecchia, v_forma_nuova)
    RETURNING a.id
  )
  SELECT coalesce(array_agg(riagganciati.id), '{}'::uuid[]) INTO v_orfani_ids FROM riagganciati;
  v_alunni_orfani := coalesce(cardinality(v_orfani_ids), 0);
  IF v_alunni_orfani > 0 THEN
    PERFORM public.frequenza_segue_classe_alunno(x) FROM unnest(v_orfani_ids) AS x;
  END IF;

  -- ─── 3. Il registro orario ──────────────────────────────────────────────────
  -- Il legame per `section_id` viene PRIMA del nome: è l'unico che sopravvive a
  -- una divergenza del testo, ed è l'unico che raggiunge le 14 righe già rimaste
  -- indietro in produzione. Il nome vecchio serve solo per le righe che un
  -- `section_id` non ce l'hanno.
  IF v_ha_registro_orario THEN
    SELECT count(*) INTO v_registro_attese
      FROM public.registro_orario r
     WHERE r.scuola_id = NEW.scuola_id
       AND (r.anno_id = NEW.anno_id OR (v_attivo AND r.anno_id IS NULL))
       AND (r.section_id = NEW.id
            OR (r.section_id IS NULL
                AND lower(replace(r.classe_sezione::text, ' ', '')) = v_forma_vecchia))
       AND r.classe_sezione IS DISTINCT FROM NEW.name;

    WITH scelte AS (
      SELECT DISTINCT ON (r.data, r.ora_lezione) r.id
        FROM public.registro_orario r
       WHERE r.scuola_id = NEW.scuola_id
       AND (r.anno_id = NEW.anno_id OR (v_attivo AND r.anno_id IS NULL))
         AND (r.section_id = NEW.id
              OR (r.section_id IS NULL
                  AND lower(replace(r.classe_sezione::text, ' ', '')) = v_forma_vecchia))
         AND r.classe_sezione IS DISTINCT FROM NEW.name
         AND NOT EXISTS (
               SELECT 1
                 FROM public.registro_orario occupata
                WHERE occupata.scuola_id = NEW.scuola_id
                  AND occupata.classe_sezione = NEW.name
                  AND occupata.data = r.data
                  AND occupata.ora_lezione = r.ora_lezione)
       ORDER BY r.data, r.ora_lezione, (r.section_id = NEW.id) DESC NULLS LAST, r.id
    )
    UPDATE public.registro_orario r
       SET classe_sezione = NEW.name
      FROM scelte s
     WHERE r.id = s.id
       AND r.scuola_id = NEW.scuola_id;
    GET DIAGNOSTICS v_registro = ROW_COUNT;
    v_registro_saltate := v_registro_attese - v_registro;
  END IF;

  -- ─── 4. I destinatari degli avvisi ──────────────────────────────────────────
  IF v_ha_avvisi THEN
    UPDATE public.avvisi t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND (t.anno_id = NEW.anno_id OR (v_attivo AND t.anno_id IS NULL))
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_avvisi = ROW_COUNT;
  END IF;

  -- ─── 5. I destinatari delle news ────────────────────────────────────────────
  IF v_ha_news_posts AND v_attivo THEN
    UPDATE public.news_posts t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_news = ROW_COUNT;
  END IF;

  -- ─── 6. I destinatari della galleria ────────────────────────────────────────
  IF v_ha_galleria_media_v2 THEN
    UPDATE public.galleria_media_v2 t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND (t.anno_id = NEW.anno_id OR (v_attivo AND t.anno_id IS NULL))
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_galleria = ROW_COUNT;
  END IF;

  -- ─── 7. I destinatari della modulistica ─────────────────────────────────────
  IF v_ha_forms_templates AND v_attivo THEN
    UPDATE public.forms_templates t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_forms = ROW_COUNT;
  END IF;

  -- ─── 8. L'assegnazione del menu di mensa ────────────────────────────────────
  IF v_ha_mensa_class_menu_assignment AND v_attivo THEN
    SELECT count(*) INTO v_mensa_attese
      FROM public.mensa_class_menu_assignment m
     WHERE m.scuola_id = NEW.scuola_id
       AND lower(replace(m.classe, ' ', '')) = v_forma_vecchia
       AND m.classe IS DISTINCT FROM NEW.name::text;

    WITH scelte AS (
      SELECT DISTINCT ON (m.attivo_dal) m.id
        FROM public.mensa_class_menu_assignment m
       WHERE m.scuola_id = NEW.scuola_id
         AND lower(replace(m.classe, ' ', '')) = v_forma_vecchia
         AND m.classe IS DISTINCT FROM NEW.name::text
         AND NOT EXISTS (
               SELECT 1
                 FROM public.mensa_class_menu_assignment occupata
                WHERE occupata.scuola_id = NEW.scuola_id
                  AND occupata.classe = NEW.name::text
                  AND occupata.attivo_dal = m.attivo_dal)
       ORDER BY m.attivo_dal, m.id
    )
    UPDATE public.mensa_class_menu_assignment m
       SET classe = NEW.name::text
      FROM scelte s
     WHERE m.id = s.id
       AND m.scuola_id = NEW.scuola_id;
    GET DIAGNOSTICS v_mensa = ROW_COUNT;
    v_mensa_saltate := v_mensa_attese - v_mensa;
  END IF;

  -- ─── Il log: quante righe, tabella per tabella ──────────────────────────────
  -- Si logga anche quando NON ha toccato niente: «nessuna riga» non può voler
  -- dire insieme «erano già allineati» e «quel ramo non è mai partito». È la
  -- regola 5 di AGENTS.md, e questo trigger nasce da un guasto che il silenzio ha
  -- nascosto per settimane. Un conteggio unico non basterebbe: con otto tabelle,
  -- «zero» deve poter essere letto per ognuna.
  --
  -- ⚠️ Nel contesto vanno SOLO uuid, conteggi e il nome della CLASSE. Mai nome,
  -- cognome o codice fiscale: sono dati di minori, e `app_log` è interrogabile da
  -- chiunque abbia accesso al database.
  INSERT INTO public.app_log (
    livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
  )
  VALUES (
    CASE WHEN v_registro_saltate + v_mensa_saltate > 0 THEN 'warn' ELSE 'info' END,
    'anagrafica', 'server',
    CASE WHEN v_registro_saltate + v_mensa_saltate > 0
         THEN 'sezione rinominata: alcune righe non hanno preso il nome nuovo, la chiave era già occupata'
         ELSE 'sezione rinominata: nome propagato a tutte le tabelle che lo tengono per testo' END,
    'db:rinomina-sezione:' || NEW.id::text,
    NEW.scuola_id,
    jsonb_build_object(
      'esito', 'rinomina-sezione-propagata',
      'operazione', 'propaga_rinomina_sezione',
      'section_id', NEW.id,
      'sezione', NEW.name,
      'sezione_anno_attivo', v_attivo,
      'n', v_alunni + v_alunni_orfani + v_registro
           + v_avvisi + v_news + v_galleria + v_forms + v_mensa,
      'conteggi', jsonb_build_object(
        'alunni', v_alunni,
        'alunni_senza_section_id', v_alunni_orfani,
        'registro_orario', v_registro,
        'avvisi', v_avvisi,
        'news_posts', v_news,
        'galleria_media_v2', v_galleria,
        'forms_templates', v_forms,
        'mensa_class_menu_assignment', v_mensa
      ),
      'saltate_chiave_occupata', jsonb_build_object(
        'registro_orario', v_registro_saltate,
        'mensa_class_menu_assignment', v_mensa_saltate
      ),
      'tabelle_assenti', to_jsonb(array_remove(ARRAY[
        CASE WHEN v_ha_registro_orario THEN NULL ELSE 'registro_orario' END,
        CASE WHEN v_ha_avvisi THEN NULL ELSE 'avvisi' END,
        CASE WHEN v_ha_news_posts THEN NULL ELSE 'news_posts' END,
        CASE WHEN v_ha_galleria_media_v2 THEN NULL ELSE 'galleria_media_v2' END,
        CASE WHEN v_ha_forms_templates THEN NULL ELSE 'forms_templates' END,
        CASE WHEN v_ha_mensa_class_menu_assignment THEN NULL ELSE 'mensa_class_menu_assignment' END
      ]::text[], NULL))
    )
  )
  -- ⚠️ IL LIVELLO NON RETROCEDE. `app_log` deduplica per `(fingerprint, giorno)`:
  -- due rinomine della stessa sezione nello stesso giorno UTC finiscono sulla
  -- stessa riga. Con `livello = excluded.livello` la seconda, andata liscia,
  -- cancellava il `warn` della prima — cioè proprio la segnalazione che alcune
  -- righe non avevano preso il nome nuovo perché la chiave era occupata. Il
  -- `contesto` invece si sovrascrive di proposito: i conteggi dell'ULTIMA
  -- rinomina sono quelli che descrivono lo stato di adesso. Rilievo del critico,
  -- 2026-09-04.
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze     = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        livello        = CASE WHEN public.app_log.livello = 'warn' OR excluded.livello = 'warn'
                              THEN 'warn' ELSE excluded.livello END,
        messaggio      = CASE WHEN public.app_log.livello = 'warn' AND excluded.livello <> 'warn'
                              THEN public.app_log.messaggio ELSE excluded.messaggio END,
        contesto       = excluded.contesto;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.propaga_rinomina_sezione() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propaga_rinomina_sezione() TO service_role;

-- ── 4.3.4 · Fase B: lo specchio si inverte (la frequenza dell'anno attivo comanda, `alunni` ne è la copia) ──────
-- Da qui la verità di classe, stato, retta e sospensione è la frequenza dell'anno ATTIVO della sede ATTUALE
-- dell'alunno; `alunni` ne è la copia. Il giro `alunni → frequenze` della fase A si restringe a due compiti che
-- non si possono togliere finché la FK `frequenze.alunno_id → alunni` obbliga a scrivere prima la scheda:
--   · `trg_alunni_specchio_frequenza_ins`  (resta com'è): fa NASCERE la frequenza dell'anno attivo di un alunno nuovo;
--   · `trg_alunni_specchio_frequenza_sede` (nuovo, solo `scuola_id`): il trasferimento (vecchia `trasferito`, nuova viva).
-- `trg_alunni_specchio_frequenza` (la copia delle 15 colonne) si toglie. La funzione `alunni_specchio_frequenza()` e
-- l'interruttore `specchio_alunni_attivo` restano fino alla PR 5. Il giro si chiude da solo: il riallineamento non
-- scrive mai `scuola_id` (il trigger di sede non riparte) e non fa INSERT su `alunni`.
-- La migrazione NON riallinea tutti gli alunni: con l'invariante 11 a zero non cambierebbe niente, e sarebbe una
-- scrittura su tutte le righe di minori senza motivo.

-- Precondizione: se la scheda e la frequenza oggi divergono, invertire la direzione butterebbe via la scheda.
DO $mig$
DECLARE
  v_n bigint;
BEGIN
  SELECT coalesce(sum(i.righe), 0) INTO v_n FROM public.anno_invarianti() i WHERE i.invariante = '11';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'FASE_B_INVARIANTE_11_ROSSA'
      USING DETAIL = format('righe fuori posto nell''invariante 11: %s', v_n),
            HINT = 'Riallinea scheda e frequenza (invariante 11 a zero) prima di invertire lo specchio.';
  END IF;
END
$mig$;

ALTER TABLE IF EXISTS public.anno_regole
  ADD COLUMN IF NOT EXISTS specchio_frequenze_attivo boolean NOT NULL DEFAULT true;

-- La copia inversa. Idempotente: scrive solo le colonne che cambiano. Colonne di `alunni` lette da jsonb, come lo
-- specchio di oggi (un database che non ne ha qualcuna non fa fallire la funzione, la salta).
--   frequenze                   → alunni
--   section_id                  → section_id, e classe_sezione = nome della sezione (NULL se non c'è)
--   stato in_attesa/iscritto    → stato 'iscritto' (resta 'sospeso' o NULL se lo era), archiviato_il NULL
--   stato ritirato/trasferito/uscito → stato 'ritirato', archiviato_il (quello che c'è; altrimenti il giorno di uscita, o ora)
--   retta_mensile               → importo_retta_mensile (NULL → 0)
--   retta_a_carico_di, retta_split_config, intestatario_fatture, giorno_scadenza_pagamenti, gruppo_mensa_id,
--   sospeso, sospeso_causa, sospeso_motivo, sospeso_il, sospeso_da, usa_pannolino → omonime, invariate
-- `scuola_id` non si scrive mai.
CREATE OR REPLACE FUNCTION public.alunni_riallinea_da_frequenze(p_alunno uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cur   jsonb;
  v_f     jsonb;
  v_t     jsonb;
  v_patch jsonb;
  v_set   text;
  v_viva  boolean;
  v_stato text;
  v_arch  timestamptz;
  v_uscita date;
  v_nome  text;
  v_oggi  date := public.giorno_roma(now());
BEGIN
  SELECT to_jsonb(a) INTO v_cur FROM public.alunni a WHERE a.id = p_alunno;
  IF v_cur IS NULL OR (v_cur ->> 'scuola_id') IS NULL THEN
    RETURN;
  END IF;

  -- La frequenza dell'anno attivo della sede ATTUALE dell'alunno: mai quella di una sede lasciata.
  SELECT to_jsonb(f) INTO v_f
    FROM public.frequenze f
   WHERE f.alunno_id = p_alunno
     AND f.anno_sede_id = public.anno_attivo((v_cur ->> 'scuola_id')::uuid);
  IF v_f IS NULL THEN
    RETURN;
  END IF;

  SELECT s.name::text INTO v_nome FROM public.sections s WHERE s.id = (v_f ->> 'section_id')::uuid;

  v_viva := (v_f ->> 'stato') IN ('in_attesa', 'iscritto');
  IF v_viva THEN
    -- 'sospeso' (o NULL, che il codice legge «iscritto») si conserva finché la frequenza è viva
    -- `ritirato` senza `archiviato_il` è la tendina della scheda (non archivia): resta com'è. Una vera riapertura
    -- (`archiviato_il` valorizzato) torna `iscritto`.
    v_stato := CASE WHEN (v_cur ->> 'archiviato_il') IS NOT NULL THEN 'iscritto'
                    WHEN coalesce(v_cur ->> 'stato', 'iscritto') IN ('iscritto', 'sospeso', 'ritirato')
                    THEN v_cur ->> 'stato' ELSE 'iscritto' END;
    v_arch := NULL;
  ELSE
    v_stato := 'ritirato';
    v_uscita := (v_f ->> 'data_uscita')::date;
    v_arch := coalesce((v_cur ->> 'archiviato_il')::timestamptz,
                       CASE WHEN v_uscita IS NOT NULL AND v_uscita <= v_oggi
                            THEN ((v_uscita + time '12:00') AT TIME ZONE 'Europe/Rome') ELSE now() END);
  END IF;

  v_t := jsonb_build_object(
    'section_id', v_f -> 'section_id',
    'classe_sezione', v_nome,
    'stato', v_stato,
    'archiviato_il', v_arch,
    'importo_retta_mensile',
      CASE WHEN jsonb_typeof(v_f -> 'retta_mensile') = 'number' THEN v_f -> 'retta_mensile' ELSE to_jsonb(0) END,
    'retta_a_carico_di', v_f -> 'retta_a_carico_di',
    'retta_split_config', v_f -> 'retta_split_config',
    'intestatario_fatture', v_f -> 'intestatario_fatture',
    'giorno_scadenza_pagamenti', v_f -> 'giorno_scadenza_pagamenti',
    'gruppo_mensa_id', v_f -> 'gruppo_mensa_id',
    'sospeso', v_f -> 'sospeso',
    'sospeso_causa', v_f -> 'sospeso_causa',
    'sospeso_motivo', v_f -> 'sospeso_motivo',
    'sospeso_il', v_f -> 'sospeso_il',
    'sospeso_da', v_f -> 'sospeso_da',
    'usa_pannolino', v_f -> 'usa_pannolino');

  -- solo le colonne che alunni ha davvero e che cambiano
  SELECT jsonb_object_agg(e.k, e.v) INTO v_patch
    FROM jsonb_each(v_t) AS e(k, v)
   WHERE v_cur ? e.k AND (v_cur -> e.k) IS DISTINCT FROM e.v;
  IF v_patch IS NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(format('%I = r.%I', k, k), ', ') INTO v_set FROM jsonb_object_keys(v_patch) AS k;
  EXECUTE format(
    'UPDATE public.alunni a SET %s FROM jsonb_populate_record(NULL::public.alunni, $1) r WHERE a.id = $2', v_set)
    USING v_patch, p_alunno;
END
$$;

-- Il trigger su `frequenze`: ricopia solo se la frequenza è quella dell'anno attivo della sede attuale dell'alunno.
-- FAIL-OPEN: un guasto lascia la scrittura della frequenza com'è e lascia una riga in `app_log` (solo tabella e SQLSTATE).
-- Un DELETE non fa niente (non c'è nulla da copiare: se manca la frequenza lo vede l'invariante 11).
CREATE OR REPLACE FUNCTION public.frequenze_specchio_alunni()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attivo boolean;
  v_scuola uuid;
BEGIN
  SELECT r.specchio_frequenze_attivo INTO v_attivo FROM public.anno_regole r;
  IF NOT coalesce(v_attivo, false) THEN
    RETURN NULL;
  END IF;

  BEGIN
    SELECT a.scuola_id INTO v_scuola FROM public.alunni a WHERE a.id = NEW.alunno_id;
    IF v_scuola IS NULL OR NEW.anno_sede_id IS DISTINCT FROM public.anno_attivo(v_scuola) THEN
      RETURN NULL;
    END IF;
    PERFORM public.alunni_riallinea_da_frequenze(NEW.alunno_id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto('frequenze', 'specchio-fallito', 'frequenze_specchio_alunni',
                                   'specchio frequenze → alunni fallito: la scrittura della frequenza è passata',
                                   'db:anno-specchio:frequenze', SQLSTATE);
  END;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.alunni_riallinea_da_frequenze(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.frequenze_specchio_alunni()         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alunni_riallinea_da_frequenze(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.frequenze_specchio_alunni()         TO service_role;

DO $mig$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.alunni') AND c.relkind IN ('r', 'p'))
          AND to_regclass('public.frequenze') IS NOT NULL
          AND to_regprocedure('public.alunni_specchio_frequenza()') IS NOT NULL) THEN
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS trg_alunni_specchio_frequenza ON public.alunni;
  DROP TRIGGER IF EXISTS trg_alunni_specchio_frequenza_sede ON public.alunni;
  CREATE TRIGGER trg_alunni_specchio_frequenza_sede
    AFTER UPDATE OF scuola_id ON public.alunni
    FOR EACH ROW WHEN (OLD.scuola_id IS DISTINCT FROM NEW.scuola_id)
    EXECUTE FUNCTION public.alunni_specchio_frequenza();

  DROP TRIGGER IF EXISTS trg_frequenze_specchio_alunni ON public.frequenze;
  CREATE TRIGGER trg_frequenze_specchio_alunni
    AFTER INSERT OR UPDATE ON public.frequenze
    FOR EACH ROW EXECUTE FUNCTION public.frequenze_specchio_alunni();
END
$mig$;
-- ── fine 4.3.4 ──────────────────────────────────────────────────────────────────────────────────

-- ── 4.3.5 · Gli scrittori SQL delle colonne copiate passano dalla frequenza ─────────────────────────────────────
-- Dal 4.3.4 nessun trigger copia più `alunni` → frequenza: una scrittura di `alunni` che cambia una delle colonne copiate
-- senza passare dalla frequenza viene ANNULLATA dalla prossima scrittura della frequenza (lo specchio inverso riporta
-- indietro il vecchio valore). Inventario delle funzioni e dei trigger che fanno `UPDATE public.alunni` (definizione più
-- recente di ciascuno):
--   · `fn_form_submission_etl()` (20260731101818): scrive `classe_sezione` di un alunno già esistente, quindi `section_id`
--     → QUI sotto riscritta per aggiornare anche la frequenza dell'anno attivo (stessa sezione);
--   · `propaga_rinomina_sezione()` (M43, 4.3.3): ramo 1, `classe_sezione` = nuovo nome per gli alunni che hanno GIÀ quel
--     `section_id`: la sezione non cambia, niente da copiare. Ramo 2, gli alunni ORFANI (`section_id` NULL, riconosciuti
--     per nome): CAMBIA `section_id` → riscritta sopra per chiamare `frequenza_segue_classe_alunno` su ciascuno;
--   · `sync_alunno_section_id()` (BEFORE su `alunni`): calcola `section_id` dentro la scrittura stessa; la sezione
--     arriva alla frequenza dalla route (`scriviAlunnoEFrequenza`) o dalla funzione qui sotto;
--   · `alunni_riallinea_da_frequenze()` (4.3.4): è lo specchio inverso stesso;
--   · il resto sono UPDATE una tantum di migrazioni passate (non girano più).
-- Fail-open come lo specchio: un guasto lascia la scrittura di `alunni` com'è e una riga in `app_log`.

CREATE OR REPLACE FUNCTION public.frequenza_segue_classe_alunno(p_alunno uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attivo boolean;
BEGIN
  IF to_regclass('public.frequenze') IS NULL OR to_regclass('public.anno_regole') IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    -- Fase A (interruttore spento): è ancora `alunni` a comandare e il suo trigger copia la sezione da solo.
    SELECT r.specchio_frequenze_attivo INTO v_attivo FROM public.anno_regole r;
    IF NOT coalesce(v_attivo, false) THEN
      RETURN;
    END IF;

    -- La frequenza dell'anno attivo della sede ATTUALE dell'alunno prende la sezione che `alunni` ha appena risolto.
    UPDATE public.frequenze f
       SET section_id = a.section_id
      FROM public.alunni a
     WHERE a.id = p_alunno
       AND f.alunno_id = a.id
       AND f.anno_sede_id = public.anno_attivo(a.scuola_id)
       AND f.section_id IS DISTINCT FROM a.section_id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto('frequenze', 'specchio-fallito', 'frequenza_segue_classe_alunno',
                                   'sezione della scheda → frequenza fallita: la scrittura di alunni è passata',
                                   'db:anno-specchio:classe', SQLSTATE);
  END;
END
$$;

REVOKE ALL ON FUNCTION public.frequenza_segue_classe_alunno(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.frequenza_segue_classe_alunno(uuid) TO service_role;

-- L'ETL dell'iscrizione: la definizione di 20260731101818 con UNA riga in più (il PERFORM dopo l'UPDATE della classe).
-- Dentro un DO perché la funzione dichiara `form_models%ROWTYPE`: dove la tabella non c'è (il banco di prova, la CI)
-- la creazione fallirebbe.
DO $mig$
BEGIN
  IF to_regclass('public.form_models') IS NULL OR to_regclass('public.form_submissions') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $etl$
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
      'Iscrizione, ETL: la compilazione % non dichiara la sede (form_submissions.scuola_id NULL): nessuna anagrafica creata',
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
        -- 4.3.5 · la classe può essere cambiata, e con lei `section_id` (trigger BEFORE): in fase B comanda la frequenza.
        PERFORM public.frequenza_segue_classe_alunno(v_student_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Era `RAISE NOTICE`: un messaggio che non arriva in nessun log e che ha
      -- tenuto invisibile ogni fallimento dell'ETL. Il caso più probabile è il
      -- codice fiscale già registrato in un ALTRO plesso (vincolo di unicità globale
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
  $etl$;
END
$mig$;
-- Segnaposto, SOLO dove la funzione vera non è stata creata qui sopra (il banco di prova, senza le tabelle dei moduli):
-- il REVOKE che segue ha bisogno che la funzione esista. In produzione la funzione c'è già e questo non fa niente.
DO $seg$
BEGIN
  IF to_regprocedure('public.fn_form_submission_etl()') IS NULL THEN
    EXECUTE $stub$
CREATE FUNCTION public.fn_form_submission_etl() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ BEGIN RETURN NEW; END $$;
    $stub$;
  END IF;
END
$seg$;
REVOKE ALL ON FUNCTION public.fn_form_submission_etl() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_form_submission_etl() TO service_role;
-- ── fine 4.3.5 ──────────────────────────────────────────────────────────────────────────────────
