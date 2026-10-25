-- Sessione 8 della seconda serie di robustezza — igiene: app_log (T7), storico dei job, timeout dei ruoli.
--
-- PERCHÉ (D11 e S12 del rapporto del 20/10). `cron.job_run_details` non ha un tetto (93.577 righe il
-- 20/10, e cresce di una riga per job a ogni giro); `idle_in_transaction_session_timeout` vale 0;
-- `app_log` cancella gli errori dopo 30 giorni, e un guasto che torna dopo un mese non si riconosce.
--
-- COSA CAMBIA.
--   1. `app_log_purge`: le righe `error` restano 90 giorni (decisione T7 del titolare, 20/10); `info`
--      e `warn` 30, come prima. Corpo di partenza: `pg_get_functiondef` in produzione, uguale a
--      `20260713090000_app_log.sql:226-248` (Passo 0). Battito `cron:app-log-purge` nella forma che
--      `controlloBattitoCron` legge. Il job `app-log-purge` (03:30 UTC) non cambia.
--   2. `cron_storico_purge` + job `cron-storico-purge` (03:41 UTC, lontano dal backup delle 02:23 e
--      dalla purge delle 03:30): `cron.job_run_details` tiene 14 giorni, ma solo per i job il cui
--      ultimo giro è già in `cron_ultimo_esito` (sessione 6) con `ultimo_runid` valorizzato, e per i
--      job che non esistono più. Il lettore `cron_esiti()` valorizza `ultimo_runid` solo dentro la
--      sua finestra di 5000 esecuzioni: un mensile ha la riga ma `ultimo_runid` nullo finché non
--      rigira, e resta trattenuto. La chiave è quella della sessione 6 (`coalesce(jobname,
--      'jobid-' || jobid)`): un job senza nome non resta trattenuto per sempre. Senza
--      `cron_ultimo_esito` non cancella niente e scrive un `error`. Battito `cron:cron-storico-purge`.
--      Se `cron.schedule` fallisce (con pg_cron presente), una riga `error`
--      `migrazione:cron-storico-purge-non-programmato` in `app_log`, e la migrazione prosegue.
--   3. `idle_in_transaction_session_timeout = 60s` sui tre ruoli dell'API (`service_role`,
--      `authenticated`, `anon`), fra i marcatori `timeout-ruoli`. Non ALTER DATABASE (su questo
--      progetto dà 42501); non `postgres`; non il ruolo del backup, che ha i suoi 30 minuti
--      (20261005212210_ruolo_backup_lettura.sql:39-40). Se il ruolo che applica la migrazione non
--      può, una riga `error` per ruolo in `app_log` e la migrazione prosegue. PostgREST applica le
--      impostazioni del ruolo impersonato dentro ogni transazione: da qui il `reload config`.
--
-- DB DELLA CI: niente pg_cron (`cron.schedule` assente: il blocco del job lo salta e lo dice con un
-- NOTICE, senza righe in app_log); `cron_ultimo_esito`
-- forse assente (la funzione lo dice e non cancella); l'ALTER ROLE ha la sua guardia.
--
-- COME SI VERIFICA
--   SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('service_role','authenticated','anon');
--     (`SHOW` come service_role non serve: i tre ruoli sono NOLOGIN, l'impostazione vive in rolconfig)
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('app-log-purge','cron-storico-purge');
--   SELECT fingerprint, livello, contesto->'campi' FROM public.app_log
--    WHERE fingerprint IN ('cron:app-log-purge','cron:cron-storico-purge')
--       OR fingerprint LIKE 'migrazione:idle-timeout-non-applicato:%'
--       OR fingerprint = 'migrazione:cron-storico-purge-non-programmato';
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   ALTER ROLE service_role RESET idle_in_transaction_session_timeout; (e authenticated, anon)
--   NOTIFY pgrst, 'reload config';
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-storico-purge';
--   app_log_purge: la definizione di 20260713090000_app_log.sql:226-251 (30 giorni per tutti).

-- ── 1. app_log_purge (T7) ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.app_log_purge()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lotto  int;
  v_altri  int := 0;
  v_errori int := 0;
BEGIN
  -- info e warn: 30 giorni, come dal 2026-07-13.
  LOOP
    DELETE FROM public.app_log
     WHERE id IN (
       SELECT id FROM public.app_log
        WHERE livello <> 'error' AND creato_il < now() - interval '30 days'
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_altri := v_altri + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;
  -- error: 90 giorni (T7). Un guasto che torna dopo un mese si riconosce solo se la prima volta c'è ancora.
  LOOP
    DELETE FROM public.app_log
     WHERE id IN (
       SELECT id FROM public.app_log
        WHERE livello = 'error' AND creato_il < now() - interval '90 days'
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_errori := v_errori + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'app_log: pulizia notturna completata', 'cron:app-log-purge',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'app-log-purge', 'esito', 'ok',
              'n_righe', v_altri + v_errori, 'n_errori', v_errori)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'app_log_purge: battito non scritto [%]', SQLSTATE;
  END;
  RETURN v_altri + v_errori;
END $$;
REVOKE ALL ON FUNCTION public.app_log_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_purge() TO service_role;

-- ── 2. cron_storico_purge + job ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cron_storico_purge()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lotto      int;
  v_totale     int := 0;
  v_trattenuti int := 0;
BEGIN
  -- Senza `cron_ultimo_esito` (sessione 6) la pulizia toglierebbe l'unica traccia dell'ultimo giro dei
  -- job mensili: non si cancella niente, e lo si dice.
  IF to_regclass('public.cron_ultimo_esito') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      VALUES ('error', 'cron', 'server', 'cron_storico_purge: tabelle mancanti, nessuna pulizia',
              'cron:cron-storico-purge:tabelle-assenti',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'cron-storico-purge', 'esito', 'tabelle-assenti')))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'cron_storico_purge: log non scritto [%]', SQLSTATE;
    END;
    RETURN 0;
  END IF;

  -- Al sicuro = riga in `cron_ultimo_esito` CON `ultimo_runid`: la sola riga non basta, perché il
  -- lettore della sessione 6 la crea anche per un job che non ha ancora visto girare. La chiave è
  -- quella della sessione 6: un job senza nome si chiama 'jobid-<jobid>'.
  SELECT count(*) INTO v_trattenuti
    FROM cron.job j
   WHERE NOT EXISTS (SELECT 1 FROM public.cron_ultimo_esito e
                      WHERE e.job = coalesce(j.jobname::text, 'jobid-' || j.jobid::text)
                        AND e.ultimo_runid IS NOT NULL);

  LOOP
    DELETE FROM cron.job_run_details d
     WHERE d.runid IN (
       SELECT x.runid FROM cron.job_run_details x
        WHERE coalesce(x.end_time, x.start_time) < now() - interval '14 days'
          AND (NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobid = x.jobid)
               OR EXISTS (SELECT 1 FROM cron.job j
                            JOIN public.cron_ultimo_esito e ON e.job = coalesce(j.jobname::text, 'jobid-' || j.jobid::text)
                           WHERE j.jobid = x.jobid AND e.ultimo_runid IS NOT NULL))
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_totale := v_totale + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'cron_storico_purge: pulizia completata', 'cron:cron-storico-purge',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'cron-storico-purge', 'esito', 'ok',
              'n_righe', v_totale, 'n_job_trattenuti', v_trattenuti)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_storico_purge: battito non scritto [%]', SQLSTATE;
  END;
  RETURN v_totale;
END $$;
REVOKE ALL ON FUNCTION public.cron_storico_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_storico_purge() TO service_role;

-- inizio: programma-job
DO $$
BEGIN
  -- pg_cron c'è se c'è la funzione che si chiama; sul DB della CI no, e lì il job non serve.
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'cron-storico-purge: pg_cron assente, job non programmato';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-storico-purge';
  PERFORM cron.schedule('cron-storico-purge', '41 3 * * *', $cron$ SELECT public.cron_storico_purge(); $cron$);
EXCEPTION WHEN OTHERS THEN
  -- Con pg_cron presente, un job non programmato è un guasto: la pulizia non partirebbe mai e il
  -- battito `cron:cron-storico-purge` mancherebbe senza dire perché. Una riga error come quelle del
  -- timeout dei ruoli (sotto), solo codici; la migrazione prosegue.
  RAISE WARNING 'cron-storico-purge: job non programmato [%]', SQLSTATE;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('error', 'migrazione', 'server',
            'cron-storico-purge: job non programmato',
            'migrazione:cron-storico-purge-non-programmato',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'cron-storico-purge', 'esito', 'non-programmato', 'sqlstate', SQLSTATE)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron-storico-purge: job non programmato e non registrato [%]', SQLSTATE;
  END;
END $$;
-- fine: programma-job

-- ── 3. Timeout dei ruoli dell'API ────────────────────────────────────────────────────────────────
-- inizio: timeout-ruoli
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN CONTINUE; END IF;
    BEGIN
      EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
        VALUES ('error', 'migrazione', 'server',
                'idle_in_transaction_session_timeout non applicato a un ruolo dell''API',
                'migrazione:idle-timeout-non-applicato:' || r,
                jsonb_build_object('campi', jsonb_build_object(
                  'operazione', 'timeout-ruoli', 'esito', 'non-applicato', 'ruolo', r, 'sqlstate', SQLSTATE)))
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'timeout-ruoli: % non applicato e non registrato [%]', r, SQLSTATE;
      END;
    END;
  END LOOP;
END $$;
-- fine: timeout-ruoli

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
