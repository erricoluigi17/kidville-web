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
    SELECT r.controlli_rigidi INTO v_rigidi FROM public.anno_regole r;
    v_rigidi := coalesce(v_rigidi, false);
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

-- Il trigger generico, in tre punti rispetto alla PR 1 (il resto è com'era):
--   (a) `segue_data` (solo `pagamenti`): in un UPDATE di una voce SENZA competenza, se `anno_id` non è toccato e
--       la scadenza cambia, l'anno segue la nuova scadenza SOLO se prima la seguiva (l'anno di OLD era quello
--       della vecchia scadenza). Un anno dichiarato diverso dalla scadenza resta dov'è e non dà mai errore;
--   (b) il ramo «anno mancante» delle sette tabelle dichiarate di oggi: con `dichiarato_transitorio` l'anno lo
--       dà `anno_dichiarato_transitorio`; con la manopola spenta, a controlli rigidi ANNO_DA_SPECIFICARE e in
--       morbido NULL. Una riga la cui sede non si ricava resta senza anno, senza errori (colonna-sede
--       facoltativa). Come il calcolo, in morbido è avvolto in una rete: un guasto lascia NULL e una riga in app_log;
--   (c) `anno_scolastico.riempimento = 'on'` (solo nella transazione del riempimento): una riga che nasce senza
--       anno e viene riempita non muove `storico_versione` né `updated_at`.
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
  IF v_rigidi THEN
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
