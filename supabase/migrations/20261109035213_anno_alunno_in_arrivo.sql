-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.5 · «Preparare e aprire l'anno prossimo» · M45b, l'alunno «in arrivo» (compito 4.5.4)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- Un bambino la cui domanda è per l'anno PROSSIMO esiste in `alunni` (la scheda è una sola) ma non frequenta ancora: ha lo
-- stato `in_arrivo`, nessuna sezione e nessuna frequenza dell'anno attivo. Questo file:
--   1. estende il CHECK `alunni_stato_ammesso` (nato in `20261024235116_iscrizioni_stati_vincolati.sql`, ammetteva solo
--      `iscritto`, `ritirato`, `sospeso`) a `in_arrivo`: `DROP CONSTRAINT` + `ADD … NOT VALID` + `VALIDATE`;
--   2. ridefinisce `alunni_specchio_frequenza()`: un alunno `in_arrivo` non riceve la frequenza dell'anno attivo
--      (ultima definizione: `20261107012110_anno_strumenti.sql`, 4.2.3; il resto del corpo non cambia);
--   3. ridefinisce `anno_invarianti()`, partendo dall'ULTIMA definizione (`20261108170148_anno_visibilita_genitore_funzioni.sql`,
--      con la riga 7): la 11-bis non conta un `in_arrivo`, e nasce la 11-ter («in arrivo senza arrivo»).
--   4. `data_ingresso` al ritorno in una sede (A → B → A): vedi la nota in fondo allo specchio.
--
-- Nessun uuid di sede, nessun valore del 2027/28. Niente dato di produzione toccato: nessun bambino ha oggi lo stato
-- `in_arrivo`, e il CHECK allargato non sposta nessuna riga.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1 · Il CHECK ────────────────────────────────────────────────────────────────────────────────
-- Il database della CI non ha il vincolo (non è migrato): lì non c'è niente da allargare, e `in_arrivo` è già ammesso.
-- La guardia conta le righe fuori dall'elenco NUOVO prima di riaggiungerlo: se ce ne fossero il `VALIDATE` fallirebbe e con lui
-- l'integrazione al merge. In quel caso il vecchio vincolo resta com'è e lo dice il log.
DO $$
DECLARE
  fuori bigint;
BEGIN
  IF to_regclass('public.alunni') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.alunni'::regclass
       AND conname = 'alunni_stato_ammesso'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO fuori
    FROM public.alunni
   WHERE stato IS NOT NULL AND stato NOT IN ('iscritto', 'ritirato', 'sospeso', 'in_arrivo');

  IF fuori > 0 THEN
    RAISE WARNING 'anno_alunno_in_arrivo: % righe di alunni con uno stato fuori elenco, vincolo non allargato', fuori;
    RETURN;
  END IF;

  ALTER TABLE public.alunni DROP CONSTRAINT alunni_stato_ammesso;
  ALTER TABLE public.alunni
    ADD CONSTRAINT alunni_stato_ammesso
    CHECK (stato IN ('iscritto', 'ritirato', 'sospeso', 'in_arrivo')) NOT VALID;
  ALTER TABLE public.alunni
    VALIDATE CONSTRAINT alunni_stato_ammesso;
END $$;

-- ── 2 · Lo specchio `alunni` → `frequenze` salta il bambino «in arrivo» ─────────────────────────
CREATE OR REPLACE FUNCTION public.alunni_specchio_frequenza()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attivo   boolean;
  v_n        jsonb := to_jsonb(NEW);
  v_oggi     date  := public.giorno_roma(now());
  v_as       public.anni_sede%ROWTYPE;
  v_old      public.anni_sede%ROWTYPE;
  v_arch     timestamptz;
  v_retta    numeric;
  v_giorno   integer;
  v_ingresso date;
BEGIN
  SELECT r.specchio_alunni_attivo INTO v_attivo FROM public.anno_regole r;
  IF NOT coalesce(v_attivo, false) THEN
    RETURN NULL;
  END IF;

  -- M45b: un bambino «in arrivo» (la sua domanda è per l'anno prossimo) non frequenta ancora. Lo specchio non gli dà
  -- nessuna frequenza dell'anno ATTIVO, né alla nascita né se la sede cambia: la sua frequenza è quella dell'anno che
  -- viene, e la scrive la 4.5.6. Lo stato si legge da jsonb come le altre colonne: dove `stato` non c'è, non scatta.
  IF v_n ->> 'stato' = 'in_arrivo' THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF NEW.scuola_id IS NULL THEN
      RETURN NULL;
    END IF;

    -- la sede cambia: la frequenza viva della sede vecchia si chiude come `trasferito`
    IF TG_OP = 'UPDATE' AND OLD.scuola_id IS NOT NULL AND OLD.scuola_id IS DISTINCT FROM NEW.scuola_id THEN
      SELECT s.* INTO v_old FROM public.anni_sede s WHERE s.id = public.anno_attivo(OLD.scuola_id);
      IF FOUND THEN
        UPDATE public.frequenze f
           SET stato = 'trasferito', data_uscita = least(greatest(v_oggi, f.data_ingresso), v_old.fine)
         WHERE f.alunno_id = NEW.id AND f.anno_sede_id = v_old.id AND f.stato IN ('in_attesa', 'iscritto');
      END IF;
    END IF;

    SELECT s.* INTO v_as FROM public.anni_sede s WHERE s.id = public.anno_attivo(NEW.scuola_id);
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    v_arch := (v_n ->> 'archiviato_il')::timestamptz;
    v_retta := (v_n ->> 'importo_retta_mensile')::numeric;
    v_giorno := (v_n ->> 'giorno_scadenza_pagamenti')::integer;
    v_ingresso := least(greatest(v_oggi, v_as.inizio), v_as.fine);

    INSERT INTO public.frequenze
      (alunno_id, anno_sede_id, section_id, origine, tipo, stato, data_ingresso, data_uscita, retta_mensile,
       retta_a_carico_di, retta_split_config, intestatario_fatture, giorno_scadenza_pagamenti, gruppo_mensa_id,
       sospeso, sospeso_causa, sospeso_motivo, sospeso_il, sospeso_da, usa_pannolino)
    VALUES
      (NEW.id, v_as.id, NEW.section_id, 'recupero', NULL,
       CASE WHEN v_arch IS NULL THEN 'iscritto' ELSE 'ritirato' END,
       v_ingresso,
       CASE WHEN v_arch IS NULL THEN NULL ELSE least(greatest(public.giorno_roma(v_arch), v_ingresso), v_as.fine) END,
       CASE WHEN v_retta > 0 THEN v_retta END,
       (v_n ->> 'retta_a_carico_di')::uuid,
       nullif(v_n -> 'retta_split_config', 'null'::jsonb),
       nullif(v_n -> 'intestatario_fatture', 'null'::jsonb),
       CASE WHEN v_giorno BETWEEN 1 AND 28 THEN v_giorno END,
       (v_n ->> 'gruppo_mensa_id')::uuid,
       coalesce((v_n ->> 'sospeso')::boolean, false), v_n ->> 'sospeso_causa', v_n ->> 'sospeso_motivo',
       (v_n ->> 'sospeso_il')::timestamptz, (v_n ->> 'sospeso_da')::uuid,
       coalesce((v_n ->> 'usa_pannolino')::boolean, false))
    ON CONFLICT (alunno_id, anno_sede_id) DO UPDATE SET
      -- M45b: un bambino che torna in una sede in cui era già stato (A → B → A) riapre la frequenza di A. L'ingresso resta
      -- quello di prima solo se la riga era viva; se era chiusa (`trasferito`, `ritirato`, `uscito`) e nata dal recupero,
      -- l'ingresso è quello di oggi: altrimenti il periodo passato in B rientrerebbe nel periodo di A, e una famiglia
      -- vedrebbe le foto che la sede A ha fatto mentre il bambino non c'era. Si perde una foto vecchia, non si apre una nuova.
      data_ingresso = CASE WHEN public.frequenze.origine = 'recupero'
                            AND public.frequenze.stato NOT IN ('in_attesa', 'iscritto')
                            AND v_arch IS NULL
                           THEN v_ingresso ELSE public.frequenze.data_ingresso END,
      section_id = excluded.section_id,
      retta_mensile = excluded.retta_mensile,
      retta_a_carico_di = excluded.retta_a_carico_di,
      retta_split_config = excluded.retta_split_config,
      intestatario_fatture = excluded.intestatario_fatture,
      giorno_scadenza_pagamenti = excluded.giorno_scadenza_pagamenti,
      gruppo_mensa_id = excluded.gruppo_mensa_id,
      sospeso = excluded.sospeso, sospeso_causa = excluded.sospeso_causa, sospeso_motivo = excluded.sospeso_motivo,
      sospeso_il = excluded.sospeso_il, sospeso_da = excluded.sospeso_da,
      usa_pannolino = excluded.usa_pannolino,
      stato = CASE WHEN public.frequenze.origine = 'recupero' THEN excluded.stato ELSE public.frequenze.stato END,
      data_uscita = CASE WHEN public.frequenze.origine <> 'recupero' THEN public.frequenze.data_uscita
                         WHEN v_arch IS NULL THEN NULL
                         ELSE least(greatest(public.giorno_roma(v_arch), public.frequenze.data_ingresso), v_as.fine) END;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto('alunni', 'specchio-fallito', 'alunni_specchio_frequenza',
                                   'specchio alunni → frequenze fallito: la scrittura di alunni è passata',
                                   'db:anno-specchio:alunni', SQLSTATE);
  END;
  RETURN NULL;
END
$$;
-- NOTA su `data_ingresso` (A → B → A): la prova «A → B → A» di `__tests__/db/anno-alunno-in-arrivo.test.ts` è stata eseguita
-- PRIMA di scrivere la correzione ed è uscita ROSSA: la frequenza di A, riletta al ritorno, aveva ancora il vecchio ingresso e una
-- foto della sede A fatta mentre il bambino era in B risultava visibile alla famiglia. Da qui la correzione dentro `ON CONFLICT`.

-- ── 3 · `anno_invarianti()`: la 11-bis esclude l'«in arrivo», nasce la 11-ter ───────────────────
-- Copia dell'ULTIMA definizione (`20261108170148_anno_visibilita_genitore_funzioni.sql:751`, con la riga 7). Cambiano solo il
-- blocco 11-bis (un filtro) e il blocco 11-ter (nuovo), più una variabile.
CREATE OR REPLACE FUNCTION public.anno_invarianti()
RETURNS TABLE (invariante text, tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r             record;
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
  v_oggi        date := public.giorno_roma(now());
  v_figli_vivi  uuid[];
  v_freq_vive   uuid[];
  v_lasciate    uuid[];
  v_genitori    uuid[] := '{}';
  v_figli       uuid[] := '{}';
  v_st_alunni   uuid[] := '{}';
  v_st_scuole   uuid[] := '{}';
  v_st_sezioni  uuid[] := '{}';
  v_foto        bigint := 0;
  v_avvisi      bigint := 0;
  v_thread      bigint := 0;
  v_frequenze   bigint := 0;
  v_guasti      bigint := 0;
  v_guasto      text;
  v_gen         record;
  v_non_arrivo  text;
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

  --     11-bis. Un alunno con una sede, che NON è «in arrivo», deve avere la frequenza dell'anno attivo (lo specchio la crea).
  --     Un bambino «in arrivo» (PR 4.5) non frequenta ancora: la sua frequenza è dell'anno che viene, e la guarda la 11-ter.
  --     `stato` si nomina solo dove la colonna c'è (il banco minimo e il database della CI possono non averla).
  v_n := 0;
  v_non_arrivo := CASE WHEN public.anno_ha_colonna('alunni', 'stato')
                       THEN 'AND al.stato IS DISTINCT FROM ''in_arrivo'' ' ELSE '' END;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.scuola_id IS NOT NULL '
            || v_non_arrivo ||
            'AND public.anno_attivo(al.scuola_id) IS NOT NULL '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = al.id '
            'AND f.anno_sede_id = public.anno_attivo(al.scuola_id))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (senza frequenza)'; righe := v_n; RETURN NEXT;

  --     11-ter. Un alunno «in arrivo» deve avere una frequenza viva in un anno che viene (in preparazione o con le iscrizioni
  --     aperte): un bambino in arrivo senza arrivo è una domanda approvata che non ha lasciato traccia nell'anno prossimo.
  --     Se l'anno è già diventato `corrente` e lo stato non è passato a `iscritto` (il passaggio non ha girato), lo dice questa
  --     riga: la frequenza non è più «di un anno che viene».
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL
     AND public.anno_ha_colonna('alunni', 'stato') THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.stato = ''in_arrivo'' '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f '
            'JOIN public.anni_sede s ON s.id = f.anno_sede_id '
            'WHERE f.alunno_id = al.id AND f.stato IN (''in_attesa'', ''iscritto'') '
            'AND s.stato::text IN (''in_preparazione'', ''iscrizioni_aperte''))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (in arrivo senza arrivo)'; righe := v_n; RETURN NEXT;

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

  -- 7. Nessun genitore vede qualcosa attraverso un figlio non attivo (PR 4.4). Il perché di ogni scelta sta nella testata qui sopra.
  --    Le frequenze vive una volta sola, dal catalogo: un bambino vivo in due sedi compare due volte.
  SELECT coalesce(array_agg(f.alunno_id), '{}'), coalesce(array_agg(f.id), '{}') INTO v_figli_vivi, v_freq_vive
    FROM public.frequenze f
   WHERE f.stato IN ('in_attesa', 'iscritto')
     AND f.anno_sede_id = public.anno_attivo(f.scuola_id)
     AND f.data_ingresso <= v_oggi
     AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);

  --    I bambini con una sede in cui hanno una frequenza e nessuna viva: è la coppia (figlio, sede) non viva.
  SELECT coalesce(array_agg(DISTINCT x.alunno_id), '{}') INTO v_lasciate
    FROM (SELECT f.alunno_id
            FROM public.frequenze f
           GROUP BY f.alunno_id, f.scuola_id
          HAVING NOT bool_or(f.id = ANY (v_freq_vive))) x;

  --    Tutte le coppie (genitore, figlio), per le due strade del legame di `figli_collegati`. `to_regclass` come lì.
  IF to_regclass('public.legame_genitori_alunni') IS NOT NULL THEN
    SELECT coalesce(array_agg(l.genitore_id), '{}'), coalesce(array_agg(l.alunno_id), '{}') INTO v_genitori, v_figli
      FROM public.legame_genitori_alunni l;
  END IF;
  IF to_regclass('public.student_parents') IS NOT NULL AND to_regclass('public.parents') IS NOT NULL THEN
    SELECT v_genitori || coalesce(array_agg(p.auth_user_id), '{}'), v_figli || coalesce(array_agg(sp.student_id), '{}')
      INTO v_genitori, v_figli
      FROM public.parents p
      JOIN public.student_parents sp ON sp.parent_id = p.id
     WHERE p.auth_user_id IS NOT NULL;
  END IF;

  --    Le funzioni di visibilità girano solo per chi ha una coppia non viva, e ognuno ha il suo blocco. Nessuno da guardare: girano
  --    lo stesso, una volta, per un genitore che non c'è.
  FOR v_gen IN
    WITH guardati AS (
      SELECT x.genitore,
             array_agg(x.figlio) AS figli,
             coalesce(array_agg(x.figlio) FILTER (WHERE vivo.alunno_id IS NULL), '{}') AS non_attivi
        FROM unnest(v_genitori, v_figli) AS x(genitore, figlio)
        LEFT JOIN (SELECT DISTINCT y.alunno_id FROM unnest(v_figli_vivi) AS y(alunno_id)) vivo ON vivo.alunno_id = x.figlio
        LEFT JOIN unnest(v_lasciate) AS lasciata(alunno_id) ON lasciata.alunno_id = x.figlio
       GROUP BY x.genitore
      HAVING bool_or(vivo.alunno_id IS NULL OR lasciata.alunno_id IS NOT NULL)
    )
    SELECT g.genitore, g.figli, g.non_attivi FROM guardati g
    UNION ALL
    SELECT NULL::uuid, '{}'::uuid[], '{}'::uuid[] WHERE NOT EXISTS (SELECT 1 FROM guardati)
  LOOP
    BEGIN
      IF to_regclass('public.galleria_media_v2') IS NOT NULL THEN
        -- Lo storico in array, come in `media_visibili_genitore`: la query delle foto resta statica anche dove la tabella non c'è.
        IF to_regclass('public.alunni_classi_storico') IS NOT NULL THEN
          SELECT coalesce(array_agg(h.alunno_id), '{}'), coalesce(array_agg(h.scuola_id), '{}'), coalesce(array_agg(h.section_id), '{}')
            INTO v_st_alunni, v_st_scuole, v_st_sezioni
            FROM public.alunni_classi_storico h
           WHERE h.alunno_id = ANY (v_gen.figli);
        END IF;
        v_foto := v_foto + (WITH sue AS MATERIALIZED (
                              SELECT f.alunno_id, f.scuola_id, f.section_id, f.id = ANY (v_freq_vive) AS viva
                                FROM public.frequenze f
                               WHERE f.alunno_id = ANY (v_gen.figli)
                              UNION ALL
                              SELECT h.alunno_id, h.scuola_id, h.section_id, false
                                FROM unnest(v_st_alunni, v_st_scuole, v_st_sezioni) AS h(alunno_id, scuola_id, section_id)
                            )
                            SELECT count(*)
                              FROM public.media_visibili_genitore(v_gen.genitore) v
                              LEFT JOIN public.galleria_media_v2 m ON m.id = v.media_id
                             WHERE NOT EXISTS (SELECT 1 FROM sue s WHERE s.viva AND s.alunno_id = v.alunno_id AND s.scuola_id = m.scuola_id)
                                OR (m.tag_students @> ARRAY[v.alunno_id]
                                    OR (m.is_broadcast = true
                                        AND coalesce(cardinality(m.target_section_ids), 0) = 0
                                        AND coalesce(cardinality(m.target_classes), 0) = 0)
                                    OR EXISTS (SELECT 1 FROM sue s
                                                WHERE s.alunno_id = v.alunno_id AND s.scuola_id = m.scuola_id
                                                  AND s.section_id = ANY (m.target_section_ids))) IS NOT TRUE);
      END IF;
      IF to_regclass('public.avvisi') IS NOT NULL THEN
        v_avvisi := v_avvisi + (WITH vive AS MATERIALIZED (
                                  SELECT f.alunno_id, f.scuola_id, f.section_id
                                    FROM public.frequenze f
                                   WHERE f.alunno_id = ANY (v_gen.figli) AND f.id = ANY (v_freq_vive)
                                )
                                SELECT count(*)
                                  FROM public.avvisi_visibili_genitore(v_gen.genitore) v
                                  LEFT JOIN public.avvisi a ON a.id = v.avviso_id
                                 WHERE NOT EXISTS (SELECT 1 FROM vive s
                                                    WHERE s.alunno_id = v.alunno_id AND s.scuola_id = a.scuola_id
                                                      AND (a.target_scope = 'globale' OR s.section_id = ANY (a.target_section_ids))));
      END IF;
      IF to_regclass('public.chat_threads') IS NOT NULL THEN
        v_thread := v_thread + (SELECT count(*)
                                  FROM public.thread_visibili(v_gen.genitore) v
                                  JOIN public.chat_threads t ON t.id = v.thread_id
                                 WHERE t.student_id = ANY (v_gen.non_attivi)
                                   AND t.teacher_id IS DISTINCT FROM v_gen.genitore);
      END IF;
      v_frequenze := v_frequenze + (SELECT count(*) FROM public.figli_attivi(v_gen.genitore) a WHERE a.frequenza_id <> ALL (v_freq_vive));
    EXCEPTION
      WHEN OTHERS THEN
        v_guasti := v_guasti + 1;
        v_guasto := SQLSTATE;
    END;
  END LOOP;

  invariante := '7'; tabella := 'galleria_media_v2'; righe := v_foto; RETURN NEXT;
  invariante := '7'; tabella := 'avvisi'; righe := v_avvisi; RETURN NEXT;
  invariante := '7'; tabella := 'chat_threads'; righe := v_thread; RETURN NEXT;
  invariante := '7'; tabella := 'frequenze'; righe := v_frequenze; RETURN NEXT;
  IF v_guasti > 0 THEN
    invariante := '7'; tabella := format('(controllo fallito: %s)', v_guasto); righe := v_guasti; RETURN NEXT;
  END IF;

  RETURN;
END
$$;

REVOKE ALL ON FUNCTION public.alunni_specchio_frequenza() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_invarianti()           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alunni_specchio_frequenza() TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_invarianti()           TO service_role;
