-- =============================================================================
-- SCATOLA NERA: OGNI RIGA CANCELLATA DALLE TABELLE PREZIOSE RESTA 90 GIORNI — 2026-10-09
--
-- Roadmap di robustezza, fase 4, problema D3-A («un solo DELETE può cancellare
-- anni di storia»). In `public` ci sono 120 FK in CASCADE: cancellare una sede
-- porta via 40 tabelle, un alunno 27, un periodo di scrutinio pagelle, giudizi e
-- firme dei genitori. Fino a oggi una cancellazione sbagliata (una route, un
-- agente, una query nel pannello) si recuperava solo dal backup notturno: tutto il
-- database di una notte fa, in locale, a mano.
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `scatola_nera.eliminazioni`: ogni riga cancellata dalle tabelle dell'elenco
--    qui sotto, come JSON, con tabella, transazione, ruolo, utente e origine. La
--    scrive un trigger AFTER DELETE a livello di ISTRUZIONE con la tabella di
--    transizione (`vecchie`): una DELETE da mille righe è un solo INSERT. Scatta
--    anche sulle righe portate via in CASCADE, e su quelle cancellate da SQL, dal
--    pannello o da un agente. Solo in aggiunta: UPDATE, DELETE e TRUNCATE sono
--    rifiutati, salvo le due funzioni di manutenzione qui sotto.
--  · Scadenza: 90 giorni (job `scatola-nera-scadenza`, ogni notte alle 05:43 UTC).
--  · Oblio: `public.scatola_nera_dimentica` toglie dalla scatola le righe che
--    nominano la persona (in `id` o in una colonna `*_id`) e lo scrive in
--    `scatola_nera.oblii` — data, uuid, tipo, mai dati. È il «registro recuperabile
--    degli oblii» chiesto dalla fase 2: dopo un ripristino da un dump vecchio, gli
--    oblii avvenuti dopo la data della copia vanno riapplicati, e fino a oggi
--    l'elenco stava solo in `app_log`, che si svuota a 30 giorni. Si tiene 400
--    giorni: più della copia mensile più vecchia (12 mesi).
--  · Ripristino: `scatola_nera.ripristina(ids)` e `ripristina_transazione(txid)`,
--    solo per il proprietario (postgres): li usa chi segue il runbook, mai l'app.
--  · TRUNCATE sulle stesse tabelle è rifiutato: la scatola nera non lo vede.
--
-- ─── PERCHÉ UNO SCHEMA A PARTE ───────────────────────────────────────────────
-- `scatola_nera` non è fra gli schemi esposti da PostgREST (`public`,
-- `graphql_public`) e nessun ruolo dell'app ha USAGE: le righe contengono dati
-- personali di minori, e l'unica porta per l'app è `public.scatola_nera_dimentica`
-- (service_role). Il backup notturno lo copia (`scripts/backup/dump-cifrato.sh`,
-- SCHEMI): `backup_lettura` ha `pg_read_all_data`, che vale per ogni schema.
--
-- ─── COSA RESTA FUORI, E PERCHÉ ──────────────────────────────────────────────
--  · le tabelle che una RETENTION svuota per legge (domande di iscrizione,
--    personale, candidature, galleria, allegati del registro, notifiche, app_log):
--    tenerne una copia 90 giorni allungherebbe la conservazione dichiarata
--    nell'informativa. Le copre il backup notturno;
--  · `protocolli`: la cancellazione «senza traccia» è una decisione del titolare
--    (Decisione #6 del registro protocolli);
--  · `fatture_emesse` e `ricevute_emesse`: sono già WORM, non si cancellano;
--  · `registro_modifiche` e `audit_scritture_docente`: sono già registri (D4);
--  · gli utenti di `auth.users`: una riga di `utenti` si ripristina solo se
--    l'account esiste ancora (la FK lo pretende).
--
-- ─── FAIL-CLOSED ─────────────────────────────────────────────────────────────
-- Se la scrittura nella scatola fallisse, fallirebbe la DELETE: è voluto. Una
-- cancellazione di una tabella preziosa senza la sua copia è proprio ciò che
-- questa migrazione esiste per impedire. L'INSERT non ha vincoli che una riga
-- possa violare (JSON, array di uuid già filtrati per forma).
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger where tgname = 'scatola_nera_eliminazioni';   -- 42
--   select has_schema_privilege('authenticated', 'scatola_nera', 'USAGE');        -- false
--   select has_function_privilege('anon', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE'); -- false
--   select jobname, schedule from cron.job where jobname = 'scatola-nera-scadenza';
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     for t in select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
--               where g.tgname in ('scatola_nera_eliminazioni','scatola_nera_no_truncate') loop
--       execute format('drop trigger if exists scatola_nera_eliminazioni on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_no_truncate on public.%I', t);
--     end loop; end $$;
--   select cron.unschedule('scatola-nera-scadenza');
--   drop function if exists public.scatola_nera_dimentica(uuid[], text, text);
--   -- lo schema e le righe si tengono finché non scadono: sono la copia.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS scatola_nera;
REVOKE ALL ON SCHEMA scatola_nera FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS scatola_nera.eliminazioni (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eliminata_il timestamptz NOT NULL DEFAULT clock_timestamp(),
  transazione  bigint      NOT NULL DEFAULT txid_current(),
  tabella      text        NOT NULL,
  riga         jsonb       NOT NULL,
  -- Gli uuid che la riga nomina in `id` o in una colonna `*_id`: è la chiave
  -- dell'oblio (chi viene dimenticato si cerca qui, con l'indice GIN).
  soggetti     uuid[]      NOT NULL DEFAULT '{}',
  -- Chi: il ruolo dell'istruzione (anon, authenticated, service_role, postgres,
  -- supabase_auth_admin…), l'utente se la richiesta portava un JWT con `sub`,
  -- l'origine (il percorso PostgREST, o l'application_name: pg_cron, il pannello).
  ruolo        text        NOT NULL,
  utente       uuid,
  origine      text
);
ALTER TABLE scatola_nera.eliminazioni ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS eliminazioni_soggetti_idx ON scatola_nera.eliminazioni USING gin (soggetti);
CREATE INDEX IF NOT EXISTS eliminazioni_eliminata_il_idx ON scatola_nera.eliminazioni (eliminata_il);
CREATE INDEX IF NOT EXISTS eliminazioni_transazione_idx ON scatola_nera.eliminazioni (transazione);

CREATE TABLE IF NOT EXISTS scatola_nera.oblii (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eseguito_il       timestamptz NOT NULL DEFAULT now(),
  soggetto          uuid        NOT NULL,
  tipo              text        NOT NULL CHECK (tipo IN ('alunno', 'genitore', 'personale', 'altro')),
  canale            text,
  righe_dimenticate int         NOT NULL DEFAULT 0
);
ALTER TABLE scatola_nera.oblii ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS oblii_eseguito_il_idx ON scatola_nera.oblii (eseguito_il);

COMMENT ON TABLE scatola_nera.eliminazioni IS
  'Scatola nera (fase 4, D3-A): ogni riga cancellata dalle tabelle preziose, come JSON, per 90 giorni. Solo in aggiunta. Contiene dati personali: schema non esposto, nessun ruolo dell''app vi accede. Oblio: public.scatola_nera_dimentica. Ripristino: scatola_nera.ripristina (runbook).';
COMMENT ON TABLE scatola_nera.oblii IS
  'Registro recuperabile degli oblii: data, uuid, tipo, canale. Mai dati personali. Serve a riapplicare gli oblii dopo un ripristino da una copia vecchia. 400 giorni (più della copia mensile più vecchia).';

-- ── Solo in aggiunta ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION scatola_nera.vieta_modifiche()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('scatola_nera.manutenzione', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'scatola_nera.%: % non ammesso, la scatola nera si scrive solo in aggiunta', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001',
          HINT = 'Le righe escono solo per scadenza (scatola_nera.scadenza) o per oblio (public.scatola_nera_dimentica).';
END $$;

DROP TRIGGER IF EXISTS solo_aggiunta ON scatola_nera.eliminazioni;
CREATE TRIGGER solo_aggiunta BEFORE UPDATE OR DELETE ON scatola_nera.eliminazioni
  FOR EACH ROW EXECUTE FUNCTION scatola_nera.vieta_modifiche();
DROP TRIGGER IF EXISTS solo_aggiunta_truncate ON scatola_nera.eliminazioni;
CREATE TRIGGER solo_aggiunta_truncate BEFORE TRUNCATE ON scatola_nera.eliminazioni
  FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_modifiche();
DROP TRIGGER IF EXISTS solo_aggiunta ON scatola_nera.oblii;
CREATE TRIGGER solo_aggiunta BEFORE UPDATE OR DELETE ON scatola_nera.oblii
  FOR EACH ROW EXECUTE FUNCTION scatola_nera.vieta_modifiche();
DROP TRIGGER IF EXISTS solo_aggiunta_truncate ON scatola_nera.oblii;
CREATE TRIGGER solo_aggiunta_truncate BEFORE TRUNCATE ON scatola_nera.oblii
  FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_modifiche();

-- ── Chi nomina una riga ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION scatola_nera.soggetti_di(p_riga jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(DISTINCT (e.value #>> '{}')::uuid), '{}'::uuid[])
    FROM jsonb_each(p_riga) e
   WHERE (e.key = 'id' OR e.key LIKE '%\_id')
     AND jsonb_typeof(e.value) = 'string'
     AND (e.value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- ── Il trigger ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER: chi cancella (authenticated, service_role, supabase_auth_admin
-- per le cascate da auth.users) non ha nessun permesso sullo schema, e non deve
-- averne. `current_setting('role')` resta quello di chi ha lanciato l'istruzione.
CREATE OR REPLACE FUNCTION scatola_nera.registra()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ruolo   text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user::text);
  v_utente  uuid;
  v_origine text;
BEGIN
  BEGIN
    v_utente := NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_utente := NULL; -- claims assenti o non JSON (pg_cron, pannello): nessun utente, non un errore
  END;
  v_origine := left(COALESCE(NULLIF(current_setting('request.path', true), ''),
                             NULLIF(current_setting('application_name', true), ''),
                             'sconosciuta'), 200);

  INSERT INTO scatola_nera.eliminazioni (tabella, riga, soggetti, ruolo, utente, origine)
  SELECT TG_TABLE_NAME, r.riga, scatola_nera.soggetti_di(r.riga), v_ruolo, v_utente, v_origine
    FROM (SELECT to_jsonb(v) AS riga FROM vecchie v) r;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION scatola_nera.vieta_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE su public.% rifiutato: la scatola nera non lo vede', TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          HINT = 'Si cancella con DELETE (e un WHERE): così ogni riga resta 90 giorni in scatola_nera.eliminazioni.';
END $$;

-- L'elenco delle tabelle preziose: anagrafica, registro e scrutini, salute e
-- documenti, contabilità, moduli firmati, struttura. Una tabella assente (il
-- database della CI non è migrato) si salta con un avviso.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- tabelle-preziose:inizio
    'alunni', 'parents', 'student_parents', 'legame_genitori_alunni', 'delegates', 'utenti', 'student_guardians',
    'presenze', 'giustifiche_didattiche', 'eventi_diario', 'valutazioni', 'valutazione_obiettivi',
    'note_disciplinari', 'firme_docenti',
    'scrutinio_periodi', 'scrutini', 'pagelle', 'pagella_ricezioni', 'scrutinio_giudizi',
    'scrutinio_comportamento', 'scrutinio_giudizio_descrittivo',
    'certificati_competenze', 'certificato_competenza_livelli', 'certificati_medici', 'student_documents',
    'pagamenti', 'pagamenti_quote', 'incassi', 'solleciti', 'fatture_coda', 'riconciliazione_movimenti',
    'cassa_movimenti', 'cassa_chiusure', 'cassa_categorie', 'mensa_ticket_movimenti', 'ticket_mensa',
    'iscrizioni_servizi',
    'forms_templates', 'forms_submissions',
    'sections', 'schools', 'scuole'
    -- tabelle-preziose:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_eliminazioni ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_eliminazioni AFTER DELETE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_no_truncate ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_no_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_truncate()', t);
  END LOOP;
END $$;

-- ── Scadenza ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION scatola_nera.scadenza()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_righe int := 0;
  v_oblii int := 0;
BEGIN
  PERFORM set_config('scatola_nera.manutenzione', 'on', true);
  DELETE FROM scatola_nera.eliminazioni WHERE eliminata_il < now() - interval '90 days';
  GET DIAGNOSTICS v_righe = ROW_COUNT;
  DELETE FROM scatola_nera.oblii WHERE eseguito_il < now() - interval '400 days';
  GET DIAGNOSTICS v_oblii = ROW_COUNT;
  PERFORM set_config('scatola_nera.manutenzione', 'off', true);

  -- IL BATTITO, nella forma che il sorvegliante (`controlloBattitoCron`) sa leggere:
  -- evento `cron`, `campi.operazione` = nome del job, `campi.esito` = 'ok'. Anche
  -- quando non scade niente (regola 5): «nessuna riga» non deve voler dire insieme
  -- «tutto a posto» e «non è mai partito». Solo conteggi.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server', 'scatola nera: scadenza 90 giorni',
    'cron:scatola-nera-scadenza',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'scatola-nera-scadenza',
        'esito',      'ok',
        'azione',     'scadenza-scatola-nera',
        'n_righe',    v_righe,
        'n_oblii',    v_oblii,
        'n_presenti', (SELECT count(*) FROM scatola_nera.eliminazioni)
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

-- ── Oblio: l'unica porta per l'app ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scatola_nera_dimentica(p_soggetti uuid[], p_tipo text, p_canale text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_righe int := 0;
  v_s     uuid;
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('alunno', 'genitore', 'personale', 'altro') THEN
    RAISE EXCEPTION 'scatola_nera_dimentica: tipo % non ammesso', p_tipo USING ERRCODE = '22023';
  END IF;
  IF p_soggetti IS NULL OR cardinality(p_soggetti) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM set_config('scatola_nera.manutenzione', 'on', true);
  DELETE FROM scatola_nera.eliminazioni WHERE soggetti && p_soggetti;
  GET DIAGNOSTICS v_righe = ROW_COUNT;
  PERFORM set_config('scatola_nera.manutenzione', 'off', true);

  FOREACH v_s IN ARRAY p_soggetti LOOP
    IF v_s IS NOT NULL THEN
      INSERT INTO scatola_nera.oblii (soggetto, tipo, canale, righe_dimenticate)
      VALUES (v_s, p_tipo, left(p_canale, 200), v_righe);
    END IF;
  END LOOP;
  RETURN v_righe;
END $$;

-- ── Ripristino (runbook, mai l'app) ───────────────────────────────────────────
-- Rimette le righe nella loro tabella, con le sole colonne che la riga salvata
-- nomina e che la tabella ha ancora (niente colonne generate). Le FK decidono
-- l'ordine: chi aspetta il padre ci riprova al giro dopo, finché qualcosa avanza.
-- Una riga con la stessa chiave già presente non si sovrascrive: si conta.
CREATE OR REPLACE FUNCTION scatola_nera.ripristina(p_ids bigint[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attesa   bigint[] := COALESCE(p_ids, '{}');
  v_dopo     bigint[];
  v_id       bigint;
  r          record;
  v_colonne  text;
  v_ok       int := 0;
  v_presenti bigint[] := '{}';
  v_fallite  jsonb := '[]'::jsonb;
  v_avanza   boolean;
BEGIN
  LOOP
    v_dopo := '{}';
    v_avanza := false;
    FOREACH v_id IN ARRAY v_attesa LOOP
      SELECT * INTO r FROM scatola_nera.eliminazioni WHERE id = v_id;
      IF NOT FOUND THEN
        v_fallite := v_fallite || jsonb_build_object('id', v_id, 'codice', 'non_trovata');
        CONTINUE;
      END IF;
      IF to_regclass(format('public.%I', r.tabella)) IS NULL THEN
        v_fallite := v_fallite || jsonb_build_object('id', v_id, 'codice', 'tabella_assente');
        CONTINUE;
      END IF;
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO v_colonne
        FROM pg_attribute a
       WHERE a.attrelid = format('public.%I', r.tabella)::regclass
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND a.attgenerated = ''
         AND r.riga ? a.attname;
      BEGIN
        EXECUTE format(
          'INSERT INTO public.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1)',
          r.tabella, v_colonne, v_colonne, r.tabella)
        USING r.riga;
        v_ok := v_ok + 1;
        v_avanza := true;
      EXCEPTION
        WHEN unique_violation THEN
          v_presenti := v_presenti || v_id;
          v_avanza := true;
        WHEN foreign_key_violation THEN
          v_dopo := v_dopo || v_id;
        WHEN OTHERS THEN
          v_fallite := v_fallite || jsonb_build_object('id', v_id, 'codice', SQLSTATE);
      END;
    END LOOP;
    EXIT WHEN cardinality(v_dopo) = 0 OR NOT v_avanza;
    v_attesa := v_dopo;
  END LOOP;

  FOREACH v_id IN ARRAY v_dopo LOOP
    v_fallite := v_fallite || jsonb_build_object('id', v_id, 'codice', '23503');
  END LOOP;
  RETURN jsonb_build_object('ripristinate', v_ok, 'gia_presenti', to_jsonb(v_presenti), 'fallite', v_fallite);
END $$;

CREATE OR REPLACE FUNCTION scatola_nera.ripristina_transazione(p_transazione bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT scatola_nera.ripristina(COALESCE(array_agg(id ORDER BY id), '{}'))
    FROM scatola_nera.eliminazioni
   WHERE transazione = p_transazione
$$;

-- ── Permessi: nessuna funzione della scatola è dell'app, tranne l'oblio ────────
-- In Supabase anon e authenticated ricevono l'EXECUTE per GRANT esplicito: si
-- revocano per nome, funzione per funzione (lock `security-definer-revoke-lock`).
REVOKE ALL ON FUNCTION scatola_nera.vieta_modifiche() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.soggetti_di(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.registra() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.vieta_truncate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.scadenza() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.ripristina(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.ripristina_transazione(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) TO service_role;

COMMENT ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) IS
  'Oblio nella scatola nera: toglie da scatola_nera.eliminazioni le righe che nominano uno di questi uuid (in id o in una colonna *_id) e scrive un oblio per uuid in scatola_nera.oblii (mai dati). Restituisce le righe tolte. Solo service_role.';

-- ── Il job notturno ───────────────────────────────────────────────────────────
-- Protetto dal blocco EXCEPTION perché il database della CI non ha pg_cron.
-- 05:43 UTC: lontano dagli altri job (04:17–05:29) e dal backup.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'scatola-nera-scadenza';
  PERFORM cron.schedule('scatola-nera-scadenza', '43 5 * * *',
    $cron$ SELECT scatola_nera.scadenza(); $cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'scatola nera: pg_cron assente, job non programmato';
END $$;

NOTIFY pgrst, 'reload schema';
