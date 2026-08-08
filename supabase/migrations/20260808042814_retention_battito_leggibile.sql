-- ═══════════════════════════════════════════════════════════════════════════════
-- I DUE LAVORI DI RETENTION SCRIVEVANO UN BATTITO CHE NESSUNO SAPEVA LEGGERE.
--
-- ─── IL FATTO (rilievo Q3 del quarto collaudo, misurato in sola lettura) ──────
--
-- La migrazione `20260807215530_notifiche_retention.sql` conteneva questa nota, in
-- buona fede e per iscritto:
--
--   ⚠️ `evento = 'cron'` E NON `'gdpr'` […] `controlloBattitoCron` cerca i battiti
--   con `.eq('evento','cron')`. Un battito scritto guardando alla NATURA DEL DATO
--   trattato invece che alla NATURA DEL SEGNALE non viene trovato da nessun
--   controllo, e un lavoro che smette di girare non se ne accorge nessuno.
--
-- La lezione era giusta e la correzione era a metà. Misurato in produzione:
--
--   select fingerprint, evento, contesto ? 'campi' as ha_campi, contesto::text
--     from public.app_log where fingerprint like 'cron:%retention';
--
--   cron:notifiche-retention                | cron | false | {"mesi":12,"esito":"retention-notifiche",…}
--   cron:presenze-giustificazioni-retention | gdpr | false | {"mesi":12,"esito":"retention-presenze-giustificazioni",…}
--
-- Due difetti indipendenti, e ognuno da solo bastava a rendere il battito inutile:
--
--  1. IL CONTESTO È PIATTO. `controlloBattitoCron` (src/lib/health/controlli.ts)
--     legge `riga.contesto?.campi` e fa `continue` su tutto il resto — quindi
--     scartava ANCHE la riga con `evento='cron'`, cioè proprio quella corretta
--     apposta. Il formato lo decide il consumatore: `logEvento` lato TypeScript
--     annida tutto sotto `campi`, e queste funzioni SQL sono il secondo produttore
--     dello stesso formato.
--  2. `esito` PORTAVA IL DOMINIO. Il controllo cerca `campi.esito = 'ok'`, che
--     risponde a «è andata bene?». «Di che cosa si occupa questo lavoro» è
--     un'altra domanda e ora ha un campo suo (`azione`).
--
-- E `presenze-giustificazioni-retention` era rimasto su `evento='gdpr'`: la lezione
-- scritta nel file gemello 44 minuti dopo non era stata riportata sul job che
-- l'aveva appena pagata.
--
-- ─── COSA CAMBIA, E COSA NO ──────────────────────────────────────────────────
--
-- Cambia SOLO la riga di log. Il predicato di cancellazione, i dodici mesi, la
-- schedulazione e i permessi restano identici: le due funzioni si ridefiniscono con
-- `CREATE OR REPLACE`, i job in `cron.job` continuano a chiamare gli stessi nomi.
-- Nessuna bonifica una tantum qui dentro: non c'è niente da bonificare, e le due
-- `SELECT … _tick()` che seguono servono solo a lasciare subito un battito della
-- forma nuova (cancellano zero righe che non avrebbero cancellato comunque).
--
-- Il complemento applicativo sta in `src/lib/health/controlli.ts`:
-- `presenze-giustificazioni-retention` entra in `JOB_CRON` con finestra 26 h;
-- `notifiche-retention`, MENSILE, resta dichiaratamente fuori in
-- `JOB_CRON_NON_SORVEGLIATI` — la finestra che servirebbe (~32 giorni) supera la
-- conservazione di `app_log` (30 giorni), quindi l'allarme suonerebbe 25 ore al
-- mese su un lavoro sano. Il lock è in
-- `__tests__/architecture/informativa-conservazione-dichiarata.test.ts`.
--
-- Il DB E2E della CI è un progetto separato e NON migrato: `CREATE OR REPLACE` non
-- dipende da pg_cron e le due chiamate finali sono protette come le altre.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.presenze_giustificazioni_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- IL TERMINE, in un posto solo. Dichiarato anche nell'informativa: il lock
  -- `informativa-conservazione-dichiarata.test.ts` confronta i due numeri.
  v_mesi  constant int := 12;
  v_righe int := 0;
BEGIN
  UPDATE public.presenze AS p
     SET giustificazione_testo = NULL,
         note_appello          = NULL
   -- Solo le righe che hanno davvero qualcosa da togliere: senza questa
   -- condizione il lavoro riscriverebbe ogni notte l'intero registro per non
   -- cancellare niente, e il conteggio nel log direbbe un numero che non
   -- descrive nessun dato rimosso.
   WHERE (p.giustificazione_testo IS NOT NULL OR p.note_appello IS NOT NULL)
     AND (
           p.data < current_date - make_interval(months => v_mesi)
        OR NOT EXISTS (
             SELECT 1
               FROM public.alunni a
              WHERE a.id = p.alunno_id
                AND COALESCE(a.stato, 'iscritto') = 'iscritto'
           )
         );
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- IL BATTITO, NELLA FORMA CHE IL SORVEGLIANTE SA LEGGERE.
  --  · `evento = 'cron'`  → il filtro `.eq('evento','cron')`;
  --  · `campi.esito = 'ok'` → la condizione che scartava questa riga;
  --  · `campi.operazione` → la chiave con cui il battito si lega al job in JOB_CRON.
  -- Il dominio del lavoro sta in `azione`: «di che cosa si occupa» e «com'è andata»
  -- sono due domande diverse, e mettere la prima nel campo della seconda è ciò che
  -- ha reso questo battito invisibile.
  -- Solo conteggi — nessun nome, nessun uuid, nessun testo.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    -- Il numero si legge da `v_mesi`, non si riscrive: due copie dello stesso
    -- termine nello stesso file sono il modo in cui i termini divergono.
    format('retention motivo assenza e note appello (%s mesi o fine iscrizione)', v_mesi),
    'cron:presenze-giustificazioni-retention',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'presenze-giustificazioni-retention',
        'esito',      'ok',
        'azione',     'retention-presenze-giustificazioni',
        'n_righe',    v_righe,
        'mesi',       v_mesi
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

REVOKE ALL ON FUNCTION public.presenze_giustificazioni_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presenze_giustificazioni_retention_tick() TO service_role;

CREATE OR REPLACE FUNCTION public.notifiche_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- IL TERMINE, in un posto solo.
  v_mesi  constant int := 12;
  v_righe int := 0;
BEGIN
  DELETE FROM public.notifiche n
   WHERE n.creato_il < now() - make_interval(months => v_mesi);
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- Stessa forma del gemello: annidato sotto `campi`, `esito = 'ok'`, dominio in
  -- `azione`. Questo job resta fuori da `JOB_CRON` perché è MENSILE (vedi
  -- `JOB_CRON_NON_SORVEGLIATI`), ma il battito dev'essere leggibile lo stesso: si
  -- segue con una query, e una query su un contesto piatto non trova niente.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    format('retention notifiche (%s mesi)', v_mesi),
    'cron:notifiche-retention',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'notifiche-retention',
        'esito',      'ok',
        'azione',     'retention-notifiche',
        'n_righe',    v_righe,
        'mesi',       v_mesi
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

REVOKE ALL ON FUNCTION public.notifiche_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_retention_tick() TO service_role;

COMMENT ON FUNCTION public.presenze_giustificazioni_retention_tick() IS
  'Azzera presenze.giustificazione_testo e presenze.note_appello dopo 12 MESI dal giorno dell''assenza, e subito per gli alunni non piu iscritti. Sono testo libero di natura sanitaria di un minore e l''informativa promette che i dati relativi alla salute non si conservano oltre la durata dell''iscrizione. La RIGA resta: stato, data e giustificata sono dati sulla frequenza. Scrive un battito in app_log a ogni esecuzione, anche quando non tocca niente, con evento=cron e contesto annidato sotto campi (esito=ok, operazione=presenze-giustificazioni-retention) cosi che controlloBattitoCron lo veda: e sorvegliato in JOB_CRON con finestra 26 h.';

COMMENT ON FUNCTION public.notifiche_retention_tick() IS
  'Cancella le righe di public.notifiche piu vecchie di 12 MESI. Il corpo di una notifica porta il NOME di un minore ed e una copia di un fatto che vive nella sua tabella: la notifica non deve sopravvivere al fatto che annuncia. Scrive un battito in app_log a ogni esecuzione con evento=cron e contesto annidato sotto campi (esito=ok, operazione=notifiche-retention). MENSILE: dichiarato fuori dalla sorveglianza di /api/health in JOB_CRON_NON_SORVEGLIATI, perche la finestra necessaria supererebbe i 30 giorni di conservazione di app_log.';

-- Un battito subito, nella forma nuova, senza aspettare la notte: entrambe le
-- funzioni sono idempotenti e su questo storico cancellano zero righe (misurato).
SELECT public.presenze_giustificazioni_retention_tick();
SELECT public.notifiche_retention_tick();
