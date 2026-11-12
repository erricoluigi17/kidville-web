-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.9 · «Chiusura automatica dell'anno» · M49a (compito 4.9.1)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- COSA FA:
--   · il vincolo `anni_sede_domande_solo_aperto`: un anno `in_chiusura` o `chiuso` non accetta domande. È un TRIGGER DI VINCOLO
--     DIFFERITO e non un CHECK, perché un CHECK si guarda a ogni istruzione e `passaggio_conferma` (4.8) porta il vecchio anno a
--     `in_chiusura` in una istruzione e spegne `domande_aperte` nella successiva: con un CHECK la conferma fallirebbe. Differito, si
--     guarda lo stato FINALE alla COMMIT, in qualunque ordine siano scritti i due campi;
--   · `anno_stati_aggiorna(p_scuola, p_oggi)`: il PASSO 2 del tick. `corrente → in_chiusura` il giorno dopo `ultimo_giorno_aperto`,
--     `in_chiusura → chiuso` il giorno dopo `fine`; un anno in ritardo fa i due salti in un giro. Nello stesso UPDATE spegne
--     `domande_aperte`. NON promuove MAI un anno a `corrente`: il passaggio lo fa una persona (4.8). Se la guardia dell'anno è
--     spenta (`anno_regole.guardia_attiva = false`) e la sede non è di prova né di simulazione NON cambia lo stato di niente e scrive
--     un `error`. Il motivo NON è più «`in_chiusura` senza guardia non proteggerebbe niente»: con la regola R-a (giro 1) la segreteria
--     scrive in `in_chiusura` anche a guardia accesa, senza gettone. Quello che `in_chiusura` porta davvero è la SOLA LETTURA DEI
--     DOCENTI (le route e `sezioni_visibili_docente`), e `chiuso` il gettone per tutti: a guardia spenta il cambio di stato
--     toglierebbe la scrittura ai docenti senza che la guardia protegga il resto, e si perderebbe l'unico segnale che qualcosa non è
--     stato fatto. Conseguenza da dire al titolare: a guardia spenta i docenti SCRIVONO anche in agosto, e la sola lettura arriva
--     soltanto quando la guardia si accende;
--   · `anni_tick` ridefinita: il passo 1 (crea l'anno successivo) è quello della 4.5 e in fondo al suo blocco svuota la coda dei vincoli
--     differiti (N2: un errore lì ferma solo la sua sede), poi i passi 2 e 3 per ogni sede, ognuno nel suo blocco. Il battito `cron:anni-tick` è sempre uno solo, con gli stessi due esiti (`ok`, `ok-parziale`);
--   · `anno_invarianti()` con la riga 16 (nessuna domanda aperta su un anno `in_chiusura` o `chiuso`). Le righe 12 e 14 esistono già:
--     la bozza del piano diceva «12», la misura dice che il numero libero è 16 (la 15 è dello storico delle classi, 4.8).
--
-- Il giorno è SEMPRE quello passato o `giorno_roma(now())`, mai `CURRENT_DATE` e mai l'ora UTC: a Roma mezzanotte arriva fra le 22
-- e le 23 UTC, e nelle due notti del cambio d'ora il giorno di Roma e quello UTC sono diversi per un'ora in più o in meno.
--
-- Nessuna scrittura su dati. Mai l'uuid di una sede, niente `schools.operativa`. Ogni funzione: SECURITY DEFINER, search_path fisso,
-- solo service_role. Idempotente (CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Questa migrazione NON fa UPDATE: un ALTER o un
-- CREATE TRIGGER su `anni_sede` dopo un UPDATE della stessa transazione urterebbe i trigger differiti pendenti (vedi la PR 1).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

-- ── 1 · Un anno che si chiude non accetta domande ───────────────────────────

CREATE OR REPLACE FUNCTION public.anni_sede_controlla_domande()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stato   text;
  v_domande boolean;
BEGIN
  -- Un trigger differito riceve la riga COM'ERA quando l'evento è stato accodato, non com'è alla COMMIT: se la conferma scrive prima
  -- lo stato e poi spegne le domande, l'evento del primo UPDATE porta ancora le domande accese. Si rilegge quindi la riga di adesso.
  SELECT a.stato, a.domande_aperte INTO v_stato, v_domande FROM public.anni_sede a WHERE a.id = NEW.id;
  IF FOUND AND v_domande AND v_stato IN ('in_chiusura', 'chiuso') THEN
    RAISE EXCEPTION 'ANNO_CHIUSO_CON_DOMANDE'
      USING ERRCODE = 'check_violation',
            DETAIL = json_build_object('anno_sede_id', NEW.id, 'stato', v_stato)::text;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS anni_sede_domande_solo_aperto ON public.anni_sede;
CREATE CONSTRAINT TRIGGER anni_sede_domande_solo_aperto
  AFTER INSERT OR UPDATE OF stato, domande_aperte ON public.anni_sede
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.domande_aperte AND NEW.stato IN ('in_chiusura', 'chiuso'))
  EXECUTE FUNCTION public.anni_sede_controlla_domande();

-- ── 2 · Il passo 2 del tick, per una sede ───────────────────────────────────

-- Restituisce {"in_chiusura":n,"chiusi":n,"saltati_guardia_spenta":n}: quanti anni sono passati a `in_chiusura`, quanti a `chiuso`, e
-- quanti cambi erano dovuti ma NON sono stati fatti perché la guardia è spenta (ognuno è un salto: un anno in ritardo ne vale due).
--   · «dovuto» è `corrente` con `p_oggi > ultimo_giorno_aperto` (→ `in_chiusura`) e `corrente`/`in_chiusura` con `p_oggi > fine`
--     (→ `chiuso`). Mai altro: un anno `in_preparazione` o `iscrizioni_aperte` non si tocca, e nessun anno diventa `corrente`.
--   · Il vecchio anno può essere GIÀ `in_chiusura` perché la conferma del passaggio (4.8) ve lo ha portato: allora il primo salto
--     non c'è, e la funzione non fa niente per quello. Rifatta due volte non cambia niente la seconda.
--   · I due `UPDATE` hanno `WHERE stato = <lo stato letto>`: se fra la lettura e la scrittura un altro (la conferma) ha cambiato lo
--     stato, l'UPDATE non tocca la riga e non si scrive una storia che non è successa.
--   · Guardia spenta: `anno_regole.guardia_attiva` falso (o nessuna riga) E la sede non è `e2e00000…` né in `sedi_simulazione`. Allora
--     niente cambia, e se c'era qualcosa di dovuto si scrive UN `error` (`anni-tick-guardia-spenta:<sede>`, per giorno) con i soli
--     conteggi. Se non c'è niente di dovuto non si scrive niente: il battito a vuoto di undici mesi su dodici non è un allarme.
--   · La porta del giorno è quella del tick: un `p_oggi` che non è quello di Roma (o ieri, per il giro a cavallo di mezzanotte) è
--     ammesso solo per una sede di prova o di simulazione, altrimenti ANNI_TICK_OGGI_NON_AMMESSO prima di toccare niente.
-- Per ogni cambio: una riga in `anni_sede_stati` (`da` NULL: il job non è una persona) e una riga `info` `anno-stato` con soli uuid e codici.
CREATE OR REPLACE FUNCTION public.anno_stati_aggiorna(p_scuola uuid, p_oggi date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ammessa      boolean;
  v_guardia      boolean;
  v_roma         date := public.giorno_roma(now());
  r              record;
  v_salti        integer;
  v_in_chiusura  integer := 0;
  v_chiusi       integer := 0;
  v_saltati      integer := 0;
BEGIN
  IF p_scuola IS NULL OR p_oggi IS NULL THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'oggi')::text;
  END IF;

  v_ammessa := p_scuola::text LIKE 'e2e00000%'
            OR EXISTS (SELECT 1 FROM public.anno_regole g WHERE p_scuola = ANY (g.sedi_simulazione));
  IF NOT v_ammessa AND NOT (p_oggi BETWEEN v_roma - 1 AND v_roma) THEN
    RAISE EXCEPTION 'ANNI_TICK_OGGI_NON_AMMESSO';
  END IF;
  v_guardia := v_ammessa OR coalesce((SELECT g.guardia_attiva FROM public.anno_regole g LIMIT 1), false);

  -- Gli anni della sede si bloccano tutti, in ordine di id (lo stesso ordine della conferma del passaggio: nessuna attesa circolare).
  -- Dopo l'attesa la lettura che segue è una istruzione nuova, e vede ciò che la conferma ha appena scritto.
  PERFORM 1 FROM public.anni_sede s WHERE s.scuola_id = p_scuola ORDER BY s.id FOR UPDATE;

  FOR r IN
    SELECT s.id, s.stato, s.ultimo_giorno_aperto, s.fine
      FROM public.anni_sede s
     WHERE s.scuola_id = p_scuola AND s.stato IN ('corrente', 'in_chiusura')
     ORDER BY s.inizio
  LOOP
    -- quanti salti sono dovuti: un `corrente` oltre la fine ne ha due, oltre l'ultimo giorno aperto uno; un `in_chiusura` oltre la fine uno
    v_salti := CASE WHEN r.stato = 'corrente' AND p_oggi > r.fine                 THEN 2
                    WHEN r.stato = 'corrente' AND p_oggi > r.ultimo_giorno_aperto THEN 1
                    WHEN r.stato = 'in_chiusura' AND p_oggi > r.fine              THEN 1
                    ELSE 0 END;
    CONTINUE WHEN v_salti = 0;

    -- Guardia spenta: nessun cambio di stato (vedi l'intestazione: i docenti continuano a scrivere finché non la si accende).
    IF NOT v_guardia THEN
      v_saltati := v_saltati + v_salti;
      CONTINUE;
    END IF;

    -- primo salto: corrente → in_chiusura. `AND stato = 'corrente'`: se la conferma lo ha già portato oltre, l'UPDATE non tocca la riga.
    IF r.stato = 'corrente' THEN
      UPDATE public.anni_sede SET stato = 'in_chiusura', domande_aperte = false WHERE id = r.id AND stato = 'corrente';
      IF FOUND THEN
        INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (r.id, 'in_chiusura', NULL);
        v_in_chiusura := v_in_chiusura + 1;
        PERFORM public.anno_stati_log(p_scuola, r.id, 'corrente', 'in_chiusura');
      END IF;
    END IF;

    -- secondo salto: in_chiusura → chiuso (anche nello stesso giro, per un anno in ritardo)
    IF p_oggi > r.fine THEN
      UPDATE public.anni_sede SET stato = 'chiuso', domande_aperte = false WHERE id = r.id AND stato = 'in_chiusura';
      IF FOUND THEN
        INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (r.id, 'chiuso', NULL);
        v_chiusi := v_chiusi + 1;
        PERFORM public.anno_stati_log(p_scuola, r.id, 'in_chiusura', 'chiuso');
      END IF;
    END IF;
  END LOOP;

  IF v_saltati > 0 THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
      VALUES ('error', 'cron', 'server', 'anni_tick: cambio di stato dovuto ma la guardia dell''anno è spenta', p_scuola,
              'anni-tick-guardia-spenta:' || p_scuola::text,
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'anni-tick', 'esito', 'guardia-spenta', 'n_saltati', v_saltati)))
      -- (correzioni dopo la revisione finale, F1) DO NOTHING: UN `error` al giorno per sede. Con la somma delle occorrenze la riga
      -- varrebbe k al k-esimo tick e `tasso-errore` (soglia 25 sulle occorrenze degli ultimi 15 minuti) si accenderebbe da solo.
      ON CONFLICT (fingerprint, giorno) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'anno_stati_aggiorna: errore della guardia spenta non registrato [%]', SQLSTATE;
    END;
  END IF;

  RETURN jsonb_build_object('in_chiusura', v_in_chiusura, 'chiusi', v_chiusi, 'saltati_guardia_spenta', v_saltati);
END
$$;

-- La riga `info` di un cambio di stato: soli uuid e codici di stato. Mai un errore: se il log non si scrive, il cambio resta.
CREATE OR REPLACE FUNCTION public.anno_stati_log(p_scuola uuid, p_anno_sede uuid, p_da text, p_a text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
  VALUES ('info', 'cron', 'server', 'anni_tick: stato dell''anno cambiato', p_scuola,
          'anno-stato:' || p_anno_sede::text || ':' || p_a,
          jsonb_build_object('campi', jsonb_build_object(
            'operazione', 'anni-tick', 'esito', 'stato', 'anno_sede_id', p_anno_sede, 'stato_da', p_da, 'stato_a', p_a)))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'anno_stati_log: riga del cambio di stato non scritta [%]', SQLSTATE;
END
$$;

-- ── 3 · Il tick: passo 1 (della 4.5, più lo svuotamento della coda di N2), passo 2 e passo 3 ──────────────────────────────

-- Copia di `anni_tick` della 4.5 (`20261109035209_anno_tick.sql`): il passo 1 è quello della 4.5, con in fondo al suo blocco lo svuotamento
-- dei vincoli differiti che ha scritto (N2). Cambia che: PRIMA del ciclo si esegue la coda dei vincoli differiti già in coda (F4); DOPO il
-- passo 1 di ogni sede e in un blocco suo gira il passo 2 (`anno_stati_aggiorna`); DOPO il passo 2 gira il passo 3 (il passaggio non fatto a
-- 7 giorni dall'inizio: una riga `error` per sede e per giorno). Se uno dei passi fallisce non ferma gli altri né le altre sedi. Un errore
-- scrive un `error` con il solo SQLSTATE e l'uuid. Il battito è uno solo: `ok-parziale` se `errori > 0` — e un cambio dovuto ma saltato
-- per la guardia spenta conta come errore, perché lo è.
-- Restituisce {"oggi","sedi","creati","copie","errori","stati"}: `stati` è il numero di cambi di stato fatti in questo giro.
CREATE OR REPLACE FUNCTION public.anni_tick(p_oggi date DEFAULT NULL, p_scuola uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi    date;
  v_ammessa boolean;
  v_sedi    integer := 0;
  v_creati  integer := 0;
  v_copie   integer := 0;
  v_errori  integer := 0;
  v_stati   integer := 0;
  r         record;
  v_prec    uuid;
  v_nuovo   uuid;
  v_n       integer;
  v_cfg     jsonb;
  v_passo2  jsonb;
BEGIN
  IF p_oggi IS NOT NULL THEN
    v_ammessa := coalesce(
      p_scuola IS NOT NULL
      AND (p_scuola::text LIKE 'e2e00000%'
           OR EXISTS (SELECT 1 FROM public.anno_regole g WHERE p_scuola = ANY (g.sedi_simulazione))),
      false);
    IF NOT v_ammessa THEN
      RAISE EXCEPTION 'ANNI_TICK_OGGI_NON_AMMESSO';
    END IF;
    v_oggi := p_oggi;
  ELSE
    v_oggi := public.giorno_roma(now());
  END IF;

  -- (correzioni dopo la revisione finale, F4) Gli eventi dei vincoli differiti GIÀ in coda in questa transazione (non scritti dal tick) si
  -- eseguono qui, una volta, fuori da ogni blocco di sede: `SET CONSTRAINTS … IMMEDIATE` esegue TUTTA la coda, e se uno di quegli eventi
  -- fallisse dentro il blocco di una sede verrebbe attribuito a lei, annullato col suo blocco e rimesso in coda (ogni sede in errore, e il
  -- giro che cade comunque alla COMMIT). Così una violazione che non è del tick lo ferma subito e per intero, col suo messaggio.
  SET CONSTRAINTS public.anni_sede_domande_solo_aperto, public.anni_sede_continuita IMMEDIATE;
  SET CONSTRAINTS public.anni_sede_domande_solo_aperto, public.anni_sede_continuita DEFERRED;

  FOR r IN
    SELECT DISTINCT s.scuola_id FROM public.anni_sede s
     WHERE p_scuola IS NULL OR s.scuola_id = p_scuola
     ORDER BY s.scuola_id
  LOOP
    v_sedi := v_sedi + 1;

    -- ── passo 1: l'anno successivo (come nella 4.5; in fondo al blocco lo svuotamento della coda dei vincoli differiti, N2)
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('anni_tick:' || r.scuola_id::text));

      SELECT s.id INTO v_prec FROM public.anni_sede s WHERE s.scuola_id = r.scuola_id ORDER BY s.inizio DESC LIMIT 1;
      v_n := public.anni_sede_crea_successivo(r.scuola_id, v_oggi);

      IF v_n > 0 THEN
        SELECT s.id INTO v_nuovo FROM public.anni_sede s WHERE s.scuola_id = r.scuola_id ORDER BY s.inizio DESC LIMIT 1;
        v_cfg := public.anno_copia_configurazione(v_prec, v_nuovo);

        BEGIN
          INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
          VALUES ('info', 'cron', 'server', 'anni_tick: anno successivo creato', r.scuola_id, 'anno-creato:' || v_nuovo::text,
                  jsonb_build_object('campi', jsonb_build_object(
                    'operazione', 'anni-tick', 'esito', 'creato',
                    'anno_sede_id', v_nuovo, 'anno_sede_da_id', v_prec,
                    'n_listino_voci', coalesce((v_cfg ->> 'listino_voci')::bigint, 0),
                    'n_moduli_richiesti', coalesce((v_cfg ->> 'moduli_richiesti')::bigint, 0),
                    'n_posti_autorizzati', coalesce((v_cfg ->> 'posti_autorizzati')::bigint, 0))))
          ON CONFLICT (fingerprint, giorno) DO UPDATE
            SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'anni_tick: riga dell''anno creato non scritta [%]', SQLSTATE;
        END;

        -- (correzioni, giro 2, N2) Gli eventi differiti scritti da questo passo si eseguono QUI, dentro il blocco della sede: se uno
        -- fallisce, il blocco lo annulla e lo scarta con sé, e l'errore resta di questa sede. Altrimenti passerebbe al passo 2, poi
        -- ai passi 2 delle sedi che seguono (ognuna incolpata), e il giro cadrebbe alla COMMIT.
        SET CONSTRAINTS public.anni_sede_domande_solo_aperto, public.anni_sede_continuita IMMEDIATE;
        SET CONSTRAINTS public.anni_sede_domande_solo_aperto, public.anni_sede_continuita DEFERRED;

        -- i conteggi si alzano SOLO a lavoro finito: se la copia fallisce, il blocco intero è annullato
        v_creati := v_creati + v_n;
        v_copie := v_copie + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errori := v_errori + 1;
      BEGIN
        INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
        VALUES ('error', 'cron', 'server', 'anni_tick: anno successivo non creato', r.scuola_id,
                'anni-tick-errore:' || r.scuola_id::text,
                jsonb_build_object('campi', jsonb_build_object(
                  'operazione', 'anni-tick', 'esito', 'errore', 'sqlstate', SQLSTATE)))
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'anni_tick: errore di una sede non registrato [%]', SQLSTATE;
      END;
    END;

    -- ── passo 2: gli stati (corrente → in_chiusura → chiuso), mai → corrente
    BEGIN
      v_passo2 := public.anno_stati_aggiorna(r.scuola_id, v_oggi);
      -- (giro 1, S1; giro 2, S1) I vincoli DIFFERITI `anni_sede_domande_solo_aperto` e `anni_sede_continuita`: se la sede ha un
      -- buco, lo scoprirebbero alla COMMIT, fuori da questo blocco, e butterebbero giù il giro di TUTTE le sedi. Qui li si
      -- verifica subito: l'errore resta di questa sede (il blocco annulla i suoi cambi di stato) e le altre proseguono.
      -- Poi tornano differiti, com'erano. La coda è vuota di eventi altrui (svuotata prima del ciclo, F4) e di quelli del passo 1
      -- (eseguiti in fondo al suo blocco, N2): qui ci sono solo quelli scritti da questo passo 2, e il loro errore è davvero suo.
      SET CONSTRAINTS public.anni_sede_domande_solo_aperto, public.anni_sede_continuita IMMEDIATE;
      SET CONSTRAINTS public.anni_sede_domande_solo_aperto, public.anni_sede_continuita DEFERRED;
      v_stati := v_stati + coalesce((v_passo2 ->> 'in_chiusura')::integer, 0) + coalesce((v_passo2 ->> 'chiusi')::integer, 0);
      IF coalesce((v_passo2 ->> 'saltati_guardia_spenta')::integer, 0) > 0 THEN
        v_errori := v_errori + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errori := v_errori + 1;
      BEGIN
        INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
        VALUES ('error', 'cron', 'server', 'anni_tick: stati degli anni non aggiornati', r.scuola_id,
                'anni-tick-stati-errore:' || r.scuola_id::text,
                jsonb_build_object('campi', jsonb_build_object(
                  'operazione', 'anni-tick', 'esito', 'errore-stati', 'sqlstate', SQLSTATE)))
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'anni_tick: errore dei stati di una sede non registrato [%]', SQLSTATE;
      END;
    END;

    -- ── passo 3 (chiusura A): il passaggio non fatto a 7 giorni o meno dall'inizio dell'anno nuovo è un incidente. UNA riga `error`
    -- al giorno per sede (la stessa impronta: al secondo giro del giorno `ON CONFLICT DO NOTHING` non scrive niente), col solo numero dei giorni. La salute resta
    -- `degradato` (`salute_anno().passaggio_da_fare`, stessa condizione) e non scrive nulla: un log scritto a ogni lettura di
    -- `/api/health` peggiorerebbe da solo il controllo `tasso-errore`. Le sedi di prova e di simulazione non contano.
    BEGIN
      IF r.scuola_id::text NOT LIKE 'e2e00000%'
         AND NOT EXISTS (SELECT 1 FROM public.anno_regole g WHERE r.scuola_id = ANY (g.sedi_simulazione)) THEN
        SELECT (n.inizio - v_oggi) INTO v_n
          FROM public.anni_sede n
         WHERE n.scuola_id = r.scuola_id AND n.stato IN ('in_preparazione', 'iscrizioni_aperte')
           AND v_oggi >= n.inizio - 7
           AND NOT EXISTS (SELECT 1 FROM public.anni_sede c
                            WHERE c.scuola_id = n.scuola_id AND c.stato = 'corrente' AND c.inizio >= n.inizio)
         ORDER BY n.inizio LIMIT 1;
        IF FOUND THEN
          INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
          VALUES ('error', 'cron', 'server', 'anni_tick: passaggio d''anno da fare', r.scuola_id,
                  'anni-tick-passaggio-da-fare:' || r.scuola_id::text,
                  jsonb_build_object('campi', jsonb_build_object(
                    'operazione', 'anni-tick', 'esito', 'passaggio-da-fare', 'giorni_all_inizio', v_n)))
          -- (correzioni dopo la revisione finale, F1) DO NOTHING: UN `error` al giorno per sede, non uno che somma le occorrenze.
          ON CONFLICT (fingerprint, giorno) DO NOTHING;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'anni_tick: passaggio da fare non registrato [%]', SQLSTATE;
    END;
  END LOOP;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'anni_tick: giro completato', 'cron:anni-tick',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'anni-tick',
              'esito', CASE WHEN v_errori > 0 THEN 'ok-parziale' ELSE 'ok' END,
              'sedi', v_sedi, 'creati', v_creati, 'copie', v_copie, 'errori', v_errori, 'stati', v_stati,
              'simulato', p_oggi IS NOT NULL)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'anni_tick: battito non scritto [%]', SQLSTATE;
  END;

  RETURN jsonb_build_object('oggi', v_oggi, 'sedi', v_sedi, 'creati', v_creati, 'copie', v_copie, 'errori', v_errori, 'stati', v_stati);
END
$$;

-- ── 4 · Le invarianti: la riga 16 ───────────────────────────────────────────
-- Copia dell'ULTIMA definizione, quella della 4.8 (`20261109182422_anno_passaggio_conferma.sql`: righe 7 con `anno_visibile`, 11 e le sue
-- varianti, 13, 14, 15 e 15-bis). Cambiano due cose: il blocco 16, nuovo, subito dopo la riga 1, e la riga 6, che conta solo gli anni
-- `chiuso` (non più `in_chiusura`). Le righe 7, 15 e 15-bis restano quelle della 4.8, parola per parola.
CREATE OR REPLACE FUNCTION public.anno_invarianti()
RETURNS TABLE (invariante text, tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r             record;
  v_guardia_dal timestamptz;
  v_mappa6      jsonb := '{}'::jsonb;
  v_ha_nera     boolean;
  v_ha_anno     boolean;
  v_fuori       text[];
  v_cond        text[];
  v_col         text;
  v_n           bigint;
  v_trovata     boolean := false;
  d             record;
  v_oggi        date := public.giorno_roma(now());
  v_figli_vivi  uuid[];
  v_freq_vive   uuid[];
  v_lasciate    uuid[];
  v_genitori    uuid[] := '{}';
  v_figli       uuid[] := '{}';
  v_st_alunni   uuid[] := '{}';
  v_st_scuole   uuid[] := '{}';
  v_st_sezioni  uuid[] := '{}';
  v_foto        bigint := 0;
  v_avvisi      bigint := 0;
  v_thread      bigint := 0;
  v_frequenze   bigint := 0;
  v_guasti      bigint := 0;
  v_guasto      text;
  v_gen         record;
  v_non_arrivo  text;
  v_non_archiv  text;
BEGIN
  -- 1. Nessun giorno senza anno, nessun giorno in due anni.
  SELECT count(*) INTO v_n FROM (
    SELECT s.scuola_id, g::date
      FROM (SELECT a.scuola_id, min(a.inizio) AS da, max(a.fine) AS al
              FROM public.anni_sede a GROUP BY a.scuola_id) s
     CROSS JOIN LATERAL generate_series(s.da::timestamp, s.al::timestamp, interval '1 day') g
      LEFT JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND g::date <@ a.periodo
     GROUP BY s.scuola_id, g::date
    HAVING count(a.id) <> 1) x;
  invariante := '1'; tabella := 'anni_sede'; righe := v_n; RETURN NEXT;

  -- 16. (PR 4.9) Nessun anno `in_chiusura` o `chiuso` accetta ancora domande: il modulo pubblico non deve offrire un anno che si chiude.
  --     Il vincolo `anni_sede_domande_solo_aperto` lo impedisce alla COMMIT; questa riga è la rete per ciò che il vincolo non vede
  --     (un anno già in questo stato prima della migrazione).
  SELECT count(*) INTO v_n FROM public.anni_sede a WHERE a.stato IN ('in_chiusura', 'chiuso') AND a.domande_aperte;
  invariante := '16'; tabella := 'anni_sede (domande aperte su un anno chiuso)'; righe := v_n; RETURN NEXT;

  -- 6, prima parte: le violazioni di tutte le tabelle in una volta sola (poi si distribuiscono).
  SELECT g.guardia_attiva_dal INTO v_guardia_dal FROM public.anno_regole g;
  v_ha_nera := to_regclass('scatola_nera.modifiche') IS NOT NULL;
  IF v_ha_nera AND v_guardia_dal IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_object_agg(x.tabella, x.n), '{}'::jsonb) FROM (
        SELECT m.tabella, count(*) AS n
          FROM scatola_nera.modifiche m
          -- `nessuna` e `solo_contenuto` non guardano gli UPDATE (la scatola nera registra solo UPDATE): non sono un difetto
          JOIN public.anno_tabelle t ON t.tabella = m.tabella AND t.guardia = 'piena'
         CROSS JOIN LATERAL (SELECT public.anno_guardia_sede(m.tabella, m.prima) AS sede) s
          JOIN public.anni_sede a ON a.scuola_id = s.sede AND a.anno_id = (m.prima ->> 'anno_id')::uuid
         CROSS JOIN LATERAL (SELECT min(st.dal) AS dal FROM public.anni_sede_stati st
                              WHERE st.anno_sede_id = a.id AND st.stato = 'chiuso') ch
         WHERE m.modificata_il >= $1
           AND ch.dal IS NOT NULL
           AND m.modificata_il >= ch.dal
           -- le modifiche che la guardia lascia passare apposta non sono un difetto
           AND NOT (
             coalesce((SELECT bool_and(
                         c = ANY (public.anno_colonne_esenti(m.tabella))
                         OR (m.tabella = 'frequenze' AND c IN ('stato', 'quota_pagamento_id')))
                         FROM unnest(m.cambiate) c), false)
             AND (m.tabella <> 'frequenze'
                  OR NOT ('stato' = ANY (m.cambiate))
                  OR m.cambiate && ARRAY['moduli_completi', 'quota_saldata']))
           AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                            WHERE u.transazione = m.transazione AND u.tabella = m.tabella
                              AND (u.riga_id IS NULL OR u.riga_id = m.riga_id))
         GROUP BY m.tabella) x
    $q$ INTO v_mappa6 USING v_guardia_dal;
  END IF;

  FOR r IN SELECT * FROM public.anno_tabelle ORDER BY tabella LOOP
    CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL;
    v_ha_anno := public.anno_ha_colonna(r.tabella, 'anno_id');

    -- 2. Nessuna riga fuori dal suo anno (modo `data`).
    IF r.modo = 'data' THEN
      invariante := '2'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_fuori_periodo(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 6, seconda parte: una riga per tabella (se c'è la scatola nera).
    IF v_ha_nera THEN
      invariante := '6'; tabella := r.tabella; righe := coalesce((v_mappa6 ->> r.tabella)::bigint, 0);
      RETURN NEXT;
    END IF;

    -- 9. Nessuna riga nuova con una sezione di un altro anno.
    IF public.anno_ha_colonna(r.tabella, 'section_id') THEN
      invariante := '9'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_sezione_altro_anno(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 10a. La colonna e il trigger generico (una riga per tabella: 0, 1 o 2 difetti).
    invariante := '10a'; tabella := r.tabella;
    righe := (CASE WHEN v_ha_anno THEN 0 ELSE 1 END)
           + (CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc pr ON pr.oid = tg.tgfoid
                                 WHERE tg.tgrelid = to_regclass(format('public.%I', r.tabella))
                                   AND pr.proname = 'anno_assegna_e_verifica' AND NOT tg.tgisinternal)
                   THEN 0 ELSE 1 END);
    RETURN NEXT;

    -- 12. Nessuna riga senza anno e con una sede da cui ricavarlo.
    invariante := '12'; tabella := r.tabella;
    righe := CASE WHEN v_ha_anno THEN public.anno_righe_senza_anno_con_sede(r.tabella) ELSE 0 END;
    RETURN NEXT;

    -- 14. «madre ⇒ FK» (Ruling P5; corretta in 4.2.M): ogni tabella `madre` ha una chiave esterna vera dalla colonna
    --     `madre_colonna` alla tabella madre. La chiave può essere COMPOSTA (le `votazioni_*` hanno
    --     `(votazione_id, scuola_id)`): conta se contiene la `madre_colonna` E garantisce davvero la madre, cioè ha una
    --     colonna sola, oppure è MATCH FULL, oppure tutte le sue colonne sono NOT NULL. Una composta MATCH SIMPLE con una
    --     colonna che ammette NULL non basta: con quella colonna NULL Postgres non controlla la chiave.
    IF r.modo = 'madre' THEN
      invariante := '14'; tabella := r.tabella;
      righe := CASE WHEN EXISTS (
                 SELECT 1 FROM pg_constraint c
                  WHERE c.contype = 'f'
                    AND c.conrelid = to_regclass(format('public.%I', r.tabella))
                    AND c.confrelid = to_regclass(format('public.%I', r.madre_tabella))
                    AND EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                  JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                 WHERE at.attname = r.madre_colonna)
                    AND (cardinality(c.conkey) = 1
                         OR c.confmatchtype = 'f'
                         OR NOT EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                          JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                         WHERE NOT at.attnotnull))) THEN 0 ELSE 1 END;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF NOT v_ha_nera THEN
    invariante := '6'; tabella := '(scatola_nera assente)'; righe := 0; RETURN NEXT;
  END IF;

  -- 3. Nessuna doppia frequenza viva per lo stesso bambino nello stesso anno.
  SELECT count(*) INTO v_n FROM (
    SELECT f.alunno_id, f.anno_id FROM public.frequenze f
     WHERE f.stato IN ('in_attesa', 'iscritto')
     GROUP BY f.alunno_id, f.anno_id HAVING count(*) > 1) x;
  invariante := '3'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;

  -- 4. Nessun «iscritto» senza moduli o senza quota, ricalcolato dalla verità e non dai flag.
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.stato = 'iscritto' AND f.origine <> 'recupero'
     AND (EXISTS (SELECT 1 FROM public.moduli_richiesti m
                   WHERE m.anno_sede_id = f.anno_sede_id AND m.lista = f.tipo
                     AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                                      WHERE fm.frequenza_id = f.id AND fm.modulo_id = m.id))
          OR q.id IS NULL OR q.stato <> 'pagato');
  invariante := '4'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;
  --    4-bis. I flag dicono la verità (vale anche per chi non è «iscritto»).
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.quota_saldata IS DISTINCT FROM (q.id IS NOT NULL AND q.stato = 'pagato');
  invariante := '4'; tabella := 'frequenze (flag)'; righe := v_n; RETURN NEXT;

  -- 5. Nessuna competenza fuori dal periodo del suo anno.
  v_n := 0;
  IF to_regclass('public.pagamenti') IS NOT NULL AND public.anno_ha_colonna('pagamenti', 'anno_id') THEN
    EXECUTE 'SELECT count(*) FROM public.pagamenti p '
            'JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id '
            'WHERE p.periodo_competenza IS NOT NULL AND NOT (p.periodo_competenza <@ a.periodo)'
    INTO v_n;
  END IF;
  invariante := '5'; tabella := 'pagamenti'; righe := v_n; RETURN NEXT;

  -- 10b. Una tabella con `anno_id` che il registro non conosce.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_fuori
    FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND at.attname = 'anno_id' AND at.attnum > 0 AND NOT at.attisdropped
     AND c.relname NOT IN ('anni_sede', 'riconciliazione_anno')
     AND c.relname NOT IN (SELECT t.tabella FROM public.anno_tabelle t);
  IF v_fuori IS NULL THEN
    invariante := '10b'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  ELSE
    FOREACH v_col IN ARRAY v_fuori LOOP
      invariante := '10b'; tabella := v_col; righe := 1; RETURN NEXT;
    END LOOP;
  END IF;

  -- 11. La scheda alunno e la frequenza dell'anno attivo dicono la stessa cosa (solo chi ha la frequenza).
  --     Si confrontano `section_id` e i campi con lo STESSO nome e lo STESSO tipo su `alunni` e
  --     `frequenze`; lo stato e la retta hanno nomi e significati diversi e restano fuori.
  v_n := 0;
  -- 4.5.15 (I2): un bambino «in arrivo» ha la frequenza dell'anno attivo chiusa (è un ex alunno che torna) e la scheda no: non sono
  -- due copie della stessa cosa, e non si confrontano. `stato` si nomina solo dove la colonna c'è.
  v_non_arrivo := CASE WHEN public.anno_ha_colonna('alunni', 'stato')
                       THEN 'AND al.stato IS DISTINCT FROM ''in_arrivo'' ' ELSE '' END;
  IF to_regclass('public.alunni') IS NOT NULL THEN
    -- (giro 4, NB4) Una scheda ARCHIVIATA non ha classe (la 15-bis), mentre la frequenza chiusa può tenere la sua per la storia: quella coppia non è una
    -- discordanza. Ogni altra differenza di classe resta un allarme.
    v_cond := ARRAY[CASE WHEN public.anno_ha_colonna('alunni', 'archiviato_il')
                         THEN 'NOT (al.archiviato_il IS NOT NULL AND al.section_id IS NULL AND f.stato IN (''ritirato'', ''trasferito'', ''uscito'')) AND al.section_id IS DISTINCT FROM f.section_id'
                         ELSE 'al.section_id IS DISTINCT FROM f.section_id' END];
    -- Fase B (4.3.4): l'invariante guarda anche ciò che lo specchio inverso scrive in più (sospensione).
    FOREACH v_col IN ARRAY ARRAY['retta_a_carico_di', 'gruppo_mensa_id', 'giorno_scadenza_pagamenti',
                                 'usa_pannolino', 'retta_split_config', 'intestatario_fatture',
                                 'sospeso', 'sospeso_causa', 'sospeso_motivo', 'sospeso_il', 'sospeso_da'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute x JOIN pg_attribute y ON y.attname = x.attname AND y.atttypid = x.atttypid
                  WHERE x.attrelid = 'public.alunni'::regclass AND y.attrelid = 'public.frequenze'::regclass
                    AND x.attname = v_col AND x.attnum > 0 AND y.attnum > 0
                    AND NOT x.attisdropped AND NOT y.attisdropped) THEN
        v_cond := v_cond || format('al.%I IS DISTINCT FROM f.%I', v_col, v_col);
      END IF;
    END LOOP;
    -- archiviato ↔ frequenza chiusa (NON `alunni.stato`: la tendina può dire «ritirato» senza archiviare) e retta
    -- (lo zero di `alunni` è NULL nella frequenza).
    IF EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = 'public.alunni'::regclass
                  AND x.attname = 'archiviato_il' AND x.attnum > 0 AND NOT x.attisdropped) THEN
      v_cond := v_cond || ARRAY['(al.archiviato_il IS NOT NULL) IS DISTINCT FROM (f.stato IN (''ritirato'', ''trasferito'', ''uscito''))'];
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = 'public.alunni'::regclass
                  AND x.attname = 'importo_retta_mensile' AND x.attnum > 0 AND NOT x.attisdropped) THEN
      v_cond := v_cond || ARRAY['nullif(al.importo_retta_mensile, 0) IS DISTINCT FROM f.retta_mensile'];
    END IF;
    EXECUTE 'SELECT count(*) FROM public.alunni al '
            'JOIN public.frequenze f ON f.alunno_id = al.id AND f.anno_sede_id = public.anno_visibile(al.scuola_id, public.giorno_roma(now())) '
            'WHERE (' || array_to_string(v_cond, ' OR ') || ') ' || v_non_arrivo
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni'; righe := v_n; RETURN NEXT;

  --     11-bis. Un alunno con una sede, che NON è «in arrivo», deve avere la frequenza dell'anno attivo (lo specchio la crea).
  --     Un bambino «in arrivo» (PR 4.5) non frequenta ancora: la sua frequenza è dell'anno che viene, e la guarda la 11-ter.
  --     `stato` si nomina solo dove la colonna c'è (il banco minimo e il database della CI possono non averla).
  --     Nemmeno un archiviato che non ha mai avuto la frequenza dell'anno attivo (4.5.15, I3): un `in_arrivo` archiviato esce da
  --     «in arrivo» ma non è mai entrato nell'anno attivo, e la sua frequenza è dell'anno che viene (chiusa dall'archiviazione).
  v_n := 0;
  v_non_archiv := CASE WHEN public.anno_ha_colonna('alunni', 'archiviato_il')
                       THEN 'AND al.archiviato_il IS NULL ' ELSE '' END;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.scuola_id IS NOT NULL '
            || v_non_arrivo || v_non_archiv ||
            'AND public.anno_visibile(al.scuola_id, public.giorno_roma(now())) IS NOT NULL '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = al.id '
            'AND f.anno_sede_id = public.anno_visibile(al.scuola_id, public.giorno_roma(now())))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (senza frequenza)'; righe := v_n; RETURN NEXT;

  --     11-ter. Un alunno «in arrivo» deve avere una frequenza viva in un anno che viene (in preparazione o con le iscrizioni
  --     aperte): un bambino in arrivo senza arrivo è una domanda approvata che non ha lasciato traccia nell'anno prossimo.
  --     Se l'anno è già diventato `corrente` e lo stato non è passato a `iscritto` (il passaggio non ha girato), lo dice questa
  --     riga: la frequenza non è più «di un anno che viene». (giro 2, R6) Un anno `corrente` che non è ancora cominciato lo è ancora (anche per la 11-quater).
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL
     AND public.anno_ha_colonna('alunni', 'stato') THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.stato = ''in_arrivo'' '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f '
            'JOIN public.anni_sede s ON s.id = f.anno_sede_id '
            'WHERE f.alunno_id = al.id AND f.stato IN (''in_attesa'', ''iscritto'') '
            'AND (s.stato::text IN (''in_preparazione'', ''iscrizioni_aperte'') '
            'OR (s.stato::text = ''corrente'' AND s.inizio > public.giorno_roma(now()))))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (in arrivo senza arrivo)'; righe := v_n; RETURN NEXT;

  --     11-quater (4.5.16, E). Una scheda ARCHIVIATA non deve avere una frequenza viva in un anno che viene: l'archiviazione la
  --     chiude (`chiudiFrequenzeAperte`), ma la scheda si scrive prima e la chiusura può non riuscire. In quel caso la quota
  --     resta visibile alla famiglia: la API lo dice e propone «Riprova», e questa riga è la rete per chi ricarica la pagina senza
  --     riprovare.
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL
     AND to_regclass('public.anni_sede') IS NOT NULL AND public.anno_ha_colonna('alunni', 'archiviato_il') THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.archiviato_il IS NOT NULL '
            'AND EXISTS (SELECT 1 FROM public.frequenze f '
            'JOIN public.anni_sede s ON s.id = f.anno_sede_id '
            'WHERE f.alunno_id = al.id AND f.stato IN (''in_attesa'', ''iscritto'') '
            'AND (s.stato::text IN (''in_preparazione'', ''iscrizioni_aperte'') '
            'OR (s.stato::text = ''corrente'' AND s.inizio > public.giorno_roma(now()) '
            -- (giro 3, NS4) La conferma TARDIVA fatta nella finestra è voluta: la scheda (archiviata dal passaggio) torna viva all'inizio, con la
            -- ricopia. Si riconosce dalla riga del passaggio (`eccezione`, `esce`/`non_risposto`) che punta a QUESTA frequenza, finché le schede
            -- non sono state ricopiate. Chi è stato archiviato dopo (dalla segreteria) ha la frequenza chiusa dall'archiviazione: non è qui.
            'AND NOT EXISTS (SELECT 1 FROM public.passaggi_anno_righe x JOIN public.passaggi_anno pt ON pt.id = x.passaggio_id '
            'WHERE x.frequenza_a_id = f.id AND x.eccezione AND x.esito IN (''esce'', ''non_risposto'') '
            'AND pt.stato = ''confermato'' AND pt.schede_copiate_il IS NULL))))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (archiviato con iscrizione viva)'; righe := v_n; RETURN NEXT;

  -- 13. I nomi di classe e gli uuid di sezione dicono la stessa cosa (una riga per tabella che ha le due colonne).
  FOR d IN SELECT x.tabella AS t, x.righe AS n FROM public.anno_target_divergenti() x LOOP
    v_trovata := true;
    invariante := '13'; tabella := d.t; righe := d.n; RETURN NEXT;
  END LOOP;
  IF NOT v_trovata THEN
    invariante := '13'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  END IF;

  -- 8. I docenti vedono solo sezioni di anni attivi o passati (PR 4.3). Si passa dalla funzione di visibilità
  --    per ogni docente assegnato e si conta quante delle sezioni che restituisce hanno, nel catalogo
  --    (`anni_sede.stato`), un anno ancora in preparazione o con le iscrizioni aperte: deve essere zero.
  v_n := 0;
  IF to_regclass('public.utenti_sezioni') IS NOT NULL AND to_regclass('public.sections') IS NOT NULL THEN
    SELECT count(*) INTO v_n
      FROM (SELECT us.utente_id FROM public.utenti_sezioni us
             UNION SELECT um.utente_id FROM public.utenti_sezioni_materie um) u
     CROSS JOIN LATERAL public.sezioni_visibili_docente(u.utente_id) v
      JOIN public.sections s  ON s.id = v.section_id
      JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
     WHERE a.stato::text IN ('in_preparazione', 'iscrizioni_aperte');
  END IF;
  invariante := '8'; tabella := 'utenti_sezioni'; righe := v_n; RETURN NEXT;

  -- 7. Nessun genitore vede qualcosa attraverso un figlio non attivo (PR 4.4). Il perché di ogni scelta sta nella testata qui sopra.
  --    Le frequenze vive una volta sola, dal catalogo: un bambino vivo in due sedi compare due volte.
  SELECT coalesce(array_agg(f.alunno_id), '{}'), coalesce(array_agg(f.id), '{}') INTO v_figli_vivi, v_freq_vive
    FROM public.frequenze f
   WHERE f.stato IN ('in_attesa', 'iscritto')
     AND f.anno_sede_id = public.anno_visibile(f.scuola_id, v_oggi)
     AND f.data_ingresso <= v_oggi
     AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);

  --    I bambini con una sede in cui hanno una frequenza e nessuna viva: è la coppia (figlio, sede) non viva.
  SELECT coalesce(array_agg(DISTINCT x.alunno_id), '{}') INTO v_lasciate
    FROM (SELECT f.alunno_id
            FROM public.frequenze f
           GROUP BY f.alunno_id, f.scuola_id
          HAVING NOT bool_or(f.id = ANY (v_freq_vive))) x;

  --    Tutte le coppie (genitore, figlio), per le due strade del legame di `figli_collegati`. `to_regclass` come lì.
  IF to_regclass('public.legame_genitori_alunni') IS NOT NULL THEN
    SELECT coalesce(array_agg(l.genitore_id), '{}'), coalesce(array_agg(l.alunno_id), '{}') INTO v_genitori, v_figli
      FROM public.legame_genitori_alunni l;
  END IF;
  IF to_regclass('public.student_parents') IS NOT NULL AND to_regclass('public.parents') IS NOT NULL THEN
    SELECT v_genitori || coalesce(array_agg(p.auth_user_id), '{}'), v_figli || coalesce(array_agg(sp.student_id), '{}')
      INTO v_genitori, v_figli
      FROM public.parents p
      JOIN public.student_parents sp ON sp.parent_id = p.id
     WHERE p.auth_user_id IS NOT NULL;
  END IF;

  --    Le funzioni di visibilità girano solo per chi ha una coppia non viva, e ognuno ha il suo blocco. Nessuno da guardare: girano
  --    lo stesso, una volta, per un genitore che non c'è.
  FOR v_gen IN
    WITH guardati AS (
      SELECT x.genitore,
             array_agg(x.figlio) AS figli,
             coalesce(array_agg(x.figlio) FILTER (WHERE vivo.alunno_id IS NULL), '{}') AS non_attivi
        FROM unnest(v_genitori, v_figli) AS x(genitore, figlio)
        LEFT JOIN (SELECT DISTINCT y.alunno_id FROM unnest(v_figli_vivi) AS y(alunno_id)) vivo ON vivo.alunno_id = x.figlio
        LEFT JOIN unnest(v_lasciate) AS lasciata(alunno_id) ON lasciata.alunno_id = x.figlio
       GROUP BY x.genitore
      HAVING bool_or(vivo.alunno_id IS NULL OR lasciata.alunno_id IS NOT NULL)
    )
    SELECT g.genitore, g.figli, g.non_attivi FROM guardati g
    UNION ALL
    SELECT NULL::uuid, '{}'::uuid[], '{}'::uuid[] WHERE NOT EXISTS (SELECT 1 FROM guardati)
  LOOP
    BEGIN
      IF to_regclass('public.galleria_media_v2') IS NOT NULL THEN
        -- Lo storico in array, come in `media_visibili_genitore`: la query delle foto resta statica anche dove la tabella non c'è.
        IF to_regclass('public.alunni_classi_storico') IS NOT NULL THEN
          SELECT coalesce(array_agg(h.alunno_id), '{}'), coalesce(array_agg(h.scuola_id), '{}'), coalesce(array_agg(h.section_id), '{}')
            INTO v_st_alunni, v_st_scuole, v_st_sezioni
            FROM public.alunni_classi_storico h
           WHERE h.alunno_id = ANY (v_gen.figli);
        END IF;
        v_foto := v_foto + (WITH sue AS MATERIALIZED (
                              SELECT f.alunno_id, f.scuola_id, f.section_id, f.id = ANY (v_freq_vive) AS viva
                                FROM public.frequenze f
                               WHERE f.alunno_id = ANY (v_gen.figli)
                              UNION ALL
                              SELECT h.alunno_id, h.scuola_id, h.section_id, false
                                FROM unnest(v_st_alunni, v_st_scuole, v_st_sezioni) AS h(alunno_id, scuola_id, section_id)
                            )
                            SELECT count(*)
                              FROM public.media_visibili_genitore(v_gen.genitore) v
                              LEFT JOIN public.galleria_media_v2 m ON m.id = v.media_id
                             WHERE NOT EXISTS (SELECT 1 FROM sue s WHERE s.viva AND s.alunno_id = v.alunno_id AND s.scuola_id = m.scuola_id)
                                OR (m.tag_students @> ARRAY[v.alunno_id]
                                    OR (m.is_broadcast = true
                                        AND coalesce(cardinality(m.target_section_ids), 0) = 0
                                        AND coalesce(cardinality(m.target_classes), 0) = 0)
                                    OR EXISTS (SELECT 1 FROM sue s
                                                WHERE s.alunno_id = v.alunno_id AND s.scuola_id = m.scuola_id
                                                  AND s.section_id = ANY (m.target_section_ids))) IS NOT TRUE);
      END IF;
      IF to_regclass('public.avvisi') IS NOT NULL THEN
        v_avvisi := v_avvisi + (WITH vive AS MATERIALIZED (
                                  SELECT f.alunno_id, f.scuola_id, f.section_id
                                    FROM public.frequenze f
                                   WHERE f.alunno_id = ANY (v_gen.figli) AND f.id = ANY (v_freq_vive)
                                )
                                SELECT count(*)
                                  FROM public.avvisi_visibili_genitore(v_gen.genitore) v
                                  LEFT JOIN public.avvisi a ON a.id = v.avviso_id
                                 WHERE NOT EXISTS (SELECT 1 FROM vive s
                                                    WHERE s.alunno_id = v.alunno_id AND s.scuola_id = a.scuola_id
                                                      AND (a.target_scope = 'globale' OR s.section_id = ANY (a.target_section_ids))));
      END IF;
      IF to_regclass('public.chat_threads') IS NOT NULL THEN
        v_thread := v_thread + (SELECT count(*)
                                  FROM public.thread_visibili(v_gen.genitore) v
                                  JOIN public.chat_threads t ON t.id = v.thread_id
                                 WHERE t.student_id = ANY (v_gen.non_attivi)
                                   AND t.teacher_id IS DISTINCT FROM v_gen.genitore);
      END IF;
      v_frequenze := v_frequenze + (SELECT count(*) FROM public.figli_attivi(v_gen.genitore) a WHERE a.frequenza_id <> ALL (v_freq_vive));
    EXCEPTION
      WHEN OTHERS THEN
        v_guasti := v_guasti + 1;
        v_guasto := SQLSTATE;
    END;
  END LOOP;

  invariante := '7'; tabella := 'galleria_media_v2'; righe := v_foto; RETURN NEXT;
  invariante := '7'; tabella := 'avvisi'; righe := v_avvisi; RETURN NEXT;
  invariante := '7'; tabella := 'chat_threads'; righe := v_thread; RETURN NEXT;
  invariante := '7'; tabella := 'frequenze'; righe := v_frequenze; RETURN NEXT;
  IF v_guasti > 0 THEN
    invariante := '7'; tabella := format('(controllo fallito: %s)', v_guasto); righe := v_guasti; RETURN NEXT;
  END IF;

  -- 15. (giro 2, R8) Ogni bambino in classe ha una riga aperta nello storico delle classi (le foto e le stampe per giorno la leggono).
  invariante := '15'; tabella := 'alunni_classi_storico (senza riga aperta)'; righe := public.passaggio_storico_senza_riga_aperta(); RETURN NEXT;

  -- 15-bis. (giro 4, NB4) Una scheda ARCHIVIATA non ha una classe: il diario, l'appello e la modulistica leggono `section_id` senza guardare lo stato.
  -- Numero `15-bis` perché la 4.9 tiene il suo `16`. In produzione vale 0 (misura del 09/11: 17 archiviate nelle sedi vere, nessuna con la classe).
  invariante := '15-bis'; tabella := 'alunni (archiviata con una classe)';
  righe := (SELECT count(*) FROM public.alunni al WHERE al.archiviato_il IS NOT NULL AND al.section_id IS NOT NULL); RETURN NEXT;

  RETURN;
END
$$;


REVOKE ALL ON FUNCTION public.anni_sede_controlla_domande()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_stati_aggiorna(uuid, date)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_stati_log(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anni_tick(date, uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_invarianti()                  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anni_sede_controlla_domande()   TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_stati_aggiorna(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_stati_log(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.anni_tick(date, uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_invarianti()               TO service_role;
