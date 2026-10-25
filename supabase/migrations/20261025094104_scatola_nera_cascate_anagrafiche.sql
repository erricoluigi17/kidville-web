-- =============================================================================
-- SCATOLA NERA SU CASCATE E ANAGRAFICHE — robustezza, seconda serie, sessione 3
--
-- Problema D4 del rapporto del 20/10 (`docs/analisi-robustezza-2026-10-20.md:486-515`):
-- cancellare un utente, un alunno o un avviso porta via in CASCADE tabelle che la scatola
-- nera della fase 4 non vede, e lo storico delle modifiche della fase 12 non copre le
-- anagrafiche. D7, in parte: la modifica di una nota cancella le prese visione dei genitori
-- (`nota_ricezioni`), fuori dalla scatola.
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `scatola_nera.registra()` rispetta `scatola_nera.senza_storico`, come fa già
--    `registra_modifica()`: una pulizia in blocco DICHIARATA non lascia copie.
--  · Dieci figlie in cascata entrano nella scatola delle eliminazioni, con lo stesso
--    trigger e lo stesso divieto di TRUNCATE della fase 4: chat_messages, chat_threads,
--    conversazioni_sospensioni, avvisi, avvisi_risposte, nota_ricezioni,
--    alunni_classi_storico, storici_collegamenti, storici_revisioni,
--    fascicolo_accessi_audit. `conversazioni_sospensioni` (figlia in CASCADE di
--    chat_threads, che gli elenchi del piano non nominavano: l'ha trovata la misura del
--    Passo 0, 25/10) è la prova che una conversazione è stata moderata, che la policy UGC
--    chiede di conservare (`src/lib/alunni/libera-spazio.ts`): entra per decisione
--    dell'assistente in assenza del titolare (25/10), da confermare. Chi sospende e chi è
--    sospeso stanno in `sospesa_da` e `sospesa_verso`, che `soggetti_di` non legge (non
--    finiscono in `_id`): la copia nomina la persona solo per `thread_id`.
--  · Lo storico delle modifiche si allarga ad alunni, parents, utenti,
--    note_disciplinari, certificati_medici. Un UPDATE che cambia SOLO `storico_versione`
--    non si copia, come già `updated_at`: è il «tocco» con cui storici_versione_aggregato
--    segna la nota quando un genitore firma la presa visione, e copierebbe ogni volta il
--    testo intero della nota. Su un database senza `scatola_nera.modifiche` (fase 4 senza
--    fase 12: la CI non migrata può esserlo) questi trigger non si accendono, perché lì
--    farebbero fallire ogni UPDATE delle anagrafiche, e l'oblio salta le sue DELETE sulle
--    modifiche, perché lì farebbe fallire ogni oblio (42P01).
--  · Le due bonifiche che cancellano copie storiche PER PROTEGGERE un dato
--    (`storici_bonifica_chat`, `storici_oblio_alunno`) accendono l'interruttore per le sole
--    proprie DELETE e lo rimettono com'era: una copia di 90 giorni disferebbe la bonifica.
--  · L'oblio (`public.scatola_nera_dimentica`) toglie anche ciò che nomina la persona solo
--    attraverso una conversazione: i messaggi delle sue conversazioni (che la nominano per
--    `thread_id`), le revisioni di quei messaggi (per `entita_id`) e le sospensioni di quelle
--    conversazioni, con le conversazioni cancellate (in scatola) o ancora vive; e le
--    sospensioni che la nominano in `sospesa_da`, `sospesa_verso` o `riaperta_da`.
--    `soggetti_di` legge solo `id` e `*_id`, di primo livello.
--  · L'oblio toglie anche le copie di un alunno (cancellato o com'era prima di un UPDATE)
--    che nominano la persona come adulto dentro un JSON: `intestatario_fatture.adult_id` e
--    `retta_split_config.quote[].adult_id` (un parents.id, accanto al nome). Se la segreteria
--    cambia l'intestatario da A a B, la riga viva nomina B e la copia è l'unico posto dove
--    restano i dati di A (revisione indipendente del 25/10). Un adulto SENZA uuid
--    (`invoice_holder_details`, l'intestatario di tipo «altro») resta: limite dichiarato nel
--    runbook, scenario A0-bis.
--  · Anonimizzare un'anagrafica è un UPDATE: lascia in `scatola_nera.modifiche` la riga
--    com'era, dati personali compresi, finché l'oblio dell'app non chiama
--    `scatola_nera_dimentica`, che la toglie perché nomina l'`id`. Per questo l'app la
--    chiama PER ULTIMA (`src/lib/gdpr/esegui.ts`).
--
-- ─── COSA RESTA FUORI, E PERCHÉ ──────────────────────────────────────────────
--  · notifiche, push_subscriptions: effimere (campanella, iscrizioni ai push), con la
--    propria conservazione già dichiarata;
--  · anagrafica_personale, galleria_media_v2, candidature_insegnanti: una retention le
--    svuota per legge, come deciso in fase 4;
--  · utenti_scuole, utenti_sezioni, utenti_sezioni_materie: configurazione d'accesso, si
--    rifà dalla segreteria;
--  · mensa_prenotazioni, mensa_alternative, divise_ordini, armadietto_richieste,
--    task_interni: operative; il valore contabile sta in tabelle già coperte;
--  · storici_generazioni: lavori di stampa che scadono da soli;
--  · registro_destinatari: figlia di alunni non elencata nella specifica (§7); la misura
--    del Passo 0 (0,09 MB in 90 giorni) è nel PRD. Resta fuori come dice il piano finché
--    il titolare non chiede che entri: decisione dell'assistente in assenza del titolare
--    (25/10), da confermare;
--  · il registro di protocollo ha la sua migrazione (`*_scatola_nera_protocollo.sql`).
--
-- ─── CORPI DI PARTENZA ───────────────────────────────────────────────────────
-- Le cinque funzioni ridefinite partono da `pg_get_functiondef` letta in produzione il
-- giorno di questa migrazione (Passo 0 del piano
-- `docs/superpowers/plans/2026-10-20-robustezza2-s03-scatola-nera-cascate.md`), uguale ai
-- file 20261009171012, 20261019215733, 20261015183000, 20261019223123. Cambia solo ciò che
-- è scritto sopra.
--
-- ─── PREREQUISITO: LA FASE 4 ─────────────────────────────────────────────────
-- Serve la scatola delle eliminazioni (20261009171012_scatola_nera_registro_eliminazioni.sql):
-- lo schema `scatola_nera` con `eliminazioni`, `oblii`, `soggetti_di(jsonb)` e `vieta_truncate()`.
-- Su un database che non ce l'ha (la CI si migra a mano, un file alla volta) questa migrazione
-- si FERMA al primo `CREATE FUNCTION scatola_nera.registra()` con 3F000 («schema does not
-- exist»); applicata come fa `migrate-ci.yml` (`psql --single-transaction`, ON_ERROR_STOP) non
-- lascia niente a metà, e i file dopo non si toccano. Si applica prima 20261009171012.
-- Non la tollera come fa `*_scatola_nera_protocollo.sql` perché qui si ridefiniscono funzioni
-- DENTRO lo schema: per saltarle servirebbero `DO` + `EXECUTE` del loro corpo, e il corpo di
-- `scatola_nera_dimentica` contiene DELETE che il lock `migrazioni-distruttive-approvate`
-- conterebbe come eseguite alla migrazione. La fase 12 (`scatola_nera.modifiche`) invece NON
-- serve: senza, i suoi trigger non si accendono e l'oblio salta le modifiche.
--
-- ─── FAIL-CLOSED ─────────────────────────────────────────────────────────────
-- Invariato: se la copia non si scrive, fallisce la DELETE o l'UPDATE.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger where tgname = 'scatola_nera_eliminazioni';   -- 42 + 10 = 52
--   select count(*) from pg_trigger where tgname = 'scatola_nera_no_truncate';    -- 42 + 10 = 52
--   select count(*) from pg_trigger where tgname = 'scatola_nera_modifiche';      -- 13 + 5 = 18
--   select prosrc ~ 'senza_storico' from pg_proc
--    where oid = 'scatola_nera.registra()'::regprocedure;                            -- true
--   select prosrc ~ 'v_collegati' from pg_proc
--    where oid = 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure;    -- true
--   select prosrc ~ 'intestatario_fatture' and prosrc ~ 'to_regclass..scatola_nera.modifiche'
--     from pg_proc where oid = 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure; -- true
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     foreach t in array array['chat_messages','chat_threads','conversazioni_sospensioni',
--         'avvisi','avvisi_risposte','nota_ricezioni','alunni_classi_storico',
--         'storici_collegamenti','storici_revisioni','fascicolo_accessi_audit'] loop
--       execute format('drop trigger if exists scatola_nera_eliminazioni on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_no_truncate on public.%I', t);
--     end loop;
--     foreach t in array array['alunni','parents','utenti','note_disciplinari','certificati_medici'] loop
--       execute format('drop trigger if exists scatola_nera_modifiche on public.%I', t);
--     end loop; end $$;
--   Poi si riesegue SOLO IL CORPO di ciascuna funzione (il suo `CREATE OR REPLACE FUNCTION`
--   fino al `$$;`, più i suoi REVOKE/GRANT), MAI il file intero: i file contengono altro che
--   tornerebbe indietro (rieseguire per intero 20261009171012 riporterebbe anche
--   `scatola_nera.scadenza()` e `scatola_nera_dimentica` alla fase 4, che non conosce
--   `scatola_nera.modifiche`; gli altri ricreano trigger che esistono già e si fermano). I
--   corpi di partenza coincidono con quelli di produzione letti nel Passo 0, quindi il
--   ritorno funzione per funzione è esatto:
--     scatola_nera.registra()            20261009171012_scatola_nera_registro_eliminazioni.sql:160-184 (REVOKE :397)
--     scatola_nera.registra_modifica()   20261019215733_scatola_nera_modifiche.sql:107-142 (REVOKE :353)
--     public.scatola_nera_dimentica      20261019215733_scatola_nera_modifiche.sql:248-280 (REVOKE/GRANT :358-359, COMMENT :361-362)
--     public.storici_bonifica_chat       20261015183000_storici_stampe_rettifiche.sql:437-446 (REVOKE/GRANT :447-448)
--     public.storici_oblio_alunno        20261019223123_battiti_app_log_che_contano.sql:157-176 (REVOKE/GRANT :177-178)
--   (oppure i corpi di produzione salvati nel Passo 0). Le righe già copiate restano finché
--   non scadono: sono la copia.
-- =============================================================================

-- ── 1. L'interruttore anche sulle eliminazioni ────────────────────────────────
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
  IF current_setting('scatola_nera.senza_storico', true) = 'on' THEN
    RETURN NULL; -- una pulizia in blocco dichiarata (bonifica, oblio): nessuna copia, di proposito
  END IF;
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
REVOKE ALL ON FUNCTION scatola_nera.registra() FROM PUBLIC, anon, authenticated;

-- ── 2. Le figlie in cascata ───────────────────────────────────────────────────
-- Lo stesso ciclo della fase 4 (20261009171012_scatola_nera_registro_eliminazioni.sql:200-232),
-- sulle figlie che contano. Il motivo di chi resta fuori è nell'intestazione.
-- `conversazioni_sospensioni` è la decima: decisione dell'assistente in assenza del titolare
-- (25/10), da confermare.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- figlie-in-cascata:inizio
    'chat_messages', 'chat_threads', 'conversazioni_sospensioni',
    'avvisi', 'avvisi_risposte',
    'nota_ricezioni',
    'alunni_classi_storico',
    'storici_collegamenti', 'storici_revisioni',
    'fascicolo_accessi_audit'
    -- figlie-in-cascata:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera, cascate: public.% assente, saltata', t;
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

-- ── 3. Le anagrafiche nello storico delle modifiche ───────────────────────────
-- Corpo di 20261019215733_scatola_nera_modifiche.sql:107-142 con UNA sola differenza:
-- `storico_versione` entra fra le colonne che da sole non fanno una modifica.
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
     AND NOT (d.cambiate <@ ARRAY['storico_versione', 'updated_at', 'aggiornato_il']::text[]);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION scatola_nera.registra_modifica() FROM PUBLIC, anon, authenticated;

-- Un database con la fase 4 ma senza la fase 12 (quello della CI, che non è migrato, può
-- esserlo) non ha `scatola_nera.modifiche`: un trigger acceso lì farebbe fallire OGNI UPDATE
-- delle anagrafiche con 42P01. Lì non si accende niente, e lo si dice.
DO $$
DECLARE
  t text;
BEGIN
  IF to_regclass('scatola_nera.modifiche') IS NULL THEN
    RAISE NOTICE 'scatola nera, storico: scatola_nera.modifiche assente (fase 12 non applicata), anagrafiche saltate';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    -- anagrafiche-storico:inizio
    'alunni', 'parents', 'utenti',
    'note_disciplinari', 'certificati_medici'
    -- anagrafiche-storico:fine
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

-- ── 4. Le bonifiche accendono l'interruttore per le sole proprie DELETE ────────
-- Una bonifica cancella una copia storica APPOSTA (il testo di prima di un messaggio
-- corretto, le copie di un alunno anonimizzato): copiarla 90 giorni in scatola la
-- disferebbe. L'interruttore si accende per le due DELETE e torna com'era subito dopo:
-- chi è nella stessa transazione non perde lo storico di quello che fa dopo.

-- Corpo di 20261015183000_storici_stampe_rettifiche.sql:437-446, più l'interruttore.
create or replace function public.storici_bonifica_chat() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_prima text;
begin
  if new.content is distinct from old.content then
    new.rettifica_staff:=null; new.rettifica_staff_il:=null; new.rettifica_staff_da:=null;
    new.rettifica_versione:=old.rettifica_versione+1;
    v_prima := current_setting('scatola_nera.senza_storico', true);
    perform set_config('scatola_nera.senza_storico', 'on', true);
    delete from public.storici_revisioni where modulo='chat' and entita_id=new.id;
    perform set_config('scatola_nera.senza_storico', coalesce(v_prima, 'off'), true);
  end if;
  return new;
end $$;
revoke all on function public.storici_bonifica_chat() from public, anon, authenticated;
grant execute on function public.storici_bonifica_chat() to service_role;

-- Corpo di 20261019223123_battiti_app_log_che_contano.sql:157-176, più l'interruttore.
CREATE OR REPLACE FUNCTION public.storici_oblio_alunno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare v_prima text;
begin
  if new.anonimizzato_il is not null and old.anonimizzato_il is null then
    v_prima := current_setting('scatola_nera.senza_storico', true);
    perform set_config('scatola_nera.senza_storico', 'on', true);
    delete from public.storici_revisioni where alunno_id=new.id;
    delete from public.storici_collegamenti where alunno_id=new.id;
    perform set_config('scatola_nera.senza_storico', coalesce(v_prima, 'off'), true);
    update public.storici_generazioni set scade_il=least(scade_il,now()) where alunni_ids @> array[new.id];
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('info','gdpr','server','Copie storiche del minore invalidate','storici-oblio-alunno',jsonb_build_object('alunno_id',new.id))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise log 'storici: logging oblio non riuscito [%]',SQLSTATE; end;
  end if;
  return new;
end $$;
REVOKE ALL ON FUNCTION public.storici_oblio_alunno() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_oblio_alunno() TO service_role;

-- ── 5. L'oblio segue le conversazioni ─────────────────────────────────────────
-- Corpo di 20261019215733_scatola_nera_modifiche.sql:248-280, più la regola delle
-- conversazioni. Un messaggio nomina la persona solo per `thread_id`, e la revisione di
-- un messaggio solo per `entita_id`: `soggetti_di` (solo `id` e `*_id`) li vede come uuid
-- qualunque. Le conversazioni della persona si cercano sia fra le copie (cancellate) sia
-- fra le vive; la tabella viva si legge con EXECUTE dietro `to_regclass`.
-- La copia di una sospensione (la decima figlia) nomina la conversazione per `thread_id`
-- e le persone in `sospesa_da`, `sospesa_verso` e `riaperta_da` (la Direzione che riapre
-- non è nella conversazione), che `soggetti_di` non legge; il suo `motivo` è testo libero.
-- Le stesse colonne che l'oblio dell'app bonifica sulla riga viva (`src/lib/gdpr/esegui.ts`).
-- La copia di un alunno (cancellato, o com'era prima di un UPDATE) contiene l'adulto che
-- intesta le fatture (`intestatario_fatture.adult_id`, con il nome) e gli adulti di una retta
-- divisa (`retta_split_config.quote[].adult_id`, con il nome): un genitore che `soggetti_di`
-- non vede, perché sta dentro un JSON. Si toglie anche quella: se la segreteria cambia
-- l'intestatario da A a B, la riga viva nomina B e la copia è l'unico posto dove resta A
-- (revisione indipendente del 25/10). Un adulto senza uuid (`invoice_holder_details`,
-- l'intestatario di tipo «altro» con i suoi `dati`) non si può cercare per uuid: limite
-- dichiarato nel runbook (scenario A0-bis), come per la riga viva, che l'oblio dell'app non
-- pulisce già oggi.
-- Senza `scatola_nera.modifiche` (fase 4 senza fase 12) le DELETE sulle modifiche si saltano.
CREATE OR REPLACE FUNCTION public.scatola_nera_dimentica(p_soggetti uuid[], p_tipo text, p_canale text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_righe     int := 0;
  v_modifiche int := 0;
  v_thread    uuid[] := '{}';
  v_messaggi  uuid[] := '{}';
  v_vivi      uuid[] := '{}';
  v_collegati uuid[] := '{}';
  v_s         uuid;
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('alunno', 'genitore', 'personale', 'altro') THEN
    RAISE EXCEPTION 'scatola_nera_dimentica: tipo % non ammesso', p_tipo USING ERRCODE = '22023';
  END IF;
  IF p_soggetti IS NULL OR cardinality(p_soggetti) = 0 THEN
    RETURN 0;
  END IF;

  -- Le conversazioni che nominano la persona: le copie e le vive.
  SELECT COALESCE(array_agg(DISTINCT (e.riga ->> 'id')::uuid), '{}')
    INTO v_thread
    FROM scatola_nera.eliminazioni e
   WHERE e.tabella = 'chat_threads' AND e.soggetti && p_soggetti;
  IF to_regclass('public.chat_threads') IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(array_agg(t.id), ''{}''::uuid[]) FROM public.chat_threads t '
            'WHERE t.parent_id = ANY ($1) OR t.student_id = ANY ($1) OR t.teacher_id = ANY ($1)'
       INTO v_vivi USING p_soggetti;
    v_thread := v_thread || v_vivi;
  END IF;

  -- I messaggi di quelle conversazioni: le loro revisioni li nominano in `entita_id`.
  SELECT COALESCE(array_agg(DISTINCT (e.riga ->> 'id')::uuid), '{}')
    INTO v_messaggi
    FROM scatola_nera.eliminazioni e
   WHERE e.tabella = 'chat_messages' AND e.soggetti && v_thread;
  IF to_regclass('public.chat_messages') IS NOT NULL AND cardinality(v_thread) > 0 THEN
    EXECUTE 'SELECT COALESCE(array_agg(m.id), ''{}''::uuid[]) FROM public.chat_messages m '
            'WHERE m.thread_id = ANY ($1)'
       INTO v_vivi USING v_thread;
    v_messaggi := v_messaggi || v_vivi;
  END IF;
  v_collegati := v_thread || v_messaggi;

  PERFORM set_config('scatola_nera.manutenzione', 'on', true);
  -- Le persone di una sospensione e gli adulti di un alunno si confrontano come TESTO: nessun
  -- cast che possa fallire su una riga di un'altra tabella, e un `riaperta_da` o un `adult_id`
  -- NULL (o assente, o in un JSON di forma storta) non è uguale a niente.
  DELETE FROM scatola_nera.eliminazioni
   WHERE soggetti && p_soggetti
      OR (tabella IN ('chat_messages', 'storici_revisioni', 'conversazioni_sospensioni')
          AND soggetti && v_collegati)
      OR (tabella = 'conversazioni_sospensioni'
          AND ARRAY[riga ->> 'sospesa_da', riga ->> 'sospesa_verso', riga ->> 'riaperta_da']
              && p_soggetti::text[])
      OR (tabella = 'alunni'
          AND (ARRAY[riga -> 'intestatario_fatture' ->> 'adult_id'] && p_soggetti::text[]
               OR jsonb_path_query_array(riga, 'lax $.retta_split_config.quote[*].adult_id')
                  ?| p_soggetti::text[]));
  GET DIAGNOSTICS v_righe = ROW_COUNT;
  -- Senza la fase 12 (la CI non migrata può esserne priva) `scatola_nera.modifiche` non c'è:
  -- l'oblio toglie le sole eliminazioni invece di fallire con 42P01. Il ramo non eseguito non
  -- viene nemmeno preparato, quindi la tabella assente non dà errore.
  IF to_regclass('scatola_nera.modifiche') IS NOT NULL THEN
    -- La copia di un UPDATE su `alunni` è la riga com'era (`prima`; la versione dopo sta nella
    -- riga viva o nella `prima` della copia successiva): l'adulto che intestava le fatture, o
    -- una quota della retta, la nomina solo dentro il JSON, per `adult_id` (un parents.id).
    DELETE FROM scatola_nera.modifiche
     WHERE soggetti && p_soggetti
        OR (tabella = 'alunni'
            AND (ARRAY[prima -> 'intestatario_fatture' ->> 'adult_id'] && p_soggetti::text[]
                 OR jsonb_path_query_array(prima, 'lax $.retta_split_config.quote[*].adult_id')
                    ?| p_soggetti::text[]));
    GET DIAGNOSTICS v_modifiche = ROW_COUNT;
  END IF;
  PERFORM set_config('scatola_nera.manutenzione', 'off', true);

  FOREACH v_s IN ARRAY p_soggetti LOOP
    IF v_s IS NOT NULL THEN
      INSERT INTO scatola_nera.oblii (soggetto, tipo, canale, righe_dimenticate)
      VALUES (v_s, p_tipo, left(p_canale, 200), v_righe + v_modifiche);
    END IF;
  END LOOP;
  RETURN v_righe + v_modifiche;
END $$;
REVOKE ALL ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) TO service_role;

COMMENT ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) IS
  'Oblio nella scatola nera: toglie da scatola_nera.eliminazioni e da scatola_nera.modifiche le righe che nominano uno di questi uuid (in id o in una colonna *_id), più i messaggi, le revisioni di messaggi e le sospensioni delle conversazioni che lo nominano, le sospensioni che lo nominano in sospesa_da, sospesa_verso o riaperta_da, e le copie di alunni che lo nominano come adulto in intestatario_fatture.adult_id o in retta_split_config.quote[].adult_id; senza scatola_nera.modifiche (fase 12 assente) toglie le sole eliminazioni. Scrive un oblio per uuid in scatola_nera.oblii (mai dati). Restituisce le righe tolte. Un adulto senza uuid (invoice_holder_details, intestatario di tipo altro) non si raggiunge: runbook, scenario A0-bis. Solo service_role.';

NOTIFY pgrst, 'reload schema';
