-- =============================================================================
-- L'AUTOMA DELLA CONSERVAZIONE DELLE CANDIDATURE — «candidature-retention».
--
-- ⚠️ APPLICATA il 2026-08-10 al progetto di produzione (`uimulkjyekgemjakmepp`)
--    con lo strumento MCP `apply_migration`, e registrata in
--    `supabase_migrations.schema_migrations` con la versione `20260810204727` —
--    che è il motivo per cui questo file porta quel numero e non l'ora locale:
--    un file il cui nome non coincide con la versione registrata verrebbe
--    riapplicato dal `db push` successivo.
--    La verifica è in fondo al file, ed è stata eseguita: `cron.job` contiene
--    `candidature-retention` con schedule `5 5 * * *` e `active = true`.
--    `get_advisors(security)` dopo l'apply: 0 ERROR, e questa funzione NON
--    compare fra le `SECURITY DEFINER` eseguibili da `authenticated`.
--
-- ─── PERCHÉ QUESTA MIGRAZIONE ESISTE, E COS'ERA IL DIFETTO ───────────────────
--
-- `POST /api/gdpr/retention-candidature` è nata il 2026-08-10 con la sua suite,
-- la sua voce in `JOB_CRON` (`src/lib/health/controlli.ts`) e la sua voce
-- nell'informativa (`src/app/privacy/page.tsx`, «dodici mesi… ventiquattro con
-- il consenso»). Le mancava la sola cosa che la faceva funzionare: **nessuno la
-- chiamava**. Non esisteva nessun `cron.schedule('candidature-retention', …)`.
--
-- Quel giorno, per qualche ora, sono state vere tre cose insieme:
--   · /privacy dichiarava pubblicamente un termine di conservazione su un dato
--     personale di persone adulte (il curriculum) che nessun programma applicava
--     — «un documento che descrive una protezione che non c'è più è peggio di
--     nessun documento», che è scritto in CLAUDE.md e vale anche al futuro;
--   · la route era codice morto in produzione;
--   · e la voce in `JOB_CRON` mandava `/api/health` in `degradato` DAL PRIMO
--     DEPLOY. `controlloBattitoCron` considera muto anche il job con
--     `t === undefined`, cioè quello che non ha MAI battuto: l'endpoint avrebbe
--     risposto «job senza battito: candidature-retention» per sempre. Un allarme
--     che suona da solo viene spento, e allora smette di proteggere.
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Il gemello delle iscrizioni ha un segreto dedicato nel Vault
-- (`app.retention_iscrizioni_url`), e un segreto in più è un modo in più di
-- avere un lavoro schedulato che non parte: se nessuno lo scrive, la funzione
-- registra «url non configurato» ogni notte e la conservazione non gira. Qui si
-- riusa il pattern di `pagamenti_solleciti_tick` (20260718400000): si prende
-- l'ORIGINE (`schema://host`) di un URL già configurato, se ne scarta il path e
-- vi si riattacca il proprio. Misurato il 2026-08-10 su questo database:
-- `app.push_dispatch_url` esiste e la sua origine è `https://app.kidville.it`.
-- Nessun segreto è scritto in questo file: URL e cron secret restano nel Vault.
--
-- ─── COME SI SA CHE HA FUNZIONATO (e perché non basta `cron.job`) ────────────
--
-- `net.http_post` è ASINCRONO: accoda e restituisce un numero d'ordine. L'esito
-- vero (4xx/5xx, timeout, DNS) lo scrive un altro processo in
-- `net._http_response`, fuori dalla transazione — quindi nessun `EXCEPTION` qui
-- dentro potrà mai vederlo. È il difetto misurato il 2026-08-02 sul gemello, e
-- il lock `cron-http-esito-osservato.test.ts` esiste per quello.
--
-- Qui il punto d'osservazione è un ALTRO, ed è più forte: la route scrive il
-- proprio battito in `app_log` (`evento=cron`, `livello=info`, `operazione=
-- candidature-retention`, `esito=ok`) in un `finally`, quindi anche a zero righe
-- e anche quando fallisce. `/api/health` lo legge tramite `JOB_CRON` con una
-- finestra di 26 h. Se la chiamata HTTP non arriva mai — host irraggiungibile,
-- segreto sbagliato, funzione non deployata — il battito non c'è, e l'endpoint
-- di salute lo dice entro un giorno col NOME del job. Questo è il motivo per cui
-- la cadenza deve restare GIORNALIERA: `app_log` conserva 30 giorni, e un lavoro
-- mensile non è sorvegliabile da lì (è la ragione per cui `iscrizioni-retention`
-- sta in `JOB_CRON_NON_SORVEGLIATI` e questo no).
--
-- 05:05 UTC: fuori dagli orari di scuola e in una fessura libera fra i lavori
-- già in tabella (3:30 purge log, 4:17 news-retention, 4:23 consensi, 4:35
-- notifiche-retention, 4:41 iscrizioni-retention, 4:47 iscrizioni-sanitari,
-- 4:53 audit-docente, 4:59 presenze-giustificazioni, 5:11 bonifica PII lunedì,
-- 6:00 promemoria e solleciti, 7:00 mensa).
--
-- Idempotente: la funzione è CREATE OR REPLACE, lo schedule fa
-- unschedule-se-presente + schedule. pg_cron NON esiste sul database di collaudo
-- della CI: il blocco `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa
-- migrazione passi senza fare niente, come le altre.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.candidature_retention_http()
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
    -- Senza questa riga, un Vault vuoto renderebbe il lavoro un no-op silenzioso:
    -- la conservazione dei curriculum non girerebbe e nessuno lo saprebbe, che è
    -- lo stesso guasto che questa migrazione esiste per chiudere.
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
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Questo `EXCEPTION` copre SOLO il fallimento dell'accodamento (pg_net
    -- assente, argomenti rifiutati): l'esito HTTP arriva altrove e in un altro
    -- momento, e a vederlo è il battito che la route scrive in `app_log`.
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
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.candidature_retention_http() OWNER TO postgres;

-- Innesca una cancellazione irreversibile portando con sé il cron secret: mai
-- esposta ai ruoli client. In Supabase anon/authenticated ricevono EXECUTE via
-- GRANT esplicito, NON via PUBLIC: revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.candidature_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candidature_retention_http() TO service_role;

COMMENT ON FUNCTION public.candidature_retention_http() IS
  'Chiama POST /api/gdpr/retention-candidature ogni notte alle 05:05 UTC: fa scadere le candidature spontanee del modulo «Lavora con noi» e i curriculum allegati (12 mesi dalla ricezione, o dalla decisione se la candidatura non e'' accolta; 24 mesi se la persona ha acconsentito alla conservazione per opportunita'' future). I file si tolgono solo dalla Storage API, che da Postgres non si raggiunge: per questo il lavoro e'' una route HTTP e non una funzione SQL. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log, sorvegliato da /api/health tramite JOB_CRON con finestra 26 h.';

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'candidature-retention';
  PERFORM cron.schedule(
    'candidature-retention',
    '5 5 * * *',
    $cron$ SELECT public.candidature_retention_http(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (eseguito il 2026-08-10 dopo l'apply):
--
--   -- (a) la funzione c'è ed è del solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'candidature_retention_http';
--
--   -- (b) il lavoro è schedulato, giornaliero e attivo:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'candidature-retention';
--
--   -- (c) LA PROVA VERA, che non è né (a) né (b) e arriva la notte dopo:
--   SELECT visto_l_ultima, contesto->'campi'->>'esito', contesto->'campi'->>'n_candidature'
--     FROM public.app_log
--    WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'candidature-retention'
--    ORDER BY visto_l_ultima DESC LIMIT 5;
--
--   -- (d) e se (c) è vuota per più di 26 h, /api/health lo dice da solo:
--   --     `{"nome":"cron-battito","esito":"degradato","dettaglio":"job senza battito: candidature-retention"}`
-- ═══════════════════════════════════════════════════════════════════════════════
