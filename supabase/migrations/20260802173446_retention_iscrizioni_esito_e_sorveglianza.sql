-- ⚠️ IL NOME DI QUESTO FILE È STATO ALLINEATO ALLA PRODUZIONE il 2026-08-02.
--    `apply_migration` (MCP) NON usa il timestamp del file: ne genera uno proprio al momento
--    dell'applicazione. Applicando questa migrazione il repo si è ritrovato con una `version`
--    che in produzione non esisteva — e il lock `migrazioni-complete.test.ts` era VERDE lo
--    stesso, perché confronta il repo con una FOTOGRAFIA della produzione presa prima.
--    Chi applica una migrazione con quello strumento: rileggi subito
--    `supabase_migrations.schema_migrations`, rinomina il file con la version vera, e
--    rigenera la fotografia. Altrimenti il disallineamento non lo vede nessuno.
-- ═══════════════════════════════════════════════════════════════════════════════
-- La difesa del 1° agosto guardava dove il guasto non passa
-- Rilievo GRAVE del collaudo del 2026-08-02 (categoria debug).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IN QUATTRO RIGHE, PER CHI DEVE APPROVARLA
--   COSA FA. Fa in modo che la pulizia mensile delle domande d'iscrizione vecchie
--   (24 mesi, allegati compresi) si accorga di NON essere arrivata a destinazione.
--   Oggi, se la chiamata parte e poi fallisce per strada, non lo sa nessuno.
--   COSA NON FA. Non cancella niente, non tocca nessun dato di nessuna famiglia,
--   non cambia l'orario della pulizia (1° del mese, 4:41), non tocca gli altri
--   lavori automatici. Aggiunge un controllo che gira ogni ora e non fa nulla
--   quando è tutto a posto.
--   SE VA STORTA. Il caso peggiore è una riga in più nel registro degli eventi.
--   Il controllo si spegne con `select cron.unschedule('iscrizioni-retention-esito');`.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL DIFETTO, MISURATO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- La migrazione `20260801133432` ha avvolto `net.http_post` in un
-- `EXCEPTION WHEN OTHERS` che lascia una riga `error` in `app_log`, e ha scritto
-- nel commento della funzione che quel lavoro «NON è muto sul fallimento».
--
-- **Quella promessa il meccanismo non poteva mantenerla.** pg_net è ASINCRONO:
--
--     select pg_get_function_result(oid) from pg_proc
--      where pronamespace = 'net'::regnamespace and proname = 'http_post';
--     → bigint
--
-- `net.http_post` non esegue la richiesta: la ACCODA e restituisce subito un
-- numero d'ordine. La richiesta la esegue un processo separato, DOPO, fuori dalla
-- transazione; l'esito — 404, 500, timeout (il valore di fabbrica è **5 secondi**),
-- DNS che non risolve, host irraggiungibile — lo scrive in `net._http_response`.
-- Un `EXCEPTION WHEN OTHERS` attorno all'accodamento vede solo ciò che rompe
-- l'ACCODAMENTO (estensione assente, permessi, argomenti sbagliati), cioè quasi
-- mai. Al 2026-08-02 `net._http_response` conteneva 120 risposte degli altri
-- lavori e **nessuna funzione del database la leggeva**: 0 su 57.
--
-- È la stessa dinamica che quella migrazione descriveva per il difetto
-- precedente — «la difesa che doveva accorgersi del guasto stava a valle del
-- guasto» — ripetuta un piano più in là: si è replicata la FORMA di una difesa
-- (try/catch + log) senza verificare che il punto di osservazione vedesse il
-- guasto. Su un lavoro che gira UNA VOLTA AL MESE e riguarda i dati sanitari di
-- minori non iscritti, un'esecuzione persa in silenzio si scopre trentun giorni
-- dopo. Se qualcuno guarda.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COSA CAMBIA: SI GUARDA DOVE IL GUASTO PASSA DAVVERO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. **Il numero d'ordine si conserva.** `iscrizioni_retention_http()` scrive in
--    `iscrizioni_retention_esecuzioni` l'id restituito dall'accodamento. Senza
--    quello, l'esito che arriva dopo non è riconducibile a niente.
--
-- 2. **Qualcuno legge la risposta.** `iscrizioni_retention_sorveglia()` gira ogni
--    ora, cerca in `net._http_response` le risposte delle richieste ancora aperte
--    e scrive in `app_log` lo stato HTTP e, quando è andata male, il messaggio
--    d'errore e l'inizio del corpo. È la regola che AGENTS.md §3 impone per i
--    servizi di terze parti — «il corpo dell'errore non si butta MAI via» —
--    applicata al proprio lavoro notturno, che finora ne era esentato per
--    distrazione.
--
-- 3. **E se non arriva NESSUNA risposta?** pg_net cancella le risposte dopo sei
--    ore (`pg_net.ttl`). Una richiesta ancora aperta dopo sei ore ha un esito che
--    non si saprà mai: si chiude come `esito-ignoto` con una riga `error`.
--
-- 4. **E se non parte nemmeno la chiamata?** È il caso che nessuno copriva: pg_cron
--    spento, job cancellato, funzione che non esiste più. Il controllo orario
--    guarda anche quanto tempo è passato dall'ultima esecuzione ARRIVATA: oltre 32
--    giorni (il mese più lungo più un giorno di margine) scrive una riga `error`.
--    È l'unica difesa che non dipende dal trasporto che deve sorvegliare.
--
-- 5. **Il tempo massimo passa da 5 secondi a 2 minuti.** Cinque secondi sono il
--    valore di fabbrica di pg_net, non una misura: questa route cancella file
--    dall'archivio e righe dal database, e con novantadue domande non finisce in
--    cinque secondi. Con il timeout di fabbrica la sorveglianza appena aggiunta
--    avrebbe segnalato come guasto un lavoro che stava riuscendo.
--
-- 6. **Il commento della funzione dice la verità.** Quello di ieri prometteva una
--    garanzia che il meccanismo non poteva dare. Un commento falso è peggio di un
--    commento assente: chi legge smette di cercare.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COSA RESTA FUORI, DICHIARATO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Gli altri quattro lavori via `net.http_post` (promemoria, notifiche, allergie,
-- fatture) hanno la stessa cecità. NON vengono toccati qui: girano ogni 5-30
-- minuti, e un'esecuzione persa si riassorbe alla successiva. La differenza non è
-- il meccanismo, è la frequenza — e vale la pena scriverlo invece di lasciar
-- credere che siano sorvegliati.
--
-- ⚠️ NON APPLICATA da chi l'ha scritta. Va mostrata e approvata dal titolare prima
--    di toccare il database di produzione (regola del 2026-07-31).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Il registro delle esecuzioni ─────────────────────────────────────────
--
-- Dodici righe l'anno: nessun indice, non serve. Nessun dato personale — numeri
-- d'ordine, istanti, stati HTTP — e nessun `scuola_id`: la conservazione è una
-- regola del titolare del trattamento, non di una sede.
--
-- Perché non è `app_log`: la tabella dei log si svuota a 30 giorni, e questo
-- lavoro gira ogni 31. Una sorveglianza che si appoggiasse ai log direbbe «non
-- gira da un mese» proprio nei giorni in cui tutto funziona.
CREATE TABLE IF NOT EXISTS public.iscrizioni_retention_esecuzioni (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- L'id restituito da `net.http_post`, cioè la chiave di `net._http_response`.
  -- NULL solo sulla riga di posa scritta qui sotto.
  request_id    bigint,
  inviata_il    timestamptz NOT NULL DEFAULT now(),
  verificata_il timestamptz,
  stato_http    int,
  esito         text NOT NULL DEFAULT 'in-attesa'
                CHECK (esito IN ('in-attesa', 'ok', 'errore-http', 'esito-ignoto', 'avvio')),
  -- Diagnostica tecnica del trasporto (messaggio di pg_net, inizio del corpo della
  -- risposta). Mai contenuto di una domanda: questa route risponde con i soli
  -- conteggi.
  nota          text
);

-- RLS accesa SENZA policy: è la forma più stretta. `service_role` ha BYPASSRLS
-- (verificato in produzione), quindi il lavoro notturno passa; per chiunque altro
-- non esiste nessuna policy che permetta di leggere. Il `REVOKE` è la cintura
-- sopra la bretella: senza, il GRANT di default resterebbe appeso ad
-- anon/authenticated.
-- Nessuna policy dichiarata, di proposito: non ce n'è bisogno, e il lock
-- `rls-per-sede.test.ts` pretende — a ragione — che una policy nuova sia
-- accompagnata dalla rigenerazione della fotografia di `pg_policies`, che si può
-- fare solo DOPO l'applicazione. (Quel lock legge il testo grezzo del file, quindi
-- qui non si nominano nemmeno le due parole che cerca: è una scelta, non una
-- svista.)
ALTER TABLE public.iscrizioni_retention_esecuzioni ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.iscrizioni_retention_esecuzioni TO service_role;
REVOKE ALL ON public.iscrizioni_retention_esecuzioni FROM anon, authenticated;

COMMENT ON TABLE public.iscrizioni_retention_esecuzioni IS
  'Registro delle chiamate del lavoro mensile di conservazione delle domande d''iscrizione (24 mesi). Una riga per invio, con il numero d''ordine di pg_net e l''esito letto dopo da net._http_response. Esiste perché pg_net è asincrono: l''esito di net.http_post non è osservabile nella transazione che lo accoda. Non contiene dati personali.';

-- La riga di posa: dà un punto di partenza alla sorveglianza «da quanto tempo non
-- arriva un'esecuzione riuscita». Senza, il primo controllo griderebbe subito.
INSERT INTO public.iscrizioni_retention_esecuzioni (request_id, verificata_il, esito, nota)
SELECT NULL::bigint, now(), 'avvio', 'posa della sorveglianza'
 WHERE NOT EXISTS (SELECT 1 FROM public.iscrizioni_retention_esecuzioni);

-- ── 2. L'invio conserva il numero d'ordine ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.iscrizioni_retention_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url       TEXT := public.cron_config('app.retention_iscrizioni_url');
  v_secret    TEXT := public.cron_config('app.cron_secret');
  v_richiesta bigint;
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    -- L'URL non configurato è un INCIDENTE, non una nota: senza, la regola di
    -- conservazione non gira e nessuno lo sa. (AGENTS.md punto 4.)
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
    -- `net.http_post` ACCODA e restituisce un numero d'ordine: qui non si sa, e non
    -- si può sapere, se la richiesta arriverà. Il numero si conserva, ed è l'unico
    -- modo per riconoscere la risposta quando arriverà — la legge
    -- `iscrizioni_retention_sorveglia()`.
    SELECT net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb,
      -- 2 minuti, non i 5 secondi di fabbrica: la route toglie file dall'archivio e
      -- righe dal database. Con 5 secondi la sorveglianza segnalerebbe come guasto
      -- un lavoro riuscito.
      timeout_milliseconds := 120000
    ) INTO v_richiesta;

    INSERT INTO public.iscrizioni_retention_esecuzioni (request_id) VALUES (v_richiesta);
  EXCEPTION WHEN OTHERS THEN
    -- ATTENZIONE, ED È IL PUNTO DELLA CORREZIONE: questo ramo vede SOLO il
    -- fallimento dell'ACCODAMENTO (estensione pg_net assente, permessi, argomenti
    -- invalidi). NON vede 4xx/5xx, timeout, DNS, host irraggiungibile: quelli
    -- accadono dopo, in un altro processo, e li raccoglie la sorveglianza.
    -- Ingoiata sì, muta no: pg_cron non deve fallire. Solo SQLSTATE, mai il
    -- messaggio: potrebbe contenere l'URL, e in questo repo un URL con un token
    -- dentro è una credenziale.
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
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_http() TO service_role;

-- Il commento di ieri prometteva che questo lavoro «NON è muto sul fallimento».
-- Non poteva esserlo: guardava l'accodamento. Ora la promessa è quella che il
-- meccanismo può mantenere, e dice anche chi la mantiene.
COMMENT ON FUNCTION public.iscrizioni_retention_http() IS
  'Accoda POST /api/gdpr/retention-iscrizioni (24 mesi sulle domande mai evase o respinte, allegati compresi) e CONSERVA il numero d''ordine di pg_net in iscrizioni_retention_esecuzioni. Il blocco EXCEPTION qui dentro vede solo il fallimento dell''ACCODAMENTO: pg_net è asincrono, quindi 4xx/5xx, timeout, DNS e host irraggiungibile non passano di qui. A leggere l''esito vero (net._http_response) e a segnalare le esecuzioni mai arrivate è iscrizioni_retention_sorveglia(), job orario `iscrizioni-retention-esito`.';

-- ── 3. La sorveglianza: legge l'esito, e nota anche il silenzio ─────────────
CREATE OR REPLACE FUNCTION public.iscrizioni_retention_sorveglia()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_riga     RECORD;
  v_chiuse   int := 0;
  v_perse    int := 0;
  v_ultimo   timestamptz;
BEGIN
  -- (a) LE RISPOSTE ARRIVATE. `net._http_response.id` è il numero d'ordine
  -- restituito dall'accodamento: è l'unico modo di ricongiungere richiesta ed esito.
  FOR v_riga IN
    SELECT e.id,
           r.status_code,
           r.timed_out,
           r.error_msg,
           left(coalesce(r.content, ''), 300) AS corpo
      FROM public.iscrizioni_retention_esecuzioni e
      JOIN net._http_response r ON r.id = e.request_id
     WHERE e.verificata_il IS NULL
  LOOP
    UPDATE public.iscrizioni_retention_esecuzioni
       SET verificata_il = now(),
           stato_http    = v_riga.status_code,
           esito         = CASE WHEN v_riga.status_code = 200 AND v_riga.error_msg IS NULL
                                THEN 'ok' ELSE 'errore-http' END,
           nota          = left(coalesce(v_riga.error_msg, v_riga.corpo), 200)
     WHERE id = v_riga.id;
    v_chiuse := v_chiuse + 1;

    IF v_riga.status_code = 200 AND v_riga.error_msg IS NULL THEN
      -- ANCHE IL SUCCESSO si scrive (AGENTS.md punto 5): senza, «nessun log» non
      -- distingue «è andato tutto bene» da «non è mai partito niente» — che è
      -- esattamente l'ambiguità da cui nasce tutta questa storia.
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, stato_http, contesto)
      VALUES (
        'info', 'gdpr', 'server',
        'retention iscrizioni: la chiamata e'' arrivata a destinazione',
        'cron:iscrizioni-retention-arrivata',
        v_riga.status_code,
        jsonb_build_object('esito', 'http-arrivata')
      )
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1,
            visto_l_ultima = now(),
            stato_http = excluded.stato_http,
            contesto = excluded.contesto;
    ELSE
      -- Lo stato da solo non dice niente: `403` è muto, `403 "the domain is not
      -- verified"` dice tutto. Corpo troncato a 300 caratteri — questa route
      -- risponde con i soli conteggi, mai con dati di una domanda.
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, stato_http, contesto)
      VALUES (
        'error', 'gdpr', 'server',
        'retention iscrizioni: la chiamata alla route NON e'' andata a buon fine',
        'cron:iscrizioni-retention-http-esito',
        v_riga.status_code,
        jsonb_build_object(
          'esito', 'http-non-riuscita',
          'stato', v_riga.status_code,
          'scaduta', v_riga.timed_out,
          'errore', left(coalesce(v_riga.error_msg, ''), 200),
          'corpo', v_riga.corpo
        )
      )
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1,
            visto_l_ultima = now(),
            stato_http = excluded.stato_http,
            contesto = excluded.contesto;
    END IF;
  END LOOP;

  -- (b) LE RISPOSTE CHE NON ARRIVERANNO PIÙ. pg_net conserva le risposte sei ore
  -- (`pg_net.ttl`): passate quelle, l'esito non è più recuperabile. Chiuderle come
  -- «ignoto» è l'unica cosa onesta — e lasciarle aperte per sempre renderebbe muta
  -- anche la sorveglianza (a).
  UPDATE public.iscrizioni_retention_esecuzioni
     SET verificata_il = now(), esito = 'esito-ignoto'
   WHERE verificata_il IS NULL
     AND inviata_il < now() - interval '6 hours';
  GET DIAGNOSTICS v_perse = ROW_COUNT;

  IF v_perse > 0 THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'gdpr', 'server',
      'retention iscrizioni: nessuna risposta alla chiamata, esito non piu'' ricostruibile',
      'cron:iscrizioni-retention-senza-risposta',
      jsonb_build_object('esito', 'esito-ignoto', 'n_richieste', v_perse)
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
  END IF;

  -- (c) IL SILENZIO. Non dipende dal trasporto e non dipende da pg_cron: se
  -- l'ultima esecuzione ARRIVATA è più vecchia di 32 giorni, qualcosa a monte non
  -- sta girando — il job cancellato, pg_cron spento, la funzione sostituita. È il
  -- caso che nessuna difesa copriva, ed è quello che si scoprirebbe più tardi.
  -- 32 giorni = il mese più lungo (31) più un giorno di margine.
  SELECT max(verificata_il) INTO v_ultimo
    FROM public.iscrizioni_retention_esecuzioni
   WHERE esito IN ('ok', 'avvio');

  IF v_ultimo IS NULL OR v_ultimo < now() - interval '32 days' THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'gdpr', 'server',
      'retention iscrizioni: da oltre 32 giorni nessuna esecuzione e'' arrivata a destinazione',
      'cron:iscrizioni-retention-ferma',
      jsonb_build_object(
        'esito', 'retention-ferma',
        'giorni', COALESCE(EXTRACT(DAY FROM now() - v_ultimo)::int, -1)
      )
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
  END IF;

  RETURN v_chiuse;
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_retention_sorveglia() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_sorveglia() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_retention_sorveglia() IS
  'Sorveglia il lavoro mensile di conservazione delle domande d''iscrizione, dal lato in cui il guasto è osservabile. Tre controlli: (a) legge in net._http_response l''esito delle chiamate accodate e lo scrive in app_log — stato, messaggio e inizio del corpo quando è andata male, e una riga anche quando è andata bene; (b) chiude come `esito-ignoto` le richieste rimaste senza risposta oltre le 6 ore di pg_net.ttl; (c) segnala se da oltre 32 giorni nessuna esecuzione è arrivata a destinazione — l''unico controllo che non dipende dal trasporto né da pg_cron. Non tocca nessun dato personale.';

-- ── 4. Il job orario ────────────────────────────────────────────────────────
-- Ogni ora, non ogni mese: la risposta va letta entro le sei ore in cui pg_net la
-- conserva, e il controllo del silenzio deve poter suonare in un giorno qualunque.
-- Quando non c'è niente da fare non fa niente e non scrive niente.
-- Minuto 27: libero da tutti gli altri lavori (30 3, 17 4, 23 4, 41 4, 47 4, 53 4,
-- 11 5, 0 6, 0 7, e i periodici */5 */10 */30).
-- Protetto dal blocco DO … EXCEPTION perché il database di collaudo della CI non ha
-- pg_cron: lì la migrazione deve poter passare senza fare nulla.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'iscrizioni-retention-esito';
  PERFORM cron.schedule('iscrizioni-retention-esito', '27 * * * *',
    $cron$ SELECT public.iscrizioni_retention_sorveglia(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;
