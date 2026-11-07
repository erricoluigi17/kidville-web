-- Anno scolastico · PR 2 · M1 · gli strumenti del riempimento.
--
-- Nessun UPDATE di massa: si applica in un attimo e i file che seguono (riempimento, vincoli) li usano.
-- Il file è ordinato a SEZIONI, ognuna con il suo titolo; le sezioni del rapporto di riconciliazione e dello
-- specchio `alunni` si aggiungono qui sotto dai compiti successivi della PR 2.
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Nessun uuid di sede, nessuna
-- lettura di `schools.operativa`, ogni tabella opzionale dietro `to_regclass` (il DB della CI non le ha tutte).

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

-- ── 2.0 · Manopole e anno successivo ────────────────────────────────────────

-- `dichiarato_transitorio`: finché è accesa il database dà l'anno alle scritture di oggi, che non lo portano
-- (il modulo pubblico delle iscrizioni, le rate, il CRM…). La PR 3 la mette a `false` quando l'app scrive
-- `anno_id` da sé; la funzione che la usa sparisce nella PR 5. Spegne SOLO il ramo «anno mancante».
-- `specchio_alunni_attivo`: interruttore d'emergenza dello specchio `alunni` → `frequenze` (compito 2.3).
ALTER TABLE public.anno_regole ADD COLUMN IF NOT EXISTS dichiarato_transitorio boolean NOT NULL DEFAULT true;
ALTER TABLE public.anno_regole ADD COLUMN IF NOT EXISTS specchio_alunni_attivo boolean NOT NULL DEFAULT true;

-- `sede_facoltativa`: la colonna che porta alla sede può essere NULL (una riga può non avere sede: un avviso
-- per tutte le sedi). `segue_data` (solo `pagamenti`): la data modificata sposta l'anno.
ALTER TABLE public.anno_tabelle ADD COLUMN IF NOT EXISTS sede_facoltativa boolean NOT NULL DEFAULT false;
ALTER TABLE public.anno_tabelle ADD COLUMN IF NOT EXISTS segue_data boolean NOT NULL DEFAULT false;

UPDATE public.anno_tabelle SET segue_data = (tabella = 'pagamenti') WHERE segue_data IS DISTINCT FROM (tabella = 'pagamenti');

-- Calcolato dal catalogo, non scritto a mano: una colonna-sede senza NOT NULL è facoltativa.
UPDATE public.anno_tabelle t
   SET sede_facoltativa = NOT a.attnotnull
  FROM pg_attribute a
 WHERE a.attrelid = to_regclass(format('public.%I', t.tabella))::oid
   AND a.attname = t.via_sede AND a.attnum > 0 AND NOT a.attisdropped
   AND t.sede_facoltativa IS DISTINCT FROM NOT a.attnotnull;

-- L'anno successivo di una sede. Lo chiamerà il job (PR 4.5): è idempotente, due chiamate fanno un anno solo.
-- Se l'ULTIMO anno della sede ha `prepara_successivo_dal` <= `p_oggi`, crea l'anno dopo di lui: comincia il
-- giorno dopo la sua fine e ha, come l'anno prima, stesso giorno e mese di `fine` e di `ultimo_giorno_aperto`
-- (un confine spostato al 25/08 resta al 25/08). Nasce `in_preparazione`: `anno_attivo()` non lo vede.
-- Restituisce quanti `anni_sede` ha creato (0 o 1).
CREATE OR REPLACE FUNCTION public.anni_sede_crea_successivo(
  p_scuola uuid,
  p_oggi   date DEFAULT public.giorno_roma(now())
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ultimo  public.anni_sede%ROWTYPE;
  v_inizio  smallint;
  v_anno    uuid;
  v_nuovo   uuid;
  v_da      date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('anni_sede_crea_successivo:' || p_scuola::text));

  SELECT s.* INTO v_ultimo FROM public.anni_sede s WHERE s.scuola_id = p_scuola ORDER BY s.inizio DESC LIMIT 1;
  IF NOT FOUND OR v_ultimo.prepara_successivo_dal > p_oggi THEN
    RETURN 0;
  END IF;

  SELECT y.anno_inizio INTO v_inizio FROM public.anni_scolastici y WHERE y.id = v_ultimo.anno_id;
  INSERT INTO public.anni_scolastici (anno_inizio) VALUES (v_inizio + 1) ON CONFLICT (anno_inizio) DO NOTHING;
  SELECT y.id INTO v_anno FROM public.anni_scolastici y WHERE y.anno_inizio = v_inizio + 1;

  v_da := v_ultimo.fine + 1;
  INSERT INTO public.anni_sede
    (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
  VALUES
    (p_scuola, v_anno, v_da, (v_ultimo.fine + interval '1 year')::date, 'in_preparazione',
     (v_ultimo.ultimo_giorno_aperto + interval '1 year')::date, v_da)
  RETURNING id INTO v_nuovo;

  INSERT INTO public.anni_sede_stati (anno_sede_id, stato) VALUES (v_nuovo, 'in_preparazione');
  RETURN 1;
END
$$;

-- ── 2.0 · La regola transitoria dei «dichiarati» ────────────────────────────

-- L'anno (`anni_scolastici.id`) che una scrittura di oggi, senza `anno_id`, riceve. UN SOLO `CASE` per tabella:
--   · domande di iscrizione, votazioni, caricamenti Excel → l'anno attivo della sede;
--   · pagamenti → competenza, poi scadenza, poi il giorno di ROMA di `creato_il` (mai il giorno UTC);
--   · CRM → `quota_anno` se c'è (è l'anno d'inizio), altrimenti l'etichetta rispetto a `creata_il`
--     (`prossimo` = l'anno dopo, il resto = quello di `creata_il`);
--   · scrutini e certificati → l'etichetta `anno_scolastico` ('2026/27'); senza etichetta, l'anno attivo.
-- NULL se non c'è un anno da dare (sede non ricavabile, etichetta che nessun anno della sede ha): chi chiama
-- decide se è un errore. Non guarda le manopole.
CREATE OR REPLACE FUNCTION public.anno_dichiarato_transitorio(p_tabella text, p_riga jsonb)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sede   uuid;
  v_giorno date;
  v_testo  text;
  v_quota  integer;
  v_base   smallint;
  v_et     text;
BEGIN
  v_sede := public.anno_sede_della_riga(p_tabella, p_riga);
  IF v_sede IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_tabella IN ('enrollment_submissions', 'votazioni', 'iscrizioni_elenco_caricamenti') THEN
    RETURN (SELECT s.anno_id FROM public.anni_sede s WHERE s.id = public.anno_attivo(v_sede));

  ELSIF p_tabella = 'pagamenti' THEN
    v_testo := coalesce(p_riga ->> 'periodo_competenza', p_riga ->> 'scadenza');
    IF v_testo IS NOT NULL THEN
      v_giorno := left(v_testo, 10)::date;
    ELSIF p_riga ->> 'creato_il' IS NOT NULL THEN
      v_giorno := public.giorno_roma((p_riga ->> 'creato_il')::timestamptz);
    END IF;
    RETURN CASE WHEN v_giorno IS NULL THEN NULL ELSE public.anno_di(v_sede, v_giorno) END;

  ELSIF p_tabella = 'crm_bambini' THEN
    v_quota := (p_riga ->> 'quota_anno')::integer;
    IF v_quota IS NULL THEN
      v_giorno := public.giorno_roma(coalesce((p_riga ->> 'creata_il')::timestamptz, now()));
      SELECT y.anno_inizio INTO v_base
        FROM public.anni_scolastici y WHERE y.id = public.anno_di(v_sede, v_giorno);
      IF v_base IS NULL THEN
        RETURN NULL;
      END IF;
      v_quota := v_base + CASE WHEN p_riga ->> 'anno_ingresso' = 'prossimo' THEN 1 ELSE 0 END;
    END IF;
    RETURN (SELECT s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
             WHERE s.scuola_id = v_sede AND y.anno_inizio = v_quota);

  ELSIF p_tabella IN ('scrutinio_periodi', 'certificati_competenze') THEN
    v_et := p_riga ->> 'anno_scolastico';
    IF v_et IS NULL THEN
      RETURN (SELECT s.anno_id FROM public.anni_sede s WHERE s.id = public.anno_attivo(v_sede));
    END IF;
    RETURN (SELECT s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
             WHERE s.scuola_id = v_sede AND (y.etichetta_breve = v_et OR y.etichetta = v_et));
  END IF;

  RETURN NULL;
END
$$;

-- Il CRM: cambiare `anno_ingresso` o `quota_anno` sposta l'anno della scheda, se nello stesso comando non si
-- tocca `anno_id`. Il nome precede `trg_zz_anno_assegna_e_verifica` (ordine alfabetico), che gira dopo.
-- Non dipende da `dichiarato_transitorio`: come `segue_data`, non è il ramo «anno mancante». Un'etichetta che
-- nessun anno della sede ha → ANNO_NON_COERENTE a controlli rigidi; in morbido la riga tiene l'anno che ha.
CREATE OR REPLACE FUNCTION public.crm_bambini_anno_da_etichetta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rigidi boolean;
  v_anno   uuid;
BEGIN
  IF NEW.anno_id IS NOT DISTINCT FROM OLD.anno_id
     AND (NEW.anno_ingresso IS DISTINCT FROM OLD.anno_ingresso OR NEW.quota_anno IS DISTINCT FROM OLD.quota_anno) THEN
    -- rigido come il trigger generico: la manopola globale O la `rigida` della tabella nel registro
    SELECT r.controlli_rigidi INTO v_rigidi FROM public.anno_regole r;
    v_rigidi := coalesce(v_rigidi, false)
                OR coalesce((SELECT t.rigida FROM public.anno_tabelle t WHERE t.tabella = 'crm_bambini'), false);
    BEGIN
      v_anno := public.anno_dichiarato_transitorio('crm_bambini', to_jsonb(NEW));
    EXCEPTION WHEN OTHERS THEN
      IF v_rigidi THEN
        RAISE;
      END IF;
      PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'transitorio-fallito', 'crm_bambini_anno_da_etichetta',
                                     'regola transitoria fallita: la scrittura è passata con l''anno di prima',
                                     'db:anno-transitorio:' || TG_TABLE_NAME, SQLSTATE);
      RETURN NEW;
    END;
    IF v_anno IS NOT NULL THEN
      NEW.anno_id := v_anno;
    ELSIF v_rigidi THEN
      RAISE EXCEPTION 'ANNO_NON_COERENTE'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'anno_id', NEW.anno_id)::text;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.crm_bambini') AND c.relkind IN ('r', 'p'))
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.crm_bambini') AND attname = 'anno_id' AND NOT attisdropped) THEN
    DROP TRIGGER IF EXISTS trg_crm_bambini_anno_da_etichetta ON public.crm_bambini;
    CREATE TRIGGER trg_crm_bambini_anno_da_etichetta
      BEFORE UPDATE OF anno_ingresso, quota_anno ON public.crm_bambini
      FOR EACH ROW EXECUTE FUNCTION public.crm_bambini_anno_da_etichetta();
  END IF;
END
$mig$;

-- Il trigger generico, in quattro punti rispetto alla PR 1 (il resto è com'era):
--   (a) `segue_data` (solo `pagamenti`): in un UPDATE di una voce SENZA competenza, se `anno_id` non è toccato e
--       la scadenza cambia, l'anno segue la nuova scadenza SOLO se prima la seguiva (l'anno di OLD era quello
--       della vecchia scadenza). Un anno dichiarato diverso dalla scadenza resta dov'è e non dà mai errore;
--   (b) il ramo «anno mancante» delle sette tabelle dichiarate di oggi: con `dichiarato_transitorio` l'anno lo
--       dà `anno_dichiarato_transitorio`; con la manopola spenta, a controlli rigidi ANNO_DA_SPECIFICARE e in
--       morbido NULL. Una riga la cui sede non si ricava resta senza anno, senza errori (colonna-sede
--       facoltativa). Come il calcolo, in morbido è avvolto in una rete: un guasto lascia NULL e una riga in app_log;
--   (c) `anno_scolastico.riempimento = 'on'` (solo nella transazione del riempimento): una riga che nasce senza
--       anno e viene riempita non muove `storico_versione` né `updated_at`;
--   (d) a controlli rigidi, una tabella `sede_facoltativa` con la sede NON ricavabile non solleva GIORNO_SENZA_ANNO:
--       lascia l'anno com'è (NULL se non scritto).
-- Tutto resta dentro i rami dell'anno NULL o dell'UPDATE di una data: gli UPDATE estranei escono prima, come oggi.
CREATE OR REPLACE FUNCTION public.anno_assegna_e_verifica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg       public.anno_tabelle%ROWTYPE;
  v_rigidi    boolean;
  v_ctrl      boolean;
  v_guardia   boolean;
  v_trans_on  boolean;
  v_n         jsonb;
  v_o         jsonb;
  v_attuale   uuid;
  v_calcolato uuid;
  v_sez_anno  uuid;
  v_senza     boolean;
  v_sede_o    uuid;
  v_sede_n    uuid;
  v_t_old     text;
  v_t_new     text;
  v_g_old     date;
  v_g_new     date;
  v_segue     uuid;
  v_trans     uuid;
  v_ripristino jsonb;
BEGIN
  -- L'UNICA lettura di `anno_regole` per riga: le manopole insieme. Con la guardia spenta è anche
  -- l'unico costo della guardia (R2: le scritture di oggi non cambiano).
  SELECT r.controlli_rigidi, r.guardia_attiva, r.dichiarato_transitorio
    INTO v_ctrl, v_guardia, v_trans_on FROM public.anno_regole r;
  v_ctrl := coalesce(v_ctrl, false);
  v_guardia := coalesce(v_guardia, false);
  v_trans_on := coalesce(v_trans_on, false);

  IF TG_OP = 'DELETE' THEN
    IF v_guardia THEN
      SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = TG_TABLE_NAME;
      IF FOUND THEN
        PERFORM public.anno_guardia_verifica(v_reg, TG_OP, to_jsonb(OLD), NULL, NULL);
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = TG_TABLE_NAME;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_n := to_jsonb(NEW);
  v_attuale := (v_n ->> 'anno_id')::uuid;
  v_senza := v_attuale IS NULL;

  IF TG_OP = 'UPDATE' AND v_attuale IS NOT NULL THEN
    v_o := to_jsonb(OLD);
    IF (v_n ->> 'anno_id')                       IS NOT DISTINCT FROM (v_o ->> 'anno_id')
       AND (v_n ->> v_reg.colonna_data)          IS NOT DISTINCT FROM (v_o ->> v_reg.colonna_data)
       AND (v_n ->> v_reg.colonna_data_riserva)  IS NOT DISTINCT FROM (v_o ->> v_reg.colonna_data_riserva)
       AND (v_n ->> v_reg.via_sede)              IS NOT DISTINCT FROM (v_o ->> v_reg.via_sede)
       AND (v_n ->> v_reg.madre_colonna)         IS NOT DISTINCT FROM (v_o ->> v_reg.madre_colonna)
       AND (v_n ->> 'section_id')                IS NOT DISTINCT FROM (v_o ->> 'section_id') THEN
      -- Niente ricalcolo, ma la guardia sì: un UPDATE estraneo all'anno su una riga di un anno chiuso.
      IF v_guardia THEN
        PERFORM public.anno_guardia_verifica(v_reg, TG_OP, v_o, v_n, NULL);
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  v_rigidi := v_reg.rigida OR v_ctrl;

  -- (a) segue_data. Solo una voce SENZA competenza, con `anno_id` non toccato e la scadenza (la data di riserva)
  -- cambiata; e solo se prima la seguiva. Non guarda `dichiarato_transitorio`. Mai un errore per l'anno.
  IF TG_OP = 'UPDATE' AND v_reg.segue_data AND v_attuale IS NOT NULL
     AND v_attuale IS NOT DISTINCT FROM (v_o ->> 'anno_id')::uuid
     AND (v_n ->> v_reg.colonna_data) IS NULL
     AND (v_n ->> v_reg.colonna_data_riserva) IS DISTINCT FROM (v_o ->> v_reg.colonna_data_riserva) THEN
    BEGIN
      v_sede_o := public.anno_sede_della_riga(TG_TABLE_NAME, v_o);
      v_sede_n := public.anno_sede_della_riga(TG_TABLE_NAME, v_n);
      v_t_old := coalesce(v_o ->> v_reg.colonna_data_riserva, v_o ->> v_reg.colonna_creazione);
      v_t_new := coalesce(v_n ->> v_reg.colonna_data_riserva, v_n ->> v_reg.colonna_creazione);
      IF v_sede_o IS NOT NULL AND v_sede_n IS NOT NULL AND v_t_old IS NOT NULL AND v_t_new IS NOT NULL THEN
        v_g_old := CASE WHEN length(v_t_old) = 10 THEN v_t_old::date ELSE public.giorno_roma(v_t_old::timestamptz) END;
        v_g_new := CASE WHEN length(v_t_new) = 10 THEN v_t_new::date ELSE public.giorno_roma(v_t_new::timestamptz) END;
        IF v_attuale IS NOT DISTINCT FROM public.anno_di(v_sede_o, v_g_old) THEN
          v_segue := public.anno_di(v_sede_n, v_g_new);
          IF v_segue IS NOT NULL AND v_segue <> v_attuale THEN
            NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_segue));
            v_attuale := v_segue;
            v_n := to_jsonb(NEW);
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF v_rigidi THEN
        RAISE;
      END IF;
      PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'segue-data-fallito', 'anno_assegna_e_verifica',
                                     'segue_data fallito: la scrittura è passata con l''anno di prima',
                                     'db:anno-segue-data:' || TG_TABLE_NAME, SQLSTATE);
    END;
  END IF;

  -- Il calcolo. RIGIDO: gli errori, i codici compresi, salgono. MORBIDO: una rete che non rifiuta
  -- mai una scrittura di oggi (R2): un guasto del calcolo (una colonna che non si converte, una madre
  -- con la chiave fatta diversamente) lascia `anno_id` NULL e lascia una traccia in `app_log`. La rete
  -- copre SOLO il calcolo, e nel ramo morbido il calcolo non solleva i codici d'errore.
  IF v_rigidi AND v_reg.sede_facoltativa AND public.anno_sede_della_riga(TG_TABLE_NAME, v_n) IS NULL THEN
    -- (d) Una tabella con la chiave della sede facoltativa e la riga SENZA sede (un avviso per tutte le sedi, la
    -- firma di un OTP che non porta la scuola): non c'è un calendario con cui calcolare. L'anno resta quello
    -- scritto, o NULL: lo ammette il `CHECK` dei vincoli (`anno_id IS NOT NULL OR <sede> IS NULL`).
    v_calcolato := NULL;
  ELSIF v_rigidi THEN
    v_calcolato := public.anno_calcola_della_riga(v_reg, v_n, true);
  ELSE
    BEGIN
      v_calcolato := public.anno_calcola_della_riga(v_reg, v_n, false);
    EXCEPTION WHEN OTHERS THEN
      v_calcolato := NULL;
      PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'calcolo-anno-fallito', 'anno_assegna_e_verifica',
                                     'calcolo dell''anno fallito: la scrittura è passata con anno_id NULL',
                                     'db:anno-calcolo:' || TG_TABLE_NAME, SQLSTATE);
    END;
  END IF;

  IF v_calcolato IS NOT NULL THEN
    IF v_attuale IS NULL THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_calcolato));
      v_attuale := v_calcolato;
    ELSIF v_attuale <> v_calcolato
          AND TG_OP = 'UPDATE' AND v_reg.modo IN ('data', 'madre')
          AND v_attuale IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'anno_id')::uuid THEN
      -- Chi corregge la data (o la madre) senza toccare `anno_id` vuole che la riga segua: l'anno si
      -- ASSEGNA, non si confronta (una data portata oltre il confine dell'anno non resta nel vecchio).
      -- La guardia, più sotto, vede ancora OLD e NEW: uscire da un anno chiuso, o entrarci, chiede il gettone.
      NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_calcolato));
      v_attuale := v_calcolato;
    ELSIF v_attuale <> v_calcolato AND v_rigidi THEN
      RAISE EXCEPTION 'ANNO_NON_COERENTE'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'anno_id', v_attuale,
                                         'anno_atteso', v_calcolato)::text;
    END IF;
  END IF;

  -- (b) La regola transitoria: l'app di oggi non scrive `anno_id`. Solo le sette tabelle dichiarate che l'app
  -- scrive senza anno (`sections` e `frequenze` hanno i loro trigger). Una sede non ricavabile lascia l'anno NULL.
  IF v_calcolato IS NULL AND v_attuale IS NULL AND v_reg.modo = 'dichiarato'
     AND TG_TABLE_NAME = ANY (ARRAY['enrollment_submissions', 'pagamenti', 'crm_bambini', 'votazioni',
                                    'scrutinio_periodi', 'certificati_competenze', 'iscrizioni_elenco_caricamenti'])
     AND public.anno_sede_della_riga(TG_TABLE_NAME, v_n) IS NOT NULL THEN
    IF v_trans_on THEN
      IF v_rigidi THEN
        v_trans := public.anno_dichiarato_transitorio(TG_TABLE_NAME, v_n);
      ELSE
        BEGIN
          v_trans := public.anno_dichiarato_transitorio(TG_TABLE_NAME, v_n);
        EXCEPTION WHEN OTHERS THEN
          v_trans := NULL;
          PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'transitorio-fallito', 'anno_assegna_e_verifica',
                                         'regola transitoria fallita: la scrittura è passata con anno_id NULL',
                                         'db:anno-transitorio:' || TG_TABLE_NAME, SQLSTATE);
        END;
      END IF;
      IF v_trans IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_trans));
        v_attuale := v_trans;
        v_n := to_jsonb(NEW);
      ELSIF v_rigidi THEN
        -- c'è un'etichetta (quota_anno, anno_scolastico) e nessun anno della sede la ha: non si indovina
        IF (v_n ->> 'quota_anno') IS NOT NULL OR (v_n ->> 'anno_scolastico') IS NOT NULL THEN
          RAISE EXCEPTION 'ANNO_NON_COERENTE'
            USING DETAIL = json_build_object('tabella', TG_TABLE_NAME)::text;
        END IF;
        RAISE EXCEPTION 'ANNO_DA_SPECIFICARE'
          USING DETAIL = json_build_object('tabella', TG_TABLE_NAME)::text;
      END IF;
    ELSIF v_rigidi THEN
      RAISE EXCEPTION 'ANNO_DA_SPECIFICARE'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME)::text;
    END IF;
  END IF;

  -- La sezione della riga deve essere dello stesso anno (solo controlli rigidi).
  IF v_rigidi AND v_attuale IS NOT NULL AND (v_n ->> 'section_id') IS NOT NULL THEN
    SELECT s.anno_id INTO v_sez_anno FROM public.sections s WHERE s.id = (v_n ->> 'section_id')::uuid;
    IF FOUND AND v_sez_anno <> v_attuale THEN
      RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'section_id', v_n ->> 'section_id')::text;
    END IF;
  END IF;

  -- La guardia dell'anno chiuso (§4.4.6), DOPO il calcolo (§4.21): guarda l'anno della riga prima
  -- (OLD) e quello in cui finisce (NEW, e l'anno che dice la sua data).
  IF v_guardia THEN
    PERFORM public.anno_guardia_verifica(v_reg, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
                                         to_jsonb(NEW), v_calcolato);
  END IF;

  -- (c) Il riempimento: una riga che nasceva senza anno non cambia versione né data di modifica.
  IF v_senza AND TG_OP = 'UPDATE' AND current_setting('anno_scolastico.riempimento', true) = 'on' THEN
    v_o := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_o -> k) INTO v_ripristino
      FROM unnest(ARRAY['storico_versione', 'updated_at']) AS k WHERE v_o ? k;
    IF v_ripristino IS NOT NULL THEN
      NEW := jsonb_populate_record(NEW, v_ripristino);
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- Funzioni: EXECUTE solo al service_role (i trigger non ne hanno bisogno).
REVOKE ALL ON FUNCTION public.anno_assegna_e_verifica()                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_assegna_e_verifica()                TO service_role;
REVOKE ALL ON FUNCTION public.anni_sede_crea_successivo(uuid, date)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_dichiarato_transitorio(text, jsonb)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_bambini_anno_da_etichetta()             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anni_sede_crea_successivo(uuid, date)    TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_dichiarato_transitorio(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_bambini_anno_da_etichetta()          TO service_role;

-- ── 2.1 · Il rapporto di riconciliazione ────────────────────────────────────

-- Una fotografia di conteggi, euro e uuid: MAI un nome, MAI testo libero. Nessuna chiave esterna verso `anni_*`
-- (un anno che sparisce non deve toglierle il senso); verso `schools` sì, perché il lock `fk-scuola-id` vuole ogni
-- `scuola_id` con la sua FK, e `SET NULL` conserva i conteggi anche se la sede viene eliminata. La migrazione gira su un database vivo, quindi il criterio di
-- conservazione non è `dopo = prima` ma `dopo − prima − nuove = 0` (`anno_riconciliazione_differenze`).
CREATE TABLE IF NOT EXISTS public.riconciliazione_anno (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fase        text        NOT NULL CONSTRAINT riconciliazione_anno_fase_check CHECK (fase IN ('prima', 'dopo', 'finale')),
  eseguita_il timestamptz NOT NULL DEFAULT now(),
  transazione bigint      NOT NULL DEFAULT txid_current(),
  tabella     text        NOT NULL,
  -- sede cancellata → le righe del rapporto restano, con la sede NULL (il rapporto è storia, non si cancella con la sede)
  scuola_id   uuid REFERENCES public.schools(id) ON DELETE SET NULL,
  anno_id     uuid,
  voce        text        NOT NULL,
  valore      numeric     NOT NULL
);
CREATE INDEX IF NOT EXISTS riconciliazione_anno_fase_idx ON public.riconciliazione_anno (fase, eseguita_il, tabella);
CREATE INDEX IF NOT EXISTS riconciliazione_anno_scuola_idx ON public.riconciliazione_anno (scuola_id);

ALTER TABLE public.riconciliazione_anno ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.riconciliazione_anno FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.riconciliazione_anno TO service_role;

-- L'espressione SQL che dà la SEDE di una riga della tabella (alias `p_alias`): `scuola_id` se la tabella ce
-- l'ha, poi la via del registro (sezione, alunno, chat). Le tabelle `madre` non hanno sede: NULL.
CREATE OR REPLACE FUNCTION public.anno_sede_sql(p_tabella text, p_alias text DEFAULT 't')
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_via   text;
  v_madre text;
  v_parti text[] := '{}';
BEGIN
  SELECT t.via_sede, t.madre_tabella INTO v_via, v_madre FROM public.anno_tabelle t WHERE t.tabella = p_tabella;
  IF v_madre IS NOT NULL THEN
    RETURN 'NULL::uuid';
  END IF;
  IF public.anno_ha_colonna(p_tabella, 'scuola_id') THEN
    v_parti := v_parti || format('%I.scuola_id', p_alias);
  END IF;
  IF v_via IS NOT NULL AND v_via <> 'scuola_id' AND public.anno_ha_colonna(p_tabella, v_via) THEN
    v_parti := v_parti || CASE
      WHEN v_via = 'section_id' THEN
        format('(SELECT x.scuola_id FROM public.sections x WHERE x.id = %I.section_id)', p_alias)
      WHEN v_via IN ('alunno_id', 'student_id') THEN
        format('(SELECT x.scuola_id FROM public.alunni x WHERE x.id = %I.%I)', p_alias, v_via)
      WHEN v_via = 'thread_id' THEN
        format('(SELECT a.scuola_id FROM public.chat_threads c JOIN public.alunni a ON a.id = c.student_id WHERE c.id = %I.thread_id)', p_alias)
    END;
  END IF;
  IF cardinality(v_parti) = 0 THEN
    RETURN 'NULL::uuid';
  END IF;
  RETURN 'coalesce(' || array_to_string(v_parti, ', ') || ')';
END
$$;

-- Scrive nel rapporto il risultato di una SELECT (colonne `scuola_id`, `anno_id`, `valore`) e dice quante righe.
CREATE OR REPLACE FUNCTION public.anno_fotografa_scrivi(p_fase text, p_tabella text, p_voce text, p_select text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n bigint;
BEGIN
  EXECUTE format(
    'INSERT INTO public.riconciliazione_anno (fase, tabella, scuola_id, anno_id, voce, valore) '
    || 'SELECT %L, %L, q.scuola_id, q.anno_id, %L, q.valore FROM (%s) q WHERE q.valore IS NOT NULL',
    p_fase, p_tabella, p_voce, p_select);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- La fotografia. Per ogni tabella del registro che esiste (o per quelle date) scrive, per sede e per anno:
-- `righe`, `righe_per_anno`, `righe_senza_anno`, `righe_senza_sede`; in `dopo` e `finale` anche `righe_nuove`
-- (righe nate dopo la fotografia `prima` della stessa tabella); su `pagamenti` gli euro; su `incassi` il totale
-- (anno solare: nessun `anno_id`); e le voci `ambiguo:*`, che contano i casi in cui il riempimento ha dovuto
-- scegliere. Conta soltanto: nessuna riga viene letta o restituita.
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
      SELECT max(x.eseguita_il) INTO v_prima
        FROM public.riconciliazione_anno x WHERE x.fase = 'prima' AND x.tabella = r.tabella;
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
        || 'WHERE a.scuola_id IS NOT NULL AND public.anno_attivo(a.scuola_id) IS NOT NULL '
        || 'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = a.id AND f.anno_sede_id = public.anno_attivo(a.scuola_id)) GROUP BY 1');
    END IF;
  END IF;

  RETURN v_tot;
END
$$;

-- Le tabelle CONSERVATE in cui l'ultima fotografia `prima` e l'ultima `dopo` (o `finale`) non tornano:
-- `dopo − prima − nuove <> 0`, per `righe` ed `euro_importo`, al centesimo. Vuota = conservato. Sono escluse
-- `frequenze` e `frequenze_moduli`, che nascono vuote; si confrontano solo le tabelle fotografate in entrambe
-- le fasi. «Ultima» = la fotografia (la transazione) dell'ultima riga scritta per quella tabella e fase.
-- Le tabelle senza una colonna di creazione propria (avvisi_risposte, gallery_photo_uploads,
-- scrutinio_comportamento, valutazione_obiettivi, votazioni_candidati, votazioni_classi) non hanno `righe_nuove`:
-- una riga nata sul database vivo sembrerebbe un difetto, quindi un AUMENTO non si segnala (le conta la voce
-- `non_confrontabili`). Un CALO sì: le righe nuove sono >= 0, quindi `dopo < prima` e per forza una cancellazione.
CREATE OR REPLACE FUNCTION public.anno_riconciliazione_differenze()
RETURNS TABLE (tabella text, scuola_id uuid, voce text, prima numeric, dopo numeric, nuove numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ultime AS (
    SELECT DISTINCT ON (r.tabella, (r.fase = 'prima'))
           r.tabella, (r.fase = 'prima') AS e_prima, r.transazione
      FROM public.riconciliazione_anno r
     ORDER BY r.tabella, (r.fase = 'prima'), r.id DESC
  ),
  complete AS (
    SELECT u.tabella FROM ultime u
     WHERE u.tabella IN (SELECT t.tabella FROM public.anno_tabelle t
                          WHERE t.tabella NOT IN ('frequenze', 'frequenze_moduli')
                            AND t.colonna_creazione IS NOT NULL)
     GROUP BY u.tabella HAVING count(*) = 2
  ),
  marcate AS (
    SELECT r.tabella, r.scuola_id,
           CASE r.voce WHEN 'righe_nuove' THEN 'righe' WHEN 'euro_nuove' THEN 'euro_importo' ELSE r.voce END AS voce,
           CASE WHEN r.fase = 'prima' THEN 'p'
                WHEN r.voce IN ('righe_nuove', 'euro_nuove') THEN 'n'
                ELSE 'd' END AS k,
           r.valore
      FROM public.riconciliazione_anno r
      JOIN ultime u ON u.tabella = r.tabella AND u.transazione = r.transazione AND u.e_prima = (r.fase = 'prima')
     WHERE r.tabella IN (SELECT c.tabella FROM complete c)
       AND r.voce IN ('righe', 'euro_importo', 'righe_nuove', 'euro_nuove')
       AND NOT (r.fase = 'prima' AND r.voce IN ('righe_nuove', 'euro_nuove'))
  ),
  confrontabili AS (
    SELECT m.tabella, m.scuola_id, m.voce,
           coalesce(sum(m.valore) FILTER (WHERE m.k = 'p'), 0) AS prima,
           coalesce(sum(m.valore) FILTER (WHERE m.k = 'd'), 0) AS dopo,
           coalesce(sum(m.valore) FILTER (WHERE m.k = 'n'), 0) AS nuove
      FROM marcate m
     GROUP BY m.tabella, m.scuola_id, m.voce
    HAVING coalesce(sum(m.valore) FILTER (WHERE m.k = 'd'), 0) - coalesce(sum(m.valore) FILTER (WHERE m.k = 'p'), 0)
           - coalesce(sum(m.valore) FILTER (WHERE m.k = 'n'), 0) <> 0
  ),
  complete_nc AS (
    SELECT u.tabella FROM ultime u
     WHERE u.tabella IN (SELECT t.tabella FROM public.anno_tabelle t
                          WHERE t.tabella NOT IN ('frequenze', 'frequenze_moduli')
                            AND t.colonna_creazione IS NULL)
     GROUP BY u.tabella HAVING count(*) = 2
  ),
  totali_nc AS (
    SELECT r.tabella,
           coalesce(sum(r.valore) FILTER (WHERE r.fase = 'prima'), 0) AS prima,
           coalesce(sum(r.valore) FILTER (WHERE r.fase <> 'prima'), 0) AS dopo
      FROM public.riconciliazione_anno r
      JOIN ultime u ON u.tabella = r.tabella AND u.transazione = r.transazione AND u.e_prima = (r.fase = 'prima')
     WHERE r.tabella IN (SELECT c.tabella FROM complete_nc c) AND r.voce = 'righe_totale'
     GROUP BY r.tabella
  )
  SELECT x.tabella, x.scuola_id, x.voce, x.prima, x.dopo, x.nuove
    FROM (
      SELECT c.tabella, c.scuola_id, c.voce, c.prima, c.dopo, c.nuove FROM confrontabili c
      UNION ALL
      SELECT n.tabella, NULL::uuid, 'righe'::text, n.prima, n.dopo, 0::numeric FROM totali_nc n WHERE n.dopo < n.prima
    ) x
   ORDER BY x.tabella, x.scuola_id, x.voce
$$;

REVOKE ALL ON FUNCTION public.anno_sede_sql(text, text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_fotografa_scrivi(text, text, text, text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_fotografa(text, text[])                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_riconciliazione_differenze()                  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_sede_sql(text, text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_fotografa_scrivi(text, text, text, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_fotografa(text, text[])                    TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_riconciliazione_differenze()               TO service_role;

-- ── 2.1 · anno_invarianti(): la fotografia del rapporto non è un difetto ─────────────
-- Identica a quella della PR 1 tranne nell'invariante 10b: `riconciliazione_anno` ha una colonna `anno_id` (la
-- fotografia dice a quale anno appartengono le righe contate) ma non è una tabella del registro, e senza questa
-- esclusione la 10b la segnalerebbe per sempre. Il compito 2.3 aggiunge qui le invarianti 12 e 13.
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

  RETURN;
END
$$;

REVOKE ALL ON FUNCTION public.anno_invarianti() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_invarianti() TO service_role;

-- ── 2.2 · Il riempimento: i nomi di classe, la copia dell'anno, `anno_riempi()` ─────────────

-- I nomi di classe (testo) diventano uuid di sezione, accanto ai nomi che restano (vincono i nomi, §4.10).
-- La colonna nuova non cambia nessuna scrittura di oggi: la riempiono il riempimento e, dal Compito 2.3, il trigger.
DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('avvisi', 'target_section_ids'), ('galleria_media_v2', 'target_section_ids'),
      ('news_posts', 'target_section_ids'), ('forms_templates', 'target_section_ids'),
      ('video_intents', 'classi_destinatarie_section_ids')) AS v(t, c) LOOP
    IF EXISTS (SELECT 1 FROM pg_class k WHERE k.oid = to_regclass(format('public.%I', r.t)) AND k.relkind IN ('r', 'p')) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I uuid[]', r.t, r.c);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_class k WHERE k.oid = to_regclass('public.mensa_class_menu_assignment') AND k.relkind IN ('r', 'p')) THEN
    ALTER TABLE public.mensa_class_menu_assignment
      ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES public.sections(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS mensa_class_menu_assignment_section_id_idx
      ON public.mensa_class_menu_assignment (section_id);
  END IF;
END
$mig$;

-- I nomi di classe → gli uuid delle sezioni DELL'ANNO ATTIVO della sede. Si abbina sul nome normalizzato
-- `lower(replace(x, ' ', ''))` (la forma di `sections_forma_normalizzata_per_sede`): «gira soli» e «Girasoli» sono
-- la stessa sezione. Toglie i doppioni; un nome che nessuna sezione ha non produce niente (resta nei nomi).
-- NULL → NULL; array vuoto → '{}'; sede NULL → '{}'. Il Compito 2.3 la chiama dai trigger per tabella.
-- `p_anno` è un `anni_scolastici.id`: NULL vuol dire l'anno attivo della sede (il riempimento la chiama così); i
-- trigger e `anno_target_divergenti()` passano l'anno DELLA RIGA, perché dopo un passaggio d'anno gli uuid di un
-- avviso vecchio sono quelli delle sezioni di quell'anno e non vanno né riscritti né contati come divergenti.
CREATE OR REPLACE FUNCTION public.anno_traduci_classi(p_scuola uuid, p_nomi text[], p_anno uuid DEFAULT NULL)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_nomi IS NULL THEN NULL
    ELSE coalesce((
      SELECT array_agg(DISTINCT s.id ORDER BY s.id)
        FROM public.sections s
       WHERE s.scuola_id = p_scuola
         AND s.anno_id = coalesce(p_anno, (SELECT x.anno_id FROM public.anni_sede x WHERE x.id = public.anno_attivo(p_scuola)))
         AND lower(replace(s.name::text, ' ', '')) IN (SELECT lower(replace(n, ' ', '')) FROM unnest(p_nomi) AS n)
    ), '{}'::uuid[])
  END
$$;

-- La configurazione di un anno di sede (listino, moduli richiesti, posti) copiata in un altro DELLA STESSA sede.
-- Idempotente: ciò che c'è già nell'anno di arrivo non si tocca, due chiamate non copiano due volte. La chiamerà
-- il job (PR 4.5) quando crea l'anno successivo. Restituisce quante righe ha copiato per tabella.
CREATE OR REPLACE FUNCTION public.anno_copia_configurazione(p_da uuid, p_a uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sede_da uuid;
  v_sede_a  uuid;
  v_l       bigint;
  v_m       bigint;
  v_p       bigint;
BEGIN
  SELECT s.scuola_id INTO v_sede_da FROM public.anni_sede s WHERE s.id = p_da;
  SELECT s.scuola_id INTO v_sede_a  FROM public.anni_sede s WHERE s.id = p_a;
  IF v_sede_da IS NULL OR v_sede_a IS NULL OR v_sede_da <> v_sede_a OR p_da = p_a THEN
    RAISE EXCEPTION 'COPIA_ANNO_NON_VALIDA';
  END IF;

  INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, payment_category_id, importo, mesi)
  SELECT p_a, l.voce, l.fascia, l.payment_category_id, l.importo, l.mesi
    FROM public.listino_voci l WHERE l.anno_sede_id = p_da
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_l = ROW_COUNT;

  INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo, ordine)
  SELECT p_a, m.lista, m.codice, m.titolo, m.ordine
    FROM public.moduli_richiesti m WHERE m.anno_sede_id = p_da
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_m = ROW_COUNT;

  INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti, fonte)
  SELECT p_a, x.fascia, x.posti, x.fonte
    FROM public.posti_autorizzati x WHERE x.anno_sede_id = p_da
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_p = ROW_COUNT;

  RETURN jsonb_build_object('listino_voci', v_l, 'moduli_richiesti', v_m, 'posti_autorizzati', v_p);
END
$$;

-- IL RIEMPIMENTO. Esiste solo fra i file di riempimento e V2, che la elimina: accende due interruttori e non deve
-- restare una funzione chiamabile. Lascia calcolare l'anno al trigger generico (`UPDATE … SET anno_id = anno_id
-- WHERE anno_id IS NULL`): una sola fonte di verità, il riempimento prova il trigger sui dati veri.
--   · `p_oggi` NULL = il giorno di Roma di oggi: lo passa ad `anni_sede_crea_successivo`. I test passano una data
--     fissa, perché dal 01/09/2027 un test che usa l'orologio creerebbe anche il 2028/29 e scadrebbe col calendario.
--   · `p_tabelle` NULL = tutto; altrimenti solo le tabelle date (un nome sconosciuto → TABELLA_NON_NEL_RIEMPIMENTO).
--     Il lavoro «di sede» (anni successivi, frequenze, listino, copia dell'anno) si fa con NULL o con 'frequenze'.
--   · Precondizioni, prima di toccare niente: controlli morbidi (194 righe vecchie hanno anno e sezione di anni
--     diversi), guardia spenta, nessuna galleria con `sopprimiGenitori` (la modifica manderebbe notifiche alle famiglie).
--   · Interruttori, solo con `set_config(…, true)`: `scatola_nera.senza_storico` (niente copie del «com'era» di ogni
--     riga) e `anno_scolastico.riempimento` (il trigger rimette `storico_versione` e `updated_at`). In uscita sempre
--     `off`, anche dopo un errore. NON si accende `registri.manutenzione`: nessun trigger di queste tabelle lo legge.
--   · Ordine: anni successivi, frequenze, listino, copia; poi per profondità di madre (le madri prima delle figlie),
--     i dichiarati prima delle tabelle `data`, le piccole prima.
-- Restituisce {tabella: righe a cui ha dato l'anno}; rieseguita dà zero ovunque.
-- La firma a un solo parametro (bozza della PR) non deve restare accanto a quella a due: sarebbe una chiamata ambigua.
DROP FUNCTION IF EXISTS public.anno_riempi(text[]);
CREATE OR REPLACE FUNCTION public.anno_riempi(p_tabelle text[] DEFAULT NULL, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_extra   text[] := ARRAY['mensa_class_menu_assignment', 'news_posts', 'forms_templates'];
  v_rigidi  boolean;
  v_guardia boolean;
  v_x       text;
  v_n       bigint;
  v_res     jsonb := '{}'::jsonb;
  r         record;
  v_prima   bigint;
  v_dopo    bigint;
  v_sede    text;
  v_cs      text;
  v_cd      text;
  v_expr    text;
  v_set     text;
  v_cond    text;
  v_sede_id uuid;
  v_cat     uuid;
  v_ex_ok   boolean;
  v_oggi    date := coalesce(p_oggi, public.giorno_roma(now()));
BEGIN
  -- 1 · le precondizioni: nessuna modifica
  IF to_regproc('public.anno_di') IS NULL OR to_regclass('public.anni_sede') IS NULL THEN
    RAISE EXCEPTION 'RIEMPIMENTO_SENZA_SCHEMA_ANNO';
  END IF;
  SELECT g.controlli_rigidi, g.guardia_attiva INTO v_rigidi, v_guardia FROM public.anno_regole g;
  IF coalesce(v_rigidi, false) THEN
    RAISE EXCEPTION 'RIEMPIMENTO_A_CONTROLLI_RIGIDI';
  END IF;
  IF coalesce(v_guardia, false) THEN
    RAISE EXCEPTION 'RIEMPIMENTO_A_GUARDIA_ATTIVA';
  END IF;
  IF to_regclass('public.galleria_media_v2') IS NOT NULL AND public.anno_ha_colonna('galleria_media_v2', 'politica_operazione') THEN
    EXECUTE 'SELECT count(*) FROM public.galleria_media_v2 WHERE politica_operazione ->> ''sopprimiGenitori'' = ''true'''
       INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'RIEMPIMENTO_GALLERIA_SOPPRIMI';
    END IF;
  END IF;
  IF p_tabelle IS NOT NULL THEN
    FOREACH v_x IN ARRAY p_tabelle LOOP
      IF NOT EXISTS (SELECT 1 FROM public.anno_tabelle t WHERE t.tabella = v_x) AND NOT (v_x = ANY (v_extra)) THEN
        RAISE EXCEPTION 'TABELLA_NON_NEL_RIEMPIMENTO';
      END IF;
    END LOOP;
  END IF;

  BEGIN
    -- 2 · gli interruttori, solo in questa transazione
    PERFORM set_config('scatola_nera.senza_storico', 'on', true);
    PERFORM set_config('anno_scolastico.riempimento', 'on', true);

    -- 3 · il lavoro di sede: anno successivo, frequenze, listino, copia
    IF p_tabelle IS NULL OR 'frequenze' = ANY (p_tabelle) THEN
      v_n := 0;
      -- Solo le sedi il cui ultimo anno è il 2026/27: serve il 2027/28 (2 voci e 9 schede del CRM ci puntano già) e
      -- nient'altro, così il riempimento non crea mai anni da sé quando lo si rilancia a settembre 2027.
      FOR v_sede_id IN SELECT s.scuola_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
                        GROUP BY s.scuola_id HAVING max(y.anno_inizio) = 2026 ORDER BY 1 LOOP
        v_n := v_n + public.anni_sede_crea_successivo(v_sede_id, v_oggi);
      END LOOP;
      v_res := v_res || jsonb_build_object('anni_sede_creati', v_n);

      -- Le frequenze: una per alunno, nell'anno attivo della sede (origine `recupero`). Le colonne che l'alunno può
      -- non avere (database diversi) si leggono solo se ci sono.
      v_cs := CASE WHEN public.anno_ha_colonna('alunni', 'archiviato_il') THEN 'a.archiviato_il' ELSE 'NULL::timestamptz' END;
      v_cd := CASE WHEN to_regclass('public.alunni_classi_storico') IS NOT NULL
                   THEN '(SELECT min(h.dal) FROM public.alunni_classi_storico h WHERE h.alunno_id = a.id)'
                   ELSE 'NULL::date' END;
      EXECUTE format($q$
        WITH base AS (
          SELECT a.id AS alunno_id, s.id AS anno_sede_id, s.inizio, s.fine,
                 CASE WHEN EXISTS (SELECT 1 FROM public.sections z WHERE z.id = a.section_id
                                    AND z.scuola_id = s.scuola_id AND z.anno_id = s.anno_id)
                      THEN a.section_id END AS section_id,
                 %1$s AS archiviato, %2$s AS dal,
                 %3$s AS retta, %4$s AS carico, %5$s AS split, %6$s AS intest, %7$s AS giorno,
                 %8$s AS mensa, %9$s AS sospeso, %10$s AS causa, %11$s AS motivo, %12$s AS sospeso_il,
                 %13$s AS sospeso_da, %14$s AS pannolino
            FROM public.alunni a
            JOIN public.anni_sede s ON s.id = public.anno_attivo(a.scuola_id)
           WHERE a.scuola_id IS NOT NULL
        ), dd AS (
          SELECT b.*, least(greatest(coalesce(b.dal, b.inizio), b.inizio), b.fine) AS ingresso FROM base b
        )
        INSERT INTO public.frequenze
          (alunno_id, anno_sede_id, section_id, origine, tipo, stato, data_ingresso, data_uscita, retta_mensile,
           retta_a_carico_di, retta_split_config, intestatario_fatture, giorno_scadenza_pagamenti, gruppo_mensa_id,
           sospeso, sospeso_causa, sospeso_motivo, sospeso_il, sospeso_da, usa_pannolino)
        SELECT d.alunno_id, d.anno_sede_id, d.section_id, 'recupero', NULL,
               CASE WHEN d.archiviato IS NULL THEN 'iscritto' ELSE 'ritirato' END,
               d.ingresso,
               CASE WHEN d.archiviato IS NULL THEN NULL
                    ELSE least(greatest(public.giorno_roma(d.archiviato), d.ingresso), d.fine) END,
               CASE WHEN d.retta > 0 THEN d.retta END,
               d.carico, d.split, d.intest,
               CASE WHEN d.giorno BETWEEN 1 AND 28 THEN d.giorno END,
               d.mensa, coalesce(d.sospeso, false), d.causa, d.motivo, d.sospeso_il, d.sospeso_da,
               coalesce(d.pannolino, false)
          FROM dd d
        ON CONFLICT (alunno_id, anno_sede_id) DO NOTHING$q$,
        v_cs, v_cd,
        CASE WHEN public.anno_ha_colonna('alunni', 'importo_retta_mensile') THEN 'a.importo_retta_mensile' ELSE 'NULL::numeric' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'retta_a_carico_di') THEN 'a.retta_a_carico_di' ELSE 'NULL::uuid' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'retta_split_config') THEN 'a.retta_split_config' ELSE 'NULL::jsonb' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'intestatario_fatture') THEN 'a.intestatario_fatture' ELSE 'NULL::jsonb' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'giorno_scadenza_pagamenti') THEN 'a.giorno_scadenza_pagamenti' ELSE 'NULL::integer' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'gruppo_mensa_id') THEN 'a.gruppo_mensa_id' ELSE 'NULL::uuid' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'sospeso') THEN 'a.sospeso' ELSE 'NULL::boolean' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'sospeso_causa') THEN 'a.sospeso_causa' ELSE 'NULL::text' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'sospeso_motivo') THEN 'a.sospeso_motivo' ELSE 'NULL::text' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'sospeso_il') THEN 'a.sospeso_il' ELSE 'NULL::timestamptz' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'sospeso_da') THEN 'a.sospeso_da' ELSE 'NULL::uuid' END,
        CASE WHEN public.anno_ha_colonna('alunni', 'usa_pannolino') THEN 'a.usa_pannolino' ELSE 'NULL::boolean' END);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_res := v_res || jsonb_build_object('frequenze_create', v_n);

      -- Il listino 2026/27: la retta senza fascia, `retta_default_importo` della sede o i 150 € di oggi
      -- (`genera-rette/route.ts`). La categoria `retta` si cerca per slug, la globale prima.
      SELECT c.id INTO v_cat FROM public.payment_categories c WHERE c.slug = 'retta' ORDER BY (c.scuola_id IS NULL) DESC, c.id LIMIT 1;
      v_ex_ok := to_regclass('public.admin_settings') IS NOT NULL AND public.anno_ha_colonna('admin_settings', 'retta_default_importo');
      EXECUTE format($q$
        INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, payment_category_id, importo, mesi)
        SELECT s.id, 'retta', NULL, $1, coalesce(%s, 150), NULL
          FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
         WHERE y.anno_inizio = 2026
        ON CONFLICT DO NOTHING$q$,
        CASE WHEN v_ex_ok
             THEN '(SELECT x.retta_default_importo FROM public.admin_settings x WHERE x.scuola_id = s.scuola_id AND x.retta_default_importo > 0 LIMIT 1)'
             ELSE 'NULL::numeric' END)
        USING v_cat;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_res := v_res || jsonb_build_object('listino_voci', v_n);

      -- La configurazione del 2026/27 copiata nel 2027/28 di ogni sede.
      v_n := 0;
      FOR r IN SELECT a.id AS da, b.id AS a
                 FROM public.anni_sede a
                 JOIN public.anni_scolastici ya ON ya.id = a.anno_id AND ya.anno_inizio = 2026
                 JOIN public.anni_sede b ON b.scuola_id = a.scuola_id
                 JOIN public.anni_scolastici yb ON yb.id = b.anno_id AND yb.anno_inizio = 2027 LOOP
        v_n := v_n + coalesce((SELECT sum(e.value::bigint) FROM jsonb_each_text(public.anno_copia_configurazione(r.da, r.a)) e), 0);
      END LOOP;
      v_res := v_res || jsonb_build_object('configurazione_copiata', v_n);
    END IF;

    -- 4 · le tabelle del registro: le madri prima delle figlie, i dichiarati prima dei `data`, le piccole prima
    FOR r IN
      WITH RECURSIVE prof(tabella, d) AS (
        SELECT t.tabella, 0 FROM public.anno_tabelle t WHERE t.madre_tabella IS NULL
        UNION ALL
        SELECT t.tabella, p.d + 1 FROM public.anno_tabelle t JOIN prof p ON p.tabella = t.madre_tabella
      )
      SELECT t.tabella, p.d
        FROM public.anno_tabelle t
        JOIN prof p ON p.tabella = t.tabella
        LEFT JOIN pg_class c ON c.oid = to_regclass(format('public.%I', t.tabella))
       ORDER BY p.d, (t.modo <> 'dichiarato'), c.reltuples NULLS FIRST, t.tabella
    LOOP
      CONTINUE WHEN p_tabelle IS NOT NULL AND NOT (r.tabella = ANY (p_tabelle));
      CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL OR NOT public.anno_ha_colonna(r.tabella, 'anno_id');

      -- i nomi di classe di questa tabella, tradotti nella STESSA UPDATE che dà l'anno (una riga che nasce senza
      -- anno e viene riempita non muove versione né data di modifica)
      v_cs := NULL; v_cd := NULL;
      IF r.tabella IN ('avvisi', 'galleria_media_v2') THEN
        v_cs := 'target_classes'; v_cd := 'target_section_ids';
      ELSIF r.tabella = 'video_intents' THEN
        v_cs := 'classi_destinatarie'; v_cd := 'classi_destinatarie_section_ids';
      END IF;
      v_set := ''; v_cond := '';
      IF v_cs IS NOT NULL AND public.anno_ha_colonna(r.tabella, v_cs) AND public.anno_ha_colonna(r.tabella, v_cd) THEN
        v_sede := public.anno_sede_sql(r.tabella, 't');
        v_expr := format('(CASE WHEN t.%I IS NULL OR %s IS NULL THEN NULL ELSE public.anno_traduci_classi(%s, t.%I) END)',
                         v_cs, v_sede, v_sede, v_cs);
        v_set := format(', %I = %s', v_cd, v_expr);
        v_cond := format(' OR t.%I IS DISTINCT FROM %s', v_cd, v_expr);
      END IF;

      EXECUTE format('SELECT count(*) FROM public.%I WHERE anno_id IS NULL', r.tabella) INTO v_prima;
      IF v_prima > 0 OR v_cond <> '' THEN
        EXECUTE format('UPDATE public.%I t SET anno_id = t.anno_id%s WHERE t.anno_id IS NULL%s', r.tabella, v_set, v_cond);
      END IF;
      EXECUTE format('SELECT count(*) FROM public.%I WHERE anno_id IS NULL', r.tabella) INTO v_dopo;
      v_res := v_res || jsonb_build_object(r.tabella, v_prima - v_dopo);
    END LOOP;

    -- 5 · i nomi di classe delle tabelle che il registro non conosce
    FOR r IN SELECT * FROM (VALUES
        ('news_posts', 'target_classes', 'target_section_ids', true),
        ('forms_templates', 'target_classes', 'target_section_ids', true),
        ('mensa_class_menu_assignment', 'classe', 'section_id', false)) AS v(tab, src, dst, e_array) LOOP
      CONTINUE WHEN p_tabelle IS NOT NULL AND NOT (r.tab = ANY (p_tabelle));
      CONTINUE WHEN to_regclass(format('public.%I', r.tab)) IS NULL
                 OR NOT public.anno_ha_colonna(r.tab, r.src) OR NOT public.anno_ha_colonna(r.tab, r.dst);
      v_sede := public.anno_sede_sql(r.tab, 't');
      IF r.e_array THEN
        v_expr := format('(CASE WHEN t.%I IS NULL OR %s IS NULL THEN NULL ELSE public.anno_traduci_classi(%s, t.%I) END)',
                         r.src, v_sede, v_sede, r.src);
      ELSE
        v_expr := format('(CASE WHEN t.%I IS NULL OR %s IS NULL THEN NULL ELSE (public.anno_traduci_classi(%s, ARRAY[t.%I]))[1] END)',
                         r.src, v_sede, v_sede, r.src);
      END IF;
      EXECUTE format('UPDATE public.%I t SET %I = %s WHERE t.%I IS DISTINCT FROM %s', r.tab, r.dst, v_expr, r.dst, v_expr);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_res := v_res || jsonb_build_object('classi:' || r.tab, v_n);
    END LOOP;

    -- 6 · gli interruttori tornano spenti
    PERFORM set_config('scatola_nera.senza_storico', 'off', true);
    PERFORM set_config('anno_scolastico.riempimento', 'off', true);
    RETURN v_res;
  EXCEPTION WHEN OTHERS THEN
    -- Ridondante: entrando qui la sotto-transazione del blocco si annulla e con lei i `set_config(…, true)` fatti dentro. Resta
    -- per chiarezza: chi legge vede che gli interruttori escono spenti anche sull'errore.
    PERFORM set_config('scatola_nera.senza_storico', 'off', true);
    PERFORM set_config('anno_scolastico.riempimento', 'off', true);
    RAISE;
  END;
END
$$;

REVOKE ALL ON FUNCTION public.anno_traduci_classi(uuid, text[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_copia_configurazione(uuid, uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_riempi(text[], date)                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_traduci_classi(uuid, text[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_copia_configurazione(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_riempi(text[], date)             TO service_role;

-- ── 2.3 · Lo specchio `alunni` → `frequenze` (fase A, §4.19) ─────────────────────────────────────
-- Finché l'app scrive la scheda dell'alunno e non la frequenza (la PR 3 le affianca, la 4.3 le inverte, la 5 toglie
-- lo specchio), ogni scrittura su `alunni` che cambia una colonna copiata si riflette nella frequenza dell'anno
-- ATTIVO della sede: mai negli altri anni. La frequenza nasce con origine `recupero` (lo ammette il CHECK senza moduli
-- né quota), `tipo` NULL, `retta_mensile` NULL se l'importo è zero (lo zero non esiste più).
--   · nuova: `data_ingresso` = il giorno di Roma di oggi, portato dentro il periodo dell'anno;
--   · già presente: si aggiornano le colonne copiate; stato e `data_uscita` solo se è una frequenza `recupero`
--     (una frequenza nata da una domanda ha un suo ciclo di vita). Lo stato viene da `archiviato_il`, come nel
--     riempimento: archiviato → `ritirato` con uscita nel giorno di Roma dell'archiviazione (dentro [ingresso, fine]);
--   · cambio di sede: la frequenza viva della sede vecchia diventa `trasferito` (con uscita), e ne nasce una nella nuova;
--   · FAIL-OPEN: qualunque errore (una sezione di un altro anno, un CHECK…) lascia la scrittura di `alunni` com'è
--     e una riga in `app_log` (`esito specchio-fallito`, solo tabella e SQLSTATE: mai un valore);
--   · interruttore: `anno_regole.specchio_alunni_attivo`.
-- Le colonne di `alunni` si leggono da jsonb: un database che non ne ha qualcuna (la CI) non fa fallire il trigger.
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

-- Due trigger (in un INSERT il `WHEN` non può nominare OLD): l'INSERT sempre, l'UPDATE solo se cambia una delle
-- colonne copiate. PostgREST rimanda la riga intera a ogni PATCH: il `WHEN` evita il lavoro quando non è cambiato niente.
DO $mig$
DECLARE
  v_cols text[];
  v_old  text;
  v_new  text;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.alunni') AND c.relkind IN ('r', 'p'))
          AND to_regclass('public.frequenze') IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT array_agg(c ORDER BY c) INTO v_cols
    FROM unnest(ARRAY['scuola_id', 'section_id', 'archiviato_il', 'importo_retta_mensile', 'retta_a_carico_di',
                      'retta_split_config', 'intestatario_fatture', 'giorno_scadenza_pagamenti', 'gruppo_mensa_id',
                      'sospeso', 'sospeso_causa', 'sospeso_motivo', 'sospeso_il', 'sospeso_da', 'usa_pannolino']) AS c
   WHERE public.anno_ha_colonna('alunni', c);
  SELECT string_agg(format('OLD.%I', c), ', '), string_agg(format('NEW.%I', c), ', ')
    INTO v_old, v_new FROM unnest(v_cols) AS c;

  DROP TRIGGER IF EXISTS trg_alunni_specchio_frequenza_ins ON public.alunni;
  CREATE TRIGGER trg_alunni_specchio_frequenza_ins
    AFTER INSERT ON public.alunni
    FOR EACH ROW EXECUTE FUNCTION public.alunni_specchio_frequenza();

  DROP TRIGGER IF EXISTS trg_alunni_specchio_frequenza ON public.alunni;
  EXECUTE format(
    'CREATE TRIGGER trg_alunni_specchio_frequenza AFTER UPDATE OF %s ON public.alunni FOR EACH ROW '
    || 'WHEN (ROW(%s) IS DISTINCT FROM ROW(%s)) EXECUTE FUNCTION public.alunni_specchio_frequenza()',
    (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_cols) AS c), v_old, v_new);
END
$mig$;

-- ── 2.3 · I nomi di classe → uuid, a ogni scrittura (e le righe che non tornano) ─────────────────

-- Un avviso che NON è un guasto: livello `warn`, contesto con tabella e conteggio. Mai un nome di classe.
CREATE OR REPLACE FUNCTION public.anno_log_avviso(
  p_tabella text, p_esito text, p_operazione text, p_messaggio text, p_fingerprint text, p_conteggio integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('warn', 'anno-scolastico', 'server', p_messaggio, p_fingerprint,
          jsonb_build_object('esito', p_esito, 'operazione', p_operazione, 'tabella', p_tabella, 'conteggio', p_conteggio))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now();
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

-- Il trigger: `TG_ARGV` = colonna dei nomi, colonna degli uuid, 'array' o 'scalare'. I NOMI vincono (fino alla PR 4.4
-- sono la fonte): nomi e uuid insieme e divergenti → gli uuid si ricalcolano dai nomi. Nomi NULL → gli uuid restano
-- come scritti. Sede non ricavabile → niente da tradurre. Un nome che nessuna sezione dell'anno ATTIVO ha resta nei
-- nomi, e una riga `warn` dice quanti (non quali). FAIL-OPEN: un guasto lascia la riga com'è e lo scrive in `app_log`.
-- La traduzione vera è `anno_traduci_classi()`: qui nessuna logica duplicata.
CREATE OR REPLACE FUNCTION public.anno_traduci_classi_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n      jsonb := to_jsonb(NEW);
  v_nomi   text[];
  v_sede   uuid;
  v_ids    uuid[];
  v_dist   integer;
  v_manca  integer;
  v_anno   uuid;
  v_data   text;
BEGIN
  BEGIN
    IF v_n -> TG_ARGV[0] IS NULL OR jsonb_typeof(v_n -> TG_ARGV[0]) = 'null' THEN
      RETURN NEW;
    END IF;
    v_sede := public.anno_sede_della_riga(TG_TABLE_NAME, v_n);
    IF v_sede IS NULL THEN
      RETURN NEW;
    END IF;

    -- L'anno delle sezioni con cui tradurre. Tabella con `anno_id`: in UPDATE quello che la riga ha già (OLD), in INSERT
    -- l'anno attivo (NULL). Tabella senza `anno_id`: l'anno della data della riga stessa (`attivo_dal`, o la creazione);
    -- senza nessuna data, o con una data fuori da ogni anno, l'anno attivo (limite noto).
    IF v_n ? 'anno_id' THEN
      IF TG_OP = 'UPDATE' THEN
        v_anno := (to_jsonb(OLD) ->> 'anno_id')::uuid;
      END IF;
    ELSE
      v_data := coalesce(v_n ->> 'attivo_dal', v_n ->> 'created_at');
      IF v_data IS NOT NULL THEN
        v_anno := public.anno_di(v_sede, CASE WHEN length(v_data) = 10 THEN v_data::date ELSE public.giorno_roma(v_data::timestamptz) END);
      END IF;
    END IF;

    -- Un anno che nella sede non ha NESSUNA sezione (gli avvisi di luglio e agosto 2026 stanno nel 2025/26): in UPDATE gli uuid
    -- restano come sono, perché ricalcolarli darebbe `{}` e butterebbe via quelli del riempimento (le righe non sono divergenti,
    -- vedi `anno_target_divergenti`). In INSERT si traduce sull'anno attivo, come sempre.
    IF TG_OP = 'UPDATE' AND v_anno IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.sections s WHERE s.scuola_id = v_sede AND s.anno_id = v_anno) THEN
      RETURN NEW;
    END IF;

    IF TG_ARGV[2] = 'array' THEN
      SELECT coalesce(array_agg(x), '{}'::text[]) INTO v_nomi FROM jsonb_array_elements_text(v_n -> TG_ARGV[0]) AS x;
      v_ids := public.anno_traduci_classi(v_sede, v_nomi, v_anno);
      SELECT count(DISTINCT lower(replace(x, ' ', ''))) INTO v_dist FROM unnest(v_nomi) AS x;
      v_manca := v_dist - coalesce(cardinality(v_ids), 0);
      NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], to_jsonb(v_ids)));
    ELSE
      v_ids := public.anno_traduci_classi(v_sede, ARRAY[v_n ->> TG_ARGV[0]], v_anno);
      v_manca := CASE WHEN v_ids[1] IS NULL THEN 1 ELSE 0 END;
      NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], v_ids[1]));
    END IF;

    IF v_manca > 0 THEN
      PERFORM public.anno_log_avviso(TG_TABLE_NAME, 'classe-non-abbinata', 'anno_traduci_classi_trg',
                                     'nomi di classe che nessuna sezione dell''anno della riga ha: restano nei nomi',
                                     'db:anno-classe-non-abbinata:' || TG_TABLE_NAME, v_manca);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'traduzione-classi-fallita', 'anno_traduci_classi_trg',
                                   'traduzione dei nomi di classe fallita: la scrittura è passata com''è',
                                   'db:anno-classi:' || TG_TABLE_NAME, SQLSTATE);
  END;
  RETURN NEW;
END
$$;

DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('avvisi', 'target_classes', 'target_section_ids', 'array'),
      ('galleria_media_v2', 'target_classes', 'target_section_ids', 'array'),
      ('news_posts', 'target_classes', 'target_section_ids', 'array'),
      ('forms_templates', 'target_classes', 'target_section_ids', 'array'),
      ('video_intents', 'classi_destinatarie', 'classi_destinatarie_section_ids', 'array'),
      ('mensa_class_menu_assignment', 'classe', 'section_id', 'scalare')) AS v(t, src, dst, tipo) LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_class k WHERE k.oid = to_regclass(format('public.%I', r.t)) AND k.relkind IN ('r', 'p'))
               OR NOT public.anno_ha_colonna(r.t, r.src) OR NOT public.anno_ha_colonna(r.t, r.dst);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || r.t || '_traduci_classi', r.t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON public.%I FOR EACH ROW '
      || 'EXECUTE FUNCTION public.anno_traduci_classi_trg(%L, %L, %L)',
      'trg_' || r.t || '_traduci_classi', r.src, r.t, r.src, r.dst, r.tipo);
  END LOOP;
END
$mig$;

-- Le righe in cui nomi e uuid non dicono la stessa cosa (nell'anno DELLA RIGA, vedi sotto): per tabella, anche a zero. Un uuid
-- senza nome, un nome senza uuid (anche perché nessuna sezione lo ha) o due insiemi diversi. Le righe senza sede
-- non si possono tradurre e non contano. L'insieme degli uuid si confronta ordinato e senza doppioni.
CREATE OR REPLACE FUNCTION public.anno_target_divergenti()
RETURNS TABLE (tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r      record;
  v_sede text;
  v_anno text;
  v_cond text;
  v_n    bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('avvisi', 'target_classes', 'target_section_ids', true),
      ('galleria_media_v2', 'target_classes', 'target_section_ids', true),
      ('news_posts', 'target_classes', 'target_section_ids', true),
      ('forms_templates', 'target_classes', 'target_section_ids', true),
      ('video_intents', 'classi_destinatarie', 'classi_destinatarie_section_ids', true),
      ('mensa_class_menu_assignment', 'classe', 'section_id', false)) AS v(t, src, dst, e_array)
    ORDER BY 1 LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_class k WHERE k.oid = to_regclass(format('public.%I', r.t)) AND k.relkind IN ('r', 'p'))
               OR NOT public.anno_ha_colonna(r.t, r.src) OR NOT public.anno_ha_colonna(r.t, r.dst);
    v_sede := public.anno_sede_sql(r.t, 't');
    -- L'anno con cui tradurre è quello DELLA RIGA: `anno_id` dove la tabella ce l'ha; altrimenti l'anno della sua data
    -- (`attivo_dal`, o la creazione). Una tabella senza nessuna delle due (o una riga fuori da ogni anno) usa l'anno attivo.
    v_anno := CASE
      WHEN public.anno_ha_colonna(r.t, 'anno_id') THEN 't.anno_id'
      WHEN public.anno_ha_colonna(r.t, 'attivo_dal') THEN format('public.anno_di(%s, t.attivo_dal)', v_sede)
      WHEN public.anno_ha_colonna(r.t, 'created_at') THEN format('public.anno_di(%s, public.giorno_roma(t.created_at::timestamptz))', v_sede)
      ELSE 'NULL::uuid' END;
    IF r.e_array THEN
      -- gli uuid non sono quelli che i nomi danno, OPPURE c'è un nome che nessuna sezione ha (resta nei nomi)
      v_cond := format(
        '((SELECT coalesce(array_agg(DISTINCT x ORDER BY x), %1$L::uuid[]) FROM unnest(coalesce(t.%2$I, %1$L::uuid[])) AS x) '
        || 'IS DISTINCT FROM coalesce(public.anno_traduci_classi(%3$s, t.%4$I, %7$s), %1$L::uuid[]) '
        || 'OR (SELECT count(DISTINCT lower(replace(n, %5$L, %6$L))) FROM unnest(coalesce(t.%4$I, %1$L::text[])) AS n) '
        || '<> cardinality(coalesce(public.anno_traduci_classi(%3$s, t.%4$I, %7$s), %1$L::uuid[])))',
        '{}', r.dst, v_sede, r.src, ' ', '', v_anno);
    ELSE
      v_cond := format('(t.%1$I IS DISTINCT FROM (public.anno_traduci_classi(%2$s, ARRAY[t.%3$I], %4$s))[1] '
                       || 'OR (t.%3$I IS NOT NULL AND (public.anno_traduci_classi(%2$s, ARRAY[t.%3$I], %4$s))[1] IS NULL))',
                       r.dst, v_sede, r.src, v_anno);
    END IF;
    -- Le righe il cui anno non ha NESSUNA sezione nella sede non contano (non c'è nulla da abbinare): le conta `anno_fotografa`
    -- come `ambiguo:classi_in_anno_senza_sezioni:<tabella>`. Un nome senza sezione in un anno che ne ha resta divergente.
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE %s IS NOT NULL AND %s '
                   || 'AND (%s IS NULL OR EXISTS (SELECT 1 FROM public.sections s WHERE s.scuola_id = %s AND s.anno_id = %s))',
                   r.t, v_sede, v_cond, v_anno, v_sede, v_anno) INTO v_n;
    tabella := r.t; righe := v_n;
    RETURN NEXT;
  END LOOP;
  RETURN;
END
$$;

-- ── 2.3 · Le righe senza anno (invariante 12 e controllo di V2) ──────────────────────────────────

-- Le righe con `anno_id` NULL e una sede da cui calcolarlo: tutte, se la colonna-sede della tabella non può mancare;
-- altrimenti (`sede_facoltativa`) solo quelle la cui colonna-sede non è NULL. È ESATTAMENTE il predicato del `CHECK`
-- `<tabella>_anno_id_presente` (V1): zero vuol dire che la convalida passa.
CREATE OR REPLACE FUNCTION public.anno_righe_senza_anno_con_sede(p_tabella text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg public.anno_tabelle%ROWTYPE;
  v_n   bigint;
BEGIN
  SELECT * INTO v_reg FROM public.anno_tabelle t WHERE t.tabella = p_tabella;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anno_righe_senza_anno_con_sede: la tabella % non è nel registro', p_tabella;
  END IF;
  IF to_regclass(format('public.%I', p_tabella)) IS NULL OR NOT public.anno_ha_colonna(p_tabella, 'anno_id') THEN
    RAISE EXCEPTION 'anno_righe_senza_anno_con_sede: la tabella % non esiste o non ha la colonna anno_id', p_tabella;
  END IF;
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.anno_id IS NULL%s', p_tabella,
                 CASE WHEN v_reg.sede_facoltativa THEN format(' AND t.%I IS NOT NULL', v_reg.via_sede) ELSE '' END)
    INTO v_n;
  RETURN v_n;
END
$$;

REVOKE ALL ON FUNCTION public.alunni_specchio_frequenza()                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_log_avviso(text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_traduci_classi_trg()                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_target_divergenti()                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_righe_senza_anno_con_sede(text)                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alunni_specchio_frequenza()                            TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_log_avviso(text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_traduci_classi_trg()                              TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_target_divergenti()                               TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_righe_senza_anno_con_sede(text)                   TO service_role;
