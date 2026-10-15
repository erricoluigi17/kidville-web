-- Token di concorrenza e rettifiche storiche atomiche: eseguibili solo dal server.
CREATE OR REPLACE FUNCTION public.storici_prima_mutazione() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE contesto jsonb := nullif(current_setting('kidville.storico_contesto', true), '')::jsonb; giorno date;
BEGIN
  IF TG_OP <> 'INSERT' AND contesto IS NOT NULL THEN
    -- La giornata è della fonte originale, anche per gruppi con date diverse.
    IF TG_TABLE_NAME IN ('note_disciplinari','valutazioni') THEN
      giorno := coalesce((to_jsonb(OLD)->>'data_evento')::date, ((to_jsonb(OLD)->>'creato_il')::timestamptz AT TIME ZONE 'Europe/Rome')::date);
    ELSIF TG_TABLE_NAME IN ('presenze','registro_orario','giustifiche_didattiche') THEN
      giorno := (to_jsonb(OLD)->>'data')::date;
    ELSIF TG_TABLE_NAME = 'eventi_diario' THEN
      giorno := ((to_jsonb(OLD)->>'orario_inizio')::timestamptz AT TIME ZONE 'Europe/Rome')::date;
    END IF;
    IF giorno IS NOT NULL THEN
      contesto := jsonb_set(contesto, '{giorno_competenza}', to_jsonb(giorno::text));
      PERFORM set_config('kidville.storico_contesto', contesto::text, true);
    END IF;
    INSERT INTO public.storici_revisioni (scuola_id, alunno_id, section_id, attore_id, modulo, entita_id, giorno_competenza, contenuto)
    VALUES (coalesce(to_jsonb(OLD)->>'scuola_id', contesto->>'scuola_id')::uuid, nullif(coalesce(to_jsonb(OLD)->>'alunno_id', contesto->>'alunno_id'),'')::uuid,
      nullif(coalesce(to_jsonb(OLD)->>'section_id', contesto->>'section_id'),'')::uuid, (contesto->>'attore_id')::uuid,
      contesto->>'modulo', OLD.id, (contesto->>'giorno_competenza')::date,
      jsonb_build_object('tabella', TG_TABLE_NAME, 'riga', to_jsonb(OLD)));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN NEW.storico_versione := OLD.storico_versione + 1; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE tabella text; BEGIN
  FOREACH tabella IN ARRAY ARRAY['eventi_diario','presenze','valutazioni','giustifiche_didattiche','registro_orario','firme_docenti','note_disciplinari','nota_ricezioni','registro_destinatari','valutazione_obiettivi','allegati_registro'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS storico_versione bigint NOT NULL DEFAULT 0', tabella);
    EXECUTE format('CREATE TRIGGER storici_prima_mutazione BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.storici_prima_mutazione()', tabella);
  END LOOP;
END $$;

ALTER TABLE public.eventi_diario ADD COLUMN IF NOT EXISTS giorno_competenza date GENERATED ALWAYS AS ((orario_inizio AT TIME ZONE 'Europe/Rome')::date) STORED;

-- Il token del consolidato cambia anche quando cambia una firma o un destinatario.
CREATE OR REPLACE FUNCTION public.storici_versione_aggregato() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE vecchia jsonb; nuova jsonb; chiave uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN vecchia := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN nuova := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'firme_docenti' THEN
    FOR chiave IN SELECT DISTINCT x::uuid FROM (VALUES (vecchia->>'registro_id'), (nuova->>'registro_id')) v(x) WHERE x IS NOT NULL LOOP
      UPDATE public.registro_orario SET storico_versione = storico_versione WHERE id = chiave;
    END LOOP;
  ELSIF TG_TABLE_NAME = 'registro_destinatari' THEN
    FOR chiave IN SELECT DISTINCT x::uuid FROM (VALUES (vecchia->>'firma_id'), (nuova->>'firma_id')) v(x) WHERE x IS NOT NULL LOOP
      UPDATE public.firme_docenti SET storico_versione = storico_versione WHERE id = chiave;
    END LOOP;
    -- Le vecchie assegnazioni senza firma appartengono direttamente alla lezione.
    FOR chiave IN SELECT DISTINCT (r->>'registro_id')::uuid FROM (VALUES (vecchia),(nuova)) v(r) WHERE r->>'firma_id' IS NULL AND r->>'registro_id' IS NOT NULL LOOP
      UPDATE public.registro_orario SET storico_versione = storico_versione WHERE id = chiave;
    END LOOP;
  ELSIF TG_TABLE_NAME = 'nota_ricezioni' THEN
    FOR chiave IN SELECT DISTINCT x::uuid FROM (VALUES (vecchia->>'nota_id'), (nuova->>'nota_id')) v(x) WHERE x IS NOT NULL LOOP
      UPDATE public.note_disciplinari SET storico_versione = storico_versione WHERE id = chiave;
    END LOOP;
  ELSIF TG_TABLE_NAME = 'valutazione_obiettivi' THEN
    FOR chiave IN SELECT DISTINCT x::uuid FROM (VALUES (vecchia->>'valutazione_id'), (nuova->>'valutazione_id')) v(x) WHERE x IS NOT NULL LOOP
      UPDATE public.valutazioni SET storico_versione = storico_versione WHERE id = chiave;
    END LOOP;
  ELSIF TG_TABLE_NAME = 'allegati_registro' THEN
    FOR chiave IN SELECT DISTINCT x::uuid FROM (VALUES (vecchia->>'registro_id'), (nuova->>'registro_id')) v(x) WHERE x IS NOT NULL LOOP
      UPDATE public.registro_orario SET storico_versione = storico_versione WHERE id = chiave;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE tabella text; BEGIN
  FOREACH tabella IN ARRAY ARRAY['firme_docenti','registro_destinatari','nota_ricezioni','valutazione_obiettivi','allegati_registro'] LOOP
    EXECUTE format('CREATE TRIGGER storici_versione_aggregato AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.storici_versione_aggregato()', tabella);
  END LOOP;
END $$;

-- Una mutazione figlia è coperta solo dalla propria attesa o dal consolidato atteso.
CREATE OR REPLACE FUNCTION public.storici_radice(tabella text, riga jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE radice jsonb;
BEGIN
  IF tabella IN ('firme_docenti','registro_destinatari','allegati_registro') THEN
    -- Le FK sono indipendenti: una firma di B non può essere associata ai
    -- destinatari di A e incrementare B fuori dalle fonti bloccate dalla RPC.
    IF tabella='registro_destinatari' AND riga->>'firma_id' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.firme_docenti f WHERE f.id=(riga->>'firma_id')::uuid AND f.registro_id=(riga->>'registro_id')::uuid
    ) THEN RETURN NULL; END IF;
    SELECT jsonb_build_object('tabella','registro_orario','riga',to_jsonb(t)) INTO radice FROM public.registro_orario t WHERE id=(riga->>'registro_id')::uuid;
  ELSIF tabella='nota_ricezioni' THEN
    SELECT jsonb_build_object('tabella','note_disciplinari','riga',to_jsonb(t)) INTO radice FROM public.note_disciplinari t WHERE id=(riga->>'nota_id')::uuid;
  ELSIF tabella='valutazione_obiettivi' THEN
    SELECT jsonb_build_object('tabella','valutazioni','riga',to_jsonb(t)) INTO radice FROM public.valutazioni t WHERE id=(riga->>'valutazione_id')::uuid;
  ELSE
    IF tabella='eventi_diario' AND riga->>'orario_inizio' IS NOT NULL THEN
      riga:=jsonb_set(riga,'{giorno_competenza}',to_jsonb(((riga->>'orario_inizio')::timestamptz AT TIME ZONE 'Europe/Rome')::date::text));
    END IF;
    radice:=jsonb_build_object('tabella',tabella,'riga',riga);
  END IF;
  RETURN radice;
END $$;
CREATE OR REPLACE FUNCTION public.storici_fonte_coperta(tabella text, riga jsonb, attese jsonb, contesto jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE radice jsonb := public.storici_radice(tabella,riga); fonte jsonb; sede uuid; giorno date;
BEGIN
  IF radice IS NULL THEN RETURN false; END IF;
  fonte:=radice->'riga';
  IF fonte->>'scuola_id' IS NOT NULL THEN sede:=(fonte->>'scuola_id')::uuid;
  ELSIF fonte->>'section_id' IS NOT NULL THEN SELECT scuola_id INTO sede FROM public.sections WHERE id=(fonte->>'section_id')::uuid;
  ELSIF fonte->>'alunno_id' IS NOT NULL THEN
    giorno:=coalesce((fonte->>'giorno_competenza')::date,((fonte->>'orario_inizio')::timestamptz AT TIME ZONE 'Europe/Rome')::date,(contesto->>'giorno_competenza')::date);
    -- Il diario non ha la sede sulla riga: vale l'appartenenza comprovata del giorno.
    IF EXISTS(SELECT 1 FROM public.alunni_classi_storico h WHERE h.alunno_id=(fonte->>'alunno_id')::uuid AND h.scuola_id=(contesto->>'scuola_id')::uuid AND h.dal<=giorno AND (h.al IS NULL OR giorno<h.al)) THEN sede:=(contesto->>'scuola_id')::uuid;
    ELSE SELECT scuola_id INTO sede FROM public.alunni WHERE id=(fonte->>'alunno_id')::uuid; END IF;
  END IF;
  IF sede IS NULL OR sede IS DISTINCT FROM (contesto->>'scuola_id')::uuid THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(attese) e WHERE e->>'tabella'=radice->>'tabella' AND fonte @> (e->'filtro'));
END $$;
REVOKE ALL ON FUNCTION public.storici_radice(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.storici_fonte_coperta(text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.storici_applica_rettifica(contesto jsonb, attese jsonb, azioni jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE elemento jsonb; corrente jsonb; candidata jsonb; nuova jsonb; tabella text; colonne text; risultato jsonb := '[]'; righe jsonb;
  ammesse text[] := ARRAY['eventi_diario','presenze','valutazioni','giustifiche_didattiche','registro_orario','firme_docenti','note_disciplinari','nota_ricezioni','registro_destinatari','valutazione_obiettivi','allegati_registro'];
BEGIN
  IF contesto->>'attore_id' IS NULL OR contesto->>'scuola_id' IS NULL OR contesto->>'modulo' IS NULL
     OR contesto->>'giorno_competenza' IS NULL OR jsonb_array_length(attese) = 0 THEN
    RAISE EXCEPTION 'Contesto storico incompleto' USING ERRCODE = '22023';
  END IF;
  -- Le attese arrivano dal form letto dal client; NULL significa fonte ancora assente.
  FOR elemento IN SELECT value FROM jsonb_array_elements(attese) ORDER BY value->>'tabella',(value->'filtro')::text LOOP
    tabella := elemento->>'tabella';
    IF NOT tabella = ANY(ammesse) OR elemento->'filtro' IS NULL OR elemento->'filtro' = '{}'::jsonb THEN
      RAISE EXCEPTION 'Fonte storica non ammessa' USING ERRCODE = '22023';
    END IF;
    IF NOT elemento->'filtro' ? 'id' AND NOT (
      tabella='presenze' AND elemento->'filtro' ?& ARRAY['alunno_id','data'] OR
      tabella='registro_orario' AND elemento->'filtro' ?& ARRAY['section_id','data','ora_lezione'] OR
      tabella='eventi_diario' AND elemento->'filtro' ?& ARRAY['alunno_id','tipo_evento','giorno_competenza']
    ) THEN RAISE EXCEPTION 'Attesa senza identità univoca' USING ERRCODE='22023'; END IF;
    -- Serializza anche gli inserimenti concorrenti quando la fonte non esiste ancora.
    PERFORM pg_advisory_xact_lock(hashtextextended(tabella || (elemento->'filtro')::text,0));
    corrente := NULL;
    BEGIN
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE to_jsonb(t) @> $1 FOR UPDATE', tabella)
        INTO STRICT corrente USING elemento->'filtro';
    EXCEPTION WHEN no_data_found THEN corrente:=NULL;
      WHEN too_many_rows THEN RAISE EXCEPTION 'Attesa ambigua' USING ERRCODE='40001';
    END;
    IF (elemento->>'versione') IS NULL THEN
      IF corrente IS NOT NULL THEN RAISE EXCEPTION 'Fonte cambiata' USING ERRCODE = '40001'; END IF;
    ELSIF corrente IS NULL OR corrente->>'storico_versione' IS DISTINCT FROM elemento->>'versione' THEN
      RAISE EXCEPTION 'Versione storica cambiata' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  PERFORM set_config('kidville.storico_contesto', contesto::text, true);
  FOR elemento IN SELECT value FROM jsonb_array_elements(azioni) LOOP
    tabella := elemento->>'tabella';
    IF NOT tabella = ANY(ammesse) THEN RAISE EXCEPTION 'Tabella storica non ammessa' USING ERRCODE = '22023'; END IF;
    IF elemento->>'operazione' = 'insert' THEN
      IF NOT public.storici_fonte_coperta(tabella,elemento->'valori',attese,contesto) THEN RAISE EXCEPTION 'Mutazione fuori dalle fonti attese' USING ERRCODE='42501'; END IF;
      SELECT string_agg(format('%I', key), ',') INTO colonne FROM jsonb_object_keys(elemento->'valori') key WHERE key <> 'storico_versione';
      EXECUTE format('WITH q AS (INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) RETURNING *) SELECT coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) FROM q', tabella, colonne, colonne, tabella)
        INTO righe USING elemento->'valori';
    ELSE
      IF elemento->'filtro' IS NULL OR elemento->'filtro' = '{}'::jsonb THEN RAISE EXCEPTION 'Filtro storico mancante' USING ERRCODE = '22023'; END IF;
      -- Controlla tutte le righe coinvolte PRIMA della prima mutazione dell'azione.
      FOR candidata IN EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE to_jsonb(t) @> $1 FOR UPDATE',tabella) USING elemento->'filtro' LOOP
        IF NOT public.storici_fonte_coperta(tabella,candidata,attese,contesto) THEN RAISE EXCEPTION 'Mutazione fuori dalle fonti attese' USING ERRCODE='42501'; END IF;
        IF elemento->>'operazione'='update' THEN
          nuova:=candidata || ((elemento->'valori') - 'id' - 'storico_versione');
          IF NOT public.storici_fonte_coperta(tabella,nuova,attese,contesto) THEN RAISE EXCEPTION 'Nuova fonte fuori perimetro' USING ERRCODE='42501'; END IF;
        END IF;
      END LOOP;
      IF elemento->>'operazione' = 'delete' THEN
        EXECUTE format('WITH q AS (DELETE FROM public.%I t WHERE to_jsonb(t) @> $1 RETURNING *) SELECT coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) FROM q', tabella)
          INTO righe USING elemento->'filtro';
      ELSIF elemento->>'operazione' = 'update' THEN
        SELECT string_agg(format('%I', key), ',') INTO colonne FROM jsonb_object_keys(elemento->'valori') key WHERE key NOT IN ('id','storico_versione');
        EXECUTE format('WITH q AS (UPDATE public.%I t SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.%I, $2)) WHERE to_jsonb(t) @> $1 RETURNING *) SELECT coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) FROM q', tabella, colonne, colonne, tabella)
          INTO righe USING elemento->'filtro', elemento->'valori';
      ELSE RAISE EXCEPTION 'Operazione storica non ammessa' USING ERRCODE = '22023'; END IF;
    END IF;
    IF elemento->>'operazione' IN ('update','delete') AND elemento->'filtro' ? 'id' AND jsonb_array_length(righe) = 0 THEN RAISE EXCEPTION 'Fonte cambiata' USING ERRCODE = '40001'; END IF;
    risultato := risultato || jsonb_build_array(jsonb_build_object('tabella', tabella, 'righe', righe));
  END LOOP;
  PERFORM set_config('kidville.storico_contesto', '', true);
  RETURN risultato;
END $$;
REVOKE ALL ON FUNCTION public.storici_applica_rettifica(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_applica_rettifica(jsonb,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.storici_prima_mutazione() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storici_versione_aggregato() FROM PUBLIC, anon, authenticated;
