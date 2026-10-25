-- Sessione 8 della seconda serie di robustezza — il timeout di pg_net è il maxDuration della route.
--
-- PERCHÉ. pg_net chiude il lato client dopo `timeout_milliseconds`, e la sessione 6 ha avvolto le
-- chiamate lasciando a ciascuna il timeout che aveva con `net.http_post`: il predefinito di
-- 5000 ms (argomento assente) per la maggior parte, 120000 per `iscrizioni_retention_http`. Le
-- route dichiarano `maxDuration = 300`: ogni giro che lavora più di 5 s lascia in `cron_chiamate`
-- un `esito = 'timeout'` al posto dell'esito vero (27 in circa 6 ore il 20/10; S1 del rapporto
-- `docs/analisi-robustezza-2026-10-20.md`). Stessa scelta di 20260911113000 per la sync SDI.
--
-- DECISIONE DELL'ASSISTENTE IN ASSENZA DEL TITOLARE, DA CONFERMARE. La misura «prima» del
-- 25/10 (Compito 2 del piano) ha contato 0 esiti `timeout` su 238 chiamate in `cron_chiamate`
-- (tabella viva dalle 12:49 UTC del 25/10; il difetto dei 5 s sulla stampa era già corretto da
-- `storici_tick` a 300000 dal 19/10). Con zero timeout osservati la migrazione fa SOLO
-- l'allineamento del timeout al `maxDuration` della route, come il piano prevede per quel caso:
-- nessun altro cambio.
--
-- COSA CAMBIA. Solo l'argomento nominato `timeout_milliseconds` della chiamata a
-- `public.cron_http_post` nelle funzioni qui sotto: dove c'era, cambia il numero; dove mancava
-- (valeva il predefinito 5000), si aggiunge `, timeout_milliseconds := <ms>` in fondo alla
-- chiamata. Il valore è il `maxDuration` della route in millisecondi. Job, URL, header, corpo e
-- tutto il resto del corpo restano identici. Corpi presi da `pg_get_functiondef` in produzione
-- (Compito 2 del piano della sessione 8), non dal repo; riscritti da `conTimeout` di
-- `scripts/cron-esiti/timeout.mjs` e controllati dal lock
-- `__tests__/architecture/cron-max-duration.test.ts` (tabella CHIAMANTI_CRON). Restano fuori le
-- funzioni già al valore giusto e quelle che la sessione 6 non avvolge (`NON_SI_AVVOLGONO`).
--
-- RISCHIO. Il worker di pg_net lavora a lotti: una richiesta che aspetta a lungo può ritardare le
-- altre dello stesso giro. Si misura la latenza per job prima e dopo (piano, Rilascio).
--
-- DB DELLA CI: nessuna guardia serve. Sono CREATE OR REPLACE di funzioni plpgsql: `cron_http_post`
-- si risolve quando girano, e senza pg_cron non girano.
--
-- COME SI VERIFICA
--   SELECT p.proname,
--          coalesce(substring(p.prosrc from 'timeout_milliseconds\s*(?::=|=>)\s*(\d+)'),
--                   '5000 (predefinito)') AS timeout_ms
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.prosrc ~ 'cron_http_post\s*\('
--      AND p.proname NOT IN ('cron_http_post', 'cron_esiti')
--    ORDER BY 1;
--   Atteso: 300000 per tutte, salvo `video_runner_kick` che resta «5000 (predefinito)» per
--   decisione (`timeoutDecisoMs` in CHIAMANTI_CRON: è un trigger a ogni caricamento video, non un
--   job, e a 300 s ogni caricamento terrebbe un posto di pg_net finché il runner lavora).
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   Lo stesso script del piano con il file dei timeout di prima (`TIMEOUT_PRIMA` nel changelog
--   del PRD della sessione 8), applicato ai corpi letti in produzione il giorno del revert.

-- candidature_retention_http → src/app/api/gdpr/retention-candidature/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- cestino_registro_retention_http → src/app/api/gdpr/retention-cestino-registro/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- galleria_retention_http → src/app/api/gdpr/retention-galleria/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- iscrizioni_import_invio_http → src/app/api/iscrizione/import-massivo/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- iscrizioni_retention_http → src/app/api/gdpr/retention-iscrizioni/route.ts: timeout_milliseconds 120000 → 300000 ms
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
      timeout_milliseconds := 300000
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

-- mensa_check_allergie_giornaliero → src/app/api/mensa/allergie-check/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.mensa_check_allergie_giornaliero() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensa_check_allergie_giornaliero() TO service_role;

-- news_digest_tick → src/app/api/news/cron/run/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{"job":"digest"}'::jsonb, timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.news_digest_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.news_digest_tick() TO service_role;

-- news_tick → src/app/api/news/cron/run/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{"job":"tick"}'::jsonb, timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.news_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.news_tick() TO service_role;

-- notifiche_dispatch_tick → src/app/api/push/dispatch/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.notifiche_dispatch_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_dispatch_tick() TO service_role;

-- notifiche_promemoria_tick → src/app/api/notifiche/promemoria/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.notifiche_promemoria_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_promemoria_tick() TO service_role;

-- pagamenti_solleciti_tick → src/app/api/pagamenti/solleciti/run/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.pagamenti_solleciti_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pagamenti_solleciti_tick() TO service_role;

-- retention_personale_http → src/app/api/gdpr/retention-personale/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- scadenze_documenti_personale_http → src/app/api/notifiche/scadenze-documenti/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- video_retention_http → src/app/api/gdpr/retention-video/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

-- video_runner_tick_http → src/app/api/video/runner/route.ts: timeout_milliseconds 5000 (predefinito, argomento aggiunto) → 300000 ms
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
      body := '{}'::jsonb, timeout_milliseconds := 300000
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

