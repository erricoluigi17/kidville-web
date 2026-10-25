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
--  · Le 19 funzioni che chiamano il server, ridefinite dai corpi della PRODUZIONE
--    (pg_get_functiondef, misura 0.6 del piano, 2026-10-25) da scripts/cron-esiti/involucro.mjs,
--    con una sola differenza: net.http_post( diventa public.cron_http_post('<job>', . URL, header,
--    corpi e timeout restano quelli di ciascuna; CREATE OR REPLACE conserva proprietario e permessi,
--    e la testata di pg_get_functiondef conserva SECURITY DEFINER e search_path. Sopra ogni
--    funzione, l'impronta (md5 di pg_get_functiondef) della definizione di produzione da cui nasce.
--    Corpi trovati diversi dal repo, e qui riallineati alla produzione: nessuna. Non si avvolge
--    genera_solleciti() (deprecata, SECURITY INVOKER, nessun job la chiama): resta com'è.
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
-- che rimette le 19 definizioni di prima (quelle della produzione al 2026-10-25) coi loro permessi
-- e toglie job, funzioni e tabelle. Provata su PGlite (__tests__/db/cron-esiti.test.ts) e su un
-- Postgres 17 locale: dopo l'inversa le 19 funzioni tornano con le impronte della produzione.
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

-- candidature_retention_http · etichetta «candidature-retention» · pg_get_functiondef, impronta c762e40438b84280e14924fcedd7aedd
CREATE OR REPLACE FUNCTION public.candidature_retention_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'candidature-retention: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:candidature-retention-url-assente',
      jsonb_build_object('operazione', 'candidature-retention', 'esito', 'url-assente')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/gdpr/retention-candidature';

  BEGIN
    PERFORM public.cron_http_post('candidature-retention', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'candidature-retention: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:candidature-retention-post-fallito',
      jsonb_build_object('operazione', 'candidature-retention', 'esito', 'post-fallito')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.candidature_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candidature_retention_http() TO service_role;

-- cestino_registro_retention_http · etichetta «cestino-registro-retention» · pg_get_functiondef, impronta bd84dced9db5ede86b8f9d2c06335290
CREATE OR REPLACE FUNCTION public.cestino_registro_retention_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4):
    -- senza questa riga un Vault vuoto renderebbe il lavoro un no-op silenzioso e
    -- il cestino non si svuoterebbe mai.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'cestino-registro-retention: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:cestino-registro-retention-url-assente',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'cestino-registro-retention', 'esito', 'url-assente'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/gdpr/retention-cestino-registro';

  BEGIN
    PERFORM public.cron_http_post('cestino-registro-retention', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Copre SOLO il fallimento dell'ACCODAMENTO (pg_net assente, argomenti
    -- rifiutati): l'esito HTTP lo vede il battito che la route scrive in app_log.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'cestino-registro-retention: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:cestino-registro-retention-post-fallito',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'cestino-registro-retention', 'esito', 'post-fallito'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.cestino_registro_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cestino_registro_retention_http() TO service_role;

-- fatture_coda_tick_http · etichetta «fatture-coda-tick» · pg_get_functiondef, impronta 970a522c9b6c849e605d73f6e6f5c8e9
CREATE OR REPLACE FUNCTION public.fatture_coda_tick_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.fattura_sync_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_esito  text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.push_dispatch_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    v_esito := 'url-assente';
  ELSIF v_secret IS NULL OR v_secret = '' THEN
    v_esito := 'segreto-assente';
  ELSE
    BEGIN
      PERFORM public.cron_http_post('fatture-coda-tick', 
        url := v_origin || '/api/pagamenti/fattura/coda/giro',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', v_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 300000
      );
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      v_esito := 'post-fallito';
    END;
  END IF;

  RAISE WARNING 'fatture-coda-tick: il giro non parte (%)', v_esito;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      CASE v_esito
        WHEN 'url-assente' THEN
          'fatture-coda-tick: nessun URL configurato nel Vault da cui ricavare l''origine, la coda fatture non parte'
        WHEN 'segreto-assente' THEN
          'fatture-coda-tick: manca app.cron_secret nel Vault, la route del giro rifiuterebbe la chiamata'
        ELSE
          'fatture-coda-tick: net.http_post non ha accettato la chiamata, il giro non e'' partito'
      END,
      'cron:fatture-coda-tick-' || v_esito,
      jsonb_build_object('campi', jsonb_build_object('operazione', 'fatture-coda-tick', 'esito', v_esito))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fatture-coda-tick: anche il log in app_log non e'' riuscito (%)', SQLERRM;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.fatture_coda_tick_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_tick_http() TO service_role;

-- fatture_sdi_sync_tick · etichetta «fatture-sdi-sync» · pg_get_functiondef, impronta 8fe958ce0969e2537034cb8ba1f8e369
CREATE OR REPLACE FUNCTION public.fatture_sdi_sync_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_url    text := public.cron_config('app.fattura_sync_url');
  v_secret text := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM public.cron_http_post('fatture-sdi-sync', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb,
      timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.fatture_sdi_sync_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_sdi_sync_tick() TO service_role;

-- galleria_retention_http · etichetta «galleria-retention» · pg_get_functiondef, impronta cdc1ab1a9c2beca05e5229317eb6a0ad
CREATE OR REPLACE FUNCTION public.galleria_retention_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4).
    -- Senza questa riga un Vault vuoto renderebbe il lavoro un no-op silenzioso: la
    -- purga del cestino non girerebbe, le foto messe nel cestino resterebbero nel
    -- bucket per sempre, e nessuno lo saprebbe — cioè lo stesso guasto che questa
    -- migrazione esiste per chiudere, per un'altra strada.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'galleria-retention: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:galleria-retention-url-assente',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'galleria-retention', 'esito', 'url-assente'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/gdpr/retention-galleria';

  BEGIN
    PERFORM public.cron_http_post('galleria-retention', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Questo `EXCEPTION` copre SOLO il fallimento dell'ACCODAMENTO (pg_net assente,
    -- argomenti rifiutati): l'esito HTTP arriva altrove e in un altro momento, e a
    -- vederlo è il battito che la route scrive in `app_log`.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'galleria-retention: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:galleria-retention-post-fallito',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'galleria-retention', 'esito', 'post-fallito'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.galleria_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.galleria_retention_http() TO service_role;

-- iscrizioni_import_invio_http · etichetta «iscrizioni-import-invio» · pg_get_functiondef, impronta 6d8ee4729625b9315ff16cb17fa3ebde
CREATE OR REPLACE FUNCTION public.iscrizioni_import_invio_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'iscrizioni-import-invio: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:iscrizioni-import-invio-url-assente',
      jsonb_build_object('operazione', 'iscrizioni-import-invio', 'esito', 'url-assente')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/iscrizione/import-massivo';

  BEGIN
    PERFORM public.cron_http_post('iscrizioni-import-invio', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'iscrizioni-import-invio: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:iscrizioni-import-invio-post-fallito',
      jsonb_build_object('operazione', 'iscrizioni-import-invio', 'esito', 'post-fallito')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.iscrizioni_import_invio_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_import_invio_http() TO service_role;

-- iscrizioni_retention_http · etichetta «iscrizioni-retention» · pg_get_functiondef, impronta 514d45f2aad549ee0bc320b4d72c9d0e
CREATE OR REPLACE FUNCTION public.iscrizioni_retention_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url       TEXT := public.cron_config('app.retention_iscrizioni_url');
  v_secret    TEXT := public.cron_config('app.cron_secret');
  v_richiesta bigint;
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'gdpr', 'server',
      'retention iscrizioni: app.retention_iscrizioni_url non configurato, il lavoro non parte',
      'cron:iscrizioni-retention-url-assente',
      jsonb_build_object('esito', 'url-assente')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;
  BEGIN
    SELECT public.cron_http_post('iscrizioni-retention', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    ) INTO v_richiesta;

    INSERT INTO public.iscrizioni_retention_esecuzioni (request_id) VALUES (v_richiesta);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'gdpr', 'server',
      'retention iscrizioni: la chiamata alla route non e'' stata nemmeno accodata',
      'cron:iscrizioni-retention-http-fallita',
      jsonb_build_object('esito', 'accodamento-fallito', 'codice', SQLSTATE)
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.iscrizioni_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_http() TO service_role;

-- mensa_check_allergie_giornaliero · etichetta «mensa-check-allergie» · pg_get_functiondef, impronta b2168ad1b3891ff90b251c389e728bce
CREATE OR REPLACE FUNCTION public.mensa_check_allergie_giornaliero()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_url    TEXT := public.cron_config('app.mensa_allergie_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM public.cron_http_post('mensa-check-allergie', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.mensa_check_allergie_giornaliero() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensa_check_allergie_giornaliero() TO service_role;

-- news_digest_tick · etichetta «news-digest» · pg_get_functiondef, impronta 2620c0072b57dca04b1d60b742ad4ea3
CREATE OR REPLACE FUNCTION public.news_digest_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    RETURN;
  END IF;
  v_origin := substring(v_base FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    RETURN;
  END IF;
  v_url := v_origin || '/api/news/cron/run';
  BEGIN
    PERFORM public.cron_http_post('news-digest', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{"job":"digest"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.news_digest_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.news_digest_tick() TO service_role;

-- news_tick · etichetta «news-tick» · pg_get_functiondef, impronta 3940b637ff299873a9fa249ff5f6c206
CREATE OR REPLACE FUNCTION public.news_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    RETURN; -- nessun URL configurato: no-op silenzioso
  END IF;
  v_origin := substring(v_base FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    RETURN;
  END IF;
  v_url := v_origin || '/api/news/cron/run';
  BEGIN
    PERFORM public.cron_http_post('news-tick', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{"job":"tick"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.news_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.news_tick() TO service_role;

-- notifiche_dispatch_tick · etichetta «notifiche-dispatch» · pg_get_functiondef, impronta 84f5a89da79915366f1ae73df137bbe8
CREATE OR REPLACE FUNCTION public.notifiche_dispatch_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url    TEXT := public.cron_config('app.push_dispatch_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM public.cron_http_post('notifiche-dispatch', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.notifiche_dispatch_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_dispatch_tick() TO service_role;

-- notifiche_promemoria_tick · etichetta «notifiche-promemoria» · pg_get_functiondef, impronta a73d0acf63fcc851c9932ac1479cc391
CREATE OR REPLACE FUNCTION public.notifiche_promemoria_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url    TEXT := public.cron_config('app.notifiche_promemoria_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM public.cron_http_post('notifiche-promemoria', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.notifiche_promemoria_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_promemoria_tick() TO service_role;

-- pagamenti_solleciti_tick · etichetta «pagamenti-solleciti-run» · pg_get_functiondef, impronta b5211511af519bd945ab72279c545323
CREATE OR REPLACE FUNCTION public.pagamenti_solleciti_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Fallback: se il primo URL non è configurato, prova un altro endpoint già
  -- impostato — serve SOLO per ricavarne l'origine (schema://host).
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    RETURN; -- nessun URL configurato: no-op silenzioso, come le tick esistenti
  END IF;
  -- Origine = schema://host[:porta], scartando il path dell'endpoint sorgente.
  v_origin := substring(v_base FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    RETURN;
  END IF;
  v_url := v_origin || '/api/pagamenti/solleciti/run';
  BEGIN
    PERFORM public.cron_http_post('pagamenti-solleciti-run', 
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

REVOKE ALL ON FUNCTION public.pagamenti_solleciti_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pagamenti_solleciti_tick() TO service_role;

-- retention_personale_http · etichetta «retention-personale» · pg_get_functiondef, impronta 3e63c9c0240de82276689c8979266f3b
CREATE OR REPLACE FUNCTION public.retention_personale_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;
  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'retention-personale: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:retention-personale-url-assente',
      jsonb_build_object('operazione', 'retention-personale', 'esito', 'url-assente')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;
  v_url := v_origin || '/api/gdpr/retention-personale';
  BEGIN
    PERFORM public.cron_http_post('retention-personale', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'retention-personale: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:retention-personale-post-fallito',
      jsonb_build_object('operazione', 'retention-personale', 'esito', 'post-fallito')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.retention_personale_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_personale_http() TO service_role;

-- scadenze_documenti_personale_http · etichetta «scadenze-documenti-personale» · pg_get_functiondef, impronta b15b474c4e961b6b94007069136ec75f
CREATE OR REPLACE FUNCTION public.scadenze_documenti_personale_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;
  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');
  IF v_origin IS NULL OR v_origin = '' THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'scadenze-documenti-personale: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:scadenze-documenti-personale-url-assente',
      jsonb_build_object(
        'campi', jsonb_build_object(
          'operazione', 'scadenze-documenti-personale',
          'esito', 'url-assente'
        )
      )
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;
  v_url := v_origin || '/api/notifiche/scadenze-documenti';
  BEGIN
    PERFORM public.cron_http_post('scadenze-documenti-personale', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'scadenze-documenti-personale: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:scadenze-documenti-personale-post-fallito',
      jsonb_build_object(
        'campi', jsonb_build_object(
          'operazione', 'scadenze-documenti-personale',
          'esito', 'post-fallito'
        )
      )
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.scadenze_documenti_personale_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scadenze_documenti_personale_http() TO service_role;

-- storici_tick · etichetta «storici-stampe» · pg_get_functiondef, impronta 80e35f9040eeb5436d1b55527000754d
CREATE OR REPLACE FUNCTION public.storici_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base text:=public.cron_config('app.push_dispatch_url'); segreto text:=public.cron_config('app.cron_secret'); origine text;
begin
  -- Stessa regola della FONTE presenze (presenze_giustificazioni_retention_tick):
  -- scadono soltanto motivo e note, a 12 mesi dal fatto o alla fine dell'iscrizione
  -- consolidata da 7 giorni. Firma e frequenza restano conservate.
  update public.storici_revisioni r set contenuto=
    case when jsonb_typeof(r.contenuto->'riga')='object' then
      jsonb_set(r.contenuto,'{riga}',(r.contenuto->'riga')||jsonb_build_object('giustificazione_testo',null,'note_appello',null))
    else r.contenuto||jsonb_build_object('giustificazione_testo',null,'note_appello',null) end
    where r.modulo in ('presenze','giustifiche-presenza')
      and (r.giorno_competenza < (now() at time zone 'Europe/Rome')::date-interval '12 months'
        or exists(select 1 from public.alunni a where a.id=r.alunno_id and public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)))
      and (r.contenuto->>'giustificazione_testo' is not null or r.contenuto->>'note_appello' is not null
        or r.contenuto#>>'{riga,giustificazione_testo}' is not null or r.contenuto#>>'{riga,note_appello}' is not null);
  if coalesce(base,'')='' then base:=public.cron_config('app.notifiche_promemoria_url'); end if;
  origine:=substring(base from '^https?://[^/]+');
  if coalesce(origine,'')='' or coalesce(segreto,'')='' then
    raise warning 'storici: configurazione cron mancante';
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','Configurazione cron storici mancante','storici-cron-config-assente','{}'::jsonb)
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise log 'storici: logging cron non riuscito [%]',SQLSTATE; end;
    return;
  end if;
  perform public.cron_http_post('storici-stampe', url:=origine||'/api/admin/storici/cron',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',segreto),body:='{}'::jsonb,timeout_milliseconds:=300000);
exception when others then raise warning 'storici: chiamata cron fallita [%]',SQLSTATE;
end $function$;

REVOKE ALL ON FUNCTION public.storici_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_tick() TO service_role;

-- video_retention_http · etichetta «video-retention» · pg_get_functiondef, impronta 75ba17f3ac9c2b10d1d60ec49175aba7
CREATE OR REPLACE FUNCTION public.video_retention_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4).
    -- Senza questa riga un Vault vuoto renderebbe il lavoro un no-op silenzioso: gli
    -- originali dei video non uscirebbero mai da `video_originals`, la coda delle
    -- notifiche non si svuoterebbe mai, e nessuno lo saprebbe — cioè lo stesso
    -- guasto che questa migrazione esiste per chiudere, per un'altra strada.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'video-retention: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:video-retention-url-assente',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'video-retention', 'esito', 'url-assente'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/gdpr/retention-video';

  BEGIN
    PERFORM public.cron_http_post('video-retention', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Questo `EXCEPTION` copre SOLO il fallimento dell'ACCODAMENTO (pg_net assente,
    -- argomenti rifiutati). L'esito HTTP arriva altrove e in un altro momento —
    -- `net.http_post` è ASINCRONO e restituisce un numero d'ordine, l'esito vero lo
    -- scrive un altro processo in `net._http_response`, fuori da questa transazione
    -- — e a vederlo è il battito che la route scrive in `app_log` dentro un
    -- `finally`, quindi anche a zero righe e anche quando fallisce.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'video-retention: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:video-retention-post-fallito',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'video-retention', 'esito', 'post-fallito'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.video_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_retention_http() TO service_role;

-- video_runner_kick · etichetta «video-runner-kick» · pg_get_functiondef, impronta de2f2674c90af030b446137b36d7a0c4
CREATE OR REPLACE FUNCTION public.video_runner_kick(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_base text;
  v_secret text;
  v_origine text;
  v_url_configurato boolean := false;
BEGIN
  IF p_job_id IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-runner-kick', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- pg_net non c'e': nessun effetto, e una riga che lo dice. Il LIVELLO della riga dipende da dove
  -- si e' (secondario #32): se l'URL del runner e' configurato l'ambiente e' quello vero e doveva
  -- avere pg_net, quindi un pg_net sparito e' un guasto e si scrive a livello `error` (AGENTS.md,
  -- regola 4: «un pg_net sparito in produzione si vedrebbe poco» e' il difetto); se non lo e'
  -- (database E2E della CI, PGlite) e' solo un ambiente che pg_net non l'ha mai avuto, e la riga
  -- resta `info`. L'URL si cerca nelle STESSE tre configurazioni, nello stesso ordine, del ramo
  -- che spedisce; se la configurazione non si legge (il Vault non risponde) il calcio non deve
  -- sollevare, e non si sa se e' configurata: si resta a `info`.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'net'
      AND p.proname = 'http_post'
  ) THEN
    BEGIN
      IF pg_catalog.to_regprocedure('public.cron_config(text)') IS NOT NULL THEN
        v_base := public.cron_config('app.push_dispatch_url');
        IF v_base IS NULL OR v_base = '' THEN
          v_base := public.cron_config('app.notifiche_promemoria_url');
        END IF;
        IF v_base IS NULL OR v_base = '' THEN
          v_base := public.cron_config('app.retention_iscrizioni_url');
        END IF;
        v_url_configurato := COALESCE(substring(COALESCE(v_base, '') FROM '^https?://[^/]+'), '') <> '';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_url_configurato := false;
    END;

    PERFORM public._video_job_transition_log(
      'video-runner-kick',
      CASE WHEN v_url_configurato THEN 'error' ELSE 'info' END,
      p_job_id, NULL, 'PG_NET_ASSENTE',
      pg_catalog.jsonb_build_object('url_configurato', v_url_configurato)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'inviato', false, 'motivo', 'pg-net-assente'
    );
  END IF;

  BEGIN
    IF pg_catalog.to_regprocedure('public.cron_config(text)') IS NOT NULL THEN
      v_base := public.cron_config('app.push_dispatch_url');
      v_secret := public.cron_config('app.cron_secret');
      -- Si cerca SOLO un'origine: qualunque endpoint gia' configurato va bene.
      IF v_base IS NULL OR v_base = '' THEN
        v_base := public.cron_config('app.notifiche_promemoria_url');
      END IF;
      IF v_base IS NULL OR v_base = '' THEN
        v_base := public.cron_config('app.retention_iscrizioni_url');
      END IF;
    END IF;

    v_origine := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

    IF v_origine IS NULL OR v_origine = '' THEN
      -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4): senza questa
      -- riga un Vault vuoto renderebbe il calcio un no-op silenzioso.
      PERFORM public._video_job_transition_log(
        'video-runner-kick', 'error', p_job_id, NULL, 'URL_ASSENTE'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'URL_ASSENTE');
    END IF;

    PERFORM public.cron_http_post('video-runner-kick', 
      url := v_origine || '/api/video/runner',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := pg_catalog.jsonb_build_object('job_id', p_job_id)
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM public._video_job_transition_log(
      'video-runner-kick', 'error', p_job_id, NULL, 'POST_FALLITO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'POST_FALLITO');
  END;

  PERFORM public._video_job_transition_log(
    'video-runner-kick', 'info', p_job_id, NULL, NULL
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'inviato', true);
END
$function$;

REVOKE ALL ON FUNCTION public.video_runner_kick(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_runner_kick(uuid) TO service_role;

-- video_runner_tick_http · etichetta «video-runner-tick» · pg_get_functiondef, impronta dad54fbb12e54be5344898160c5e5b73
CREATE OR REPLACE FUNCTION public.video_runner_tick_http()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4).
    -- Senza questa riga un Vault vuoto renderebbe il lavoro un no-op silenzioso: i
    -- video resterebbero in coda per sempre e nessuno lo saprebbe — cioè
    -- esattamente il guasto che questa migrazione esiste per chiudere.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'video-runner-tick: nessun URL configurato nel Vault da cui ricavare l''origine, la conversione non parte',
      'cron:video-runner-tick-url-assente',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'video-runner-tick', 'esito', 'url-assente'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/video/runner';

  BEGIN
    PERFORM public.cron_http_post('video-runner-tick', 
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Questo `EXCEPTION` copre SOLO il fallimento dell'ACCODAMENTO (pg_net assente,
    -- argomenti rifiutati). L'esito HTTP arriva altrove e in un altro momento —
    -- `net.http_post` è ASINCRONO — e a vederlo è il battito che la route scrive in
    -- `app_log` dentro un `finally`, quindi anche quando non c'era niente da fare.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'video-runner-tick: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:video-runner-tick-post-fallito',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'video-runner-tick', 'esito', 'post-fallito'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $function$;

REVOKE ALL ON FUNCTION public.video_runner_tick_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_runner_tick_http() TO service_role;

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
