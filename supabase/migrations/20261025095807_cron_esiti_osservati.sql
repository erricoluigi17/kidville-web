-- =============================================================================
-- Sessione 6 della seconda serie di robustezza — esiti dei cron: si osserva, non si cambia
-- Specifica: docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md, §7, Sessione 6.
--
-- PERCHÉ
-- Le funzioni dei job di pg_cron chiamano il server con net.http_post e buttano via il numero
-- della richiesta. La risposta arriva dopo in net._http_response, che la tiene circa 6 ore, e
-- nessuno sa più di quale job fosse: il 20/10 c'erano 27 chiamate senza risposta e nessun nome.
--
-- COSA FA
--  · cron_chiamate: una riga per chiamata — job, numero della richiesta, esito, codice HTTP.
--  · cron_ultimo_esito: una riga per job di cron.job, HTTP o solo SQL; non scade, quindi copre
--    anche i mensili.
--  · cron_http_post(job, url, body, params, headers, timeout_milliseconds): manda la richiesta
--    con net.http_post e gli stessi argomenti, POI ne registra il numero. Se la registrazione
--    fallisce la richiesta è già partita: lo dice app_log, e il job va avanti come prima.
--  · Le funzioni che chiamano il server, ridefinite dai corpi della PRODUZIONE
--    (pg_get_functiondef, misura 0.6 del piano) con una sola differenza: net.http_post( diventa
--    public.cron_http_post('<job>', . URL, header, corpi e timeout restano quelli di ciascuna.
--    Corpi trovati diversi dal repo, e qui riallineati alla produzione: nessuna.
--  · cron_esiti(), job cron-esiti ai minuti 4, 14, … 54: chiude le chiamate leggendo
--    net._http_response, aggiorna cron_ultimo_esito da cron.job e cron.job_run_details, e scrive
--    in app_log: error cron-http:<job> (4xx, 5xx, rete; un 3xx è ok), info cron-http-timeout:<job>
--    (timeout del client pg_net, che non ferma la route), error cron-sql:<job> (esecuzione
--    fallita, a partire dal secondo giro del lettore: al primo giro in assoluto, con
--    cron_ultimo_esito ancora vuota, i fallimenti sono storia di prima dell'installazione; dal
--    secondo vale anche per un job mai visto, come un mensile fuori dalle ultime 5000 esecuzioni),
--    warn cron-esiti:esiti-persi, error cron-esiti:fallito e il battito info cron:cron-esiti.
--    Mai il corpo di una risposta: solo il suo codice in maiuscolo.
--
-- Domande d'iscrizione contate prima della migrazione: 734 alle 2026-10-25 09:58:33 UTC.
--
-- ─── DB DELLA CI E PGLITE ───
-- pg_net e pg_cron possono mancare: il lettore li cerca con to_regclass e salta ciò che non c'è;
-- il job si installa solo se lo schema cron esiste. Nessuna riga di dati esistente viene toccata.
--
-- ─── IDEMPOTENTE ───
-- CREATE … IF NOT EXISTS, CREATE OR REPLACE; il job si toglie prima di rimetterlo.
--
-- ─── COME SI VERIFICA ───
--   SELECT count(*) FROM public.cron_ultimo_esito;                 -- una riga per job di cron.job
--   SELECT job, esito, count(*) FROM public.cron_chiamate GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT fingerprint, livello, occorrenze FROM public.app_log
--    WHERE fingerprint LIKE 'cron-http%' OR fingerprint LIKE 'cron-sql:%'
--       OR fingerprint LIKE 'cron-esiti:%' OR fingerprint = 'cron:cron-esiti'
--    ORDER BY visto_l_ultima DESC LIMIT 20;
--
-- ─── ROLLBACK ───
-- Fermata subito (la esegue il titolare dall'editor SQL):  SELECT cron.unschedule('cron-esiti');
-- Completo: una migrazione NUOVA, dentro una PR di revert, generata da
--   node scripts/cron-esiti/involucro.mjs inversa supabase/migrations/20261025095807_cron_esiti_osservati.sql
-- che rimette le definizioni di prima coi loro permessi e toglie job, funzioni e tabelle.
-- =============================================================================

-- == I DUE REGISTRI ==

CREATE TABLE IF NOT EXISTS public.cron_chiamate (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job           text NOT NULL,
  richiesta_id  bigint NOT NULL,
  percorso      text,
  timeout_ms    integer,
  inviata_il    timestamptz NOT NULL DEFAULT now(),
  esito         text NOT NULL DEFAULT 'in-attesa'
                CHECK (esito IN ('in-attesa', 'ok', 'errore-http', 'errore-rete', 'timeout', 'esito-ignoto')),
  codice_http   integer,
  codice_errore text,
  errore        text,
  verificata_il timestamptz
);

CREATE INDEX IF NOT EXISTS cron_chiamate_aperte_idx ON public.cron_chiamate (richiesta_id) WHERE verificata_il IS NULL;
CREATE INDEX IF NOT EXISTS cron_chiamate_job_idx ON public.cron_chiamate (job, inviata_il DESC);
CREATE INDEX IF NOT EXISTS cron_chiamate_verificata_idx ON public.cron_chiamate (verificata_il);

ALTER TABLE public.cron_chiamate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_chiamate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cron_chiamate TO service_role;
-- La sequenza dell'identità: i privilegi predefiniti del baseline la darebbero ai ruoli client.
-- Scrive solo il proprietario (cron_http_post, SECURITY DEFINER), che non ha bisogno di grant.
REVOKE ALL ON SEQUENCE public.cron_chiamate_id_seq FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.cron_chiamate IS
  'Una riga per ogni chiamata al server fatta da una funzione dei cron attraverso cron_http_post: job, numero della richiesta di pg_net, percorso (mai la query string), timeout, e l''esito che cron_esiti() legge da net._http_response. Si scrive solo da cron_http_post e cron_esiti (SECURITY DEFINER); service_role legge. Le righe verificate si tengono 14 giorni. Sessione 6 della seconda serie di robustezza.';

CREATE TABLE IF NOT EXISTS public.cron_ultimo_esito (
  job                     text PRIMARY KEY,
  attivo                  boolean NOT NULL DEFAULT true,
  pianificazione          text,
  http                    boolean NOT NULL DEFAULT false,
  ultimo_runid            bigint,
  ultima_esecuzione_il    timestamptz,
  ultima_esecuzione_stato text,
  ultima_chiamata_il      timestamptz,
  ultima_chiamata_esito   text,
  ultimo_codice_http      integer,
  ultimo_ok_il            timestamptz,
  ultimo_errore_il        timestamptz,
  aggiornato_il           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_ultimo_esito ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_ultimo_esito FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cron_ultimo_esito TO service_role;

COMMENT ON TABLE public.cron_ultimo_esito IS
  'Una riga per job di cron.job (anche spento: attivo=false), aggiornata da cron_esiti() ogni 10 minuti: ultima esecuzione da cron.job_run_details, ultima chiamata al server da cron_chiamate, ultimo successo e ultimo errore. Non scade: copre anche i job mensili. Per un job HTTP il successo è la risposta del server, non l''esecuzione del job (che dice solo «richiesta accodata»).';

-- == L'INVOLUCRO ==

CREATE OR REPLACE FUNCTION public.cron_http_post(
  job text,
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_richiesta bigint;
  v_stato     text;
BEGIN
  -- La richiesta parte PRIMA e FUORI da ogni blocco d'eccezione: un errore di pg_net arriva a chi
  -- chiama esattamente come arrivava prima dell'involucro.
  v_richiesta := net.http_post(
    url                  => cron_http_post.url,
    body                 => cron_http_post.body,
    params               => cron_http_post.params,
    headers              => cron_http_post.headers,
    timeout_milliseconds => cron_http_post.timeout_milliseconds
  );

  -- La registrazione non può fermare il job: se fallisce, lo dice app_log.
  BEGIN
    INSERT INTO public.cron_chiamate (job, richiesta_id, percorso, timeout_ms)
    VALUES (cron_http_post.job, v_richiesta,
            substring(cron_http_post.url FROM '^https?://[^/]+(/[^?#]*)'),
            cron_http_post.timeout_milliseconds);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_stato = RETURNED_SQLSTATE;
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, contesto)
      VALUES ('error', 'cron', 'server',
              'chiamata di un cron partita ma non registrata in cron_chiamate: il suo esito non si saprà',
              v_stato, 'cron-http:registro-non-scritto',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'cron-http-post', 'job', cron_http_post.job,
                'esito', 'registro-non-scritto', 'richiesta_id', v_richiesta)))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(),
            contesto = excluded.contesto, codice = excluded.codice;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'cron_http_post: né cron_chiamate né app_log scritti (job %, sqlstate %)', cron_http_post.job, v_stato;
    END;
  END;

  RETURN v_richiesta;
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer) IS
  'net.http_post con il nome del job davanti: manda la stessa richiesta con gli stessi argomenti e default, poi registra il numero in cron_chiamate. La chiamano solo le funzioni dei cron (SECURITY DEFINER, proprietario postgres); nessun ruolo client la esegue. Sessione 6 della seconda serie di robustezza.';

-- == LE FUNZIONI CHE CHIAMANO IL SERVER (generate, Passo 0.6) ==

-- == IL LETTORE ==

CREATE OR REPLACE FUNCTION public.cron_esiti()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vita_risposte constant interval := interval '6 hours';   -- pg_net.ttl, misura 0.2
  v_tieni         constant interval := interval '14 days';   -- righe verificate di cron_chiamate
  v_finestra_run  constant bigint   := 5000;                 -- esecuzioni lette al massimo, misura 0.8
  v_adesso     timestamptz := now();
  v_ha_net     boolean := to_regclass('net._http_response') IS NOT NULL;
  v_ha_coda    boolean := to_regclass('net.http_request_queue') IS NOT NULL;
  v_ha_cron    boolean := to_regclass('cron.job') IS NOT NULL AND to_regclass('cron.job_run_details') IS NOT NULL;
  v_chiuse     integer := 0;
  v_ignote     integer := 0;
  v_esecuzioni integer := 0;
  v_fallite    integer := 0;
  v_cancellate integer := 0;
  v_primo_giro boolean;
  v_da         bigint;
  v_stato      text;
  v_esito      jsonb;
BEGIN
  -- 0. Il primo giro IN ASSOLUTO: cron_ultimo_esito è ancora vuota. Si guarda qui, prima del passo 4
  --    che la riempie, e non job per job: un job mensile o settimanale che non ha girato nelle
  --    ultime v_finestra_run esecuzioni resta con ultimo_runid nullo anche dopo il primo giro, e la
  --    sua prima corsa fallita dopo l'installazione deve diventare un error (passo 6).
  v_primo_giro := NOT EXISTS (SELECT 1 FROM public.cron_ultimo_esito);

  -- 1. Chiude le chiamate che hanno una risposta. Il corpo non si copia: solo un codice in maiuscolo.
  --    Errore HTTP = 4xx o 5xx (la specifica: «4xx/5xx/rete»); un 3xx si chiude come ok.
  IF v_ha_net THEN
    UPDATE public.cron_chiamate AS c
       SET esito = CASE
                     WHEN coalesce(r.timed_out, false) OR coalesce(r.error_msg, '') ILIKE 'Timeout of %' THEN 'timeout'
                     WHEN r.status_code IS NULL THEN 'errore-rete'
                     WHEN r.status_code >= 400 THEN 'errore-http'
                     ELSE 'ok'
                   END,
           codice_http   = r.status_code,
           codice_errore = CASE WHEN r.status_code >= 400
                                THEN substring(left(r.content, 2000) FROM '[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}') END,
           errore        = left(r.error_msg, 200),
           verificata_il = v_adesso
      FROM net._http_response AS r
     WHERE c.verificata_il IS NULL
       AND r.id = c.richiesta_id
       AND r.created >= c.inviata_il - interval '1 minute';
    GET DIAGNOSTICS v_chiuse = ROW_COUNT;
  END IF;

  -- 2. Senza risposta oltre la vita delle risposte (e non più in coda): l'esito non si saprà più.
  IF v_ha_coda THEN
    UPDATE public.cron_chiamate AS c
       SET esito = 'esito-ignoto', verificata_il = v_adesso
     WHERE c.verificata_il IS NULL
       AND c.inviata_il < v_adesso - v_vita_risposte
       AND NOT EXISTS (SELECT 1 FROM net.http_request_queue AS q WHERE q.id = c.richiesta_id);
  ELSE
    UPDATE public.cron_chiamate AS c
       SET esito = 'esito-ignoto', verificata_il = v_adesso
     WHERE c.verificata_il IS NULL
       AND c.inviata_il < v_adesso - v_vita_risposte;
  END IF;
  GET DIAGNOSTICS v_ignote = ROW_COUNT;

  IF v_ignote > 0 THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, occorrenze, contesto)
    VALUES ('warn', 'cron', 'server',
            format('%s chiamate dei cron senza risposta dopo %s: pg_net le ha già dimenticate', v_ignote, v_vita_risposte),
            'ESITO_IGNOTO', 'cron-esiti:esiti-persi', v_ignote,
            jsonb_build_object('campi', jsonb_build_object('operazione', 'cron-esiti', 'esito', 'esiti-persi', 'n', v_ignote)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(), contesto = excluded.contesto;
  END IF;

  -- 3. In app_log, una riga per job: gli errori (HTTP e rete) e, a parte, i timeout del client.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, route, stato_http, fingerprint, occorrenze, contesto)
  SELECT 'error', 'cron', 'server',
         format('il server non ha risposto bene a %s chiamate del job %s', count(*), c.job),
         coalesce(min(c.codice_errore),
                  CASE WHEN max(c.codice_http) IS NULL THEN 'ERRORE_RETE' ELSE 'HTTP_' || max(c.codice_http) END),
         min(c.percorso), max(c.codice_http), 'cron-http:' || c.job, count(*)::int,
         jsonb_build_object('campi', jsonb_build_object(
           'operazione', 'cron-esiti', 'job', c.job, 'esito', 'errore', 'n', count(*),
           'n_rete', count(*) FILTER (WHERE c.esito = 'errore-rete'), 'codice_http', max(c.codice_http)))
    FROM public.cron_chiamate AS c
   WHERE c.verificata_il = v_adesso AND c.esito IN ('errore-http', 'errore-rete')
   GROUP BY c.job
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(),
        contesto = excluded.contesto, codice = excluded.codice, stato_http = excluded.stato_http;

  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, route, fingerprint, occorrenze, contesto)
  SELECT 'info', 'cron', 'server',
         format('%s chiamate del job %s scadute nel client pg_net: la route può aver finito lo stesso', count(*), c.job),
         'TIMEOUT_PG_NET', min(c.percorso), 'cron-http-timeout:' || c.job, count(*)::int,
         jsonb_build_object('campi', jsonb_build_object(
           'operazione', 'cron-esiti', 'job', c.job, 'esito', 'timeout', 'n', count(*), 'timeout_ms', max(c.timeout_ms)))
    FROM public.cron_chiamate AS c
   WHERE c.verificata_il = v_adesso AND c.esito = 'timeout'
   GROUP BY c.job
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(), contesto = excluded.contesto;

  -- 4. Una riga per job di cron.job, anche spento; chi sparisce da cron.job resta, spento.
  IF v_ha_cron THEN
    INSERT INTO public.cron_ultimo_esito AS u (job, attivo, pianificazione, http, aggiornato_il)
    SELECT DISTINCT ON (k.job) k.job, k.active, k.schedule,
           EXISTS (SELECT 1 FROM public.cron_chiamate AS c WHERE c.job = k.job), v_adesso
      FROM (SELECT coalesce(j.jobname, 'jobid-' || j.jobid) AS job, j.jobid, j.active, j.schedule FROM cron.job AS j) AS k
     ORDER BY k.job, k.jobid DESC
    ON CONFLICT (job) DO UPDATE
      SET attivo = excluded.attivo, pianificazione = excluded.pianificazione,
          http = u.http OR excluded.http, aggiornato_il = excluded.aggiornato_il;

    UPDATE public.cron_ultimo_esito AS u
       SET attivo = false, aggiornato_il = v_adesso
     WHERE u.attivo
       AND NOT EXISTS (SELECT 1 FROM cron.job AS j WHERE coalesce(j.jobname, 'jobid-' || j.jobid) = u.job);
  END IF;

  -- 5. Le chiamate chiuse in questo giro aggiornano l'ultimo esito HTTP del loro job.
  UPDATE public.cron_ultimo_esito AS u
     SET http = true,
         ultima_chiamata_il    = CASE WHEN u.ultima_chiamata_il IS NULL OR s.ultima_il >= u.ultima_chiamata_il
                                      THEN s.ultima_il ELSE u.ultima_chiamata_il END,
         ultima_chiamata_esito = CASE WHEN u.ultima_chiamata_il IS NULL OR s.ultima_il >= u.ultima_chiamata_il
                                      THEN s.ultimo_esito ELSE u.ultima_chiamata_esito END,
         ultimo_codice_http    = CASE WHEN u.ultima_chiamata_il IS NULL OR s.ultima_il >= u.ultima_chiamata_il
                                      THEN s.ultimo_codice ELSE u.ultimo_codice_http END,
         ultimo_ok_il          = greatest(u.ultimo_ok_il, s.ok_il),
         ultimo_errore_il      = greatest(u.ultimo_errore_il, s.errore_il),
         aggiornato_il         = v_adesso
    FROM (
      SELECT DISTINCT ON (c.job) c.job,
             c.inviata_il AS ultima_il, c.esito AS ultimo_esito, c.codice_http AS ultimo_codice,
             max(c.inviata_il) FILTER (WHERE c.esito = 'ok') OVER (PARTITION BY c.job) AS ok_il,
             max(c.inviata_il) FILTER (WHERE c.esito IN ('errore-http', 'errore-rete')) OVER (PARTITION BY c.job) AS errore_il
        FROM public.cron_chiamate AS c
       WHERE c.verificata_il = v_adesso
       ORDER BY c.job, c.inviata_il DESC, c.id DESC
    ) AS s
   WHERE u.job = s.job;

  -- 6. Le esecuzioni nuove di ogni job. Dal secondo giro in poi ogni fallimento nuovo è un error,
  --    anche di un job che il lettore non aveva mai visto (ultimo_runid nullo: un mensile fuori
  --    dalla finestra al primo giro); quelli trovati al primo giro in assoluto (v_primo_giro, passo
  --    0) sono storia di prima dell'installazione.
  IF v_ha_cron THEN
    SELECT greatest(
             (SELECT min(u.ultimo_runid) FROM public.cron_ultimo_esito AS u
               WHERE u.attivo AND u.ultimo_runid IS NOT NULL),
             (SELECT max(d.runid) FROM cron.job_run_details AS d) - v_finestra_run)
      INTO v_da;

    WITH nuove AS (
      SELECT coalesce(j.jobname, 'jobid-' || j.jobid) AS job, d.runid, d.status,
             coalesce(d.end_time, d.start_time) AS il
        FROM cron.job_run_details AS d
        JOIN cron.job AS j ON j.jobid = d.jobid
       WHERE d.runid > coalesce(v_da, 0)
         AND d.status IN ('succeeded', 'failed')
    ), per_job AS (
      SELECT n.job,
             max(n.runid) AS ultimo_runid,
             (array_agg(n.status ORDER BY n.runid DESC))[1] AS ultimo_stato,
             (array_agg(n.il ORDER BY n.runid DESC))[1] AS ultimo_il,
             max(n.il) FILTER (WHERE n.status = 'succeeded') AS ok_il,
             max(n.il) FILTER (WHERE n.status = 'failed') AS errore_il,
             count(*) AS esecuzioni,
             count(*) FILTER (WHERE n.status = 'failed') AS fallite
        FROM nuove AS n
        JOIN public.cron_ultimo_esito AS u ON u.job = n.job
       WHERE n.runid > coalesce(u.ultimo_runid, 0)
       GROUP BY n.job
    ), aggiornate AS (
      UPDATE public.cron_ultimo_esito AS u
         SET ultimo_runid            = p.ultimo_runid,
             ultima_esecuzione_il    = p.ultimo_il,
             ultima_esecuzione_stato = p.ultimo_stato,
             ultimo_ok_il            = CASE WHEN u.http THEN u.ultimo_ok_il ELSE greatest(u.ultimo_ok_il, p.ok_il) END,
             ultimo_errore_il        = greatest(u.ultimo_errore_il, p.errore_il),
             aggiornato_il           = v_adesso
        FROM per_job AS p
       WHERE u.job = p.job
      RETURNING p.job, p.esecuzioni, p.fallite, p.ultimo_runid
    ), segnalate AS (
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, occorrenze, contesto)
      SELECT 'error', 'cron', 'server',
             format('%s esecuzioni fallite del job %s', a.fallite, a.job),
             'CRON_ESECUZIONE_FALLITA', 'cron-sql:' || a.job, a.fallite::int,
             jsonb_build_object('campi', jsonb_build_object(
               'operazione', 'cron-esiti', 'job', a.job, 'esito', 'esecuzione-fallita',
               'n', a.fallite, 'runid', a.ultimo_runid))
        FROM aggiornate AS a
       WHERE a.fallite > 0 AND NOT v_primo_giro
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(), contesto = excluded.contesto
      RETURNING 1
    )
    SELECT coalesce(sum(a.esecuzioni), 0)::int,
           CASE WHEN v_primo_giro THEN 0 ELSE coalesce(sum(a.fallite), 0)::int END
      INTO v_esecuzioni, v_fallite
      FROM aggiornate AS a;
  END IF;

  -- 7. Le chiamate verificate da più di 14 giorni escono: il riassunto resta in cron_ultimo_esito.
  DELETE FROM public.cron_chiamate AS c
   WHERE c.verificata_il IS NOT NULL AND c.verificata_il < v_adesso - v_tieni;
  GET DIAGNOSTICS v_cancellate = ROW_COUNT;

  -- 8. Il battito, nella forma che controlloBattitoCron sa leggere (campi.operazione, campi.esito).
  v_esito := jsonb_build_object(
    'operazione', 'cron-esiti', 'esito', 'ok', 'chiuse', v_chiuse, 'ignote', v_ignote,
    'esecuzioni', v_esecuzioni, 'fallite', v_fallite, 'cancellate', v_cancellate,
    'primo_giro', v_primo_giro, 'net', v_ha_net, 'cron', v_ha_cron);
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('info', 'cron', 'server',
          format('esiti dei cron: %s chiamate chiuse, %s senza esito, %s esecuzioni lette', v_chiuse, v_ignote, v_esecuzioni),
          'cron:cron-esiti', jsonb_build_object('campi', v_esito))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;

  RETURN v_esito;
EXCEPTION WHEN OTHERS THEN
  -- Se si guasta, il giro è annullato per intero ma lascia la sua traccia. Se non può scrivere
  -- neanche questa, l'errore esce e lo vede cron.job_run_details.
  GET STACKED DIAGNOSTICS v_stato = RETURNED_SQLSTATE;
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, contesto)
  VALUES ('error', 'cron', 'server', 'il lettore degli esiti dei cron si è fermato: questo giro non ha letto niente',
          v_stato, 'cron-esiti:fallito',
          jsonb_build_object('campi', jsonb_build_object('operazione', 'cron-esiti', 'esito', 'fallito', 'sqlstate', v_stato)))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(),
        contesto = excluded.contesto, codice = excluded.codice;
  RETURN jsonb_build_object('operazione', 'cron-esiti', 'esito', 'fallito', 'sqlstate', v_stato);
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_esiti() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cron_esiti() IS
  'Lettore degli esiti dei cron (job cron-esiti, minuti 4, 14, … 54): chiude le righe di cron_chiamate leggendo net._http_response, aggiorna cron_ultimo_esito da cron.job e cron.job_run_details, scrive in app_log (cron-http:<job>, cron-http-timeout:<job>, cron-sql:<job>, cron-esiti:esiti-persi, cron-esiti:fallito, battito cron:cron-esiti). Senza pg_net o pg_cron salta ciò che manca. Sessione 6 della seconda serie di robustezza.';

-- == IL JOB ==

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE WARNING 'cron-esiti: schema cron assente (DB della CI o PGlite), job non installato';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-esiti';
  PERFORM cron.schedule('cron-esiti', '4,14,24,34,44,54 * * * *', 'SELECT public.cron_esiti();');
END
$$;

NOTIFY pgrst, 'reload schema';
