-- =============================================================================
-- L'AUTOMA DELL'ALLARME DI SCADENZA DEI DOCUMENTI DEL PERSONALE —
-- «scadenze-documenti-personale».
--
-- ✅ APPLICATA il 2026-08-12, version `20260811234403`.
--    Verificato DOPO: `cron.job` contiene `scadenze-documenti-personale` alle `47 5 * * *`
--    (fessura libera: i 19 lavori attivi sono stati letti prima di scegliere l'orario),
--    la funzione NON è eseguibile da `anon` né da `authenticated` (`has_function_privilege`
--    risponde false), `get_advisors(security)` → 0 ERROR e nessun WARN nuovo.
--
-- (storia) Questo file è nato con un numero di versione PROVVISORIO, perché chi
--    lo ha scritto non aveva — e non doveva avere — il permesso di scrivere sullo
--    schema di produzione. `apply_migration` registra la versione VERA (l'ora
--    dell'apply) e il file va rinominato di conseguenza: un file il cui nome non
--    coincide con la versione registrata verrebbe riapplicato dal `db push`
--    successivo. È l'avvertenza scritta in testa a
--    `20260810204727_candidature_retention_cron.sql`, che quel giorno la pagò.
--    Rinominato il 2026-08-12, contestualmente all'apply.
--
--    ⚠️ E UNA LEZIONE SUL MARCATORE, che vale oltre questo file. Fino all'11/08
--    la testata portava la formula di mancata applicazione con la parola «ancora»
--    in mezzo, ed era un verde a vuoto MISURATO: il rilevatore che i lock di
--    questo repo usano cercava le due parole ADIACENTI, e con un avverbio in
--    mezzo non trovava niente — cioè questo file risultava già applicato a
--    chiunque leggesse la prosa. Da allora il rilevatore ammette anche la forma
--    con «ancora» (`cron-sorvegliato-e-applicato.test.ts`), ma la difesa vera non
--    è mai stata la prosa: quel lock confronta la `version` con la fotografia di
--    `supabase_migrations.schema_migrations`, che non si aggira scrivendo.
--
--    ⚠️ …e finisce per `9900` e non per `9999` PERCHÉ IL POSTO ERA GIÀ OCCUPATO:
--    `20260811234419_retention_personale_cron.sql`, scritta in parallelo nello
--    stesso lavoro, porta lo stesso numero provvisorio. Due file con la STESSA
--    version vengono applicati per uno solo, e l'altro è saltato senza dirlo a
--    nessuno — il repo descriverebbe un database che non esiste. Il lock
--    `__tests__/architecture/migrazioni-complete.test.ts` lo vede, e l'ha visto.
--
-- ─── PERCHÉ ESISTE, E COS'È IL DIFETTO CHE CHIUDE ───────────────────────────
--
-- `POST /api/notifiche/scadenze-documenti` nasce con la sua logica pura
-- (`src/lib/anagrafica/scadenze.ts`), la sua suite, il suo tipo di notifica e la
-- sua voce in `JOB_CRON` (`src/lib/health/controlli.ts`). Senza questo file le
-- mancherebbe l'unica cosa che la fa funzionare: **nessuno la chiamerebbe**. È
-- successo davvero, il 2026-08-10, alla conservazione delle candidature: route
-- scritta, testata, sorvegliata da /api/health, e nessun `cron.schedule` — cioè
-- codice morto in produzione, con l'aggravante che la voce in `JOB_CRON` mandava
-- l'endpoint di salute in `degradato` dal primo deploy.
--
-- Qui il danno sarebbe di un'altra natura, e vale la pena nominarlo: senza il
-- lavoro notturno, l'unico modo di accorgersi che il documento d'identità di una
-- maestra è scaduto tornerebbe a essere qualcuno che ci pensa. Il documento
-- serve al datore per identificarla negli adempimenti obbligatori (comunicazione
-- UNILAV, libro unico, denunce INPS/INAIL): senza, quegli adempimenti si fanno
-- su un dato che non è più verificabile, e nessuno se ne accorge finché non
-- serve.
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Stesso ragionamento del gemello, e per la stessa ragione pratica: un segreto in
-- più nel Vault è un modo in più di avere un lavoro schedulato che non parte, se
-- nessuno lo scrive. Si prende l'ORIGINE (`schema://host`) di un URL già
-- configurato, se ne scarta il path e vi si riattacca il proprio — il pattern di
-- `pagamenti_solleciti_tick` (20260718400000). Misurato il 2026-08-10 su questo
-- database: `app.push_dispatch_url` esiste e la sua origine è
-- `https://app.kidville.it`. **Nessun segreto è scritto in questo file**: URL e
-- cron secret restano nel Vault, e questo repository è pubblico.
--
-- ─── COME SI SA CHE HA FUNZIONATO (e perché `cron.job` non basta) ───────────
--
-- `net.http_post` è ASINCRONO: accoda e restituisce un numero d'ordine. L'esito
-- vero (4xx/5xx, timeout, DNS) lo scrive un altro processo in
-- `net._http_response`, fuori dalla transazione — quindi nessun `EXCEPTION` qui
-- dentro potrà mai vederlo. Il punto d'osservazione è un altro, e più forte: la
-- route scrive il proprio battito in `app_log` (`evento=cron`, `livello=info`,
-- `operazione=scadenze-documenti-personale`, `esito=ok`) dentro un `finally`,
-- quindi ANCHE A ZERO RIGHE e anche quando fallisce.
--
-- ⚠️ QUEL «ANCHE A ZERO RIGHE» qui è il cuore di tutto, più che negli altri
-- lavori: la condizione NORMALE di questo job è non mandare niente. Quasi ogni
-- notte non c'è nessun documento che attraversa una soglia. Un lavoro che
-- tacesse quando non ha nulla da fare sarebbe indistinguibile, per mesi, da un
-- lavoro che non parte più — e l'unica prova del guasto arriverebbe il giorno in
-- cui si scopre che una persona lavora da tre mesi con un documento scaduto e
-- nessuno l'ha avvisata. `/api/health` legge il battito tramite `JOB_CRON` con
-- finestra 26 h, e la cadenza deve restare GIORNALIERA per questo: `app_log`
-- conserva 30 giorni, e un lavoro mensile da lì non è sorvegliabile.
--
-- ─── ⚠️ PRECONDIZIONE D'APPLICAZIONE: PRIMA IL DEPLOY, POI QUESTA MIGRAZIONE ──
--
-- Non è una preferenza di stile: è un incidente MISURATO il 2026-08-11 sul gemello
-- `candidature-retention`, e questo file ne è l'erede diretto.
--
-- Cos'era successo, in ordine: la migrazione `20260810204727` fu applicata al
-- database di produzione il **2026-08-10**; il codice della route che essa chiama
-- entrò in `main` — e quindi in produzione — solo con `a9dcc6d`, il **2026-08-11
-- alle 08:16 UTC**. In mezzo, alle **05:05 UTC dell'11**, il lavoro girò per la sua
-- unica volta e chiamò un URL che rispondeva **404**: nessun handler, nessun
-- battito, nessuna riga in `app_log`. `cron.job_run_details` diceva `succeeded`,
-- perché misura l'ACCODAMENTO e non l'esito HTTP — ed è precisamente l'inganno
-- contro cui è scritta la sezione qui sopra.
--
-- Chi guardò `/api/health` in quelle ore lesse «job senza battito:
-- candidature-retention» e concluse che il lavoro fosse rotto dalla nascita. Non lo
-- era: non aveva ancora nessuno da chiamare. Un allarme che descrive un guasto
-- inesistente costa esattamente quanto uno che tace su un guasto vero.
--
-- Quindi, per QUESTO file, due regole operative:
--   1. si applica **dopo** che il rilascio è in produzione e la route risponde
--      (`curl -s -o /dev/null -w '%{http_code}' https://app.kidville.it/api/notifiche/scadenze-documenti`
--       deve dare **405** su GET: 404 significa che il deploy non c'è ancora);
--   2. subito dopo l'apply si innesca il PRIMO battito a mano, invece di aspettare
--      le 05:47 della notte seguente — vedi il punto (c-bis) in fondo al file.
--      Senza, `/api/health` nomina questo job per un massimo di ~24 h senza che
--      nulla sia rotto, e chi legge impara che quel nome è rumore.
--
-- ─── LA FESSURA ORARIA: 05:47 UTC ──────────────────────────────────────────
--
-- Già occupate: 3:30 purge log, 4:17 news-retention, 4:23 consensi, 4:35
-- notifiche-retention, 4:41 iscrizioni-retention, 4:47 iscrizioni-sanitari, 4:53
-- audit-docente, 4:59 presenze-giustificazioni, 5:05 candidature-retention, 5:11
-- bonifica PII (lunedì), **5:17 retention-personale**, 6:00 promemoria e solleciti,
-- 7:00 mensa.
--
-- ⚠️ Le 5:17 sono il gemello scritto NELLO STESSO LAVORO
-- (`20260811234419_retention_personale_cron.sql`): non compare in `cron.job` finché
-- quella migrazione non è applicata, quindi una mappa costruita interrogando il
-- database non lo vedrebbe, e due lavori nati insieme potrebbero prendersi la
-- stessa fessura. Le due migrazioni vanno lette insieme, non una alla volta.
--
-- 05:47 non è solo «la prima libera»: sta DOPO il grappolo delle conservazioni
-- (4:35-5:11) e PRIMA del giro delle 6:00 verso le famiglie. Questo lavoro manda
-- email a persone, non cancella righe: alle 05:47 UTC in Italia sono le 07:47
-- d'estate e le 06:47 d'inverno, cioè l'avviso è già nella casella quando chi lo
-- riceve la apre. E resta fuori dagli orari di scuola.
--
-- Idempotente: la funzione è CREATE OR REPLACE, lo schedule fa
-- unschedule-se-presente + schedule. pg_cron NON esiste sul database di collaudo
-- della CI: il blocco `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa
-- migrazione passi senza fare niente, come le altre.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.scadenze_documenti_personale_http()
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
    -- nessun avviso di scadenza partirebbe mai, e non lo saprebbe nessuno — che è
    -- lo stesso guasto che questa migrazione esiste per chiudere.
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
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.scadenze_documenti_personale_http() OWNER TO postgres;

-- Porta con sé il cron secret: mai esposta ai ruoli client. In Supabase
-- anon/authenticated ricevono EXECUTE via GRANT esplicito, NON via PUBLIC:
-- revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.scadenze_documenti_personale_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scadenze_documenti_personale_http() TO service_role;

COMMENT ON FUNCTION public.scadenze_documenti_personale_http() IS
  'Chiama POST /api/notifiche/scadenze-documenti ogni notte alle 05:47 UTC: avvisa a 90, 60, 30 e 7 giorni dalla scadenza del documento d''identita'' del personale in servizio, e risollecita una volta a settimana quando la scadenza e'' gia'' superata. Notifica in-app all''interessata e alla segreteria della sede; email all''interessata da 60 giorni in giu'', e anche alla segreteria da 7 giorni in giu''. La condizione NORMALE di questo lavoro e'' non mandare niente: per questo il battito si scrive anche a zero righe, ed e'' l''unico modo di distinguere «nessuna scadenza» da «il cron non parte piu''». L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito in app_log, sorvegliato da /api/health tramite JOB_CRON con finestra 26 h.';

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'scadenze-documenti-personale';
  PERFORM cron.schedule(
    'scadenze-documenti-personale',
    '47 5 * * *',
    $cron$ SELECT public.scadenze_documenti_personale_http(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'apply):
--
--   -- (a) la funzione c'è ed è del solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'scadenze_documenti_personale_http';
--
--   -- (b) il lavoro è schedulato, giornaliero e attivo:
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'scadenze-documenti-personale';
--
--   -- (c-bis) IL PRIMO BATTITO, SUBITO — non la notte dopo.
--   --     Da eseguire una volta, appena dopo l'apply, con il deploy già in
--   --     produzione (vedi la PRECONDIZIONE in testa al file). Innesca lo stesso
--   --     giro che farebbe pg_cron alle 05:47, e chiude il freddo d'avvio di ~24 h
--   --     che sul gemello `candidature-retention` fu scambiato per un guasto.
--   --
--   --     ⚠️ NON è un no-op: manda per davvero gli avvisi eventualmente dovuti.
--   --     È accettabile qui perché l'unico modo di ricevere un avviso è avere una
--   --     riga in `anagrafica_personale` con `document_expiry` entro 90 giorni, e
--   --     quelle righe nascono solo da una pratica APPROVATA dalla segreteria: al
--   --     momento dell'apply la tabella è nuova e vuota, quindi il giro scrive il
--   --     battito e non spedisce niente. Questa riga NON sta dentro il blocco
--   --     `DO … cron.schedule` proprio per questo: la migrazione è idempotente e
--   --     verrebbe rieseguita, e una rilettura futura, a tabella piena, farebbe
--   --     partire avvisi veri a un'ora arbitraria del giorno.
--   SELECT public.scadenze_documenti_personale_http();
--
--   -- (c) LA PROVA VERA, che non è né (a) né (b) e arriva la notte dopo.
--   --     ⚠️ `n_avvisate = 0` è il risultato ATTESO quasi ogni notte: ciò che si
--   --     verifica è che la RIGA ci sia, non che il numero sia grande.
--   SELECT visto_l_ultima,
--          contesto->'campi'->>'esito'      AS esito,
--          contesto->'campi'->>'n_lette'    AS lette,
--          contesto->'campi'->>'n_avvisate' AS avvisate
--     FROM public.app_log
--    WHERE evento = 'cron'
--      AND contesto->'campi'->>'operazione' = 'scadenze-documenti-personale'
--    ORDER BY visto_l_ultima DESC LIMIT 5;
--
--   -- (d) e se (c) è vuota per più di 26 h, /api/health lo dice da solo:
--   --     `{"nome":"cron-battito","esito":"degradato",
--   --       "dettaglio":"job senza battito: scadenze-documenti-personale"}`
-- ═══════════════════════════════════════════════════════════════════════════════
