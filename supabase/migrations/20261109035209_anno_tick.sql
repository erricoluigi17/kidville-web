-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.5 · «Preparare e aprire l'anno prossimo» · M45a, il tick orario (compito 4.5.2)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- COSA FA:
--   · `anni_tick`: ogni ora crea da solo l'anno successivo di una sede quando arriva il suo giorno
--     (`prepara_successivo_dal` dell'ultimo anno) e ne copia listino, moduli e posti. È il PASSO 1: NON fa il
--     passaggio e non cambia lo stato di nessun anno (lo aggiunge la 4.9, con CREATE OR REPLACE). Solleva
--     `ANNI_TICK_OGGI_NON_AMMESSO` (codice solo SQL, non HTTP) se gli si passa un giorno di oggi per una sede che non è
--     di prova o di simulazione: prima di toccare niente.
--   · `anno_regole.sedi_simulazione`: le sedi vere su cui il titolare ammette di simulare un giorno (si scrive dall'editor
--     SQL; il freno nega le scritture su `anno_regole`). Le sedi col prefisso `e2e00000` sono sempre ammesse.
--   · `anno_invarianti_notturno`: ogni notte rilegge `anno_invarianti()` e scrive un `error` in `app_log` se una non è zero.
--   · `salute_anno`: sola lettura, per `/api/health`.
--   · i job `anni-tick` (`10 * * * *`) e `anno-invarianti` (`17 3 * * *`), programmati solo se `cron.schedule` esiste.
--
-- Cambia comportamento solo in apparenza: oggi, in produzione, il tick non ha niente da creare fino al 01/09/2027
-- (`prepara_successivo_dal` del 2027/28). Il battito `ok` a vuoto è ciò che si vedrà per mesi, ed è voluto: senza,
-- «nessun log» non distinguerebbe «tutto a posto» da «il job non è mai partito».
--
-- Mai l'uuid di una sede, niente `schools.operativa`. Ogni funzione: SECURITY DEFINER, search_path fisso, solo service_role.
-- Idempotente (CREATE OR REPLACE, IF NOT EXISTS, unschedule prima di schedule).
--
-- ORDINE DELLE CINQUE TESTATE: a (questa), b, d, c, e. M45d viene prima di M45c perché `anno_quota_voce` (M45c) legge
-- `listino_voci.scadenza`, che nasce in M45d.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

-- ── 1 · Le sedi su cui si può simulare un giorno ────────────────────────────

-- Un elenco, non una regola cablata: la migrazione non può riconoscere la sede Demo (non si scrivono uuid di sede, non si
-- legge `schools.operativa`). Nasce vuoto; lo riempie il titolare quando vuole provare un giorno diverso da oggi.
ALTER TABLE public.anno_regole ADD COLUMN IF NOT EXISTS sedi_simulazione uuid[] NOT NULL DEFAULT '{}';

-- ── 2 · Il tick ─────────────────────────────────────────────────────────────

-- Per ogni sede, in un blocco proprio: `anni_sede_crea_successivo` e, se ha creato, `anno_copia_configurazione(ultimo, nuovo)`.
-- Un errore su una sede toglie SOLO il lavoro di quella sede (l'anno non resta creato a metà), scrive un `error` con il
-- solo SQLSTATE e l'uuid, e non ferma le altre.
--   · `p_oggi` NULL = `giorno_roma(now())`: il giorno è SEMPRE quello di Roma, mai quello UTC e mai `CURRENT_DATE`.
--   · `p_oggi` non NULL esige `p_scuola` e che la sede sia ammessa; altrimenti ANNI_TICK_OGGI_NON_AMMESSO prima di toccare niente.
--   · Il battito `cron:anni-tick` si scrive SEMPRE (`ok`, o `ok-parziale` se `errori > 0`), con i conteggi come numeri; `simulato`
--     dice che il giorno non era quello vero. Un anno creato scrive una riga `info` con soli uuid e conteggi.
-- Restituisce {"oggi":"AAAA-MM-GG","sedi":n,"creati":n,"copie":n,"errori":n}.
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
  r         record;
  v_prec    uuid;
  v_nuovo   uuid;
  v_n       integer;
  v_cfg     jsonb;
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

  FOR r IN
    SELECT DISTINCT s.scuola_id FROM public.anni_sede s
     WHERE p_scuola IS NULL OR s.scuola_id = p_scuola
     ORDER BY s.scuola_id
  LOOP
    v_sedi := v_sedi + 1;
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
  END LOOP;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'anni_tick: giro completato', 'cron:anni-tick',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'anni-tick',
              'esito', CASE WHEN v_errori > 0 THEN 'ok-parziale' ELSE 'ok' END,
              'sedi', v_sedi, 'creati', v_creati, 'copie', v_copie, 'errori', v_errori,
              'simulato', p_oggi IS NOT NULL)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'anni_tick: battito non scritto [%]', SQLSTATE;
  END;

  RETURN jsonb_build_object('oggi', v_oggi, 'sedi', v_sedi, 'creati', v_creati, 'copie', v_copie, 'errori', v_errori);
END
$$;

-- ── 3 · Le invarianti, ogni notte ───────────────────────────────────────────

-- Rilegge `anno_invarianti()` e restituisce quante righe hanno `righe <> 0`. Se sono più di zero scrive un `error`
-- (`fingerprint 'anno-invarianti'`, SOLO `n_invarianti` e `n_righe`: nessun nome di tabella, nessuna riga) — se quella scrittura
-- fallisce, fallisce il job, e si vede: un allarme che non può suonare è peggio di un job rosso. Il battito
-- `cron:anno-invarianti` (`esito 'ok'`) si scrive SEMPRE: dice che il lavoro è girato, non che i dati siano a posto. Porta lo stesso
-- conteggio, che `salute_anno` legge senza rifare la verifica a ogni giro del campanello.
CREATE OR REPLACE FUNCTION public.anno_invarianti_notturno()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv   integer;
  v_righe bigint;
BEGIN
  SELECT count(*) FILTER (WHERE i.righe <> 0)::integer,
         coalesce(sum(i.righe) FILTER (WHERE i.righe <> 0), 0)
    INTO v_inv, v_righe
    FROM public.anno_invarianti() i;

  IF v_inv > 0 THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('error', 'cron', 'server', 'anno_invarianti_notturno: invarianti dell''anno non a zero', 'anno-invarianti',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'anno-invarianti', 'esito', 'invarianti-non-zero',
              'n_invarianti', v_inv, 'n_righe', v_righe)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  END IF;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'anno_invarianti_notturno: verifica completata', 'cron:anno-invarianti',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'anno-invarianti', 'esito', 'ok',
              'n_invarianti', v_inv, 'n_righe', v_righe)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'anno_invarianti_notturno: battito non scritto [%]', SQLSTATE;
  END;
  RETURN v_inv;
END
$$;

-- ── 4 · La salute dell'anno, per /api/health ────────────────────────────────

-- Sola lettura (STABLE), tre numeri:
--   · `sedi_senza_successivo`: le sedi il cui ULTIMO anno ha `prepara_successivo_dal <= oggi` (è l'ultimo: un successivo non c'è);
--   · `in_ritardo_giorni`: il massimo scarto, in giorni, fra oggi e quel `prepara_successivo_dal` (0 se nessuna);
--   · `invarianti_non_zero`: il conteggio dell'ULTIMO giro notturno, letto dal suo battito. NON si rifanno qui le invarianti: la
--     salute si chiama a ogni giro del campanello e le invarianti leggono mezzo registro.
-- Il tick gira ogni ora: lo stesso giorno di `prepara_successivo_dal` il ritardo è 0 e non è un allarme.
CREATE OR REPLACE FUNCTION public.salute_anno()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi    date := public.giorno_roma(now());
  v_sedi    integer;
  v_ritardo integer;
  v_inv     integer;
BEGIN
  SELECT count(*)::integer, coalesce(max(v_oggi - u.prepara_successivo_dal), 0)::integer
    INTO v_sedi, v_ritardo
    FROM (SELECT DISTINCT ON (s.scuola_id) s.scuola_id, s.prepara_successivo_dal
            FROM public.anni_sede s
           ORDER BY s.scuola_id, s.inizio DESC) u
   WHERE u.prepara_successivo_dal <= v_oggi;

  SELECT coalesce((SELECT (l.contesto -> 'campi' ->> 'n_invarianti')::integer
                     FROM public.app_log l
                    WHERE l.fingerprint = 'cron:anno-invarianti'
                    ORDER BY l.giorno DESC, l.visto_l_ultima DESC
                    LIMIT 1), 0)
    INTO v_inv;

  RETURN jsonb_build_object(
    'sedi_senza_successivo', v_sedi, 'in_ritardo_giorni', v_ritardo, 'invarianti_non_zero', v_inv);
END
$$;

-- ── 5 · Privilegi ───────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.anni_tick(date, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_invarianti_notturno()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salute_anno()                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anni_tick(date, uuid)        TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_invarianti_notturno()   TO service_role;
GRANT EXECUTE ON FUNCTION public.salute_anno()                TO service_role;

-- ── 6 · I due job ───────────────────────────────────────────────────────────

-- `pg_cron` c'è se c'è la funzione che si chiama; sul DB della CI no, e lì i job non servono (e `salute_anno` dice ok).
-- Con `pg_cron` presente, un job non programmato è un guasto: una riga `error`, solo codici, e la migrazione prosegue.
DO $$
BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'anni-tick: pg_cron assente, job non programmati';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('anni-tick', 'anno-invarianti');
  PERFORM cron.schedule('anni-tick', '10 * * * *', $cron$ SELECT public.anni_tick(); $cron$);
  PERFORM cron.schedule('anno-invarianti', '17 3 * * *', $cron$ SELECT public.anno_invarianti_notturno(); $cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'anni-tick: job non programmati [%]', SQLSTATE;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('error', 'migrazione', 'server', 'anni-tick: job non programmati', 'migrazione:anni-tick-non-programmato',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'anni-tick', 'esito', 'non-programmato', 'sqlstate', SQLSTATE)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'anni-tick: job non programmati e non registrati [%]', SQLSTATE;
  END;
END $$;
