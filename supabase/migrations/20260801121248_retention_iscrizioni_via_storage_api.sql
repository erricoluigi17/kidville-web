-- ═══════════════════════════════════════════════════════════════════════════════
-- La regola dei 24 mesi non ha mai potuto cancellare niente
-- Rilievo BLOCCANTE del collaudo finale del 2026-08-01 (categoria privacy).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IN DUE RIGHE, PER CHI DEVE APPROVARLA
--   COSA FA. Ripara la pulizia automatica delle domande d'iscrizione vecchie, che
--   era stata messa in funzione stamattina e **non ha mai funzionato**. Da ora il
--   lavoro notturno lo fa il programma, che è l'unico che sa togliere anche i
--   documenti allegati.
--   COSA NON FA. Non cancella niente adesso: oggi non c'è nessuna domanda che
--   abbia due anni (la prima li compirà il 16 luglio 2028). Non tocca le 251
--   domande esistenti, i loro allegati, gli account o le altre due pulizie.
--   SE VA STORTO. Il caso peggiore è che la pulizia continui a non fare niente,
--   com'è oggi — ma da stanotte, a differenza di oggi, **lo scrive nel registro**.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL DIFETTO, MISURATO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- La migrazione `20260801081423` ha creato `iscrizioni_retention_tick()` e l'ha
-- agganciata a pg_cron. Il DDL è passato, il job risulta creato e attivo — e la
-- funzione **non è mai stata invocata nemmeno una volta**. Eseguita dal collaudo:
--
--     ERROR 42501: Direct deletion from storage tables is not allowed.
--                  Use the Storage API instead.
--
-- Su Supabase `storage.objects` ha il trigger `protect_objects_delete`, che è
-- **FOR EACH STATEMENT**: scatta a ogni DELETE anche quando le righe da cancellare
-- sono ZERO. Il job sarebbe fallito la prima notte utile — il 1° settembre — e
-- ogni volta dopo.
--
-- IL DANNO PEGGIORE NON ERA LA CANCELLAZIONE MANCATA, ERA IL SILENZIO. Quella
-- migrazione prometteva per iscritto: «Ogni notte i tre lavori lasciano una riga
-- nel registro degli eventi con i SOLI CONTEGGI […] Se un giorno non cancellano
-- niente, si vede». Non si vedeva: l'INSERT in `app_log` stava DOPO la DELETE, e
-- l'eccezione lo saltava. **La difesa che doveva accorgersi del guasto stava a
-- valle del guasto.** L'unica traccia sarebbe stata una riga in
-- `cron.job_run_details` che nessuno legge.
--
-- E c'è un secondo difetto sotto il primo: cancellare la riga di `storage.objects`
-- **non toglie il file** dall'archivio, toglie l'indice. Anche senza quel trigger,
-- la versione SQL avrebbe lasciato i documenti d'identità sul disco dichiarando di
-- averli cancellati.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COSA CAMBIA
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il lavoro passa al programma, che è l'unico che può parlare con l'archivio dei
-- file (`POST /api/gdpr/retention-iscrizioni`). È lo stesso schema con cui in
-- questo progetto girano già quattro lavori notturni — promemoria, notifiche push,
-- controllo allergie, fatture — e lo stesso che l'oblio su richiesta
-- (`src/lib/gdpr/esegui.ts`) usa da mesi per togliere i file: quella strada era
-- già giusta, il lavoro notturno SQL era l'eccezione.
--
-- La vecchia funzione non viene cancellata ma **svuotata**: chiamarla ora non fa
-- danni e lascia una riga di `warn` che dice dov'è finito il lavoro. Cancellarla
-- del tutto romperebbe qualunque cosa la chiami senza dire perché.
--
-- L'ordine dentro la route è quello di prima e per la stessa ragione: PRIMA i
-- file, POI le righe. Se i file non si tolgono, le righe **non si toccano** — un
-- documento senza più nessuna riga che lo nomini è invisibile, non cancellato.
--
-- ⚠️ SERVE UNA COSA FUORI DA QUESTO FILE: l'URL della route va messo nel vault,
-- come per gli altri quattro lavori:
--     select vault.create_secret('https://<dominio>/api/gdpr/retention-iscrizioni',
--                                'app.retention_iscrizioni_url');
-- Finché non c'è, il lavoro notturno **non parte** — e lo dice, invece di fallire
-- in silenzio come faceva prima.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. La vecchia funzione smette di provarci, e lo dichiara ────────────────
CREATE OR REPLACE FUNCTION public.iscrizioni_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Non tocca più `storage.objects`: da SQL non si può, e provarci faceva fallire
  -- l'intera transazione prima ancora di scrivere il log. Il lavoro vero è in
  -- `POST /api/gdpr/retention-iscrizioni`, chiamato da `iscrizioni_retention_http()`.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'warn', 'gdpr', 'server',
    'iscrizioni_retention_tick e'' stata sostituita: il lavoro lo fa la route applicativa',
    'cron:iscrizioni-retention-legacy',
    jsonb_build_object('esito', 'funzione-ritirata')
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now();
  RETURN 0;
END $$;

-- `CREATE OR REPLACE` non tocca i privilegi, quindi quelli della prima versione
-- restano — ma chi legge QUESTO file non può saperlo, e su Supabase
-- `REVOKE … FROM PUBLIC` da solo non basta (anon/authenticated hanno un GRANT
-- esplicito). Ripetuti qui perché la riga sia visibile accanto alla funzione.
REVOKE ALL ON FUNCTION public.iscrizioni_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_tick() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_retention_tick() IS
  'RITIRATA il 2026-08-01. Cancellava anche i file da storage.objects, cosa che Postgres vieta (trigger protect_objects_delete, FOR EACH STATEMENT): falliva a ogni esecuzione con 42501, e falliva PRIMA di scrivere la riga di log che avrebbe dovuto segnalarlo. Il lavoro è passato a POST /api/gdpr/retention-iscrizioni, che toglie i file dalla Storage API. Non cancellata per non rompere in silenzio chi la chiamasse.';

-- ── 2. Il lavoro notturno chiama il programma ───────────────────────────────
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
    -- L'URL non configurato è un INCIDENTE, non una nota: senza, la regola di
    -- conservazione dei dati sanitari di 92 domande non gira e nessuno lo sa.
    -- (AGENTS.md punto 4: configurazione mancante = livello error.)
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
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_http() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_retention_http() IS
  'Chiama POST /api/gdpr/retention-iscrizioni (24 mesi sulle domande mai evase o respinte, allegati compresi). Stesso schema degli altri quattro lavori notturni via net.http_post + vault. Se l''URL manca lascia una riga `error` in app_log: senza, l''assenza del lavoro sarebbe invisibile.';

-- ── 3. Il job punta alla funzione nuova ─────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'iscrizioni-retention';
  PERFORM cron.schedule('iscrizioni-retention', '41 4 1 * *',
    $cron$ SELECT public.iscrizioni_retention_http(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;
