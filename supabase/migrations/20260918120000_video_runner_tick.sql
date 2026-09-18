-- ═══════════════════════════════════════════════════════════════════════════════
-- IL BATTITO CHE FA PARTIRE LA CONVERSIONE DEI VIDEO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────
--
-- Fino al 2026-09-18 la pipeline video aveva tutti i pezzi e NESSUNO CHE LA
-- AVVIASSE. Misurato, non supposto: `eseguiProssimoJobVideo` non aveva un solo
-- chiamante fuori dal proprio modulo, e `vercel.json` non dichiarava nessun cron.
--
-- L'effetto in produzione sarebbe stato questo: un genitore carica il video,
-- l'upload TUS riesce, il job entra in coda come `queued`, e ci resta PER SEMPRE.
-- Nei log non compare un solo errore, perché non sbaglia niente: semplicemente non
-- parte niente. È la forma di guasto che questo repository ha già pagato una volta
-- con le email di credenziali — mesi di silenzio, nessun test rosso, nessuno che se
-- ne accorgesse.
--
-- ─── PERCHÉ UNA ROUTE HTTP E NON UN LAVORO SQL ───────────────────────────────
--
-- Perché la conversione non avviene nel database: avviene in una MicroVM Vercel
-- che va aperta, sorvegliata e richiusa, e da Postgres non ci si arriva. Stessa
-- ragione, e stessa forma, dei quattro giri di conservazione già in produzione.
--
-- ─── LA CADENZA: CINQUE MINUTI, E IL VINCOLO NON È IL CRON ───────────────────
--
-- Il runner tiene UN job alla volta e un'invocazione lo sorveglia fino a 240
-- secondi (`TETTO_INVOCAZIONE_MS`), poi esce con `in-corso` lasciando la MicroVM
-- accesa: il tick dopo la riaggancia per nome. La cadenza deve quindi essere PIÙ
-- LUNGA del tetto dell'invocazione.
--
-- Con un cron al minuto il tick N+1 partirebbe mentre il tick N sta ancora
-- sorvegliando. `video_job_claim` con lo stesso owner è idempotente, quindi
-- entrambi si aggancerebbero allo STESSO Sandbox, entrambi leggerebbero il
-- marcatore, ed entrambi chiamerebbero `video_job_ready`: il primo vince, il
-- secondo prende `OUTPUT_CONFLICT` e scrive un `error` su una conversione
-- RIUSCITA. Non si corrompe niente — le guardie del database e il `fence_epoch`
-- nel nome della MicroVM reggono — ma il registro si riempie di allarmi falsi, e
-- un allarme che suona sempre viene spento.
--
-- ⚠️ IL NUMERO GIUSTO LO DIRÀ LA MISURA (V15), NON QUESTO COMMENTO. Se le
-- conversioni vere risultassero molto più corte del tetto, accorciare la cadenza
-- diventa sicuro — ma allora va accorciato PRIMA `TETTO_INVOCAZIONE_MS`, perché il
-- vincolo è quello, non lo schedule.
--
-- Minuti scelti sul contenuto reale di `cron.job`, non a caso: `news-tick` e
-- `tetto-frequenza-pulizia` stanno a `*/10` sul minuto 0, `iscrizioni-retention-esito`
-- al 27, `video-retention` a `3,13,...`. L'offset di 1 li evita tutti.
--
-- ─── ORDINE DI APPLICAZIONE, E PERCHÉ NON È NEGOZIABILE ──────────────────────
--
-- Si applica DOPO le cinque migrazioni video e DOPO il deploy di
-- `POST /api/video/runner`. Applicata prima, il cron chiamerebbe un 404 e
-- `cron.job_run_details` direbbe `succeeded` lo stesso, perché misura
-- l'ACCODAMENTO e non l'esito: è già successo l'11/08/2026 a `candidature-retention`,
-- tre ore e undici minuti di chiamate a vuoto lette come riuscite.
--
-- QUANDO SI APPLICA: spostare `video-runner-tick` in `JOB_CRON`
-- (`src/lib/health/controlli.ts`) con `finestraMs: 20 * MIN` — che assorbe tre giri
-- saltati su una cadenza di cinque minuti — e NON UN MINUTO PRIMA: un nome in
-- `JOB_CRON` la cui migrazione non è applicata manda `/api/health` in `degradato`
-- dal primo deploy e per sempre, e il lock `cron-sorvegliato-e-applicato` lo vieta.
-- Poi innescare il primo battito a mano con `SELECT public.video_runner_tick_http();`
-- e leggere la prova vera, che non è né la funzione né lo schedule:
--
--     SELECT visto_l_ultima, contesto->'campi'->>'esito'
--       FROM public.app_log
--      WHERE evento = 'cron'
--        AND contesto->'campi'->>'operazione' = 'video-runner-tick'
--      ORDER BY visto_l_ultima DESC LIMIT 5;
--
-- Idempotente: `CREATE OR REPLACE` ovunque, e lo schedule fa unschedule-se-presente
-- più schedule. **pg_cron non esiste sul database E2E della CI**: il blocco
-- `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa migrazione passi senza
-- fare niente, come tutte le altre della sua famiglia.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.video_runner_tick_http()
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
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.video_runner_tick_http() OWNER TO postgres;

-- Porta con sé il cron secret: mai esposta ai ruoli client. In Supabase
-- anon/authenticated ricevono EXECUTE via GRANT esplicito, NON via PUBLIC:
-- revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.video_runner_tick_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_runner_tick_http() TO service_role;

COMMENT ON FUNCTION public.video_runner_tick_http() IS
  'Chiama POST /api/video/runner ogni cinque minuti: prende il prossimo job video dalla coda e lo converte in una MicroVM Vercel, oppure riaggancia quella gia'' accesa di una conversione lunga. La cadenza e'' piu'' lunga del tetto dell''invocazione del runner (240 s) di proposito: al minuto, due tick si aggancerebbero allo stesso Sandbox e il secondo scriverebbe un error su una conversione riuscita. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log, sorvegliabile da /api/health tramite JOB_CRON con finestra 20 minuti.';

-- ── Il lavoro periodico ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'video-runner-tick';
  PERFORM cron.schedule(
    'video-runner-tick',
    '1,6,11,16,21,26,31,36,41,46,51,56 * * * *',
    $cron$SELECT public.video_runner_tick_http();$cron$
  );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron non esiste sul database E2E della CI: lì questa migrazione passa senza
  -- fare niente, come tutte le altre della sua famiglia.
  NULL;
END $$;
