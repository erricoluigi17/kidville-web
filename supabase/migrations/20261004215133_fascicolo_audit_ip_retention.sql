-- ═══════════════════════════════════════════════════════════════════════════════
-- GLI IP DEL REGISTRO DEGLI ACCESSI SI CONSERVANO UN ANNO
-- (decisione del titolare, 2026-10-04)
--
-- STATO: NON APPLICATA al 2026-10-04, e di proposito. Sta nella PR #184 e la applica
-- l'integrazione Supabase al merge, con la `version` di questo file. Applicarla
-- prima a mano (MCP `apply_migration`, `supabase db push`) registrerebbe una seconda
-- riga in `supabase_migrations.schema_migrations` al momento del merge.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL FATTO ─────────────────────────────────────────────────────────────────
--
-- `fascicolo_accessi_audit` registra chi apre i dati di un bambino: gli elenchi, i
-- documenti del fascicolo e, da questa PR, la scheda anagrafica consultata dalle
-- insegnanti. Ogni riga porta anche `ip` (da dove) e `user_agent` (con quale
-- dispositivo) di chi ha consultato, e nessun termine li faceva scadere: sarebbero
-- rimasti in tabella per sempre. Domanda al titolare, «per quanto si tengono gli
-- IP?»; risposta, «un anno».
--
-- ─── COSA SCADE, E COSA NO ───────────────────────────────────────────────────
--
-- Scadono `ip` e `user_agent`, dopo DODICI MESI dalla data della riga (`creato_il`).
--
--  · ANCHE `user_agent`, non solo `ip`: il dispositivo e il browser hanno la stessa
--    natura dell'indirizzo, perché insieme identificano la persona che ha
--    consultato. Togliere l'uno e lasciare l'altro lascerebbe il difetto a metà.
--    È la stessa coppia che già scade in `chat_vigilanza_accessi`
--    (`vigilanza-chat-retention`) e nei consensi (`consensi-retention`).
--  · LA RIGA RESTA: `alunno_id`, `documento_id`, `utente_id`, `azione`, `finalita`
--    e `creato_il` sono il registro che risponde alla domanda di una famiglia, «chi
--    ha aperto la scheda di mio figlio?», e quella risposta non scade. Nessuna
--    `DELETE`: si azzerano due colonne, non si toglie una traccia.
--  · VALE PER TUTTO IL REGISTRO, non solo per le aperture della scheda: la natura
--    del dato non dipende da quale schermata l'ha prodotto.
--  · Una riga con `creato_il` NULL non scade (il confronto è falso): davanti a una
--    data che non si conosce non si sceglie di cancellare. Il default della colonna
--    è `now()`, quindi è un caso che non nasce dall'applicazione.
--
-- L'INFORMATIVA PER LE FAMIGLIE NON CAMBIA (decisione del titolare): gli IP di
-- questo registro sono del PERSONALE che consulta, non delle famiglie.
--
-- ─── PERCHÉ UNA FUNZIONE SQL E NON UNA ROUTE ─────────────────────────────────
--
-- Le scadenze che passano da una route (`galleria-retention`,
-- `cestino-registro-retention`) ci passano perché devono togliere FILE dallo
-- Storage, e da SQL i file non si cancellano (lock `storage-delete-vietata-in-sql`).
-- Qui non c'è nessun file: è un `UPDATE` su due colonne di una tabella, e una
-- funzione SQL schedulata con `pg_cron` non ha una route da tenere viva, un
-- segreto da far viaggiare né un deploy da cui dipendere. È lo stesso stampo di
-- `presenze_giustificazioni_retention_tick` (il motivo dell'assenza).
--
-- `SECURITY DEFINER` di proprietà di `postgres`, con `search_path` fissato, ed
-- eseguibile dal solo `service_role` (oltre che da `pg_cron`, che gira come
-- `postgres`): `anon` e `authenticated` non la possono chiamare.
--
-- ─── IL BATTITO, E LA SORVEGLIANZA ───────────────────────────────────────────
--
-- A ogni esecuzione, anche quando non tocca niente, una riga in `app_log` con
-- impronta `cron:fascicolo-audit-ip-retention`, nella forma che
-- `controlloBattitoCron` sa leggere: `evento = 'cron'`, contesto annidato sotto
-- `campi`, `esito = 'ok'`, `operazione = 'fascicolo-audit-ip-retention'`. Solo
-- conteggi e mesi: nessun IP, nessun uuid di persona.
--
-- In `src/lib/health/controlli.ts` il job sta in `JOB_CRON_NON_SORVEGLIATI` finché
-- questa migrazione non è applicata e il primo battito non è arrivato: il lock
-- `cron-sorvegliato-e-applicato` vieta di sorvegliare un lavoro che non esiste
-- ancora, e un nome sorvegliato in anticipo manderebbe `/api/health` in
-- `degradato` dal primo deploy. Dopo, entra in `JOB_CRON` con finestra 26 h, come
-- gli altri giornalieri, e questa testata va attestata con «APPLICATA il …».
--
-- ─── IDEMPOTENTE ─────────────────────────────────────────────────────────────
--
-- `CREATE OR REPLACE`, `REVOKE`/`GRANT`, `COMMENT ON` e il lavoro notturno tolto e
-- rimesso: la migrazione si può rilanciare (anche dal workflow «DB migrate (CI)»)
-- senza effetti diversi dal primo giro. Il DB E2E della CI non ha `pg_cron`: il
-- blocco `DO … EXCEPTION` lo lascia passare senza installare il lavoro, e lo dice.
--
-- Nessuna corsa una tantum qui dentro: la prima la fa il lavoro notturno, oppure il
-- coordinatore a mano dopo il merge (`SELECT public.fascicolo_audit_ip_retention_tick();`),
-- dopo averla mostrata.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fascicolo_audit_ip_retention_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- IL TERMINE, in un posto solo: «un anno», decisione del titolare del 2026-10-04.
  -- Il lock `fascicolo-audit-ip-retention.test.ts` lo confronta con quel numero.
  v_mesi  constant int := 12;
  v_righe int := 0;
BEGIN
  UPDATE public.fascicolo_accessi_audit AS a
     SET ip         = NULL,
         user_agent = NULL
   WHERE a.creato_il < now() - make_interval(months => v_mesi)
     -- Solo le righe che hanno ancora qualcosa da togliere: senza questa condizione
     -- il lavoro riscriverebbe ogni notte tutto lo storico già azzerato, e il
     -- conteggio nel battito direbbe un numero che non descrive nessun dato tolto.
     AND (a.ip IS NOT NULL OR a.user_agent IS NOT NULL);
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- IL BATTITO, nella forma che il sorvegliante sa leggere (vedi la testata).
  -- Solo conteggi: nessun IP, nessun uuid, nessun testo.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    -- Il numero si legge da `v_mesi`, non si riscrive: due copie dello stesso
    -- termine nello stesso file sono il modo in cui i termini divergono.
    format('retention indirizzo e dispositivo del registro accessi al fascicolo (%s mesi)', v_mesi),
    'cron:fascicolo-audit-ip-retention',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'fascicolo-audit-ip-retention',
        'esito',      'ok',
        'azione',     'retention-fascicolo-audit-ip',
        'n_righe',    v_righe,
        'mesi',       v_mesi
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;
END $$;

REVOKE ALL ON FUNCTION public.fascicolo_audit_ip_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fascicolo_audit_ip_retention_tick() TO service_role;

COMMENT ON FUNCTION public.fascicolo_audit_ip_retention_tick() IS
  'Azzera fascicolo_accessi_audit.ip e fascicolo_accessi_audit.user_agent dopo 12 MESI da creato_il (decisione del titolare del 2026-10-04: gli IP del registro degli accessi si conservano un anno). La RIGA resta: chi, quale bambino, quale documento, quale azione e quando sono il registro che risponde a chi ha aperto i dati di un minore. Scrive un battito in app_log a ogni esecuzione, anche quando non tocca niente, con evento=cron e contesto annidato sotto campi (esito=ok, operazione=fascicolo-audit-ip-retention). Job pg_cron fascicolo-audit-ip-retention, ogni notte.';

COMMENT ON COLUMN public.fascicolo_accessi_audit.ip IS
  'Indirizzo IP di chi ha consultato. Si conserva 12 mesi, poi il job fascicolo-audit-ip-retention lo azzera (la riga resta).';

COMMENT ON COLUMN public.fascicolo_accessi_audit.user_agent IS
  'Dispositivo e browser di chi ha consultato. Stessa natura e stessa scadenza di ip: 12 mesi, job fascicolo-audit-ip-retention.';

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
-- 04:29 UTC, ogni notte: fuori dagli orari in cui la scuola lavora, e su un minuto
-- che nessun altro lavoro in supabase/migrations/ occupa (4:17 news la domenica,
-- 4:23 consensi, 4:35 notifiche, 4:37 vigilanza chat, 4:41 iscrizioni, 4:47
-- iscrizioni-sanitari, 4:53 audit-docente, 4:59 motivo dell'assenza; e nessuno dei
-- lavori a cadenza di minuti cade al :29). OGNI NOTTE e non una volta al mese:
-- un mensile non si può sorvegliare da /api/health, perché `app_log` conserva 30
-- giorni e il battito sparirebbe prima del successivo.
-- Il nome sta sulla stessa riga di `cron.schedule(`: è così che lo trovano i lock.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fascicolo-audit-ip-retention';
  PERFORM cron.schedule('fascicolo-audit-ip-retention', '29 4 * * *', $cron$ SELECT public.fascicolo_audit_ip_retention_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN
  -- pg_cron non esiste sul database E2E della CI: lì la migrazione passa senza
  -- installare il lavoro. Lo si dice, invece di tacerlo: in produzione lo stesso
  -- avviso vorrebbe dire che la decisione del titolare non è applicata da niente.
  RAISE WARNING 'fascicolo-audit-ip-retention non installato (pg_cron assente?): %', SQLERRM;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (dopo il merge, in sola lettura):
--
--   -- (a) la funzione c'è:
--   SELECT proname FROM pg_proc WHERE proname = 'fascicolo_audit_ip_retention_tick';
--
--   -- (b) il lavoro è schedulato:
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'fascicolo-audit-ip-retention';
--
--   -- (c) LA PROVA VERA, che non è (a) né (b): il battito che il lavoro lascia in
--   --     app_log. Senza, «nessun log» non distingue «non c'era niente da
--   --     togliere» da «non è mai partito».
--   SELECT visto_l_ultima, contesto FROM public.app_log
--    WHERE fingerprint = 'cron:fascicolo-audit-ip-retention'
--    ORDER BY visto_l_ultima DESC LIMIT 3;
--
-- Dopo (c), il job passa da `JOB_CRON_NON_SORVEGLIATI` a `JOB_CRON` (26 h) in
-- `src/lib/health/controlli.ts`, e questa testata si attesta con «APPLICATA il …».
-- ═══════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
