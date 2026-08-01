-- ═══════════════════════════════════════════════════════════════════════════════
-- Il lavoro notturno della conservazione smette di fallire in silenzio
-- Rilievo GRAVE del collaudo del 2026-08-01 (categoria log).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO. `iscrizioni_retention_http()` avvolgeva `net.http_post` in
-- `EXCEPTION WHEN OTHERS THEN null`. Se la chiamata alla route non parte — pg_net
-- non disponibile, URL irraggiungibile, errore di rete — non succede niente e
-- nessuno lo sa. È lo stesso identico difetto che la migrazione precedente ha
-- appena finito di riparare a valle: quella funzione falliva prima di scrivere il
-- log, questa non lo scriveva affatto.
--
-- Il pattern viene dagli altri quattro lavori notturni, dove è stato copiato
-- perché lì l'invio è ripetibile ogni cinque minuti e una riga per tentativo
-- sarebbe rumore. Qui no: questo job gira UNA VOLTA AL MESE e riguarda la
-- conservazione dei dati sanitari di 92 domande. Un'esecuzione persa in silenzio si
-- scopre trentun giorni dopo — se qualcuno guarda.
--
-- COSA FA. L'eccezione viene ancora ingoiata — il lavoro notturno non deve far
-- fallire la transazione di pg_cron — ma lascia una riga `error` in `app_log` col
-- codice dell'errore. Il fallimento resta innocuo e diventa visibile.
--
-- COSA NON FA. Non tocca dati, non cambia la pianificazione (`41 4 1 * *`), non
-- tocca gli altri quattro job.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.iscrizioni_retention_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    TEXT := public.cron_config('app.retention_iscrizioni_url');
  v_secret TEXT := public.cron_config('app.cron_secret');
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
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Ingoiata sì, muta no: pg_cron non deve fallire, ma un'esecuzione persa deve
    -- lasciare traccia. Solo SQLSTATE, mai il messaggio: potrebbe contenere l'URL,
    -- e in questo repo un URL con un token dentro è una credenziale.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'gdpr', 'server',
      'retention iscrizioni: la chiamata alla route non e'' partita',
      'cron:iscrizioni-retention-http-fallita',
      jsonb_build_object('esito', 'http-non-partita', 'codice', SQLSTATE)
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
  END;
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_http() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_retention_http() IS
  'Chiama POST /api/gdpr/retention-iscrizioni (24 mesi sulle domande mai evase o respinte, allegati compresi). A differenza degli altri quattro job via net.http_post, NON è muta sul fallimento: gira una volta al mese e riguarda dati sanitari di minori, quindi un''esecuzione persa lascia una riga `error` in app_log invece di sparire.';
