-- ═══════════════════════════════════════════════════════════════════════════════
-- L'AUTOMA DELLA PURGA DEL CESTINO DEL REGISTRO E DEL FASCICOLO
-- — «cestino-registro-retention». Scritta il 2026-09-25.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── ✅ APPLICATA il 2026-09-25, DALL'INTEGRAZIONE AL MERGE DELLA PR #166 ──────
--
-- Version `20260924220100`, quella del FILE: una sola riga in `schema_migrations`
-- (nessun apply a mano). Guardato in sola lettura dopo il merge: `cron.job` ha una
-- riga `cestino-registro-retention`, `29 5 * * *`, `active = true`. La fotografia
-- delle applicate è stata rigenerata lo stesso giorno. Il nome resta ancora in
-- `JOB_CRON_NON_SORVEGLIATI` finché non si vede il primo battito (05:29 UTC): lo
-- sposta in `JOB_CRON` un passo successivo, non questo.
--
-- Com'era scritto prima dell'apply, e resta vero come regola: questa migrazione
-- viaggiava dentro la PR dei sei interventi e dell'app 1.1, e al merge
-- l'integrazione Supabase l'ha applicata da sé, con la version del FILE. Applicarla
-- a mano prima avrebbe fatto nascere due righe in `schema_migrations` (è successo il
-- 2026-09-12 con la gemella `galleria-retention`).
--
-- ⚠️ L'ORDINE conta ed è quello giusto per costruzione: il codice
-- (`POST /api/gdpr/retention-cestino-registro`) arriva in produzione con lo stesso
-- merge, e il primo giro è alle 05:29 UTC della notte dopo. Se il deploy di Vercel
-- fallisse, il cron chiamerebbe un URL che risponde 404 (la lezione di
-- `candidature-retention`, 2026-08-10): dopo il merge si innesca il primo giro a
-- mano e si guarda il battito, invece di aspettare la notte.
--
-- ⚠️ E DIPENDE DA `20260924220000_primaria_modifica_elimina.sql`, che aggiunge
-- `eliminato_il` alle due tabelle: la version di questo file è successiva apposta.
--
-- Fino all'apply il nome del lavoro stava in `JOB_CRON_NON_SORVEGLIATI`
-- (`src/lib/health/controlli.ts`) e NON in `JOB_CRON`, perché il lock
-- `cron-sorvegliato-e-applicato` vieta di sorvegliare un lavoro che non esiste
-- ancora: `/api/health` sarebbe andato in `degradato` dal primo deploy. Quella
-- condizione è superata dal 2026-09-25: la migrazione è applicata, attestata qui in
-- testa, e sta nella fotografia delle applicate
-- (`__tests__/fixtures/migrazioni-applicate-snapshot.json`). Il nome resta fra i
-- non sorvegliati per un'altra ragione: si aspetta il PRIMO BATTITO, alle 05:29 UTC.
-- Sorvegliare un lavoro che non ha mai scritto un battito vorrebbe dire
-- `degradato` fino al primo giro. Dopo quel battito lo si sposta in `JOB_CRON` con
-- `finestraMs: 26 * ORA`, come dice già la ragione scritta in `controlli.ts`.
--
-- ─── PERCHÉ QUESTA MIGRAZIONE ESISTE ─────────────────────────────────────────
--
-- Dalla spec del 2026-09-24 gli allegati del registro (`allegati_registro`) e i
-- documenti del fascicolo (`student_documents`) eliminati, sostituiti o rimasti
-- senza lezione vanno nel CESTINO (`eliminato_il`) e si possono ripristinare per
-- 7 giorni; passati quelli, riga e file spariscono. La costante che vale è
-- `GIORNI_CESTINO_REGISTRO` in `src/lib/primaria/cestino-registro.ts`, e la soglia
-- la calcola la ROUTE: questo file non porta il numero dentro nessuna istruzione,
-- così non c'è un secondo numero da tenere allineato. Il lock
-- `cestino-registro-giorni-un-numero-solo` pretende che, dove questo file NOMINA
-- dei giorni, siano gli stessi della costante.
--
-- `POST /api/gdpr/retention-cestino-registro` è il programma che mantiene la
-- promessa, e questa migrazione è la sola cosa che lo CHIAMA. Senza, sarebbe
-- codice morto: il cestino diventerebbe un archivio eterno di diagnosi, PEI e
-- verbali della 104 di minori, invisibili nel prodotto e non cancellati.
--
-- ─── PERCHÉ UNA ROUTE HTTP E NON UNA FUNZIONE SQL ───────────────────────────
--
-- Perché **i file si tolgono solo dalla Storage API**: `storage.objects` ha il
-- trigger `protect_objects_delete` (FOR EACH STATEMENT, `42501` anche a zero
-- righe) e il lock `storage-delete-vietata-in-sql` lo vieta per iscritto. E
-- comunque cancellare la riga di `storage.objects` toglie l'indice, non il binario.
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Stesso pattern di `galleria_retention_http`: si prende l'ORIGINE (`schema://host`)
-- di un URL già configurato nel Vault e vi si riattacca il proprio path. Un
-- segreto in più è un modo in più di avere un lavoro schedulato che non parte.
-- Nessun segreto è scritto in questo file: il cron secret si legge dal Vault
-- (`public.cron_config('app.cron_secret')`).
--
-- ─── COME SI SA CHE HA FUNZIONATO ───────────────────────────────────────────
--
-- `net.http_post` è ASINCRONO: accoda e basta, l'esito HTTP arriva altrove. Il
-- punto d'osservazione è il battito che la route scrive in `app_log`
-- (`evento='cron'`, `operazione='cestino-registro-retention'`, `esito='ok'`)
-- dentro un `finally`, quindi anche a zero righe e anche quando fallisce.
--
-- GIORNALIERO, e non per gusto: il termine è breve (una settimana) e una cadenza
-- più rada lo allungherebbe senza che nessuna riga di testo lo dica — il tetto
-- vero è sempre soglia + un giro. E solo un lavoro giornaliero è sorvegliabile da
-- `/api/health` con la finestra di 26 ore degli altri.
--
-- 05:29 UTC: fessura libera, verificata su `cron.job` il 2026-09-25 in sola
-- lettura. Nella fascia delle 5: 5:05 candidature-retention, 5:11
-- app-log-bonifica-pii (lunedì), 5:17 retention-personale, 5:23 galleria-retention,
-- 5:47 scadenze-documenti-personale. Il minuto 29 era quello lasciato libero dalla
-- gemella della galleria, a sei minuti dai vicini.
--
-- Idempotente: la funzione è `CREATE OR REPLACE`, lo schedule fa
-- unschedule-se-presente + schedule. **pg_cron NON esiste sul database E2E della
-- CI**: il blocco `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa
-- migrazione passi senza fare niente, come tutte le altre della sua famiglia.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cestino_registro_retention_http()
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
    PERFORM net.http_post(
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
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.cestino_registro_retention_http() OWNER TO postgres;

-- Innesca una distruzione irreversibile di documenti di minori portando con sé il
-- cron secret: mai esposta ai ruoli client. In Supabase anon/authenticated
-- ricevono EXECUTE via GRANT esplicito, NON via PUBLIC: revocare dal solo PUBLIC
-- non basta.
REVOKE ALL ON FUNCTION public.cestino_registro_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cestino_registro_retention_http() TO service_role;

COMMENT ON FUNCTION public.cestino_registro_retention_http() IS
  'Chiama POST /api/gdpr/retention-cestino-registro ogni notte alle 05:29 UTC: distrugge definitivamente, prima il file e poi la riga, gli allegati del registro (allegati_registro, bucket registro-allegati) e i documenti del fascicolo (student_documents, bucket sensitive_documents) che stanno nel cestino da piu'' di 7 giorni (GIORNI_CESTINO_REGISTRO in src/lib/primaria/cestino-registro.ts: la soglia la calcola la route). I file si tolgono solo dalla Storage API: per questo il lavoro e'' una route HTTP. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log con operazione cestino-registro-retention.';

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cestino-registro-retention';
  PERFORM cron.schedule(
    'cestino-registro-retention',
    '29 5 * * *',
    $cron$ SELECT public.cestino_registro_retention_http(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (dopo il merge, in sola lettura):
--
--   -- (a) la funzione c'è ed è del solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'cestino_registro_retention_http';
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_name = 'cestino_registro_retention_http';
--
--   -- (b) il lavoro è schedulato, GIORNALIERO e attivo:
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'cestino-registro-retention';
--
--   -- (c) LA PROVA VERA, che non è né (a) né (b):
--   SELECT visto_l_ultima, contesto->'campi'->>'esito', contesto->'campi'->>'n_righe'
--     FROM public.app_log
--    WHERE evento = 'cron'
--      AND contesto->'campi'->>'operazione' = 'cestino-registro-retention'
--    ORDER BY visto_l_ultima DESC LIMIT 5;
-- ═══════════════════════════════════════════════════════════════════════════════
