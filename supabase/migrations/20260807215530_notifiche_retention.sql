-- ═══════════════════════════════════════════════════════════════════════════════
-- IL NOME DEL BAMBINO NELLA CAMPANELLA NON SCADEVA MAI
-- (rilievo privacy del collaudo, 2026-08-07)
--
-- ✅ APPLICATA in produzione il 2026-08-07, dal coordinatore, dopo aver RIMISURATO
--    il predicato invece di fidarsi della misura scritta qui sotto (che al momento
--    dell'applicazione aveva già qualche ora): `notifiche` = 1949 righe, di cui
--    **0** più vecchie di dodici mesi. Verificato subito dopo:
--      · `notifiche_retention_tick` è in `pg_proc`;
--      · `notifiche-retention` è in `cron.job`, `35 4 1 * *`, attivo;
--      · la corsa una tantum ha lasciato in `app_log` la sua riga, `n_righe: 0`;
--      · **1949 righe prima, 1949 dopo**: il DELETE non ha tolto niente, che è
--        esattamente ciò che era stato previsto. Su un `DELETE` questa non è una
--        formalità — è l'unica prova che separa «non c'era niente da cancellare»
--        da «ha cancellato qualcosa che non doveva».
--
--    ⚠️ Il nome del file è cambiato: `20260807213000` → `20260807215530`. La
--    `version` la assegna il database quando la migrazione entra, non chi scrive
--    il file, e il lock `migrazioni-complete.test.ts` confronta i due nomi.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL FATTO ─────────────────────────────────────────────────────────────────
--
-- Il ciclo che rimette in vita «Comunica un'assenza» produce, a ogni gesto del
-- genitore, una riga in `public.notifiche` il cui `corpo` è testualmente
--
--     «<nome e cognome di un minore> sarà assente il 09/08/2026.»
--
-- e, all'annullamento, la sua gemella. Prima di questo ciclo di notifiche
-- `assenza_comunicata` ne erano state emesse **zero, da sempre**: il canale era
-- morto. Da oggi lo alimentano tutte le famiglie di tutti e tre i gradi.
--
-- IL NOME NON È IL DIFETTO, ed è bene dirlo prima del resto: senza il nome
-- l'avviso al docente non serve a niente — è il motivo per cui la funzione
-- esiste — e il destinatario è la maestra della SUA sezione, che quel nome lo
-- conosce già. Il difetto è la CONSERVAZIONE SENZA TERMINE: nessuno dei 17
-- lavori attivi in `cron.job` (contati in produzione il 2026-08-07) tocca
-- `notifiche`, e l'unica cosa che ne ha mai cancellato righe è stata una
-- pulizia UNA TANTUM di orfane (`20260801081644`). Il nome di un bambino
-- sarebbe rimasto leggibile lì per sempre.
--
-- ─── LA MISURA, PRIMA DI SCRIVERE (produzione, 2026-08-07, sola lettura) ──────
--
--   select count(*) righe,
--          count(*) filter (where creato_il < now() - interval '12 months') oltre_12_mesi,
--          count(*) filter (where corpo is not null) con_corpo,
--          min(creato_il)::date piu_vecchia, max(creato_il)::date piu_recente
--     from public.notifiche;
--   →  righe 1949 · oltre_12_mesi 0 · con_corpo 1918
--      piu_vecchia 2026-07-06 · piu_recente 2026-08-07
--
-- Quindi la corsa UNA TANTUM in fondo a questo file tocca **zero righe**: la
-- campanella più vecchia ha un mese. Non c'è niente di storico da distruggere, e
-- la regola comincia a valere da qui in avanti — che è la ragione per cui si
-- scrive adesso e non «quando servirà».
--
-- ─── IL TERMINE, E PERCHÉ QUESTO ─────────────────────────────────────────────
--
-- DODICI MESI da `creato_il`.
--
--  · è la finestra che questo progetto ha già scelto quattro volte per i dati
--    che CORROBORANO un fatto senza costituirlo — `consensi-retention`
--    (20260731142105), `news-retention` (20260720200000),
--    `audit-docente-retention` (20260801081423) e, tre ore fa,
--    `presenze-giustificazioni-retention` (20260807211157);
--  · e soprattutto: **la notifica non deve sopravvivere al fatto che annuncia.**
--    Il motivo dell'assenza scade a dodici mesi dal giorno dell'assenza; se
--    l'avviso che porta il nome del bambino durasse di più, la scadenza appena
--    introdotta sulla colonna sarebbe aggirata dalla sua stessa eco. Due termini
--    diversi sullo stesso fatto sono un termine solo: il più lungo.
--
-- ─── SI TOGLIE LA RIGA, NON IL TESTO ─────────────────────────────────────────
--
-- Al contrario di `presenze`, dove la riga è il dato di frequenza e ciò che
-- scade è il motivo, qui la riga È il messaggio: una notifica senza titolo e
-- senza corpo non è un dato conservato, è una riga vuota che occupa la
-- campanella. Il fatto — l'assenza, l'avviso, il pagamento — vive nella sua
-- tabella e non si tocca.
--
-- ─── COSA QUESTA MIGRAZIONE NON CHIUDE, e va detto ───────────────────────────
--
-- L'OBLIO SU RICHIESTA (art. 17). `src/lib/gdpr/esegui.ts` tratta sedici tabelle
-- e `notifiche` non è fra queste: dopo un'anonimizzazione dell'alunno il nome
-- resta leggibile in campanella fino alla scadenza qui sotto. La scadenza
-- automatica non sostituisce l'art. 17 e viceversa — questa migrazione chiude il
-- «per sempre», non il «subito, su richiesta». Il complemento applicativo è
-- lavoro di chi tiene `src/lib/gdpr/esegui.ts`.
--
-- Il DB E2E della CI è un progetto separato e NON migrato: non ha pg_cron, e il
-- blocco `DO … EXCEPTION` lo protegge come già fanno le altre migrazioni.
-- ═══════════════════════════════════════════════════════════════════════════════

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

  -- Un lavoro che cancella dati di famiglie deve dire ANCHE quando non cancella
  -- niente: «nessuna riga» non può voler dire insieme «tutto a posto» e «non è
  -- mai partito». Solo conteggi — nessun nome, nessun uuid, nessun testo.
  --
  -- ⚠️ `evento = 'cron'` E NON `'gdpr'`, ed è la lezione appena pagata dal job
  -- gemello: `controlloBattitoCron` (`src/lib/health/controlli.ts`) cerca i
  -- battiti con `.eq('evento','cron')`. Un battito scritto guardando alla NATURA
  -- DEL DATO trattato invece che alla NATURA DEL SEGNALE non viene trovato da
  -- nessun controllo, e un lavoro che smette di girare non se ne accorge
  -- nessuno. Il contesto porta comunque il dominio, in `esito`.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    format('retention notifiche (%s mesi)', v_mesi),
    'cron:notifiche-retention',
    jsonb_build_object('esito', 'retention-notifiche', 'n_righe', v_righe, 'mesi', v_mesi)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

REVOKE ALL ON FUNCTION public.notifiche_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_retention_tick() TO service_role;

COMMENT ON FUNCTION public.notifiche_retention_tick() IS
  'Cancella le righe di public.notifiche piu vecchie di 12 MESI. Il corpo di una notifica porta il NOME di un minore ("<nome> sara assente il ...") ed e una copia di un fatto che vive nella sua tabella: la notifica non deve sopravvivere al fatto che annuncia (il motivo dell''assenza scade a 12 mesi, job presenze-giustificazioni-retention). Scrive una riga di conteggi in app_log a ogni esecuzione, anche quando non tocca niente, con evento=cron cosi che controlloBattitoCron la veda.';

COMMENT ON COLUMN public.notifiche.corpo IS
  'Testo dell''avviso mostrato in campanella. Puo contenere il NOME e COGNOME di un minore (es. "<nome> sara assente il 09/08/2026"): e persistito, e scade dopo 12 mesi (job notifiche-retention). L''oblio su richiesta NON lo tocca ancora: src/lib/gdpr/esegui.ts non tratta questa tabella.';

-- Bonifica UNA TANTUM sullo storico, all'applicazione della migrazione.
-- Misurata il 2026-08-07: tocca ZERO righe (la notifica più vecchia in
-- produzione è del 2026-07-06). Sta qui lo stesso, perché il giorno in cui
-- questa migrazione verrà applicata potrebbe non essere oggi.
SELECT public.notifiche_retention_tick();

-- ── Il lavoro periodico ──────────────────────────────────────────────────────
-- Idempotente (unschedule-se-presente) e protetto dal blocco DO … EXCEPTION,
-- perché il database di collaudo della CI non ha pg_cron: lì la migrazione deve
-- poter passare senza fare nulla, come le altre.
--
-- MENSILE e non notturno, al contrario del gemello sulle presenze: lì la seconda
-- condizione («non più iscritto») deve valere entro un giorno da quando la
-- segreteria cambia lo stato, qui il predicato è solo l'età della riga e un mese
-- di ritardo su una soglia di dodici mesi non cambia niente per nessuno. Girare
-- ogni notte costerebbe 365 scansioni l'anno per cancellare le stesse righe.
--
-- 04:35 del primo del mese: la fascia in cui stanno già le altre retention
-- mensili (4:23 consensi, 4:41 iscrizioni, 4:53 audit-docente) e uno slot
-- libero — verificato il 2026-08-07 sui 17 lavori in `cron.job`.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'notifiche-retention';
  PERFORM cron.schedule(
    'notifiche-retention',
    '35 4 1 * *',
    $cron$ SELECT public.notifiche_retention_tick(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'applicazione):
--
--   -- (a) la funzione c'è ed è eseguibile dal solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'notifiche_retention_tick';
--
--   -- (b) il lavoro è schedulato:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'notifiche-retention';
--
--   -- (c) LA PROVA VERA, che non è (a) né (b): la riga che il lavoro lascia in
--   --     app_log. La corsa una tantum ne scrive una SUBITO, quindi si può
--   --     controllare senza aspettare il primo del mese:
--   SELECT creato_il, contesto FROM public.app_log
--    WHERE fingerprint = 'cron:notifiche-retention'
--    ORDER BY creato_il DESC LIMIT 3;
-- ═══════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
