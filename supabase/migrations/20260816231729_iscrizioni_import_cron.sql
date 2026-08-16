-- =============================================================================
-- L'orologio dell'import iscrizioni 2026/27 — ogni mattina alle 10:10 di Roma
--
-- ✅ APPLICATA il 2026-08-17, version 20260816231729 — DOPO il deploy, con la
--    route che rispondeva già 405 su GET (la verifica qui sotto, eseguita).
--
-- ⚠️ Il file nasceva `20260817120000_...`: `apply_migration` assegna la version
--    da sé, e in produzione la riga è `20260816231729`. Rinominato sulla version
--    VERA — il CLI applica i file in ordine alfabetico di nome, quindi un
--    timestamp inventato fa ricostruire il database in un ordine mai avvenuto.
--
-- ⚠️ IL PRIMO BATTITO È STATO INNESCATO, ED È STATO INNOCUO: eseguito il
--    2026-08-17, cioè FUORI dalla finestra 22/08–10/09, la route esce subito e
--    non spedisce niente. Verificato subito dopo: `iscrizioni_inviti_credenziali`
--    0 righe, `iscrizioni_import_esiti` 0, nessun alunno creato, nessuna riga
--    `evento=email`.
--
-- 🔑 E UNA TRAPPOLA MISURATA LÌ, che vale per OGNI battito di questo repository:
--    `app_log` deduplica per `(fingerprint, giorno)` e sull'`ON CONFLICT` aggiorna
--    solo `occorrenze` e `visto_l_ultima` — **il `contesto` resta quello della
--    PRIMA occorrenza del giorno**. Il battito qui letto mostrava `n: 170`, che
--    non era il giro di produzione (0, fuori finestra) ma una prova a vuoto locale
--    di mezz'ora prima, sullo stesso database. Il battito è un segnale di VITA,
--    non di contenuto: `/api/health` guarda l'istante e fa bene; chi leggesse `n`
--    starebbe leggendo il primo giro della giornata.
--
-- ─── ⚠️ PRECONDIZIONE D'APPLICAZIONE: PRIMA IL DEPLOY, POI QUESTA MIGRAZIONE ──
--
-- Non è una preferenza di stile: è un incidente MISURATO il 2026-08-11 su
-- `candidature-retention`, raccontato per esteso in
-- `20260811234403_scadenze_documenti_cron.sql:87-113`. In breve: la migrazione fu
-- applicata il giorno PRIMA che la route entrasse in produzione; il lavoro girò
-- per la sua unica volta e chiamò un URL che rispondeva 404 — nessun handler,
-- nessun battito, nessuna riga in `app_log`. `cron.job_run_details` diceva
-- `succeeded`, perché misura l'ACCODAMENTO e non l'esito HTTP.
--
-- Qui il danno sarebbe più grande che altrove: questo lavoro manda PASSWORD a
-- famiglie vere. Quindi, prima dell'apply:
--
--   curl -s -o /dev/null -w '%{http_code}' https://app.kidville.it/api/iscrizione/import-massivo
--   -- deve dare 405 (GET su una route che espone solo POST).
--   -- 404 significa che il deploy non c'è ancora: NON applicare.
--
-- ⚠️ E IL PRIMO BATTITO A MANO **NON SI INNESCA COME ALTROVE**. Sugli altri
-- lavori si esegue `SELECT public.<nome>_http();` subito dopo l'apply, per non
-- lasciare `/api/health` a nominare il job per 24 h. Qui quella riga
-- SPEDIREBBE INVITI VERI se il giorno è dentro la finestra 22/08–10/09. Il primo
-- battito si innesca invece con la prova a vuoto, che passa dallo stesso codice e
-- scrive lo stesso battito senza mandare niente:
--
--   curl -X POST https://app.kidville.it/api/iscrizione/import-massivo \
--     -H "x-cron-secret: <dal Vault>" -H 'Content-Type: application/json' \
--     -d '{"dry_run":true,"forza_fuori_finestra":true}'
--
-- ─── LA FESSURA ORARIA: 08:10 UTC, E I DIECI MINUTI NON SONO UN VEZZO ────────
--
-- `news-digest` gira `0 8 1 * *` (20260720191525_news_cron.sql:109): il **1°
-- settembre** cadrebbe nello stesso minuto di questo lavoro, e i due si
-- contenderebbero la stessa quota Resend senza sapere l'uno dell'altro. Dieci
-- minuti di scarto tolgono la CORSA senza acrobazie sul rate limit.
--
-- 🔻 Lo scarto NON risolve il problema di fondo, ed è giusto scriverlo qui dove
-- lo si rilegge: dopo questo import gli account genitore saranno ~479 in più, e
-- il 1° settembre `news-digest` proverà a spedire ~500 email in un colpo contro
-- un tetto di 100 al giorno. Il picco misurato negli ultimi 21 giorni è 33. La
-- decisione — alzare il piano Resend, oppure mettere mano al digest — è del
-- titolare, e non si prende in una migrazione.
--
-- Le altre fessure già occupate (UTC): 3:30 purge log, 4:17 news-retention, 4:23
-- consensi, 4:35 notifiche-retention, 4:41 iscrizioni-retention, 4:47
-- iscrizioni-sanitari, 4:53 audit-docente, 4:59 presenze-giustificazioni, 5:05
-- candidature-retention, 5:11 bonifica PII (lunedì), 5:17 retention-personale,
-- 5:47 scadenze-documenti, 6:00 promemoria e solleciti, 7:00 mensa, 8:00
-- news-digest (mensile, giorno 1).
--
-- ─── IL CALENDARIO STA NELLA ROUTE, NON QUI ─────────────────────────────────
--
-- Nessun cron sa dire «dal 22 agosto al 10 settembre». Il job resta programmato
-- tutto l'anno e fuori da quelle date la route esce subito senza fare niente:
-- è preferibile a un `cron.unschedule` che qualcuno deve ricordarsi di eseguire.
-- Conseguenza voluta: il battito si scrive TUTTI i giorni dell'anno, anche fuori
-- finestra, e per questo la voce può stare in `JOB_CRON` (finestra 26 h) invece
-- che fra i non sorvegliati.
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Si prende l'ORIGINE (`schema://host`) di un URL già configurato nel Vault, se
-- ne scarta il path e vi si riattacca il proprio. Un segreto in più è un modo in
-- più di avere un lavoro schedulato che non parte. Nessun segreto è scritto in
-- questo file: il repository è pubblico.
--
-- ─── COME SI SA CHE HA FUNZIONATO ───────────────────────────────────────────
--
-- `net.http_post` è ASINCRONO: accoda e restituisce un numero d'ordine. L'esito
-- vero lo scrive un altro processo in `net._http_response`, fuori dalla
-- transazione, quindi nessun `EXCEPTION` qui dentro potrà mai vederlo. Il punto
-- d'osservazione è il battito che la route scrive in `app_log` da un `finally`
-- (`evento=cron`, `operazione=iscrizioni-import-invio`), letto da `/api/health`
-- tramite `JOB_CRON` con finestra 26 h.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.iscrizioni_import_invio_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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
    -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md punto 4).
    -- Senza questa riga un Vault vuoto renderebbe il lavoro un no-op silenzioso:
    -- le iscrizioni non partirebbero e nessuno lo saprebbe fino a settembre.
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
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      -- Corpo vuoto: il tetto è quello di `INVITI_AL_GIORNO` (90 email) e la
      -- finestra la decide la route. Un `max_inviti` scritto qui sarebbe un
      -- secondo posto in cui vive lo stesso numero, e i due divergerebbero.
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Copre SOLO il fallimento dell'ACCODAMENTO (pg_net assente, argomenti
    -- rifiutati): l'esito HTTP arriva altrove e in un altro momento, e a vederlo
    -- è il battito che la route scrive in `app_log`.
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
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.iscrizioni_import_invio_http() OWNER TO postgres;

-- Porta il cron secret e fa partire email a famiglie vere: mai raggiungibile da
-- `/rest/v1/rpc/`. `REVOKE ... FROM PUBLIC` non basta — in Supabase `anon` e
-- `authenticated` ricevono l'EXECUTE per GRANT esplicito (regressione RPC mensa,
-- 2026-07-18) — e il lock `security-definer-revoke-lock` lo pretende.
REVOKE ALL ON FUNCTION public.iscrizioni_import_invio_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_import_invio_http() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_import_invio_http() IS
  'Chiama POST /api/iscrizione/import-massivo ogni mattina alle 08:10 UTC (10:10 di Roma). Il giro prende le domande d''iscrizione piu'' vecchie, cerca il bambino nell''elenco di classe della sua sede, lo inserisce con la sua retta, crea l''accesso di OGNI genitore con un''email e glielo manda — fermandosi da solo su tutto cio'' che non e'' certo. Il tetto e'' di 90 EMAIL al giorno, non di domande: con due genitori una domanda costa il doppio. La finestra 22/08-10/09 la decide la route, non questo schedule. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito in app_log, sorvegliato da /api/health tramite JOB_CRON con finestra 26 h.';

-- ── L'orologio ───────────────────────────────────────────────────────────────
-- ⚠️ Il nome sta sulla STESSA RIGA di `cron.schedule(`, e non per estetica: il
-- lock `cron-sorvegliato-e-applicato.test.ts:87` cerca `cron\.schedule\s*\(\s*'<nome>'`
-- e la forma multilinea usata da tre migrazioni precedenti NON la soddisfa —
-- quei job sfuggono al lock, ed è una svista del lock, non una licenza.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'iscrizioni-import-invio';
  PERFORM cron.schedule('iscrizioni-import-invio', '10 8 * * *', $cron$ SELECT public.iscrizioni_import_invio_http(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (DOPO l'apply)
--
--   select jobname, schedule, active from cron.job where jobname = 'iscrizioni-import-invio';
--   -- 1 riga, '10 8 * * *', active = true
--
--   select has_function_privilege('anon', p.oid, 'execute'),
--          has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'iscrizioni_import_invio_http';
--   -- false, false
--
--   -- il battito, dopo la prova a vuoto in produzione:
--   select livello, contesto->'campi'->>'esito', visto_l_ultima
--     from app_log
--    where evento = 'cron' and contesto->'campi'->>'operazione' = 'iscrizioni-import-invio'
--    order by visto_l_ultima desc limit 3;
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   select cron.unschedule(jobid) from cron.job where jobname = 'iscrizioni-import-invio';
--   drop function if exists public.iscrizioni_import_invio_http();
--   -- e togliere la voce da JOB_CRON in src/lib/health/controlli.ts, altrimenti
--   -- /api/health resta `degradato` per sempre su un lavoro che non esiste più.
-- ═══════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
