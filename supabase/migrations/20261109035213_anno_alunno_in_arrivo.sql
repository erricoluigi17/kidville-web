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
--   5. `elimina_alunno_definitivo` respinge l'`in_arrivo` (compito 4.5.4-bis), 6. `anno_fotografa` non lo conta fra gli alunni
--      senza frequenza, 7. il CHECK `alunni_in_arrivo_senza_sezione`.
--
-- distruttiva approvata: nessuna riga cancellata alla migrazione; le `DELETE FROM` stanno nel corpo di `elimina_alunno_definitivo`, ridefinita col suo stesso testo più un rifiuto in testa, e girano solo quando qualcuno la chiama
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

-- ── 5 · `elimina_alunno_definitivo` respinge il bambino «in arrivo» (compito 4.5.4-bis) ─────────────────────────────────
-- Per la funzione «senza sezione» voleva dire «eliminabile»: un bambino la cui domanda è per l'anno dopo, che una sezione non
-- ce l'ha, si poteva cancellare per intero come un ex alunno. Ora ha un codice proprio (`in_arrivo`): prima si archivia
-- (lo stato diventa `ritirato`), poi si elimina. Il testo è quello dell'ULTIMA definizione (`20261107165503_anno_scrittura.sql`,
-- stessa guardia `to_regprocedure`: il database della CI non ha la funzione, e un `CREATE OR REPLACE` la creerebbe senza i
-- `REVOKE`), con il solo controllo in più, prima di quello sulla sezione.
DO $do$
BEGIN
  IF to_regprocedure('public.elimina_alunno_definitivo(uuid,boolean,boolean)') IS NOT NULL THEN
    EXECUTE $def$
CREATE OR REPLACE FUNCTION public.elimina_alunno_definitivo(p_alunno uuid, p_con_pagamenti boolean DEFAULT false, p_solo_verifica boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_alunno    record;
  v_pagamenti int;
  v_bloccati  int;
  v_ricevute  int;
  v_n         int;
  v_righe     jsonb := '{}'::jsonb;
begin
  -- Anno scolastico (M3): l'oblio è l'unica scrittura che può toccare un anno chiuso senza gettone.
  perform set_config('anno_chiuso.oblio', 'on', true);
  if p_alunno is null then
    raise exception 'elimina_alunno_definitivo: p_alunno obbligatorio';
  end if;

  select id, stato, section_id, anonimizzato_il
    into v_alunno
    from public.alunni
   where id = p_alunno
   for update;

  if not found then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'non_trovato');
  end if;
  if v_alunno.anonimizzato_il is not null then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'gia_anonimizzato');
  end if;
  -- Un bambino «in arrivo» (la domanda è per l'anno dopo) non ha sezione ma NON è un ex alunno: lo si tratta da iscritto.
  -- Prima si archivia (lo stato diventa «ritirato»), poi si elimina. Va PRIMA del controllo sulla sezione, che altrimenti
  -- lo lascerebbe passare.
  if v_alunno.stato = 'in_arrivo' then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'in_arrivo');
  end if;
  -- Elenco chiuso degli stati, mai la negazione di 'iscritto'. `stato` è
  -- nullable (DEFAULT 'iscritto') e un NULL non è un ritiro (`eNonPiuIscritto`):
  -- senza il coalesce `NULL = any(…)` darebbe NULL, `not (NULL or false)` NULL,
  -- e l'if NON scatterebbe — cioè lascerebbe eliminare chi frequenta.
  if not (coalesce(v_alunno.stato = any(public.stati_alunno_non_piu_iscritto()), false)
          or v_alunno.section_id is null) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'frequentante');
  end if;

  -- IL SECONDO LOCK: i pagamenti del bambino, PRIMA di controllarli.
  -- Il `for update` sulla scheda ferma solo chi scrive su `alunni` (o inserisce
  -- un pagamento nuovo per lui). Non ferma chi scrive una riga FIGLIA di un
  -- pagamento P che esiste già: un incasso, un abbinamento, la quota di un
  -- fratello, una voce in fatture_coda. Se quella transazione non ha ancora
  -- confermato quando i controlli qui sotto guardano P, la sua riga è invisibile:
  -- il controllo dice «pulito», la delete di P aspetta che l'altra confermi, e poi
  -- porta via in CASCADE l'incasso appena registrato — rispondendo ok: true.
  -- Chi inserisce una riga figlia prende sul padre, per il controllo della FK, un
  -- lock FOR KEY SHARE; FOR UPDATE è in conflitto con quello. Da qui in poi chi
  -- scrive o ha già confermato (e i controlli lo vedono), o aspetta la fine di
  -- questa transazione e fallisce con 23503 perché P non c'è più.
  perform 1 from public.pagamenti where alunno_id = p_alunno for update;

  -- registro-primaria:inizio
  if exists (select 1 from public.valutazioni where alunno_id = p_alunno)
     or exists (select 1 from public.pagelle where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_giudizi where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_comportamento where alunno_id = p_alunno)
     or exists (select 1 from public.note_disciplinari where alunno_id = p_alunno)
     or exists (select 1 from public.certificati_competenze where alunno_id = p_alunno) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;
  -- registro-primaria:fine

  -- La ricevuta di una pagella (fase 7): registro della primaria come la pagella,
  -- fuori dai marcatori perché l'elenco qui sopra è la copia di quello in TS.
  if exists (select 1 from public.pagella_ricezioni where alunno_id = p_alunno) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;

  select count(*) into v_pagamenti from public.pagamenti where alunno_id = p_alunno;
  select count(*) into v_ricevute from public.ricevute_emesse where alunno_id = p_alunno;

  if v_pagamenti > 0 or v_ricevute > 0 then
    if not coalesce(p_con_pagamenti, false) then
      perform set_config('anno_chiuso.oblio', 'off', true);
      return jsonb_build_object('ok', false, 'code', 'ha_pagamenti', 'pagamenti', v_pagamenti);
    end if;
    -- Un pagamento è contabilità vera se ha una ricevuta, una fattura, un
    -- bonifico abbinato, un incasso, quote di un ALTRO alunno appese a lui
    -- (la cascata su parent_payment_id le porterebbe via), oppure una voce
    -- ancora viva in fatture_coda (vedi il commento di testa della migrazione
    -- 20261008220540).
    select count(*) into v_bloccati
      from public.pagamenti p
     where p.alunno_id = p_alunno
       and (exists (select 1 from public.ricevute_emesse r where r.pagamento_id = p.id)
         or exists (select 1 from public.fatture_emesse f where f.pagamento_id = p.id)
         or exists (select 1 from public.riconciliazione_movimenti m where m.pagamento_id = p.id)
         or exists (select 1 from public.incassi i where i.pagamento_id = p.id)
         or exists (select 1 from public.pagamenti c
                     where c.parent_payment_id = p.id
                       and c.alunno_id is distinct from p_alunno)
         or exists (select 1 from public.fatture_coda q
                     where q.pagamento_id = p.id
                       and q.stato <> 'tolta'));
    if v_bloccati > 0 or v_ricevute > 0 then
      perform set_config('anno_chiuso.oblio', 'off', true);
      return jsonb_build_object('ok', false, 'code', 'pagamenti_non_cancellabili',
                                'bloccati', v_bloccati, 'ricevute', v_ricevute);
    end if;
  end if;

  -- La sola verifica si ferma QUI: dopo ogni controllo (e ogni lock) qui sopra,
  -- prima della prima cancellazione qui sotto.
  if coalesce(p_solo_verifica, false) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', true, 'code', 'ammissibile');
  end if;

  -- Le cancellazioni: prima ciò che bloccherebbe la DELETE finale, poi la scheda.
  delete from public.solleciti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('solleciti', v_n);

  delete from public.pagamenti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('pagamenti', v_n);

  delete from public.eventi_diario where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('diario', v_n);

  delete from public.legame_genitori_alunni where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('legami', v_n);

  delete from public.armadietto where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('armadietto', v_n);

  delete from public.ticket_mensa where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('ticket_mensa', v_n);

  delete from public.forms_submissions where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('moduli', v_n);

  -- Certificati medici e fascicolo: i FILE li ha già tolti la route; qui va via
  -- l'indice. Prima della fase 7 lo faceva la cascata senza dirlo.
  delete from public.certificati_medici where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('certificati_medici', v_n);

  delete from public.student_documents where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('fascicolo', v_n);

  update public.galleria_media
     set tag_alunni = array_remove(tag_alunni, p_alunno)
   where p_alunno = any(tag_alunni);
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('tag_galleria', v_n);

  -- Copia di sicurezza del diario creata a mano il 2026-09-08, senza migrazione:
  -- esiste solo in produzione, quindi la si nomina solo se c'è.
  if to_regclass('public.backup_diario_vuote_20260908') is not null then
    execute 'delete from public.backup_diario_vuote_20260908 where alunno_id = $1' using p_alunno;
    get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('backup_diario', v_n);
  end if;

  -- Il resto (presenze, deleghe, chat, servizi, registro_destinatari, ...) segue
  -- in CASCADE: nessuna di quelle catene ha un freno RESTRICT. retta_a_carico_di
  -- dei fratelli va a NULL da sé.
  delete from public.alunni where id = p_alunno;

  perform set_config('anno_chiuso.oblio', 'off', true);
  return jsonb_build_object('ok', true, 'code', 'eliminato', 'righe', v_righe);
end;
$function$;
    $def$;
  END IF;
END
$do$;

-- ── 6 · `anno_fotografa` non conta il bambino «in arrivo» fra gli alunni senza frequenza ────────────────────────────────
-- Come la 11-bis delle invarianti: l'«in arrivo» non ha la frequenza dell'anno attivo per costruzione, e contarlo farebbe
-- divergere il confronto prima/dopo del passaggio d'anno per un caso normale. Testo dell'ULTIMA definizione
-- (`20261107012110_anno_strumenti.sql`), con la sola condizione in più sulla voce `alunni_senza_frequenza`.
CREATE OR REPLACE FUNCTION public.anno_fotografa(p_fase text, p_tabelle text[] DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r       record;
  c       record;
  v_tot   bigint := 0;
  v_sede  text;
  v_t     text;
  v_prima timestamptz;
  v_nuova text;
  v_cond  text;
BEGIN
  IF p_fase IS NULL OR p_fase NOT IN ('prima', 'dopo', 'finale') THEN
    RAISE EXCEPTION 'FASE_NON_VALIDA';
  END IF;

  FOR r IN SELECT * FROM public.anno_tabelle ORDER BY tabella LOOP
    CONTINUE WHEN p_tabelle IS NOT NULL AND NOT (r.tabella = ANY (p_tabelle));
    CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL;

    v_t := format('public.%I', r.tabella);
    v_sede := public.anno_sede_sql(r.tabella, 't');
    v_prima := NULL;
    IF p_fase <> 'prima' THEN
      -- l'istante in cui l'ULTIMA fotografia `prima` di questa tabella ha cominciato a scrivere (con clock_timestamp()
      -- le righe di una stessa fotografia hanno istanti diversi: il minimo della sua transazione, non il massimo di tutte)
      SELECT min(x.eseguita_il) INTO v_prima
        FROM public.riconciliazione_anno x
       WHERE x.fase = 'prima' AND x.tabella = r.tabella
         AND x.transazione = (SELECT y.transazione FROM public.riconciliazione_anno y
                               WHERE y.fase = 'prima' AND y.tabella = r.tabella
                               ORDER BY y.eseguita_il DESC, y.id DESC LIMIT 1);
    END IF;
    -- le righe nate dopo la fotografia `prima` di QUESTA tabella
    v_nuova := CASE WHEN v_prima IS NOT NULL AND r.colonna_creazione IS NOT NULL
                    THEN format('t.%I::timestamptz >= %L::timestamptz', r.colonna_creazione, v_prima) END;

    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'righe',
      format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t GROUP BY 1', v_sede, v_t));
    -- Il totale, SEMPRE una riga (un aggregato senza GROUP BY): una tabella svuotata o riempita da zero deve
    -- comparire nella fotografia, o la differenza non la vedrebbe (`righe` per sede, a tabella vuota, non scrive niente).
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'righe_totale',
      format('SELECT NULL::uuid AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t', v_t));
    -- Senza una colonna di creazione propria le righe nuove non si distinguono dalle perse: la tabella non e
    -- confrontabile (`anno_riconciliazione_differenze` la salta) e il suo conteggio resta qui, visibile.
    IF r.colonna_creazione IS NULL THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'non_confrontabili',
        format('SELECT NULL::uuid AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t', v_t));
    END IF;
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'righe_per_anno',
      format('SELECT %s AS scuola_id, t.anno_id AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.anno_id IS NOT NULL GROUP BY 1, 2', v_sede, v_t));
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'righe_senza_anno',
      format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.anno_id IS NULL GROUP BY 1', v_sede, v_t));
    -- la sede non ricavabile: una riga così, a controlli rigidi, può restare senza anno (tabelle `sede_facoltativa`)
    IF r.modo <> 'madre' THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'righe_senza_sede',
        format('SELECT NULL::uuid AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE %s IS NULL', v_t, v_sede));
    END IF;
    IF v_nuova IS NOT NULL THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'righe_nuove',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE %s GROUP BY 1', v_sede, v_t, v_nuova));
    END IF;

    -- La sezione della riga è di un altro anno (tutte le righe, non solo quelle dopo `controlli_rigidi_dal`).
    IF r.tabella <> 'sections' AND public.anno_ha_colonna(r.tabella, 'section_id') THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:sezione_altro_anno:' || r.tabella,
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t JOIN public.sections s ON s.id = t.section_id '
               || 'WHERE t.anno_id IS NOT NULL AND s.anno_id IS NOT NULL AND t.anno_id <> s.anno_id GROUP BY 1', v_sede, v_t));
    END IF;

    IF r.tabella = 'pagamenti' THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'euro_importo',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, coalesce(sum(t.importo), 0)::numeric AS valore FROM %s t GROUP BY 1', v_sede, v_t));
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'euro_importo_pagato',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, coalesce(sum(t.importo_pagato), 0)::numeric AS valore FROM %s t GROUP BY 1', v_sede, v_t));
      IF v_nuova IS NOT NULL THEN
        v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'euro_nuove',
          format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, coalesce(sum(t.importo), 0)::numeric AS valore FROM %s t WHERE %s GROUP BY 1', v_sede, v_t, v_nuova));
      END IF;
      -- per quale strada il riempimento ha trovato l'anno di una voce: competenza, scadenza o creazione
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:via_competenza',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.%I IS NOT NULL GROUP BY 1',
               v_sede, v_t, r.colonna_data));
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:via_scadenza',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.%I IS NULL AND t.%I IS NOT NULL GROUP BY 1',
               v_sede, v_t, r.colonna_data, r.colonna_data_riserva));
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:via_creazione',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.%I IS NULL AND t.%I IS NULL GROUP BY 1',
               v_sede, v_t, r.colonna_data, r.colonna_data_riserva));
      -- competenza oltre la fine dell'ultimo anno che la sede ha in questo momento
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:pagamenti_anno_successivo',
        format('SELECT q.sede AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore '
               || 'FROM (SELECT %s AS sede, t.%I AS giorno FROM %s t WHERE t.%I IS NOT NULL) q '
               || 'WHERE q.giorno > (SELECT max(s.fine) FROM public.anni_sede s WHERE s.scuola_id = q.sede) GROUP BY 1',
               v_sede, r.colonna_data, v_t, r.colonna_data));
      -- Una voce senza competenza con l'anno DICHIARATO diverso da quello della scadenza è legittima (una quota
      -- 2027/28 con scadenza a febbraio 2027): non è un errore, la segreteria deve solo poterla vedere.
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:pagamenti_anno_diverso_da_scadenza',
        format('SELECT q.sede AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore '
               || 'FROM (SELECT %s AS sede, t.anno_id AS anno, t.%I AS giorno FROM %s t '
               || 'WHERE t.%I IS NULL AND t.%I IS NOT NULL AND t.anno_id IS NOT NULL) q '
               || 'WHERE q.anno IS DISTINCT FROM public.anno_di(q.sede, q.giorno) GROUP BY 1',
               v_sede, r.colonna_data_riserva, v_t, r.colonna_data, r.colonna_data_riserva));

    ELSIF r.tabella = 'enrollment_submissions' THEN
      -- L'anno della domanda: il suo, o quello attivo della sede. Il 15/09 e il 01/09 sono di QUELL'anno.
      v_cond := format('SELECT t.scuola_id AS sede, public.giorno_roma(t.created_at) AS giorno, '
                       || '(SELECT y.anno_inizio FROM public.anni_scolastici y WHERE y.id = coalesce(t.anno_id, '
                       || '(SELECT x.anno_id FROM public.anni_sede x WHERE x.id = public.anno_attivo(t.scuola_id)))) AS base '
                       || 'FROM %s t WHERE t.scuola_id IS NOT NULL', v_t);
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:domande_dopo_15_09',
        format('SELECT q.sede AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM (%s) q '
               || 'WHERE q.base IS NOT NULL AND q.giorno > make_date(q.base::int, 9, 15) GROUP BY 1', v_cond));
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:domande_prima_1_09',
        format('SELECT q.sede AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM (%s) q '
               || 'WHERE q.base IS NOT NULL AND q.giorno < make_date(q.base::int, 9, 1) GROUP BY 1', v_cond));

    ELSIF r.tabella = 'crm_bambini' THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:crm_non_indicato',
        format('SELECT %s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.anno_ingresso = %L GROUP BY 1',
               v_sede, v_t, 'non_indicato'));

    ELSIF r.tabella = 'frequenze' THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'recuperi',
        format('SELECT t.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.origine = %L GROUP BY 1',
               v_t, 'recupero'));
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:retta_da_listino',
        format('SELECT t.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE t.retta_mensile IS NULL GROUP BY 1', v_t));
      -- sedi senza `retta_default_importo`: la retta senza fascia diventa 150 € (come fa oggi la generazione).
      -- Il valore sta in `admin_settings` (una riga per sede); il ripiego sulla colonna di `schools` resta per i
      -- database che hanno quella forma.
      v_cond := NULL;
      IF to_regclass('public.admin_settings') IS NOT NULL AND public.anno_ha_colonna('admin_settings', 'retta_default_importo') THEN
        v_cond := 'NOT EXISTS (SELECT 1 FROM public.admin_settings x WHERE x.scuola_id = t.scuola_id AND x.retta_default_importo > 0)';
      ELSIF public.anno_ha_colonna('schools', 'retta_default_importo') THEN
        v_cond := 'EXISTS (SELECT 1 FROM public.schools s WHERE s.id = t.scuola_id AND s.retta_default_importo IS NULL)';
      END IF;
      IF v_cond IS NOT NULL THEN
        v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:retta_default_assente_150',
          format('SELECT t.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t WHERE %s GROUP BY 1', v_t, v_cond));
      END IF;
      -- ingresso/uscita che il riempimento ha dovuto portare all'inizio dell'anno
      IF to_regclass('public.alunni_classi_storico') IS NOT NULL THEN
        v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:ingresso_portato_a_inizio_anno',
          format('SELECT t.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t '
                 || 'JOIN public.anni_sede a ON a.id = t.anno_sede_id WHERE t.data_ingresso = a.inizio '
                 || 'AND EXISTS (SELECT 1 FROM public.alunni_classi_storico h WHERE h.alunno_id = t.alunno_id AND h.dal < a.inizio) GROUP BY 1', v_t));
      END IF;
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, r.tabella, 'ambiguo:uscita_portata_a_inizio_anno',
        format('SELECT t.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM %s t '
               || 'JOIN public.anni_sede a ON a.id = t.anno_sede_id WHERE t.data_uscita IS NOT NULL AND t.data_uscita = a.inizio GROUP BY 1', v_t));
    END IF;
  END LOOP;

  -- I nomi di classe (testo) che nessuna sezione dell'anno ATTIVO della sede ha: si contano, non si leggono.
  FOR c IN SELECT * FROM (VALUES
      ('avvisi', 'target_classes', true), ('forms_templates', 'target_classes', true),
      ('galleria_media_v2', 'target_classes', true), ('news_posts', 'target_classes', true),
      ('video_intents', 'classi_destinatarie', true), ('mensa_class_menu_assignment', 'classe', false)
    ) AS v(tab, col, e_array) LOOP
    CONTINUE WHEN p_tabelle IS NOT NULL AND NOT (c.tab = ANY (p_tabelle));
    CONTINUE WHEN to_regclass(format('public.%I', c.tab)) IS NULL OR NOT public.anno_ha_colonna(c.tab, c.col);
    v_t := format('public.%I', c.tab);
    v_sede := public.anno_sede_sql(c.tab, 't');
    v_cond := CASE WHEN c.e_array
                   THEN format('SELECT %s AS sede, v.voce FROM %s t CROSS JOIN LATERAL unnest(coalesce(t.%I, %L::text[])) AS v(voce)', v_sede, v_t, c.col, '{}')
                   ELSE format('SELECT %s AS sede, t.%I AS voce FROM %s t', v_sede, c.col, v_t) END;
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, c.tab, 'ambiguo:nomi_classe_non_abbinati:' || c.tab,
      format('SELECT q.sede AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM (%s) q '
             || 'WHERE q.sede IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sections s WHERE s.scuola_id = q.sede '
             || 'AND s.anno_id = (SELECT x.anno_id FROM public.anni_sede x WHERE x.id = public.anno_attivo(q.sede)) '
             || 'AND lower(replace(s.name, %L, %L)) = lower(replace(q.voce, %L, %L))) GROUP BY 1',
             v_cond, ' ', '', ' ', ''));
  END LOOP;

  -- Le righe con nomi di classe il cui anno non ha NESSUNA sezione nella sede (es. gli avvisi dell'estate 2026, nel 2025/26): gli uuid
  -- sono quelli del riempimento e non si possono ricalcolare. Lo stesso anno della riga che usa `anno_target_divergenti`.
  FOR c IN SELECT * FROM (VALUES
      ('avvisi', 'target_classes', true), ('forms_templates', 'target_classes', true),
      ('galleria_media_v2', 'target_classes', true), ('news_posts', 'target_classes', true),
      ('video_intents', 'classi_destinatarie', true), ('mensa_class_menu_assignment', 'classe', false)
    ) AS v(tab, col, e_array) LOOP
    CONTINUE WHEN p_tabelle IS NOT NULL AND NOT (c.tab = ANY (p_tabelle));
    CONTINUE WHEN to_regclass(format('public.%I', c.tab)) IS NULL OR NOT public.anno_ha_colonna(c.tab, c.col);
    v_sede := public.anno_sede_sql(c.tab, 't');
    v_cond := CASE
      WHEN public.anno_ha_colonna(c.tab, 'anno_id') THEN 't.anno_id'
      WHEN public.anno_ha_colonna(c.tab, 'attivo_dal') THEN format('public.anno_di(%s, t.attivo_dal)', v_sede)
      WHEN public.anno_ha_colonna(c.tab, 'created_at') THEN format('public.anno_di(%s, public.giorno_roma(t.created_at::timestamptz))', v_sede)
      ELSE 'NULL::uuid' END;
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, c.tab, 'ambiguo:classi_in_anno_senza_sezioni:' || c.tab,
      format('SELECT %1$s AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM public.%2$I t '
             || 'WHERE %1$s IS NOT NULL AND %3$s IS NOT NULL AND %4$s '
             || 'AND NOT EXISTS (SELECT 1 FROM public.sections s WHERE s.scuola_id = %1$s AND s.anno_id = %3$s) GROUP BY 1',
             v_sede, c.tab, v_cond,
             CASE WHEN c.e_array THEN format('cardinality(coalesce(t.%I, %L::text[])) > 0', c.col, '{}')
                  ELSE format('t.%I IS NOT NULL', c.col) END));
  END LOOP;

  -- Gli incassi non hanno anno (anno solare): solo il totale per sede, via la voce di pagamento.
  IF (p_tabelle IS NULL OR 'incassi' = ANY (p_tabelle))
     AND to_regclass('public.incassi') IS NOT NULL AND to_regclass('public.pagamenti') IS NOT NULL THEN
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, 'incassi', 'euro_incassi',
      'SELECT p.scuola_id AS scuola_id, NULL::uuid AS anno_id, coalesce(sum(i.importo), 0)::numeric AS valore '
      || 'FROM public.incassi i JOIN public.pagamenti p ON p.id = i.pagamento_id GROUP BY 1');
  END IF;

  -- Gli alunni: la tabella non è nel registro, ma il riempimento e lo specchio li toccano.
  IF (p_tabelle IS NULL OR 'alunni' = ANY (p_tabelle)) AND to_regclass('public.alunni') IS NOT NULL THEN
    v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, 'alunni', 'ambiguo:alunni_senza_sede',
      'SELECT NULL::uuid AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM public.alunni a WHERE a.scuola_id IS NULL');
    IF to_regclass('public.alunni_classi_storico') IS NOT NULL THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, 'alunni', 'ambiguo:alunni_senza_storico',
        'SELECT a.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM public.alunni a '
        || 'WHERE a.scuola_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.alunni_classi_storico h WHERE h.alunno_id = a.id) GROUP BY 1');
    END IF;
    -- gli alunni con sede ma senza frequenza nell'anno attivo della sede (chi non ha sede non conta)
    IF to_regclass('public.frequenze') IS NOT NULL THEN
      v_tot := v_tot + public.anno_fotografa_scrivi(p_fase, 'alunni', 'alunni_senza_frequenza',
        'SELECT a.scuola_id AS scuola_id, NULL::uuid AS anno_id, count(*)::numeric AS valore FROM public.alunni a '
        || 'WHERE a.scuola_id IS NOT NULL AND public.anno_attivo(a.scuola_id) IS NOT NULL AND a.stato IS DISTINCT FROM ''in_arrivo'' '
        || 'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = a.id AND f.anno_sede_id = public.anno_attivo(a.scuola_id)) GROUP BY 1');
    END IF;
  END IF;

  RETURN v_tot;
END
$$;

-- ── 7 · Un «in arrivo» non ha una sezione: lo dice il database ─────────────────────────────────────────────────────────
-- Il bambino esce dagli elenchi staccandosi dalla sezione, e l'«in arrivo» ha la stessa impronta: se qualcosa gli desse una
-- sezione comparirebbe fra i frequentanti senza passare dal passaggio d'anno. La guardia conta le righe che violerebbero il
-- vincolo prima di aggiungerlo: se ce ne fossero il `VALIDATE` farebbe fallire l'integrazione al merge, e il vincolo non
-- nasce (lo dice il log). Riapplicabile: se c'è già, non si tocca.
DO $$
DECLARE
  fuori bigint;
BEGIN
  IF to_regclass('public.alunni') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'alunni' AND column_name IN ('stato', 'section_id')
     HAVING count(*) = 2
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.alunni'::regclass AND conname = 'alunni_in_arrivo_senza_sezione'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO fuori FROM public.alunni WHERE stato = 'in_arrivo' AND section_id IS NOT NULL;
  IF fuori > 0 THEN
    RAISE WARNING 'anno_alunno_in_arrivo: % righe in_arrivo con una sezione, vincolo alunni_in_arrivo_senza_sezione non aggiunto', fuori;
    RETURN;
  END IF;

  ALTER TABLE public.alunni
    ADD CONSTRAINT alunni_in_arrivo_senza_sezione
    CHECK (stato IS DISTINCT FROM 'in_arrivo' OR section_id IS NULL) NOT VALID;
  ALTER TABLE public.alunni
    VALIDATE CONSTRAINT alunni_in_arrivo_senza_sezione;
END $$;

-- ── 8 · I permessi ────────────────────────────────────────────────────────────────────────────────────────────────────
-- `CREATE OR REPLACE` conserva i privilegi che c'erano. `elimina_alunno_definitivo` resta com'era (revocata ad anon e
-- authenticated da `20261008220540_alunni_elimina_definitivo.sql`; dentro `to_regprocedure`, dove la funzione non c'è non nasce
-- aperta): è nell'elenco AMMESSE del lock dei SECURITY DEFINER, come già per M3. `anno_fotografa` si riscrive lo stesso.
REVOKE ALL ON FUNCTION public.anno_fotografa(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_fotografa(text, text[]) TO service_role;
