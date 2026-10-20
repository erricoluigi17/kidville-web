-- =============================================================================
-- SCATOLA NERA, SECONDA METÀ: OGNI VERSIONE SOVRASCRITTA DI VOTI, PRESENZE, PAGAMENTI,
-- INCASSI E SCRUTINI RESTA 90 GIORNI — 2026-10-19
--
-- Roadmap di robustezza, fase 12 («storico UPDATE», problema D4: «l'audit è
-- applicativo e se va bene»). Dal 09/10 una riga CANCELLATA dalle tabelle preziose
-- resta 90 giorni in `scatola_nera.eliminazioni`. Una riga SOVRASCRITTA no: un voto
-- cambiato per sbaglio, una presenza rifatta, un pagamento ricalcolato male, un
-- giudizio di scrutinio riscritto da una route difettosa, da un agente o da una query
-- nel pannello si recuperavano solo dal backup notturno, cioè dalla notte prima e
-- per tutto il database insieme. `registro_modifiche` e `audit_scritture_docente`
-- tengono solo ciò che l'app sceglie di scriverci, e niente di ciò che passa da SQL.
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `scatola_nera.modifiche`: per ogni riga cambiata da un UPDATE, la riga COM'ERA
--    (JSON intero), le colonne cambiate, tabella, transazione, ruolo, utente, origine.
--    Trigger AFTER UPDATE a livello di ISTRUZIONE con le due tabelle di transizione:
--    un UPDATE da mille righe è un solo INSERT. Una riga che l'UPDATE non ha cambiato
--    davvero (stessi valori, o solo `updated_at`) non si scrive. Solo in aggiunta.
--  · Le tabelle: voti (`valutazioni`, `valutazione_obiettivi`), presenze
--    (`presenze`, `giustifiche_didattiche`), pagamenti (`pagamenti`,
--    `pagamenti_quote`, `incassi`) e scrutini (`scrutini`, `scrutinio_giudizi`,
--    `scrutinio_comportamento`, `scrutinio_giudizio_descrittivo`, `pagelle`,
--    `scrutinio_periodi`). Hanno tutte `id` uuid come chiave.
--  · Scadenza: 90 giorni, nello stesso job notturno delle eliminazioni
--    (`scatola-nera-scadenza`, 05:43 UTC), che ora conta anche queste.
--  · Oblio: `public.scatola_nera_dimentica` toglie ANCHE da qui le righe che nominano
--    la persona. L'oblio la chiama per ultima (`src/lib/gdpr/scatola-nera.ts`), dopo
--    le proprie bonifiche: le versioni «prima» che quelle bonifiche hanno appena
--    prodotto se ne vanno con lei.
--  · Ripristino: `scatola_nera.ripristina_modifiche(ids)` e
--    `ripristina_modifiche_transazione(txid)`, solo per il proprietario (runbook,
--    scenario A0-bis). Il ripristino è a sua volta un UPDATE, e quindi lascia la sua
--    traccia: si può disfare.
--
-- ─── COSA RESTA FUORI, E PERCHÉ ──────────────────────────────────────────────
-- La RETENTION non lascia copie: il lavoro notturno che fa scadere motivo e note
-- delle assenze (`presenze_giustificazioni_retention_tick`) esiste per far sparire
-- un testo che può parlare di salute, e una copia di 90 giorni allungherebbe la
-- conservazione dichiarata nell'informativa. Il job ora chiama un involucro che
-- accende `scatola_nera.senza_storico` nella sua transazione. Lo stesso interruttore
-- serve a una migrazione futura che riscrive in blocco una colonna e lo dichiara.
--
-- ─── FAIL-CLOSED ─────────────────────────────────────────────────────────────
-- Come per le eliminazioni: se la copia non si scrivesse, fallirebbe l'UPDATE. Un
-- voto sovrascritto senza la sua versione precedente è ciò che questa migrazione
-- esiste per impedire. L'INSERT non ha vincoli che una riga possa violare.
--
-- ─── VOLUME (misurato il 19/10, `pg_stat_user_tables`, dall'avvio dell'istanza) ──
-- UPDATE: pagamenti 11.376, presenze 3.717, valutazioni 437, incassi 55, scrutini 0.
-- Sono poche migliaia di righe al mese: con la scadenza a 90 giorni la tabella resta
-- di qualche MB.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger where tgname = 'scatola_nera_modifiche';            -- 13
--   select has_table_privilege('authenticated', 'scatola_nera.modifiche', 'SELECT');   -- false
--   select command from cron.job where jobname = 'presenze-giustificazioni-retention'; -- l'involucro
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     for t in select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
--               where g.tgname = 'scatola_nera_modifiche' loop
--       execute format('drop trigger if exists scatola_nera_modifiche on public.%I', t);
--     end loop; end $$;
--   select cron.alter_job(jobid, command := 'SELECT public.presenze_giustificazioni_retention_tick();')
--     from cron.job where jobname = 'presenze-giustificazioni-retention';
--   -- scadenza e dimentica funzionano anche con la tabella vuota; le righe si tengono
--   -- finché non scadono: sono la copia.
-- =============================================================================

CREATE TABLE IF NOT EXISTS scatola_nera.modifiche (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  modificata_il  timestamptz NOT NULL DEFAULT clock_timestamp(),
  transazione    bigint      NOT NULL DEFAULT txid_current(),
  tabella        text        NOT NULL,
  -- L'`id` della riga, come testo: la chiave con cui il ripristino la ritrova.
  riga_id        text        NOT NULL,
  -- La riga COM'ERA prima dell'UPDATE. La versione dopo sta nella tabella viva, o
  -- nella `prima` della modifica successiva.
  prima          jsonb       NOT NULL,
  cambiate       text[]      NOT NULL,
  soggetti       uuid[]      NOT NULL DEFAULT '{}',
  ruolo          text        NOT NULL,
  utente         uuid,
  origine        text
);
ALTER TABLE scatola_nera.modifiche ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS modifiche_soggetti_idx ON scatola_nera.modifiche USING gin (soggetti);
CREATE INDEX IF NOT EXISTS modifiche_modificata_il_idx ON scatola_nera.modifiche (modificata_il);
CREATE INDEX IF NOT EXISTS modifiche_transazione_idx ON scatola_nera.modifiche (transazione);
CREATE INDEX IF NOT EXISTS modifiche_riga_idx ON scatola_nera.modifiche (tabella, riga_id);

COMMENT ON TABLE scatola_nera.modifiche IS
  'Scatola nera (fase 12, storico UPDATE): la versione precedente di ogni riga sovrascritta di voti, presenze, pagamenti, incassi e scrutini, come JSON, per 90 giorni. Solo in aggiunta. Contiene dati personali: schema non esposto. Oblio: public.scatola_nera_dimentica. Ripristino: scatola_nera.ripristina_modifiche (runbook, A0-bis).';

-- Solo in aggiunta: la stessa guardia delle eliminazioni (DELETE solo in manutenzione).
DROP TRIGGER IF EXISTS solo_aggiunta ON scatola_nera.modifiche;
CREATE TRIGGER solo_aggiunta BEFORE UPDATE OR DELETE ON scatola_nera.modifiche
  FOR EACH ROW EXECUTE FUNCTION scatola_nera.vieta_modifiche();
DROP TRIGGER IF EXISTS solo_aggiunta_truncate ON scatola_nera.modifiche;
CREATE TRIGGER solo_aggiunta_truncate BEFORE TRUNCATE ON scatola_nera.modifiche
  FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_modifiche();

-- ── Il trigger ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER per la stessa ragione di `scatola_nera.registra()`: chi aggiorna
-- non ha permessi sullo schema e non deve averne.
CREATE OR REPLACE FUNCTION scatola_nera.registra_modifica()
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
  IF current_setting('scatola_nera.senza_storico', true) = 'on' THEN
    RETURN NULL; -- retention, o una riscrittura in blocco dichiarata: nessuna copia, di proposito
  END IF;
  BEGIN
    v_utente := NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_utente := NULL; -- claims assenti o non JSON (pg_cron, pannello): nessun utente, non un errore
  END;
  v_origine := left(COALESCE(NULLIF(current_setting('request.path', true), ''),
                             NULLIF(current_setting('application_name', true), ''),
                             'sconosciuta'), 200);

  INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, soggetti, ruolo, utente, origine)
  SELECT TG_TABLE_NAME, o.r ->> 'id', o.r, d.cambiate, scatola_nera.soggetti_di(o.r), v_ruolo, v_utente, v_origine
    FROM (SELECT to_jsonb(v) AS r FROM vecchie v) o
    JOIN (SELECT to_jsonb(n) AS r FROM nuove n) nn ON nn.r -> 'id' = o.r -> 'id'
    CROSS JOIN LATERAL (
      SELECT array_agg(k ORDER BY k) AS cambiate
        FROM jsonb_object_keys(o.r || nn.r) AS k
       WHERE (o.r -> k) IS DISTINCT FROM (nn.r -> k)
    ) d
   WHERE d.cambiate IS NOT NULL
     AND NOT (d.cambiate <@ ARRAY['updated_at', 'aggiornato_il']::text[]);
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- tabelle-storico:inizio
    'valutazioni', 'valutazione_obiettivi',
    'presenze', 'giustifiche_didattiche',
    'pagamenti', 'pagamenti_quote', 'incassi',
    'scrutini', 'scrutinio_giudizi', 'scrutinio_comportamento', 'scrutinio_giudizio_descrittivo',
    'pagelle', 'scrutinio_periodi'
    -- tabelle-storico:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera, storico: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_modifiche ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_modifiche AFTER UPDATE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie NEW TABLE AS nuove '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra_modifica()', t);
  END LOOP;
END $$;

-- ── La retention non lascia copie ─────────────────────────────────────────────
-- L'interruttore si accende per la sola durata della funzione chiamata e si rispegne
-- subito dopo: `set_config(…, true)` vale fino alla fine della TRANSAZIONE, e chi
-- chiamasse questo involucro dentro una transazione più lunga non deve perdere lo
-- storico di tutto quello che fa dopo. Il battito lo scrive la funzione vera, come prima.
CREATE OR REPLACE FUNCTION scatola_nera.retention_presenze_senza_storico()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config('scatola_nera.senza_storico', 'on', true);
  PERFORM public.presenze_giustificazioni_retention_tick();
  PERFORM set_config('scatola_nera.senza_storico', 'off', true);
END $$;

-- Il job esiste già (installato e sorvegliato da `JOB_CRON`): se ne cambia solo il COMANDO,
-- con `alter_job`, senza reinstallarlo. Stesso nome, stesso orario, stesso battito; dove il
-- job non c'è (il database della CI, senza pg_cron) non succede niente.
DO $$
BEGIN
  PERFORM cron.alter_job(jobid, command := $cron$ SELECT scatola_nera.retention_presenze_senza_storico(); $cron$)
     FROM cron.job WHERE jobname = 'presenze-giustificazioni-retention';
  IF NOT FOUND THEN
    RAISE NOTICE 'scatola nera, storico: job presenze-giustificazioni-retention assente, comando non cambiato';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'scatola nera, storico: pg_cron assente, comando della retention non cambiato';
END $$;

-- ── Scadenza: anche le modifiche, nello stesso giro ───────────────────────────
CREATE OR REPLACE FUNCTION scatola_nera.scadenza()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_righe     int := 0;
  v_modifiche int := 0;
  v_oblii     int := 0;
BEGIN
  PERFORM set_config('scatola_nera.manutenzione', 'on', true);
  DELETE FROM scatola_nera.eliminazioni WHERE eliminata_il < now() - interval '90 days';
  GET DIAGNOSTICS v_righe = ROW_COUNT;
  DELETE FROM scatola_nera.modifiche WHERE modificata_il < now() - interval '90 days';
  GET DIAGNOSTICS v_modifiche = ROW_COUNT;
  DELETE FROM scatola_nera.oblii WHERE eseguito_il < now() - interval '400 days';
  GET DIAGNOSTICS v_oblii = ROW_COUNT;
  PERFORM set_config('scatola_nera.manutenzione', 'off', true);

  -- IL BATTITO, nella forma che il sorvegliante (`controlloBattitoCron`) sa leggere,
  -- anche quando non scade niente. Solo conteggi.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server', 'scatola nera: scadenza 90 giorni',
    'cron:scatola-nera-scadenza',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione',            'scatola-nera-scadenza',
        'esito',                 'ok',
        'azione',                'scadenza-scatola-nera',
        'n_righe',               v_righe,
        'n_modifiche',           v_modifiche,
        'n_oblii',               v_oblii,
        'n_presenti',            (SELECT count(*) FROM scatola_nera.eliminazioni),
        'n_modifiche_presenti',  (SELECT count(*) FROM scatola_nera.modifiche)
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe + v_modifiche;
END $$;

-- ── Oblio: anche le versioni sovrascritte ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scatola_nera_dimentica(p_soggetti uuid[], p_tipo text, p_canale text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_righe     int := 0;
  v_modifiche int := 0;
  v_s         uuid;
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
  DELETE FROM scatola_nera.modifiche WHERE soggetti && p_soggetti;
  GET DIAGNOSTICS v_modifiche = ROW_COUNT;
  PERFORM set_config('scatola_nera.manutenzione', 'off', true);

  FOREACH v_s IN ARRAY p_soggetti LOOP
    IF v_s IS NOT NULL THEN
      INSERT INTO scatola_nera.oblii (soggetto, tipo, canale, righe_dimenticate)
      VALUES (v_s, p_tipo, left(p_canale, 200), v_righe + v_modifiche);
    END IF;
  END LOOP;
  RETURN v_righe + v_modifiche;
END $$;

-- ── Ripristino (runbook, mai l'app) ───────────────────────────────────────────
-- Riporta ogni riga alla versione salvata, con le sole colonne che la versione nomina
-- e che la tabella ha ancora (niente colonne generate, niente identità ALWAYS, niente
-- `id`). Più versioni della stessa riga: si applicano dalla più recente alla più
-- vecchia, quindi vince la più vecchia dell'elenco — «com'era prima di tutto questo».
-- Una riga che non c'è più va prima rimessa da `scatola_nera.ripristina` (eliminazioni).
CREATE OR REPLACE FUNCTION scatola_nera.ripristina_modifiche(p_ids bigint[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r         record;
  v_colonne text;
  v_n       int;
  v_ok      int := 0;
  v_assenti bigint[] := '{}';
  v_fallite jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT m.* FROM scatola_nera.modifiche m
     WHERE m.id = ANY (COALESCE(p_ids, '{}'))
     ORDER BY m.id DESC
  LOOP
    IF to_regclass(format('public.%I', r.tabella)) IS NULL THEN
      v_fallite := v_fallite || jsonb_build_object('id', r.id, 'codice', 'tabella_assente');
      CONTINUE;
    END IF;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
      INTO v_colonne
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', r.tabella)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attgenerated = ''
       AND a.attidentity <> 'a'
       AND a.attname <> 'id'
       AND r.prima ? a.attname;
    BEGIN
      EXECUTE format(
        'UPDATE public.%I AS t SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1)) '
        'WHERE t.id = (jsonb_populate_record(NULL::public.%I, $1)).id',
        r.tabella, v_colonne, v_colonne, r.tabella, r.tabella)
      USING r.prima;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        v_assenti := v_assenti || r.id;
      ELSE
        v_ok := v_ok + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fallite := v_fallite || jsonb_build_object('id', r.id, 'codice', SQLSTATE);
    END;
  END LOOP;
  RETURN jsonb_build_object('ripristinate', v_ok, 'righe_assenti', to_jsonb(v_assenti), 'fallite', v_fallite);
END $$;

CREATE OR REPLACE FUNCTION scatola_nera.ripristina_modifiche_transazione(p_transazione bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT scatola_nera.ripristina_modifiche(COALESCE(array_agg(id ORDER BY id), '{}'))
    FROM scatola_nera.modifiche
   WHERE transazione = p_transazione
$$;

-- ── Permessi: niente di tutto questo è dell'app, tranne l'oblio ───────────────
REVOKE ALL ON TABLE scatola_nera.modifiche FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.registra_modifica() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.retention_presenze_senza_storico() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.scadenza() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.ripristina_modifiche(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION scatola_nera.ripristina_modifiche_transazione(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) TO service_role;

COMMENT ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) IS
  'Oblio nella scatola nera: toglie da scatola_nera.eliminazioni e da scatola_nera.modifiche le righe che nominano uno di questi uuid (in id o in una colonna *_id) e scrive un oblio per uuid in scatola_nera.oblii (mai dati). Restituisce le righe tolte. Solo service_role.';

NOTIFY pgrst, 'reload schema';
