-- =============================================================================
-- L'AUTOMA DELLA CONSERVAZIONE DELL'ANAGRAFICA DEL PERSONALE — «retention-personale».
--
-- ✅ APPLICATA il 2026-08-12, version `20260811234419`.
--    Verificato DOPO: `cron.job` contiene `retention-personale` alle `17 5 * * *`, la
--    funzione NON è eseguibile da `anon` né da `authenticated`, `get_advisors(security)`
--    → 0 ERROR e nessun WARN nuovo. Da questo momento il termine che `/privacy` promette
--    ha un lavoro che lo applica davvero: era la condizione posta dal lock
--    `gdpr-retention-personale`, e non era una formalità.
--
-- (storia) Questo file era stato scritto Questo file è stato scritto dall'agente che ha realizzato
--    `POST /api/gdpr/retention-personale` e NON è stato applicato al database:
--    l'agente non ha (e non deve avere) il permesso di scrivere sullo schema di
--    produzione. La applica chi rilascia, con lo strumento MCP `apply_migration`
--    + `get_advisors` (0 ERROR), e **attesta qui in testata la data** con una
--    riga «APPLICATA il AAAA-MM-GG» — che è ciò che i lock di questo repo
--    leggono per distinguere un lavoro che gira da un file che nessuno ha mai
--    eseguito.
--
--    ⚠️ IL NOME DEL FILE È PROVVISORIO (`20260811234419`), E NON È L'UNICO:
--    `20260811234403_scadenze_documenti_cron.sql` porta lo stesso prefisso di
--    data, perché è stato scritto in parallelo con la stessa consegna — e finisce
--    per `9900` proprio perché questo posto era già preso (fino all'11/08/2026
--    questa riga sbagliava il nome del gemello e lo chiamava `…999999`, cioè
--    descriveva un conflitto che era già stato risolto). Due migrazioni con la
--    stessa versione non possono convivere. Il nome DEVE coincidere con
--    la versione registrata in `supabase_migrations.schema_migrations`: un file
--    il cui nome non coincide viene riapplicato dal `db push` successivo. Chi
--    applica rinumeri ENTRAMBE con la versione che lo strumento registra
--    davvero — è la stessa nota che porta in testata
--    `20260810204727_candidature_retention_cron.sql`.
--
--    ⚠️ E FINCHÉ NON È APPLICATA, LA VOCE IN `JOB_CRON` VA MESSA INSIEME, NON
--    PRIMA. `controlloBattitoCron` considera muto anche il job che non ha MAI
--    battuto (`t === undefined`): un nome in `JOB_CRON` senza il suo
--    `cron.schedule` manda `/api/health` in `degradato` DAL PRIMO DEPLOY, per
--    sempre. È successo davvero al gemello `candidature-retention` il
--    2026-08-10, ed è scritto nella testata della sua migrazione. Un allarme che
--    suona da solo viene spento, e allora non protegge più niente.
--
--    ⚠️ E SI APPLICA INSIEME ALL'ALTRA, non prima e non dopo. `JOB_CRON` porta
--    DUE nomi nuovi in questa consegna — `retention-personale` (questo file) e
--    `scadenze-documenti-personale` (`20260811234403`): applicandone una sola,
--    il gate diventa verde e `/api/health` resta `degradato` per l'altra, senza
--    che nulla lo segnali. È il caso «gate verde sopra un allarme rotto», e in
--    questo repo è già costato una volta. Il lock che tiene la coppia — per
--    TUTTI i job, non solo per questi due — è
--    `__tests__/architecture/cron-sorvegliato-e-applicato.test.ts`, e legge la
--    fotografia di `supabase_migrations.schema_migrations`: dopo l'apply va
--    rigenerata, altrimenti resta rosso (ed è voluto — è il momento in cui
--    qualcuno guarda davvero se repo e database dicono la stessa cosa).
--
--    ─── L'ORDINE DEL RILASCIO, che è l'unica cosa ancora ambigua qui sopra ──
--
--    I due riquadri precedenti dicono «si applica INSIEME al deploy» e il
--    commento di `candidature-retention` in `src/lib/health/controlli.ts` dice
--    «la migrazione si applica DOPO il rilascio». Non si contraddicono: parlano
--    di due guasti diversi, e la sequenza che li evita entrambi è una sola.
--
--    Il guasto di «prima»: MISURATO sul gemello l'11/08/2026 — la migrazione era
--    stata applicata il 10/08, la route è entrata in produzione con `a9dcc6d`
--    l'11/08 alle 08:16 UTC, e il giro delle 05:05 UTC ha chiamato un URL che
--    rispondeva 404, cioè **3 h 11 min prima che l'handler esistesse**. Nessun
--    battito, e `cron.job_run_details` diceva `succeeded` perché misura
--    l'accodamento, non l'esito HTTP.
--    Il guasto di «dopo»: il nome è già in `JOB_CRON`, quindi fra il deploy e
--    l'apply `/api/health` risponde `degradato` su un lavoro che non esiste.
--
--    LA SEQUENZA, nell'ordine, senza saltare il punto 4:
--      1. merge + deploy in produzione (la route esiste e risponde);
--      2. `apply_migration` di QUESTO file e di `20260811234403`, insieme;
--         `get_advisors` a 0 ERROR;
--      3. attestare in testata «APPLICATA il AAAA-MM-GG» su entrambi e
--         rigenerare `__tests__/fixtures/migrazioni-applicate-snapshot.json`;
--      4. innescare il PRIMO BATTITO a mano invece di aspettare le 05:17 UTC:
--           SELECT public.retention_personale_http();
--         poi verificare il punto (c) in fondo a questo file. Senza il punto 4,
--         `/api/health` resta `degradato` fino alla notte successiva e nessuno
--         sa se è perché il lavoro non ha ancora girato o perché è rotto.
--
--    ⚠️ FRA IL PUNTO 1 E IL PUNTO 3 IL GATE È ROSSO, ed è voluto: tre lock
--    leggono la fotografia e nessuno di essi può diventare verde prima che il
--    database sia davvero cambiato. Il rosso si chiude col punto 3, non
--    aggirandolo — e in particolare NON spostando il nome in
--    `JOB_CRON_NON_SORVEGLIATI`: quella via d'uscita, che gli altri due lock
--    suggeriscono, lascerebbe `/privacy` a promettere novanta giorni, dodici mesi
--    e dieci anni con il gate verde. È il rilievo del revisore dell'11/08/2026, e
--    il lock che lo chiude è in `__tests__/api/gdpr-retention-personale.test.ts`
--    («il termine è promesso ⇒ esiste un `cron.schedule` in una migrazione
--    APPLICATA»), che non guarda `JOB_CRON` affatto.
--
-- ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
--
-- `POST /api/gdpr/retention-personale` fa scadere tre cose, e nessuna di queste
-- scade da sola:
--   · la PRATICA non approvata del modulo pubblico `/anagrafica-personale`, con
--     la scansione del documento d'identità allegata — 90 giorni;
--   · la SOLA SCANSIONE del documento di chi ha cessato il rapporto — 12 mesi
--     dalla cessazione (il file esce dal bucket e `documento_path` torna NULL);
--   · il FASCICOLO anagrafico di chi ha cessato — 10 anni.
-- I tre termini sono `PERSONALE_LIMITI` (src/lib/forms/personale-template.ts),
-- cioè gli stessi numeri che il testo del consenso promette all'interessata e
-- che `/privacy` dichiara. Senza questo `cron.schedule` la route è codice morto
-- e quelle tre dichiarazioni non le mantiene nessuno — che è esattamente la
-- forma di difetto per cui `CLAUDE.md` dice che «un documento che descrive una
-- protezione che non c'è è peggio di nessun documento».
--
-- ─── PERCHÉ UNA ROUTE HTTP E NON UNA FUNZIONE SQL ───────────────────────────
--
-- Perché i file si tolgono solo dalla Storage API, e da Postgres non ci si
-- arriva: `DELETE FROM storage.objects` è vietato dal trigger
-- `protect_objects_delete` (`42501`, FOR EACH STATEMENT: scatta anche a zero
-- righe). La conservazione delle domande d'iscrizione nacque così e sarebbe
-- fallita dalla prima notte.
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Un segreto in più è un modo in più di avere un lavoro schedulato che non
-- parte: se nessuno lo scrive, la funzione registra «url non configurato» ogni
-- notte e la conservazione non gira. Si riusa il pattern del gemello: si prende
-- l'ORIGINE (`schema://host`) di un URL già configurato nel Vault, se ne scarta
-- il path e vi si riattacca il proprio. Nessun segreto è scritto in questo file.
--
-- ─── COME SI SA CHE HA FUNZIONATO (e perché non basta `cron.job`) ───────────
--
-- `net.http_post` è ASINCRONO: accoda e restituisce un numero d'ordine. L'esito
-- vero (4xx/5xx, timeout, DNS) lo scrive un altro processo in
-- `net._http_response`, fuori dalla transazione — quindi nessun `EXCEPTION` qui
-- dentro potrà mai vederlo. Il punto d'osservazione è un altro, ed è più forte:
-- la route scrive il proprio battito in `app_log` (`evento=cron`,
-- `livello=info`, `operazione=retention-personale`, `esito=ok`) dentro un
-- `finally`, quindi anche a zero righe e anche quando fallisce.
--
-- 05:17 UTC: fuori dagli orari di scuola e in una fessura libera fra i lavori
-- già in tabella (3:30 purge log, 4:17 news-retention, 4:23 consensi, 4:35
-- notifiche-retention, 4:41 iscrizioni-retention, 4:47 iscrizioni-sanitari,
-- 4:53 audit-docente, 4:59 presenze-giustificazioni, 5:05 candidature-retention,
-- 5:11 bonifica PII lunedì, 6:00 promemoria e solleciti, 7:00 mensa).
--
-- GIORNALIERO, e non è una preferenza: `app_log` conserva 30 giorni, quindi un
-- lavoro mensile non è sorvegliabile da `JOB_CRON` (è la ragione per cui
-- `iscrizioni-retention` sta in `JOB_CRON_NON_SORVEGLIATI` e il gemello no).
--
-- Idempotente: la funzione è CREATE OR REPLACE, lo schedule fa unschedule-se-
-- presente + schedule. pg_cron NON esiste sul database di collaudo della CI: il
-- blocco `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa migrazione
-- passi senza fare niente, come le altre.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.retention_personale_http()
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
    -- la conservazione delle scansioni dei documenti non girerebbe e nessuno lo
    -- saprebbe, che è lo stesso guasto che questa migrazione esiste per chiudere.
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
      'retention-personale: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:retention-personale-post-fallito',
      jsonb_build_object('operazione', 'retention-personale', 'esito', 'post-fallito')
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.retention_personale_http() OWNER TO postgres;

-- Innesca una cancellazione irreversibile portando con sé il cron secret: mai
-- esposta ai ruoli client. In Supabase anon/authenticated ricevono EXECUTE via
-- GRANT esplicito, NON via PUBLIC: revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.retention_personale_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_personale_http() TO service_role;

COMMENT ON FUNCTION public.retention_personale_http() IS
  'Chiama POST /api/gdpr/retention-personale ogni notte alle 05:17 UTC: fa scadere le pratiche non approvate del modulo /anagrafica-personale con la scansione allegata (90 giorni), la sola scansione del documento di chi ha cessato il rapporto (12 mesi dalla cessazione, con documento_path azzerato DOPO la rimozione del file) e il fascicolo anagrafico (10 anni). I file si tolgono solo dalla Storage API, che da Postgres non si raggiunge: per questo il lavoro e'' una route HTTP e non una funzione SQL. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log, sorvegliato da /api/health tramite JOB_CRON con finestra 26 h.';

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'retention-personale';
  PERFORM cron.schedule(
    'retention-personale',
    '17 5 * * *',
    $cron$ SELECT public.retention_personale_http(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'apply):
--
--   -- (a) la funzione c'è ed è del solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'retention_personale_http';
--
--   -- (b) il lavoro è schedulato, giornaliero e attivo:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'retention-personale';
--
--   -- (c) LA PROVA VERA, che non è né (a) né (b) e arriva la notte dopo:
--   SELECT visto_l_ultima, contesto->'campi'->>'esito', contesto->'campi'->>'n_pratiche'
--     FROM public.app_log
--    WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'retention-personale'
--    ORDER BY visto_l_ultima DESC LIMIT 5;
--
--   -- (d) e se (c) è vuota per più di 26 h, /api/health lo dice da solo:
--   --     `{"nome":"cron-battito","esito":"degradato","dettaglio":"job senza battito: retention-personale"}`
-- ═══════════════════════════════════════════════════════════════════════════════
