-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.8 · «Il passaggio d'anno» · M48b, confermare, annullare e rientrare (compito 4.8.7)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE. Si applica DOPO M48a (anteprima) e M48c (didattica):
-- la conferma chiama `passaggio_calcola` e `passaggio_copia_didattica`.
--
-- Il passaggio lo fa la SEGRETERIA, con l'anteprima, le eccezioni e una conferma: non gira mai da sé. Nessun `cron.schedule`, nessuna
-- chiamata da `anni_tick`. La conferma è UNA transazione sola: o cambia tutto, o non cambia niente.
--
-- Contenuto: una colonna nullable in `passaggi_anno_docenti` (`inserita`: quali assegnazioni ha scritto la conferma, perché
-- l'annullamento tolga solo quelle), `passaggio_oggi` (il giorno, con la stessa porta di `anni_tick`), `passaggio_conferma`,
-- `passaggio_annulla`, `passaggio_conferma_tardiva`. Nessun uuid di sede, nessun valore del 2027/28.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.passaggi_anno_docenti ADD COLUMN IF NOT EXISTS inserita boolean NOT NULL DEFAULT false;

-- ── Giro di correzione 1 · B1 · lo storico delle classi non perde la riga aperta ─────────────────
-- `storici_traccia_classe` (trigger su `alunni`): corpo di produzione del 2026-11-09 (`pg_get_functiondef`), con UNA correzione. La terza
-- scrittura di classe nello stesso giorno (conferma, annullo, riconferma) cadeva sulla riga di quella mattina, già chiusa con `al` = oggi,
-- e `ON CONFLICT DO NOTHING` non la riapriva: il bambino restava in classe senza riga aperta, e `media_visibili_genitore` e le stampe
-- per giorno (`alunni-giorno.ts`) non lo vedevano per tutto l'anno. Ora la riga dello stesso giorno e della stessa classe si RIAPRE.
-- Cambia per chi legge: niente, se non che il caso sopra torna a funzionare. DA DICHIARARE nel corpo della PR (tocca un trigger vecchio).
CREATE OR REPLACE FUNCTION public.storici_traccia_classe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare giorno date := public.giorno_roma(now());  -- = (now() at time zone 'Europe/Rome')::date, ma si può fissare nelle prove
begin
  if TG_OP='UPDATE' and new.section_id is not distinct from old.section_id and new.scuola_id is not distinct from old.scuola_id
    and new.archiviato_il is not distinct from old.archiviato_il then return new; end if;
  if TG_OP='UPDATE' then
    update public.alunni_classi_storico set al=greatest(dal,giorno)
    where alunno_id=new.id and al is null;
  end if;
  if new.section_id is not null and new.anonimizzato_il is null and new.archiviato_il is null then
    -- la riga di questa classe aperta e chiusa nello stesso giorno (la mattina stessa) torna aperta
    update public.alunni_classi_storico set al=null
    where alunno_id=new.id and scuola_id=new.scuola_id and section_id=new.section_id and dal=giorno and fonte='trasferimento' and al is not null;
    insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,fonte)
    values(new.id,new.scuola_id,new.section_id,coalesce((select name from public.sections where id=new.section_id),''),giorno,'trasferimento') on conflict do nothing;
  end if;
  begin
    insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
    values('info','registro','server','Appartenenza storica registrata','storici-classe-tracciata',jsonb_build_object('alunno_id',new.id,'scuola_id',new.scuola_id))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  exception when others then raise log 'storici: logging appartenenza non riuscito [%]', SQLSTATE;
  end;
  return new;
end $$;
REVOKE ALL ON FUNCTION public.storici_traccia_classe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_traccia_classe() TO service_role;

-- L'invariante nuova, «ogni bambino in classe ha una riga aperta di storico», come funzione a sé (misura in produzione il 2026-11-09:
-- 0 casi su tutte le sedi, quindi può girare di notte). NON ridefinisco `anno_invarianti()`: è una funzione lunga che ogni PR
-- ridefinisce per intero, e la mia versione più recente cancellerebbe quelle degli altri rami. L'aggancio si fa all'allineamento.
-- Conta i bambini con una classe, né archiviati né anonimizzati, senza nessuna riga aperta. Senza la tabella dello storico: 0.
CREATE OR REPLACE FUNCTION public.passaggio_storico_senza_riga_aperta()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n bigint;
BEGIN
  IF to_regclass('public.alunni_classi_storico') IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.alunni a
   WHERE a.section_id IS NOT NULL AND a.archiviato_il IS NULL AND a.anonimizzato_il IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.alunni_classi_storico h WHERE h.alunno_id = a.id AND h.al IS NULL);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.passaggio_storico_senza_riga_aperta() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_storico_senza_riga_aperta() TO service_role;

-- ── Giro di correzione 1 · B3 · la finestra fra la conferma e l'inizio dell'anno nuovo ───────────
-- Ruling R1 (a): dal giorno della conferma al giorno prima dell'`inizio` del nuovo anno la famiglia vede come prima della conferma.
-- `anno_visibile(sede, oggi)` = l'anno attivo, tranne quando non è ancora cominciato (`inizio > oggi`): allora vale l'anno il cui
-- periodo contiene oggi (il vecchio, in chiusura). Prima di una conferma l'anno attivo è già cominciato: il ramo nuovo non scatta mai.
-- `frequenze_attive` (e con lei `figli_attivi`, le foto, gli avvisi, le chat, `verificaAlunnoAttivo`, la rubrica) legge da qui. Chi esce
-- ha la frequenza vecchia `uscito`: non c'è. Chi è nuovo ha la frequenza nel nuovo anno, con `data_ingresso` = inizio: non c'è finché non comincia.
CREATE OR REPLACE FUNCTION public.anno_visibile(p_scuola uuid, p_oggi date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN a.inizio > p_oggi THEN coalesce(
             (SELECT v.id FROM public.anni_sede v
               WHERE v.scuola_id = p_scuola AND v.periodo @> p_oggi AND v.stato IN ('corrente', 'in_chiusura', 'chiuso')
               LIMIT 1),
             a.id)
           ELSE a.id
         END
    FROM public.anni_sede a
   WHERE a.id = public.anno_attivo(p_scuola)
$$;
REVOKE ALL ON FUNCTION public.anno_visibile(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_visibile(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.frequenze_attive(p_alunni uuid[])
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi date := public.giorno_roma(now());
BEGIN
  RETURN QUERY
    SELECT f.alunno_id, f.id, f.section_id, f.scuola_id
      FROM public.frequenze f
     WHERE f.alunno_id = ANY (p_alunni)
       AND f.stato IN ('in_attesa', 'iscritto')
       AND f.anno_sede_id = public.anno_visibile(f.scuola_id, v_oggi)
       AND f.data_ingresso <= v_oggi
       AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);
END
$$;
REVOKE ALL ON FUNCTION public.frequenze_attive(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.frequenze_attive(uuid[]) TO service_role;

-- ── passaggio_oggi ───────────────────────────────────────────────────────────────────────────────
-- Il giorno di oggi per una sede. NULL = oggi a Roma. Un giorno scelto da chi chiama è ammesso SOLO per le sedi di prova
-- (`e2e00000…`) o messe in `anno_regole.sedi_simulazione`: la stessa porta di `anni_tick` (ANNI_TICK_OGGI_NON_AMMESSO).
CREATE OR REPLACE FUNCTION public.passaggio_oggi(p_scuola uuid, p_oggi date)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_oggi IS NULL THEN
    RETURN public.giorno_roma(now());
  END IF;
  IF p_scuola::text LIKE 'e2e00000%'
     OR EXISTS (SELECT 1 FROM public.anno_regole g WHERE p_scuola = ANY (g.sedi_simulazione)) THEN
    RETURN p_oggi;
  END IF;
  RAISE EXCEPTION 'PASSAGGIO_OGGI_NON_AMMESSO';
END
$$;

-- ── passaggio_log ────────────────────────────────────────────────────────────────────────────────
-- Una riga di `app_log` con i SOLI numeri e uuid (mai un nome, mai un conteggio per bambino). Mai un errore: se il log non si scrive,
-- il passaggio non per questo si ferma.
CREATE OR REPLACE FUNCTION public.passaggio_log(p_scuola uuid, p_esito text, p_passaggio uuid, p_campi jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
  VALUES ('info', 'anno-scolastico', 'server', 'passaggio d''anno: ' || p_esito, p_scuola,
          'passaggio-' || p_esito || ':' || p_passaggio::text,
          jsonb_build_object('campi', jsonb_build_object('operazione', 'passaggio', 'esito', p_esito, 'entita_id', p_passaggio) || p_campi))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'passaggio_log: riga non scritta [%]', SQLSTATE;
END
$$;

-- ── passaggio_conferma ───────────────────────────────────────────────────────────────────────────
-- Il giorno dopo l'ultimo giorno aperto dell'anno vecchio la segreteria conferma: cambia l'anno attivo.
-- Codici: PASSAGGIO_OGGI_NON_AMMESSO (per primo), PASSAGGIO_NON_TROVATO, PASSAGGIO_NON_MODIFICABILE (annullato),
--   PASSAGGIO_TROPPO_PRESTO (`oggi <= ultimo_giorno_aperto` del vecchio), PASSAGGIO_NON_PRONTO, ANTEPRIMA_VECCHIA (le righe non
--   coincidono più col ricalcolo, ignorando le eccezioni: DETAIL {righe_diverse}), RIGHE_DA_DECIDERE (DETAIL {senza_sezione,
--   ritirato_tendina}: righe che continuano o cambiano grado senza classe nuova, e “ritirato” dalla tendina da decidere).
-- Rifatta su un passaggio già confermato ritorna `gia_confermato: true` SENZA scrivere niente.
--
-- ORDINE OBBLIGATORIO (una transazione; `FOR UPDATE` sui due anni e sul passaggio, sempre in questo ordine):
--   1. i controlli e il ricalcolo;
--   2. le USCITE, mentre il vecchio è ancora l'anno attivo: la specchiatura sulla scheda dell'alunno (ritirato, archiviato) guarda
--      l'anno attivo, e deve guardare quello vecchio. Per ogni `esce`/`non_risposto` la frequenza vecchia diventa `uscito` con
--      `data_uscita` = fine dell'anno, e lo stato di prima si salva (serve all'annullamento). Un “esce” scelto a mano su chi ha già
--      una frequenza nuova viva ritira anche quella (`ritirato`, uscita = ingresso);
--   3. i DOCENTI: le assegnazioni `copiata`/`aggiunta` entrano in `utenti_sezioni` (se mancano), e si ricorda quali ha scritto la conferma;
--   4. la DIDATTICA: `passaggio_copia_didattica`;
--   5. le classi scelte a mano: `frequenze.section_id` delle righe con eccezione;
--   6. il CAMBIO DI STATO: il vecchio `corrente → in_chiusura` se serve, le domande del vecchio si chiudono, il nuovo diventa `corrente`
--      (il vecchio PRIMA del nuovo: un solo `corrente` per sede); una riga in `anni_sede_stati` per ciascuno; i valori di prima in `conteggi`;
--   7. lo SPECCHIO: `alunni_riallinea_da_frequenze` per ogni bambino del passaggio, ora che l'anno attivo è il nuovo (a chi non ha una
--      frequenza nell'anno nuovo non cambia niente; a chi l'ha ritirata a mano segue la scheda);
--   8. il passaggio diventa `confermato`, con chi e quando, i conteggi, e una riga di log con i soli numeri.
-- Risposta: {passaggio_id, gia_confermato, conteggi{continuano, nuovi, usciti, cambia_grado, docenti_copiati}}.
CREATE OR REPLACE FUNCTION public.passaggio_conferma(p_passaggio uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p        public.passaggi_anno%ROWTYPE;
  v_da       public.anni_sede%ROWTYPE;
  v_a        public.anni_sede%ROWTYPE;
  v_oggi     date;
  v_diverse  integer;
  v_senza    integer;
  v_tendina  integer;
  v_continuano integer;
  v_nuovi    integer;
  v_cambia   integer;
  v_usciti   integer := 0;
  v_docenti  integer := 0;
  v_didattica jsonb;
  v_giro     record;
  v_conteggi jsonb;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  -- I due anni prima, poi il passaggio: lo stesso ordine di `passaggio_anteprima` (nessuna attesa circolare).
  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;

  IF v_p.stato = 'confermato' THEN
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_confermato', true, 'conteggi', jsonb_build_object(
      'continuano', coalesce((v_p.conteggi ->> 'continuano')::integer, 0), 'nuovi', coalesce((v_p.conteggi ->> 'nuovi')::integer, 0),
      'usciti', coalesce((v_p.conteggi ->> 'usciti')::integer, 0), 'cambia_grado', coalesce((v_p.conteggi ->> 'cambia_grado')::integer, 0),
      'docenti_copiati', coalesce((v_p.conteggi ->> 'docenti_copiati')::integer, 0)));
  END IF;
  IF v_p.stato <> 'anteprima' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_MODIFICABILE' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
  END IF;

  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  -- 1 · controlli e ricalcolo
  IF v_oggi <= v_da.ultimo_giorno_aperto THEN
    RAISE EXCEPTION 'PASSAGGIO_TROPPO_PRESTO'
      USING DETAIL = json_build_object('giorni_mancanti', v_da.ultimo_giorno_aperto - v_oggi + 1)::text;
  END IF;
  IF v_a.stato <> 'iscrizioni_aperte' OR public.anno_attivo(v_da.scuola_id) IS DISTINCT FROM v_da.id THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'anni-cambiati';
  END IF;

  SELECT count(*) INTO v_diverse
    FROM (SELECT x.* FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id) r2
    FULL JOIN public.passaggio_calcola(v_da.id, v_a.id) c ON c.alunno_id = r2.alunno_id
   WHERE r2.alunno_id IS NULL OR c.alunno_id IS NULL
      OR r2.frequenza_da_id IS DISTINCT FROM c.frequenza_da_id
      OR (r2.eccezione AND ((r2.frequenza_a_id IS NULL) <> (c.frequenza_a_id IS NULL)))
      OR (NOT r2.eccezione AND (r2.esito <> c.esito
                                OR r2.frequenza_a_id IS DISTINCT FROM c.frequenza_a_id
                                OR r2.sezione_a_id IS DISTINCT FROM c.sezione_a_id
                                OR r2.avviso IS DISTINCT FROM c.avviso));
  IF v_diverse > 0 THEN
    RAISE EXCEPTION 'ANTEPRIMA_VECCHIA' USING DETAIL = json_build_object('righe_diverse', v_diverse)::text;
  END IF;

  SELECT count(*) FILTER (WHERE esito IN ('continua', 'cambia_grado') AND sezione_a_id IS NULL),
         count(*) FILTER (WHERE avviso = 'ritirato_tendina'),
         count(*) FILTER (WHERE esito = 'continua'),
         count(*) FILTER (WHERE esito = 'nuova'),
         count(*) FILTER (WHERE esito = 'cambia_grado')
    INTO v_senza, v_tendina, v_continuano, v_nuovi, v_cambia
    FROM public.passaggi_anno_righe WHERE passaggio_id = v_p.id;
  IF v_senza > 0 OR v_tendina > 0 THEN
    RAISE EXCEPTION 'RIGHE_DA_DECIDERE'
      USING DETAIL = json_build_object('senza_sezione', v_senza, 'ritirato_tendina', v_tendina)::text;
  END IF;

  -- 2 · le uscite, con il vecchio ancora attivo
  UPDATE public.passaggi_anno_righe r SET stato_da_prima = f.stato
    FROM public.frequenze f
   WHERE r.passaggio_id = v_p.id AND r.esito IN ('esce', 'non_risposto') AND f.id = r.frequenza_da_id AND f.stato IN ('in_attesa', 'iscritto');
  UPDATE public.frequenze f SET stato = 'uscito', data_uscita = v_da.fine
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.esito IN ('esce', 'non_risposto') AND f.id = r.frequenza_da_id AND f.stato IN ('in_attesa', 'iscritto');
  GET DIAGNOSTICS v_usciti = ROW_COUNT;
  UPDATE public.frequenze f SET stato = 'ritirato', data_uscita = f.data_ingresso
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.esito = 'esce' AND r.frequenza_a_id IS NOT NULL AND f.id = r.frequenza_a_id AND f.stato IN ('in_attesa', 'iscritto');

  -- 3 · i docenti
  WITH nuovi AS (
    INSERT INTO public.utenti_sezioni (utente_id, section_id)
    SELECT d.utente_id, d.sezione_a_id
      FROM public.passaggi_anno_docenti d
     WHERE d.passaggio_id = v_p.id AND d.origine IN ('copiata', 'aggiunta')
       AND EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = d.utente_id)
    ON CONFLICT DO NOTHING
    RETURNING utente_id, section_id)
  UPDATE public.passaggi_anno_docenti d SET inserita = true
    FROM nuovi n
   WHERE d.passaggio_id = v_p.id AND d.utente_id = n.utente_id AND d.sezione_a_id = n.section_id;
  GET DIAGNOSTICS v_docenti = ROW_COUNT;

  -- 4 · la didattica della classe nuova
  v_didattica := public.passaggio_copia_didattica(v_p.id);

  -- 5 · le classi scelte a mano
  UPDATE public.frequenze f SET section_id = r.sezione_a_id
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.eccezione AND r.esito IN ('continua', 'cambia_grado', 'nuova') AND r.sezione_a_id IS NOT NULL
     AND f.id = r.frequenza_a_id AND f.stato IN ('in_attesa', 'iscritto') AND f.section_id IS DISTINCT FROM r.sezione_a_id;

  -- 6 · il cambio di stato: il vecchio prima del nuovo (un solo `corrente` per sede)
  v_conteggi := jsonb_build_object(
    'stato_da_prima', v_da.stato, 'domande_da_prima', v_da.domande_aperte,
    'continuano', v_continuano, 'nuovi', v_nuovi, 'usciti', v_usciti, 'cambia_grado', v_cambia, 'docenti_copiati', v_docenti);
  IF v_da.stato = 'corrente' THEN
    UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = v_da.id;
    INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_da.id, 'in_chiusura', p_da);
  END IF;
  UPDATE public.anni_sede SET domande_aperte = false WHERE id = v_da.id;
  UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_a.id, 'corrente', p_da);

  -- 7 · lo specchio, ora che l'anno attivo è il nuovo
  FOR v_giro IN
    SELECT x.alunno_id FROM public.passaggi_anno_righe x
     WHERE x.passaggio_id = v_p.id
  LOOP
    PERFORM public.alunni_riallinea_da_frequenze(v_giro.alunno_id);
  END LOOP;

  -- 8 · confermato
  UPDATE public.passaggi_anno
     SET stato = 'confermato', confermato_da = p_da, confermato_il = now(), conteggi = v_conteggi
   WHERE id = v_p.id;

  PERFORM public.passaggio_log(v_p.scuola_id, 'confermato', v_p.id,
    jsonb_build_object('n_continuano', v_continuano, 'n_nuovi', v_nuovi, 'n_usciti', v_usciti, 'n_cambia_grado', v_cambia,
                       'n_docenti_copiati', v_docenti, 'n_materie', coalesce((v_didattica ->> 'materie')::integer, 0)));

  RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_confermato', false, 'conteggi', jsonb_build_object(
    'continuano', v_continuano, 'nuovi', v_nuovi, 'usciti', v_usciti, 'cambia_grado', v_cambia, 'docenti_copiati', v_docenti));
END
$$;

-- ── passaggio_annulla ────────────────────────────────────────────────────────────────────────────
-- Annulla un passaggio. Un'anteprima si scarta (nessun effetto da disfare). Un passaggio CONFERMATO si annulla solo se nel nuovo anno non
-- c'è ancora niente d'USO: PASSAGGIO_NON_ANNULLABILE, con DETAIL i conteggi per tabella, se una tabella del registro con `modo = 'data'`
-- ha già righe nei giorni del nuovo anno. Fuori dal conto stanno `iscrizioni_servizi` e `eventi_agenda` (le prepara la segreteria in
-- anticipo); le tabelle `dichiarato` (classi, frequenze, pagamenti, domande) e le figlie non contano mai: le crea la preparazione.
-- Disfa, nell'ordine: il nuovo torna `iscrizioni_aperte`; il vecchio torna `corrente` SOLO se lo era e se oggi è ancora dentro il suo
-- periodo; `domande_aperte` del vecchio torna com'era; i `uscito` tornano al loro stato di prima (`data_uscita` vuota); i `ritirato`
-- per eccezione tornano vivi; si tolgono i soli `utenti_sezioni` scritti dalla conferma; lo specchio si rifà per tutti. LE COPIE
-- DIDATTICHE RESTANO (sono lavoro della segreteria: ricopiarle non duplica). Idempotente: rifatta ritorna `gia_annullato: true`.
CREATE OR REPLACE FUNCTION public.passaggio_annulla(p_passaggio uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p       public.passaggi_anno%ROWTYPE;
  v_da      public.anni_sede%ROWTYPE;
  v_a       public.anni_sede%ROWTYPE;
  v_oggi    date;
  v_uso     jsonb := '{}'::jsonb;
  v_n       bigint;
  v_tab     record;
  v_giro    record;
  v_riaperto boolean := false;
  v_tornati integer := 0;
  v_ritirati integer := 0;
  v_tolti   integer := 0;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;

  IF v_p.stato = 'annullato' THEN
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_annullato', true);
  END IF;

  IF v_p.stato = 'anteprima' THEN
    UPDATE public.passaggi_anno SET stato = 'annullato', annullato_da = p_da, annullato_il = now() WHERE id = v_p.id;
    PERFORM public.passaggio_log(v_p.scuola_id, 'annullato', v_p.id, jsonb_build_object('n_ripristinati', 0));
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'conteggi', jsonb_build_object('ripristinati', 0));
  END IF;

  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  -- Il nuovo dev'essere ancora l'anno in corso, e senza niente d'uso.
  IF v_a.stato <> 'corrente' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_ANNULLABILE' USING DETAIL = json_build_object('anno_non_corrente', 1)::text;
  END IF;
  FOR v_tab IN
    SELECT g.tabella FROM public.anno_tabelle g
     WHERE g.modo = 'data' AND g.tabella NOT IN ('iscrizioni_servizi', 'eventi_agenda')
       AND to_regclass('public.' || g.tabella) IS NOT NULL
     ORDER BY g.tabella
  LOOP
    v_n := public.anno_conta_righe_assegnate_nei_giorni(v_tab.tabella, v_a.anno_id, v_a.scuola_id, v_a.inizio, v_a.fine);
    IF v_n > 0 THEN
      v_uso := v_uso || jsonb_build_object(v_tab.tabella, v_n);
    END IF;
  END LOOP;
  IF v_uso <> '{}'::jsonb THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_ANNULLABILE' USING DETAIL = v_uso::text;
  END IF;

  -- Gli anni: il nuovo lascia il posto di `corrente` PRIMA che il vecchio lo riprenda.
  UPDATE public.anni_sede SET stato = 'iscrizioni_aperte' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_a.id, 'iscrizioni_aperte', p_da);
  IF coalesce(v_p.conteggi ->> 'stato_da_prima', '') = 'corrente' AND v_oggi <= v_da.fine THEN
    UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_da.id AND stato <> 'corrente';
    IF FOUND THEN
      INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_da.id, 'corrente', p_da);
      v_riaperto := true;
    END IF;
  END IF;
  IF v_p.conteggi ? 'domande_da_prima' THEN
    UPDATE public.anni_sede SET domande_aperte = (v_p.conteggi ->> 'domande_da_prima')::boolean WHERE id = v_da.id;
  END IF;

  -- Le frequenze, con il vecchio di nuovo anno attivo (lo specchio le segue).
  UPDATE public.frequenze f SET stato = r2.stato_da_prima, data_uscita = NULL
    FROM public.passaggi_anno_righe r2
   WHERE r2.passaggio_id = v_p.id AND r2.esito IN ('esce', 'non_risposto') AND r2.stato_da_prima IS NOT NULL
     AND f.id = r2.frequenza_da_id AND f.stato = 'uscito';
  GET DIAGNOSTICS v_tornati = ROW_COUNT;
  UPDATE public.frequenze f SET stato = 'in_attesa', data_uscita = NULL
    FROM public.passaggi_anno_righe r2
   WHERE r2.passaggio_id = v_p.id AND r2.esito = 'esce' AND r2.eccezione AND r2.frequenza_a_id IS NOT NULL
     AND f.id = r2.frequenza_a_id AND f.stato = 'ritirato';
  GET DIAGNOSTICS v_ritirati = ROW_COUNT;

  -- Le assegnazioni dei docenti: solo quelle che la conferma ha scritto.
  DELETE FROM public.utenti_sezioni us
   USING public.passaggi_anno_docenti d
   WHERE d.passaggio_id = v_p.id AND d.inserita AND us.utente_id = d.utente_id AND us.section_id = d.sezione_a_id;
  GET DIAGNOSTICS v_tolti = ROW_COUNT;
  UPDATE public.passaggi_anno_docenti SET inserita = false WHERE passaggio_id = v_p.id AND inserita;

  -- I bambini “nuovi” non hanno una frequenza viva nell'anno vecchio, e lo specchio non ha niente da copiare: tornano “in arrivo”, senza
  -- classe e non archiviati (com'erano prima dell'arrivo). Prima dello specchio, che li lascia così. Il resto della scheda (retta,
  -- intestatario) resta com'è: lo riscrive il prossimo specchio.
  UPDATE public.alunni a SET stato = 'in_arrivo', section_id = NULL, classe_sezione = NULL, archiviato_il = NULL
   WHERE a.id IN (SELECT x.alunno_id FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id AND x.esito = 'nuova')
     AND NOT EXISTS (SELECT 1 FROM public.frequenze f
                      WHERE f.alunno_id = a.id AND f.anno_sede_id = public.anno_attivo(v_p.scuola_id) AND f.stato IN ('in_attesa', 'iscritto'));
  FOR v_giro IN SELECT x.alunno_id FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id LOOP
    PERFORM public.alunni_riallinea_da_frequenze(v_giro.alunno_id);
  END LOOP;

  UPDATE public.passaggi_anno SET stato = 'annullato', annullato_da = p_da, annullato_il = now() WHERE id = v_p.id;

  PERFORM public.passaggio_log(v_p.scuola_id, 'annullato', v_p.id,
    jsonb_build_object('n_ripristinati', v_tornati + v_ritirati, 'n_docenti_tolti', v_tolti));

  RETURN jsonb_build_object('passaggio_id', v_p.id, 'conteggi', jsonb_build_object(
    'ripristinati', v_tornati + v_ritirati, 'docenti_tolti', v_tolti, 'vecchio_riaperto', CASE WHEN v_riaperto THEN 1 ELSE 0 END));
END
$$;

-- ── passaggio_conferma_tardiva ───────────────────────────────────────────────────────────────────
-- Una famiglia che conferma DOPO il passaggio: il bambino era `esce` o `non_risposto` e la sua frequenza vecchia si è chiusa. Solo se il
-- passaggio è `confermato` e il nuovo anno è `corrente` (PASSAGGIO_NON_PRONTO) e la riga è `esce`/`non_risposto` (RIGA_NON_VALIDA).
-- Crea la frequenza nuova (`tipo = 'conferma'`, `origine = 'passaggio'`, `continua_da` = la vecchia, ingresso = il più tardi fra l'inizio
-- dell'anno e oggi) con i campi di famiglia della vecchia come `anno_conferma`, oppure RIAPRE quella ritirata; la classe è `p_section`
-- o la continuazione della vecchia. Poi lo specchio (la scheda archiviata torna viva: senza questo la voce della quota non nasce) e la
-- voce della quota. Aggiorna la riga (`frequenza_a_id`, `eccezione = true`; l'esito resta quello della conferma, che è storia).
-- Rifatta: `creata: false`. Risposta: {frequenza_id, creata, quota, pagamento_id}.
CREATE OR REPLACE FUNCTION public.passaggio_conferma_tardiva(
  p_passaggio uuid, p_alunno uuid, p_section uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p      public.passaggi_anno%ROWTYPE;
  v_a      public.anni_sede%ROWTYPE;
  v_r      public.passaggi_anno_righe%ROWTYPE;
  v_fd     public.frequenze%ROWTYPE;
  v_f      public.frequenze%ROWTYPE;
  v_s      public.sections%ROWTYPE;
  v_oggi   date;
  v_sez    uuid := p_section;
  v_creata boolean := false;
  v_ingresso date;
  v_quota  jsonb;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR SHARE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;
  SELECT * INTO v_a FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;
  IF v_p.stato <> 'confermato' OR v_a.stato <> 'corrente' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'passaggio-non-in-corso';
  END IF;

  SELECT * INTO v_r FROM public.passaggi_anno_righe WHERE passaggio_id = v_p.id AND alunno_id = p_alunno FOR UPDATE;
  IF NOT FOUND OR v_r.esito NOT IN ('esce', 'non_risposto') THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'riga-non-tardiva';
  END IF;
  IF EXISTS (SELECT 1 FROM public.alunni a WHERE a.id = p_alunno AND a.anonimizzato_il IS NOT NULL) THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'alunno-anonimizzato';
  END IF;

  SELECT * INTO v_fd FROM public.frequenze WHERE id = v_r.frequenza_da_id;

  IF v_sez IS NOT NULL THEN
    SELECT * INTO v_s FROM public.sections WHERE id = v_sez;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'sezione-sconosciuta';
    END IF;
    IF v_s.scuola_id IS DISTINCT FROM v_p.scuola_id THEN
      RAISE EXCEPTION 'SEDE_DIVERSA' USING HINT = 'sezione';
    END IF;
    IF v_s.anno_id IS DISTINCT FROM v_a.anno_id THEN
      RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO' USING HINT = 'sezione';
    END IF;
  ELSIF v_fd.section_id IS NOT NULL THEN
    SELECT s.id INTO v_sez FROM public.sections s
     WHERE s.continua_da = v_fd.section_id AND s.anno_id = v_a.anno_id AND s.scuola_id = v_a.scuola_id
     ORDER BY s.id LIMIT 1;
  END IF;

  v_ingresso := least(greatest(v_a.inizio, v_oggi), v_a.fine);

  SELECT * INTO v_f FROM public.frequenze WHERE alunno_id = p_alunno AND anno_sede_id = v_a.id FOR UPDATE;
  IF FOUND THEN
    IF v_f.stato = 'ritirato' THEN
      UPDATE public.frequenze SET stato = 'in_attesa', data_uscita = NULL, tipo = 'conferma',
             continua_da = coalesce(continua_da, v_fd.id), section_id = coalesce(v_sez, section_id)
       WHERE id = v_f.id;
      v_creata := true;
    ELSIF v_f.stato NOT IN ('in_attesa', 'iscritto') THEN
      RAISE EXCEPTION 'FREQUENZA_NON_VIVA' USING DETAIL = json_build_object('stato', 1)::text;
    END IF;
  ELSE
    INSERT INTO public.frequenze
      (alunno_id, anno_sede_id, anno_id, scuola_id, section_id, continua_da, tipo, stato, origine, data_ingresso,
       retta_esente, retta_a_carico_di, retta_split_config, intestatario_fatture, giorno_scadenza_pagamenti, gruppo_mensa_id, usa_pannolino)
    VALUES
      (p_alunno, v_a.id, v_a.anno_id, v_a.scuola_id, v_sez, v_fd.id, 'conferma', 'in_attesa', 'passaggio', v_ingresso,
       coalesce(v_fd.retta_esente, false), v_fd.retta_a_carico_di, v_fd.retta_split_config, v_fd.intestatario_fatture,
       v_fd.giorno_scadenza_pagamenti, v_fd.gruppo_mensa_id, coalesce(v_fd.usa_pannolino, false))
    RETURNING * INTO v_f;
    v_creata := true;
  END IF;

  UPDATE public.passaggi_anno_righe SET frequenza_a_id = v_f.id, eccezione = true, modificata_da = p_da WHERE id = v_r.id;

  -- Prima lo specchio (la scheda archiviata torna viva), poi la voce: a una scheda archiviata la quota non nasce.
  PERFORM public.alunni_riallinea_da_frequenze(p_alunno);
  v_quota := public.anno_quota_voce(v_f.id, p_da, v_oggi);

  PERFORM public.passaggio_log(v_p.scuola_id, 'conferma-tardiva', v_p.id, jsonb_build_object('n_creata', CASE WHEN v_creata THEN 1 ELSE 0 END));

  RETURN jsonb_build_object('frequenza_id', v_f.id, 'creata', v_creata,
                            'quota', v_quota -> 'esito', 'pagamento_id', v_quota -> 'pagamento_id');
END
$$;

REVOKE ALL ON FUNCTION public.passaggio_oggi(uuid, date)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_log(uuid, text, uuid, jsonb)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_conferma(uuid, uuid, date)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_annulla(uuid, uuid, date)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_conferma_tardiva(uuid, uuid, uuid, uuid, date)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_oggi(uuid, date)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_log(uuid, text, uuid, jsonb)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_conferma(uuid, uuid, date)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_annulla(uuid, uuid, date)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_conferma_tardiva(uuid, uuid, uuid, uuid, date)   TO service_role;
