-- =============================================================================
-- STATI VINCOLATI: `enrollment_submissions.status` e `alunni.stato`
--
-- Seconda serie della roadmap di robustezza, sessione 1 (D11 del rapporto del 2026-10-20).
-- Le due colonne erano testo libero. Lo stato di una domanda lo decideva solo il codice
-- (`STATI_DOMANDA`, src/lib/iscrizioni/stati.ts), quello di un alunno solo la tendina
-- (`STATI_TENDINA`, src/lib/alunni/stato.ts). La migrazione 20260812194517 aveva scelto di
-- non vincolare `alunni.stato`. Oggi i valori sono misurati (Passo 0 del piano
-- docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md), e un valore fuori elenco
-- è un guasto, non una variante.
--
-- ─── COME È FATTA ─────────────────────────────────────────────────────────────
--  Per ciascuna tabella, dentro un blocco che non fa fallire l'integrazione:
--   1. se la tabella manca (database E2E della CI) non fa niente;
--   2. se il vincolo c'è già non fa niente: la migrazione si può rieseguire;
--   3. CONTA le righe fuori elenco. Se ce n'è anche una sola, il vincolo NON si aggiunge,
--      nemmeno NOT VALID: varrebbe comunque al prossimo UPDATE di quella riga e fermerebbe
--      una segreteria a metà lavoro. In app_log resta un `error` con il conteggio;
--   4. altrimenti ADD CONSTRAINT … NOT VALID e subito VALIDATE, e in app_log un `info`.
--  Il NULL in `alunni.stato` resta ammesso: il codice lo legge come «iscritto», e un CHECK
--  con IN lascia passare il NULL.
--
-- ─── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select conname, convalidated from pg_constraint
--    where conname in ('enrollment_submissions_status_ammesso', 'alunni_stato_ammesso');
--   → due righe, convalidated = true.
--   select livello, contesto->'campi'->>'esito', contesto->'campi'->>'n' from app_log
--    where fingerprint like 'migrazione-stati-vincolati-%' order by visto_l_ultima desc;
--   → due righe `info` `vincolo-convalidato`. Una riga `error` `vincolo-non-aggiunto`
--     vuol dire righe fuori elenco, e il loro numero è in `n`.
--   Nel repo lo tiene il lock __tests__/architecture/stati-vincolati-in-sql.test.ts.
--
-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
--   alter table public.enrollment_submissions drop constraint if exists enrollment_submissions_status_ammesso;
--   alter table public.alunni drop constraint if exists alunni_stato_ammesso;
--   Nessun dato cambia, in un verso o nell'altro: un CHECK non scrive righe.
-- =============================================================================

DO $$
DECLARE
  fuori bigint;
BEGIN
  IF to_regclass('public.enrollment_submissions') IS NULL THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.enrollment_submissions'::regclass
       AND conname = 'enrollment_submissions_status_ammesso'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO fuori
    FROM public.enrollment_submissions
   WHERE status NOT IN ('pending', 'approved', 'rejected');

  IF fuori > 0 THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      VALUES ('error', 'migrazione', 'server',
              'CHECK su enrollment_submissions.status NON aggiunto: righe fuori elenco',
              'migrazione-stati-vincolati-domande',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-non-aggiunto',
                'entita_tipo', 'enrollment_submissions', 'n', fuori)))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    EXCEPTION WHEN others THEN
      RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
    END;
    RAISE WARNING 'iscrizioni_stati_vincolati: % righe di enrollment_submissions fuori elenco, vincolo non aggiunto', fuori;
    RETURN;
  END IF;

  ALTER TABLE public.enrollment_submissions
    ADD CONSTRAINT enrollment_submissions_status_ammesso
    CHECK (status IN ('pending', 'approved', 'rejected')) NOT VALID;
  ALTER TABLE public.enrollment_submissions
    VALIDATE CONSTRAINT enrollment_submissions_status_ammesso;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'migrazione', 'server',
            'CHECK su enrollment_submissions.status aggiunto e convalidato',
            'migrazione-stati-vincolati-domande',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-convalidato',
              'entita_tipo', 'enrollment_submissions', 'n', 0)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN others THEN
    RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
  END;
END $$;

DO $$
DECLARE
  fuori bigint;
BEGIN
  IF to_regclass('public.alunni') IS NULL THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.alunni'::regclass
       AND conname = 'alunni_stato_ammesso'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO fuori
    FROM public.alunni
   WHERE stato IS NOT NULL AND stato NOT IN ('iscritto', 'ritirato', 'sospeso');

  IF fuori > 0 THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      VALUES ('error', 'migrazione', 'server',
              'CHECK su alunni.stato NON aggiunto: righe fuori elenco',
              'migrazione-stati-vincolati-alunni',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-non-aggiunto',
                'entita_tipo', 'alunni', 'n', fuori)))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    EXCEPTION WHEN others THEN
      RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
    END;
    RAISE WARNING 'iscrizioni_stati_vincolati: % righe di alunni fuori elenco, vincolo non aggiunto', fuori;
    RETURN;
  END IF;

  ALTER TABLE public.alunni
    ADD CONSTRAINT alunni_stato_ammesso
    CHECK (stato IN ('iscritto', 'ritirato', 'sospeso')) NOT VALID;
  ALTER TABLE public.alunni
    VALIDATE CONSTRAINT alunni_stato_ammesso;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'migrazione', 'server',
            'CHECK su alunni.stato aggiunto e convalidato',
            'migrazione-stati-vincolati-alunni',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-convalidato',
              'entita_tipo', 'alunni', 'n', 0)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN others THEN
    RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
  END;
END $$;

NOTIFY pgrst, 'reload schema';
