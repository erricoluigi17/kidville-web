-- ═══════════════════════════════════════════════════════════════════════════════
-- IL MOTIVO DELL'ASSENZA È UN DATO SANITARIO DI UN MINORE, E NON SCADEVA MAI
-- (rilievo privacy del collaudo, 2026-08-07)
--
-- ⚠️ NON APPLICATA dall'agente che l'ha scritta: la applica il coordinatore dopo
--    averne mostrato il testo. In produzione ci sono dati reali di famiglie.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL FATTO ─────────────────────────────────────────────────────────────────
--
-- `presenze.giustificazione_testo` raccoglie testo libero che l'interfaccia stessa
-- invita a riempire con un dato sanitario: il segnaposto del modulo genitore dice
-- testualmente «Es. febbre, visita medica, motivi familiari…». Il gemello
-- `presenze.note_appello` è la nota che il docente scrive facendo l'appello.
--
-- Le due colonne esistono dal baseline, ma il canale che le riempie era MORTO:
-- misurato in produzione il 2026-08-07, 49 righe di presenza e ZERO scritte da un
-- genitore. Il ciclo che rimette in vita «Comunica un'assenza» apre quel canale su
-- tutti e tre i gradi — nido, infanzia e primaria — e da quel momento la scuola
-- raccoglie quel testo da tutte le famiglie.
--
-- L'informativa pubblica (`src/app/privacy/page.tsx`, «Conservazione dei dati»)
-- promette, per i dati relativi alla salute: «per il tempo necessario alla finalità
-- che ne ha giustificato la raccolta e comunque non oltre la durata
-- dell'iscrizione». **Nessun meccanismo applicava quel termine**: nessuno dei
-- sedici lavori attivi in `cron.job` (contati in produzione il 2026-08-07) nominava
-- `presenze`, e il flusso di oblio su richiesta (`src/lib/gdpr/esegui.ts`, sedici
-- tabelle) non ci arrivava. Il testo sarebbe rimasto in tabella per sempre.
--
-- ─── LA MISURA, PRIMA DI SCRIVERE (produzione, 2026-08-07) ───────────────────
--
--   select count(*) righe,
--          count(*) filter (where giustificazione_testo is not null) con_motivo,
--          count(*) filter (where note_appello is not null)          con_note,
--          count(*) filter (where data < current_date - interval '12 months') oltre_12_mesi
--     from public.presenze;
--   →  righe 49 · con_motivo 1 · con_note 0 · oltre_12_mesi 0
--
--   select coalesce(stato,'(null)'), count(*) from public.alunni group by 1;
--   →  iscritto 32   (nessun altro stato, nessun NULL)
--
--   select count(*) from public.presenze p
--    where not exists (select 1 from public.alunni a where a.id = p.alunno_id);
--   →  0
--
-- E il predicato esatto del lavoro qui sotto, eseguito in sola lettura sullo
-- schema di produzione: 0 righe. Il `59 4 * * *` è libero (16 lavori in `cron.job`,
-- nessuno a quell'ora, nessuno con questo nome).
--
-- Quindi la corsa UNA TANTUM in fondo a questa migrazione tocca **zero righe**:
-- non c'è niente di storico da distruggere, e la regola comincia a valere da qui in
-- avanti. È il motivo per cui si scrive adesso e non «quando servirà».
--
-- ─── IL TERMINE, E PERCHÉ QUESTO ─────────────────────────────────────────────
--
-- DODICI MESI dal giorno dell'assenza, **e comunque non oltre l'iscrizione**.
--
--  · dodici mesi è la finestra che questo progetto ha già scelto tre volte per i
--    dati che CORROBORANO un fatto senza costituirlo — `consensi-retention`
--    (20260731142105), `news-retention` (20260720200000), `audit-docente-retention`
--    (20260801081423). Copre l'anno scolastico in cui una contestazione può
--    nascere («mio figlio non era assente quel giorno») e non un minuto di più;
--  · la seconda condizione è la promessa dell'informativa alla lettera: quando
--    l'alunno non è più iscritto il testo esce subito, senza aspettare i dodici
--    mesi. `COALESCE(stato,'iscritto')` di proposito: davanti a uno stato che non
--    si sa leggere si sceglie di NON cancellare — «non lo so» non vale «demolisci»
--    — e i dodici mesi arrivano comunque.
--
-- Il numero è dichiarato in UN posto solo (`v_mesi`) e il lock
-- `__tests__/architecture/informativa-conservazione-dichiarata.test.ts` lo confronta
-- con quello scritto nell'informativa: il giorno in cui uno dei due cambia senza
-- l'altro, il gate diventa rosso. È la stessa protezione già in piedi per i 24 mesi
-- delle domande non accolte, e nasce dallo stesso difetto ripetuto tre giorni dopo
-- su un'altra colonna.
--
-- ─── SI TOGLIE IL TESTO, NON LA RIGA ─────────────────────────────────────────
--
-- `stato`, `data` e `giustificata` sono dati sulla FREQUENZA, che la stessa
-- informativa dichiara soggetti agli obblighi di conservazione documentale degli
-- archivi scolastici. Un'assenza resta un'assenza: ciò che scade è il motivo.
--
-- Non si tocca nemmeno `giustificazione_firma` (la prova FEA della giustifica
-- firmata): ha natura e retention diverse, e cancellarla di straforo dentro una
-- migrazione sulla salute sarebbe una decisione presa senza dirlo. Resta aperta e
-- dichiarata come tale.
--
-- ─── DOVE STA IL COMPLEMENTO APPLICATIVO ─────────────────────────────────────
--
-- La scadenza automatica non sostituisce l'art. 17 e viceversa: l'oblio SU
-- RICHIESTA azzera le stesse due colonne subito, in `src/lib/gdpr/esegui.ts`
-- (`anonimizzaAlunno`, punto 2), e il conteggio arriva fino alla risposta delle due
-- route di Direzione (`presenze_bonificate`).
--
-- Il DB E2E della CI è un progetto separato e NON migrato: non ha pg_cron, e il
-- blocco `DO … EXCEPTION` lo protegge come già fanno le altre migrazioni.
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

  -- Un lavoro che cancella dati di famiglie deve dire ANCHE quando non cancella
  -- niente: «nessuna riga» non può voler dire insieme «tutto a posto» e «non è
  -- mai partito». Solo conteggi — nessun nome, nessun uuid, nessun testo.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server',
    -- Il numero si legge da `v_mesi`, non si riscrive: due copie dello stesso
    -- termine nello stesso file sono il modo in cui i termini divergono.
    format('retention motivo assenza e note appello (%s mesi o fine iscrizione)', v_mesi),
    'cron:presenze-giustificazioni-retention',
    jsonb_build_object('esito', 'retention-presenze-giustificazioni', 'n_righe', v_righe, 'mesi', v_mesi)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

REVOKE ALL ON FUNCTION public.presenze_giustificazioni_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presenze_giustificazioni_retention_tick() TO service_role;

COMMENT ON FUNCTION public.presenze_giustificazioni_retention_tick() IS
  'Azzera presenze.giustificazione_testo e presenze.note_appello dopo 12 MESI dal giorno dell''assenza, e subito per gli alunni non piu iscritti. Sono testo libero di natura sanitaria di un minore (il segnaposto del modulo genitore chiede un sintomo: "Es. febbre, visita medica..."), e l''informativa promette che i dati relativi alla salute non si conservano oltre la durata dell''iscrizione. La RIGA resta: stato, data e giustificata sono dati sulla frequenza, soggetti agli obblighi di conservazione documentale. Scrive una riga di conteggi in app_log a ogni esecuzione, anche quando non tocca niente.';

COMMENT ON COLUMN public.presenze.giustificazione_testo IS
  'Motivo dell''assenza scritto dalla FAMIGLIA (comunicazione anticipata o giustifica). Testo libero di natura sanitaria (art. 9 GDPR) su un minore: non esce mai nei log, non entra in nessuna notifica, e scade dopo 12 mesi o alla fine dell''iscrizione (job presenze-giustificazioni-retention). L''oblio su richiesta lo azzera subito (src/lib/gdpr/esegui.ts, anonimizzaAlunno).';

COMMENT ON COLUMN public.presenze.note_appello IS
  'Nota scritta dal DOCENTE durante l''appello. Stessa natura e stesso trattamento di giustificazione_testo: testo libero su un minore, scadenza a 12 mesi o alla fine dell''iscrizione, azzerata dall''oblio su richiesta.';

-- Bonifica UNA TANTUM sullo storico, all'applicazione della migrazione.
-- Misurata il 2026-08-07: tocca ZERO righe (nessuna presenza oltre i 12 mesi,
-- nessun alunno non iscritto, nessuna riga orfana). Sta qui lo stesso, perché il
-- giorno in cui questa migrazione verrà applicata potrebbe non essere oggi.
SELECT public.presenze_giustificazioni_retention_tick();

-- ── Il lavoro notturno ───────────────────────────────────────────────────────
-- Idempotente (unschedule-se-presente) e protetto dal blocco DO … EXCEPTION,
-- perché il database di collaudo della CI non ha pg_cron: lì la migrazione deve
-- poter passare senza fare nulla, come le altre.
-- 04:59 UTC: fuori dagli orari in cui la scuola lavora e lontano dagli altri
-- lavori già in tabella (3:30 purge log, 4:17 news, 4:23 consensi, 4:41
-- iscrizioni-retention, 4:47 iscrizioni-sanitari, 4:53 audit-docente, 5:11
-- bonifica PII, 6:00 solleciti, 7:00 mensa).
-- OGNI NOTTE e non una volta al mese: la seconda condizione — «non più iscritto»
-- — deve valere entro un giorno da quando la segreteria cambia lo stato, non
-- entro trenta.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'presenze-giustificazioni-retention';
  PERFORM cron.schedule(
    'presenze-giustificazioni-retention',
    '59 4 * * *',
    $cron$ SELECT public.presenze_giustificazioni_retention_tick(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'applicazione):
--
--   -- (a) la funzione c'è ed è eseguibile dal solo service_role:
--   SELECT proname FROM pg_proc WHERE proname = 'presenze_giustificazioni_retention_tick';
--
--   -- (b) il lavoro è schedulato:
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'presenze-giustificazioni-retention';
--
--   -- (c) LA PROVA VERA, che non è (a) né (b): la riga che il lavoro lascia in
--   --     app_log la notte dopo. Senza, «nessun log» non distingue «non c'era
--   --     niente da togliere» da «non è mai partito».
--   SELECT creato_il, contesto FROM public.app_log
--    WHERE fingerprint = 'cron:presenze-giustificazioni-retention'
--    ORDER BY creato_il DESC LIMIT 3;
-- ═══════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
