-- ═══════════════════════════════════════════════════════════════════════════════
-- L'AUTOMA DELLA PURGA DEL CESTINO DELLA GALLERIA — «galleria-retention».
-- Scritta il 2026-09-12, misurando il database di produzione in SOLA LETTURA.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── ⚠️ NON APPLICATA, E VA APPLICATA **DOPO** IL DEPLOY DEL CODICE ───────────
--
-- Questo file è stato SCRITTO, non applicato. Non è prudenza generica: è
-- l'ORDINE, e l'ordine sbagliato è già stato pagato in questo repo.
--
-- Misurato l'11/08/2026 su `candidature-retention` (la ragione sta per esteso in
-- `src/lib/health/controlli.ts`, accanto a quella voce): la migrazione fu
-- applicata il 10 agosto, il codice della route entrò in `main` il giorno dopo
-- alle 08:16 UTC, e il cron girò alle 05:05 — **tre ore e undici minuti prima
-- che la route esistesse**. Ha chiamato un URL che rispondeva 404: nessun
-- handler, nessun battito, e `/api/health` avrebbe detto «job senza battito» per
-- un guasto inventato. `cron.job_run_details` diceva `succeeded`, perché misura
-- l'accodamento e non l'esito HTTP.
--
-- Quindi, nell'ordine, e nessun passo si salta:
--
--   1. **PRIMA il deploy del codice** (`POST /api/gdpr/retention-galleria` vivo in
--      produzione), poi `apply_migration` su questo file.
--
--   2. ⚠️ **RINOMINA QUESTO FILE CON LA VERSION CHE IL DATABASE HA REGISTRATO.**
--      Lo strumento MCP `apply_migration` NON usa la version del nome che gli si
--      passa: genera la PROPRIA, dall'orologio del momento. Il 2026-08-31 lo
--      scarto fu di undici secondi e bastò — `supabase db push` non trova la
--      version del file fra le applicate, la considera nuova e LA RIAPPLICA. Qui
--      riapplicare non farebbe danni (ogni istruzione è idempotente) ma
--      *l'idempotenza è una fortuna, non una difesa*. Subito dopo l'apply:
--          SELECT version, name FROM supabase_migrations.schema_migrations
--           ORDER BY version DESC LIMIT 3;
--      e si rinomina in `<version_registrata>_galleria_retention_cron.sql` PRIMA
--      di committare.
--
--   3. **RIGENERA LA FOTOGRAFIA DELLE MIGRAZIONI APPLICATE** — apply → rileggi la
--      version → rinomina → rigenera, mai l'inverso:
--          node __tests__/fixtures/migrazioni-fotografia.mjs --sql
--      e `get_advisors(security)` a **0 ERROR**.
--
--   4. **SPOSTA `galleria-retention` DA `JOB_CRON_NON_SORVEGLIATI` A `JOB_CRON`**
--      in `src/lib/health/controlli.ts`, con `finestraMs: 26 * ORA`. Finché la
--      migrazione non è applicata quel nome NON può stare in `JOB_CRON`: il lock
--      `__tests__/architecture/cron-sorvegliato-e-applicato.test.ts` lo vieta, e
--      lo vieta per la ragione giusta — `controlloBattitoCron` considera muto
--      anche il job che non ha MAI battuto, quindi il nome in `JOB_CRON` prima
--      dell'apply manda `/api/health` in `degradato` dal primo deploy e per
--      sempre, su un lavoro che non esiste ancora. Un allarme che suona da solo
--      viene spento.
--
--   5. **INNESCA IL PRIMO BATTITO A MANO** invece di aspettare la notte:
--          SELECT public.galleria_retention_http();
--      e poi la prova vera, che non è né la funzione né lo schedule:
--          SELECT visto_l_ultima, contesto->'campi'->>'esito',
--                 contesto->'campi'->>'n_righe'
--            FROM public.app_log
--           WHERE evento = 'cron'
--             AND contesto->'campi'->>'operazione' = 'galleria-retention'
--           ORDER BY visto_l_ultima DESC LIMIT 5;
--
-- ─── PERCHÉ QUESTA MIGRAZIONE ESISTE ─────────────────────────────────────────
--
-- Dal 2026-09-11 «Elimina» sulla galleria non distrugge più: NASCONDE. Il dialogo
-- che l'insegnante conferma (`DialogoEliminaMedia.tsx`) promette che la segreteria
-- può ripristinare la foto entro 30 giorni e che, passati quelli, la foto **viene
-- distrutta**. La prima metà era vera dal primo giorno; la seconda non era
-- mantenuta da NIENTE — nessuna riga cancellata, nessun file tolto dal bucket.
-- `POST /api/gdpr/retention-galleria` è il programma che la mantiene, e questa
-- migrazione è la sola cosa che lo CHIAMA. Senza, sarebbe codice morto in
-- produzione: è esattamente lo stato in cui `candidature-retention` è nata il
-- 2026-08-10 (route, suite, voce in `/privacy` — e nessun `cron.schedule`).
--
-- ⚠️ E NON È SOLO IL CESTINO. Lo stesso giro spazza gli ORFANI del bucket: al
-- 2026-09-12 sono **26 oggetti, 19 MB, il più vecchio del 26 maggio**, foto di
-- bambini che nessuna riga di `galleria_media_v2` nomina più — invisibili nel
-- prodotto, non cancellate, e non raggiungibili dall'oblio su richiesta, che parte
-- dalle righe. Misurato in sola lettura:
--   with ogg as (select name from storage.objects
--                 where bucket_id = 'gallery' and name like 'uploads/%')
--   select count(*) from ogg
--    where name not in (select distinct file_url from galleria_media_v2);
--
-- ─── PERCHÉ UNA ROUTE HTTP E NON UNA FUNZIONE SQL ───────────────────────────
--
-- Perché **i file si tolgono solo dalla Storage API**, e da Postgres non ci si
-- arriva: `storage.objects` ha il trigger `protect_objects_delete`, ed è FOR EACH
-- STATEMENT — scatta a ogni `DELETE` anche a zero righe (`42501`). Il lock
-- `__tests__/architecture/storage-delete-vietata-in-sql.test.ts` lo vieta per
-- iscritto, e nasce da un lavoro che sarebbe fallito dalla prima notte e per
-- sempre. E comunque cancellare la riga di `storage.objects` toglie l'indice, non
-- il binario: anche il giorno in cui Supabase togliesse quel trigger, il codice
-- resterebbe sbagliato.
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Stesso pattern di `candidature_retention_http` e di `pagamenti_solleciti_tick`:
-- si prende l'ORIGINE (`schema://host`) di un URL già configurato nel Vault, se ne
-- scarta il path e vi si riattacca il proprio. Un segreto in più è un modo in più
-- di avere un lavoro schedulato che non parte. Misurato il 2026-09-12: nel Vault
-- ci sono `app.cron_secret`, `app.push_dispatch_url`,
-- `app.notifiche_promemoria_url`, `app.retention_iscrizioni_url`,
-- `app.fattura_sync_url`, `app.mensa_allergie_url`. Nessun segreto è scritto in
-- questo file.
--
-- ─── COME SI SA CHE HA FUNZIONATO (e perché non basta `cron.job`) ────────────
--
-- `net.http_post` è ASINCRONO: accoda e restituisce un numero d'ordine. L'esito
-- vero (4xx/5xx, timeout, DNS) lo scrive un altro processo in
-- `net._http_response`, fuori dalla transazione — quindi nessun `EXCEPTION` qui
-- dentro potrà mai vederlo. Il punto d'osservazione è un altro, ed è più forte:
-- la route scrive il proprio battito in `app_log` (`evento='cron'`,
-- `livello='info'`, `operazione='galleria-retention'`, `esito='ok'`) dentro un
-- `finally`, quindi anche a zero righe e anche quando fallisce.
--
-- ⚠️ GIORNALIERO, E NON MENSILE, e la ragione non è di gusto: `app_log` conserva
-- **30 giorni**, quindi un lavoro mensile non è sorvegliabile da `/api/health` —
-- il battito precedente sparisce prima che arrivi il successivo. È esattamente
-- perché girano il primo del mese che `iscrizioni-retention`,
-- `notifiche-retention` e `news-digest` stanno in `JOB_CRON_NON_SORVEGLIATI`
-- invece che in `JOB_CRON`. Con la cadenza giornaliera la finestra è 26 h come per
-- gli altri: assorbe un giro saltato, non due.
--
-- ⚠️ E la cadenza giornaliera è anche ciò che rende vero il termine della grazia
-- sugli orfani: il tetto vero è `ORE_GRAZIA_ORFANI` + un giro di cron, cioè ~48 h
-- con una corsa a notte. Diradare questo schedule allunga quel tetto senza che una
-- riga di testo lo dica (è la lezione del lock
-- `informativa-termine-orfani-sostenibile`, scritta sul gemello).
--
-- 05:23 UTC: fessura libera, verificata sul database e non supposta. `cron.job` al
-- 2026-09-12 contiene, nella fascia 3-6 UTC: 3:30 app-log-purge, 4:17 news-retention
-- (domenica), 4:23 consensi-retention (mensile), 4:35 notifiche-retention (mensile),
-- 4:37 vigilanza-chat-retention (mensile), 4:41 iscrizioni-retention (mensile),
-- 4:47 iscrizioni-sanitari, 4:53 audit-docente-retention (mensile),
-- 4:59 presenze-giustificazioni-retention, 5:05 candidature-retention,
-- 5:11 app-log-bonifica-pii (lunedì), 5:17 retention-personale,
-- 5:47 scadenze-documenti-personale, 6:00 notifiche-promemoria e pagamenti-solleciti.
-- I minuti 23 e 29 della fascia 5 erano gli unici liberi a distanza di sei minuti
-- dai vicini; si è preso il primo.
--
-- Idempotente: la funzione è `CREATE OR REPLACE`, lo schedule fa
-- unschedule-se-presente + schedule. **pg_cron NON esiste sul database E2E della
-- CI**: il blocco `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa
-- migrazione passi senza fare niente, come tutte le altre della sua famiglia.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.galleria_retention_http()
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
    PERFORM net.http_post(
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
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.galleria_retention_http() OWNER TO postgres;

-- Innesca una distruzione irreversibile di foto di minori portando con sé il cron
-- secret: mai esposta ai ruoli client. In Supabase anon/authenticated ricevono
-- EXECUTE via GRANT esplicito, NON via PUBLIC: revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.galleria_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.galleria_retention_http() TO service_role;

COMMENT ON FUNCTION public.galleria_retention_http() IS
  'Chiama POST /api/gdpr/retention-galleria ogni notte alle 05:23 UTC: distrugge definitivamente — riga E file — le foto e i video di galleria che stanno nel cestino da piu'' di 30 giorni (il termine che il dialogo di eliminazione promette all''insegnante), ripulisce le segnalazioni rimaste senza oggetto e spazza gli oggetti del bucket `gallery` che nessuna riga nomina piu'' (26 al 2026-09-12, il piu'' vecchio del 26 maggio). I file si tolgono solo dalla Storage API, che da Postgres non si raggiunge: per questo il lavoro e'' una route HTTP e non una funzione SQL. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log, sorvegliato da /api/health tramite JOB_CRON con finestra 26 h.';

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'galleria-retention';
  PERFORM cron.schedule(
    'galleria-retention',
    '23 5 * * *',
    $cron$ SELECT public.galleria_retention_http(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'apply):
--
--   -- (a) la funzione c'è ed è del solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'galleria_retention_http';
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_name = 'galleria_retention_http';
--
--   -- (b) il lavoro è schedulato, GIORNALIERO e attivo:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'galleria-retention';
--
--   -- (c) LA PROVA VERA, che non è né (a) né (b):
--   SELECT visto_l_ultima, contesto->'campi'->>'esito',
--          contesto->'campi'->>'n_righe', contesto->'campi'->>'n_orfani_rimossi'
--     FROM public.app_log
--    WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'galleria-retention'
--    ORDER BY visto_l_ultima DESC LIMIT 5;
--
--   -- (d) e la contro-prova sul bucket, che è la sola che misura l'effetto:
--   with ogg as (select name from storage.objects
--                 where bucket_id = 'gallery' and name like 'uploads/%')
--   select count(*) as orfani_residui from ogg
--    where name not in (select distinct file_url from public.galleria_media_v2);
--
--   -- (e) se (c) è vuota per più di 26 h — e solo DOPO il passo 4 della testata —
--   --     /api/health lo dice da solo:
--   --     {"nome":"cron-battito","esito":"degradato","dettaglio":"job senza battito: galleria-retention"}
-- ═══════════════════════════════════════════════════════════════════════════════
