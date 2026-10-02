-- ═══════════════════════════════════════════════════════════════════════════════
-- I RITENTATIVI DEI JOB VIDEO — un guasto NOSTRO non deve chiudere un video al primo colpo.
-- Scritta il 2026-10-02 per la PR 1 «hotfix video». NON applicata da chi l'ha scritta: si
-- applica dopo averla mostrata (vedi «ORDINE DI APPLICAZIONE»).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────
--
-- `video_job_fail` rende un job definitivo al primo colpo. Per un difetto del FILE è
-- giusto — un codec che non si converte non si converte nemmeno al secondo giro — ma per
-- un guasto NOSTRO no. Dal 2026-09-29 alle 14:20 UTC tutti i 17 job che il runner ha
-- preso sono finiti `failed` con `BUILD_DOWNLOAD_FAILED` e `attempt = 1`: l'archivio di
-- FFmpeg che si scaricava a ogni MicroVM rispondeva 404, e il video di un'insegnante
-- veniva scartato per una colpa che non era né sua né del filmato, senza una seconda
-- possibilità.
--
-- DECISIONE DEL TITOLARE: ritentativo automatico SOLO quando il guasto è nostro
-- (infrastruttura, non il file), con tre ritentativi dopo il primo — quattro tentativi in
-- tutto — e attese di circa 5, 10 e 15 minuti, entro un'ora; poi `failed`. Quale guasto
-- sia «nostro» lo decide il runner (`src/lib/media/video/runner/ritentativi.ts`), che poi
-- chiama `video_job_retry`: qui si sa soltanto FARLO, in modo atomico, con gli stessi lock
-- e le stesse guardie di `video_job_fail`.
--
-- ─── COSA AGGIUNGE ───────────────────────────────────────────────────────────
--
--   1. Due colonne su `video_jobs`:
--        · `next_attempt_at` — da quando un job messo in attesa si può riprendere;
--        · `last_error_code` — il codice dell'ultimo guasto nostro che l'ha rimesso in
--          coda. SOLO il codice, mai lo stderr di FFmpeg: può contenere i metadati
--          dell'iPhone, compresa la posizione di dove sono stati ripresi i bambini, e
--          `video_jobs` non ha una conservazione. La coda leggibile dell'errore finisce
--          in `app_log`, che scade a 30 giorni.
--   2. `video_job_retry`: rimette in coda un job `processing` con la sua attesa
--      (processing → queued) oppure, a tentativi esauriti, delega a `video_job_fail`.
--   3. `video_job_next` e `video_job_claim`, riscritte uguali a prima salvo tre
--      modifiche dichiarate più sotto: un job in attesa non si sceglie e non si prende
--      finché la sua ora non è arrivata.
--
-- ─── TRE SCELTE CHE SI VEDONO SOLO LEGGENDO ATTENTAMENTE ─────────────────────
--
-- (1) NESSUN VINCOLO lega `next_attempt_at` allo stato. «Ha un valore solo se `queued`»
--     si romperebbe da solo il giorno in cui `video_job_cancel`, `video_intent_supersede`,
--     `video_intent_revoke` o `video_retention_scadenze` portano in `cancelled` o `failed`
--     un job che sta aspettando: nessuna di loro tocca quella colonna, e non deve. Un
--     valore rimasto su una riga già chiusa è inerte — `video_job_next` guarda solo i
--     `queued` e `video_job_claim` rifiuta ogni altro stato. Che sia davvero così lo
--     prova `__tests__/lib/video-job-ritentativi.test.ts`, che cancella, supera, ritira e
--     dichiara incagliato un job in attesa.
--
-- (2) `attempt` e `fence_epoch` NON cambiano qui. Il job torna `queued`: chi prova a
--     chiuderlo (`video_job_ready`, `video_job_fail`) prende `INVALID_STATE`, e alla presa
--     in carico successiva `video_job_claim` alza il fence, quindi il worker di prima non
--     può più scrivere niente. `attempt` conta le volte che il job è stato PRESO: il
--     primo guasto si vede con `attempt = 1`, e con un massimo di 4 il quarto è quello
--     definitivo.
--
-- (3) Il CHECK di `last_error_code` nasce DENTRO la definizione della colonna, in un DO
--     con guardia, e non con un `ADD CONSTRAINT` a parte. Non è un vezzo: il
--     riconoscitore `toccaLeFkUtenti` (`__tests__/architecture/soglia-fotografia.ts`)
--     segnala OGNI aggiunta di vincolo come «tocca le chiavi esterne verso utenti», e per
--     una migrazione posteriore alla fotografia delle FK il rosso di
--     `tracce-docente-dichiarate` si spegne solo rigenerando quella fotografia dalla
--     produzione. Un CHECK su una colonna di testo non cambia nessuna fotografia: la
--     forma scelta non accende nessuna delle tre guardie di freschezza (RLS, indici
--     unici, FK verso utenti), e il test lo verifica.
--
-- ─── L'ORDINE DEI LOCK, come in `video_job_fail` ─────────────────────────────
--
-- Prima l'INTENT, poi il JOB, e l'orologio dopo entrambi: è l'ordine di tutte le RPC di
-- questo schema, e la testata di `20260916190200_video_intent_lifecycle.sql` spiega perché
-- due ordini diversi sulle stesse due righe sono un deadlock che si vede solo sotto
-- carico. `video_job_fail`, che questa funzione chiama a tentativi esauriti, riprende gli
-- stessi lock nello stesso ordine: nella stessa transazione sono già suoi.
--
-- ─── LE DUE FUNZIONI COPIATE, E CIÒ CHE CAMBIA ───────────────────────────────
--
-- `video_job_next` e `video_job_claim` sono il testo ATTUALE, copiato riga per riga da
-- `20260917210000_video_job_next.sql` (righe 133-222) e da
-- `20260916190100_video_job_transitions.sql` (righe 161-284). Il corpo che sta in
-- produzione ha lo stesso md5 del corpo che sta in quei due file (misurato il
-- 2026-10-02), quindi la copia non riporta indietro nessuna correzione fatta fuori dai
-- file. Cambiano TRE cose, e nient'altro:
--   · `video_job_next`: nel WHERE, `j.status = 'queued'` diventa
--     `(j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= v_now))`;
--   · `video_job_claim`: la guardia `RETRY_NOT_DUE`, prima di `INVALID_STATE`;
--   · `video_job_claim`: `next_attempt_at = NULL` nell'UPDATE della presa in carico.
-- Il test `__tests__/lib/video-job-ritentativi.test.ts` fa il confronto da sé: toglie dal
-- corpo nuovo SOLO quelle tre modifiche e pretende che resti il corpo vecchio, byte per
-- byte (commenti esclusi).
--
-- ─── ORDINE DI APPLICAZIONE ──────────────────────────────────────────────────
--
-- Prima si MOSTRA l'SQL, poi si applica (`apply_migration`), poi `get_advisors` deve
-- tornare 0 ERROR. Questa migrazione viaggia dentro una PR: o la applica l'integrazione
-- al merge, o la si applica a mano PRIMA — mai tutte e due, perché si registrerebbe due
-- volte. Se a mano, il file prende la `version` registrata (`git mv`).
--
-- È RETROCOMPATIBILE: applicata prima del codice nuovo non cambia niente. Nessun job ha
-- `next_attempt_at` finché qualcuno non chiama `video_job_retry`, il codice attuale non la
-- chiama, e per un job con `next_attempt_at` NULL le due funzioni riscritte si comportano
-- come prima (il runner legge il job con un cast, non con uno schema rigido: le due chiavi
-- in più nel JSON non lo disturbano). Il codice nuovo invece la PRETENDE: se la RPC
-- mancasse, il runner ripiega su `video_job_fail` (il comportamento di oggi) e lo scrive
-- nel log.
--
-- ─── COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'apply) ────────
--
--   -- (a) le due colonne ci sono, e la RPC non la può chiamare nessun utente:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'video_jobs'
--      AND column_name IN ('next_attempt_at', 'last_error_code');
--   SELECT has_function_privilege('anon', 'public.video_job_retry(uuid,bigint,uuid,text,integer,integer)', 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', 'public.video_job_retry(uuid,bigint,uuid,text,integer,integer)', 'EXECUTE') AS authenticated,
--          has_function_privilege('service_role', 'public.video_job_retry(uuid,bigint,uuid,text,integer,integer)', 'EXECUTE') AS service_role;
--   -- deve rispondere false, false, true.
--
--   -- (b) le due funzioni riscritte conoscono l'attesa:
--   SELECT p.proname, position('next_attempt_at' IN p.prosrc) > 0 AS conosce_l_attesa
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname IN ('video_job_next', 'video_job_claim');
--
--   -- (c) nessun job sta aspettando finché nessuno ha chiamato la RPC:
--   SELECT count(*) FROM public.video_jobs WHERE next_attempt_at IS NOT NULL;   -- 0
--
-- ─── SE VA STORTO ────────────────────────────────────────────────────────────
--
--   · le due funzioni tornano com'erano riapplicando i corpi originali:
--     `video_job_next` da `20260917210000_video_job_next.sql` (righe 133-222) e
--     `video_job_claim` da `20260916190100_video_job_transitions.sql` (righe 161-284);
--   · `DROP FUNCTION public.video_job_retry(uuid, bigint, uuid, text, integer, integer);`
--   · le due colonne possono restare: sono NULL e nessun altro codice le legge. Un job
--     rimasto `queued` con l'attesa nel futuro verrebbe ripreso subito dal `claim` di
--     prima: si perde l'attesa, niente di più.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Le due colonne ───────────────────────────────────────────────────────────
ALTER TABLE public.video_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- `last_error_code` con il suo CHECK, in un solo gesto e una volta sola: se la colonna
-- c'è già il blocco non fa niente. Lo stesso formato di `video_job_fail` per `error_code`
-- (`^[A-Z][A-Z0-9_]{0,79}$`), così un codice che una RPC accetta lo accetta anche la colonna.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.video_jobs'::pg_catalog.regclass
      AND attname = 'last_error_code'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE public.video_jobs
      ADD COLUMN last_error_code text
        CONSTRAINT video_jobs_last_error_code_chk
        CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$');
  END IF;
END
$$;

COMMENT ON COLUMN public.video_jobs.next_attempt_at IS
  'Da quando un job rimesso in coda da video_job_retry puo'' essere ripreso: finche'' sta nel futuro video_job_next non lo sceglie e video_job_claim risponde RETRY_NOT_DUE. NULL per un job che non sta aspettando; video_job_claim lo azzera alla presa in carico. Ha senso solo mentre il job e'' queued: nessun vincolo lo lega allo stato, e su un job chiuso nel frattempo puo'' restare un valore vecchio che nessuno legge.';
COMMENT ON COLUMN public.video_jobs.last_error_code IS
  'Il codice dell''ultimo guasto NOSTRO (infrastruttura, non il file) che ha rimesso il job in coda o con cui ha esaurito i tentativi. Solo il codice, mai lo stderr: quello puo'' contenere i metadati del telefono, posizione compresa, e video_jobs non ha una conservazione. La coda leggibile dell''errore sta in app_log, che scade a 30 giorni.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_job_retry — rimette in coda un job il cui guasto è NOSTRO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il chiamante è il runner, che la usa al posto di `video_job_fail` quando la causa è
-- l'infrastruttura (un download che dà 404, la MicroVM che non si apre, lo Storage che
-- risponde 503) e non il file. Ha i lock e le guardie di `video_job_fail`: intent, poi
-- job, e fence, stato e lease verificati sotto lock.
--
-- L'ORDINE DELLE DECISIONI è il contratto, e i test lo provano uno per uno:
--   1. argomenti: massimo di tentativi fra 1 e 10, attesa fra 1 e 86400 secondi, codice
--      nel formato di `video_job_fail`                                   → BAD_INPUT;
--   2. NOT_FOUND / INTENT_CHANGED_RETRY / FENCE_MISMATCH, come ogni altra transizione;
--   3. IDEMPOTENZA: il job è già in coda per questo stesso codice e ha la sua attesa
--      → ok, senza toccare niente;
--   4. il job è già `failed` o `rejected` → decide `video_job_fail`;
--   5. non è `processing` → INVALID_STATE; la lease non è di chi chiama → LEASE_MISMATCH;
--      la lease è scaduta → LEASE_EXPIRED;
--   6. `attempt` ha raggiunto il massimo → i tentativi sono finiti: si annota il codice
--      e si chiude con `video_job_fail`, che dà all'originale la sua scadenza di sette giorni;
--   7. altrimenti `queued`, con `next_attempt_at` fra `p_attesa_secondi` secondi, lease
--      sciolta e codice annotato.
--
-- ⚠️ `original_delete_after` NON si tocca al punto 7, ed è il motivo per cui il lock
-- `video-originale-mai-senza-scadenza` ha questa funzione fra le transizioni dichiarate
-- senza scadenza: il job non è concluso, l'originale serve ancora per il tentativo dopo, e
-- la scadenza la scrive `video_job_fail` quando i tentativi finiscono.
CREATE OR REPLACE FUNCTION public.video_job_retry(
  p_job_id uuid,
  p_fence_epoch bigint,
  p_lease_owner uuid,
  p_error_code text,
  p_tentativi_massimi integer,
  p_attesa_secondi integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_job_id IS NULL
    OR p_fence_epoch IS NULL
    OR p_lease_owner IS NULL
    OR p_error_code IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_error_code)) < 1
    OR pg_catalog.char_length(p_error_code) > 80
    OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
    OR p_tentativi_massimi IS NULL
    OR p_tentativi_massimi < 1
    OR p_tentativi_massimi > 10
    OR p_attesa_secondi IS NULL
    OR p_attesa_secondi < 1
    OR p_attesa_secondi > 86400
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT i.* INTO v_intent
  FROM public.video_intents AS i
  INNER JOIN public.video_jobs AS j ON j.intent_id = i.id
  WHERE j.id = p_job_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.fence_epoch IS DISTINCT FROM p_fence_epoch THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, v_intent.id, 'FENCE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');
  END IF;

  -- La prima chiamata è riuscita e la risposta si è persa: il job è già in coda per
  -- QUESTO guasto e ha la sua attesa. Si risponde ok senza toccare niente — in
  -- particolare senza spostare `next_attempt_at`, che altrimenti un ritentativo di rete
  -- allungherebbe di altri minuti l'attesa di un'insegnante. L'attesa non nulla fa parte
  -- della condizione perché `last_error_code` resta sulla riga anche dopo la presa in
  -- carico successiva: da solo non direbbe «sto aspettando», lo dice l'attesa.
  IF v_job.status = 'queued'
    AND v_job.last_error_code = p_error_code
    AND v_job.next_attempt_at IS NOT NULL
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'info', p_job_id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object(
        'idempotent', true,
        'attempt', v_job.attempt,
        'fence_epoch', v_job.fence_epoch
      )
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
  END IF;

  -- Già concluso: il verdetto spetta a `video_job_fail`, che conosce le sue idempotenze
  -- (lo stesso codice → ok, un altro → ERROR_CONFLICT, un job rifiutato non si riapre).
  -- Non se ne copia la logica qui.
  IF v_job.status IN ('failed', 'rejected') THEN
    RETURN public.video_job_fail(
      p_job_id, p_fence_epoch, p_lease_owner, p_error_code, false
    );
  END IF;

  IF v_job.status <> 'processing' THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, v_intent.id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-retry', 'error', p_job_id, v_intent.id, 'LEASE_EXPIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_EXPIRED');
  END IF;

  -- I tentativi sono finiti. `attempt` è già quello in corso (lo alza `video_job_claim`),
  -- quindi con un massimo di 4 è il quarto guasto a chiudere il job. Si annota il codice
  -- anche in `last_error_code` e si lascia chiudere a `video_job_fail`, che scrive
  -- `error_code`, la scadenza di sette giorni dell'originale e scioglie la lease: la
  -- decisione «definitivo» ha un autore solo.
  IF v_job.attempt >= p_tentativi_massimi THEN
    UPDATE public.video_jobs
    SET last_error_code = p_error_code,
        updated_at = v_now
    WHERE id = p_job_id;

    RETURN public.video_job_fail(
      p_job_id, p_fence_epoch, p_lease_owner, p_error_code, false
    );
  END IF;

  -- Si ritenta. `original_delete_after` resta com'è (NULL): il job non è concluso e
  -- l'originale serve ancora. `fence_epoch` e `attempt` restano quelli del tentativo che
  -- è fallito: li alza `video_job_claim` alla presa in carico successiva.
  UPDATE public.video_jobs
  SET status = 'queued',
      next_attempt_at = v_now + p_attesa_secondi * interval '1 second',
      last_error_code = p_error_code,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  -- Solo identificatori, codici e numeri: nessun percorso, nessun MIME, e dello stderr
  -- nemmeno una riga (la sua coda va in `app_log` dal runner, ripulita).
  PERFORM public._video_job_transition_log(
    'video-job-retry', 'warn', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'error_code', p_error_code,
      'tentativi_massimi', p_tentativi_massimi,
      'attesa_secondi', p_attesa_secondi
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_job_retry(uuid, bigint, uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_retry(uuid, bigint, uuid, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_job_retry(uuid, bigint, uuid, text, integer, integer) IS
  'Rimette in coda un job video il cui guasto e'' dell''infrastruttura e non del file: processing -> queued con un''attesa (next_attempt_at) e il codice del guasto (last_error_code), senza toccare original_delete_after. A tentativi esauriti (attempt >= p_tentativi_massimi) delega a video_job_fail, che chiude il job e da all''originale la sua scadenza di sette giorni. Idempotente: una chiamata ripetuta non sposta l''attesa. Solo il service role.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_job_next — IDENTICA a `20260917210000_video_job_next.sql:133-222`, tranne UNA riga
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Nel WHERE un job `queued` è candidato solo se non sta aspettando: `next_attempt_at` è
-- NULL oppure è già passato. Il commento che lo dice sta dentro il corpo, accanto alla
-- riga. Tutto il resto — la testata, il lock sull'intent e basta, l'orologio preso prima,
-- la delega a `video_job_claim`, i log — è il testo di prima.
CREATE OR REPLACE FUNCTION public.video_job_next(
  p_lease_owner uuid,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_job_id uuid;
  v_intent_id uuid;
  v_esito jsonb;
BEGIN
  -- Gli stessi limiti di `video_job_claim`, e non per simmetria estetica: validare qui
  -- evita di prendere un lock sull'intent per poi farsi dire di no un istante dopo.
  IF p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-next', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  -- Il lock è su `i` — l'INTENT — e su nient'altro: è il primo anello della catena che
  -- tutte le RPC di questo schema percorrono nello stesso verso. Il job lo bloccherà
  -- `video_job_claim`. `SKIP LOCKED` fa sì che un intent in mano a un altro worker non
  -- fermi questa scansione: si passa al candidato successivo.
  SELECT j.id, i.id
  INTO v_job_id, v_intent_id
  FROM public.video_jobs AS j
  INNER JOIN public.video_intents AS i ON i.id = j.intent_id
  WHERE i.status NOT IN ('cancelled', 'superseded', 'published')
    AND (
      -- Un job rimesso in coda da `video_job_retry` aspetta la sua ora: finché
      -- `next_attempt_at` sta nel futuro NON è candidato. Non è un'ottimizzazione: se fosse
      -- scelto, `video_job_claim` lo rifiuterebbe (RETRY_NOT_DUE) e, siccome questa funzione
      -- propone un candidato per chiamata e non scorre la coda, quel rifiuto fermerebbe
      -- TUTTA la coda, anche i job pronti che stanno dietro. Il confronto è con `v_now`,
      -- preso prima di claim: l'orologio avanza, quindi un job dovuto per noi lo è a
      -- maggior ragione per claim (la stessa direzione prudente della lease qui sotto).
      (j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= v_now))
      OR (
        j.status = 'processing'
        AND j.lease_expires_at IS NOT NULL
        AND j.lease_expires_at <= v_now
      )
    )
  ORDER BY j.created_at, j.id
  FOR UPDATE OF i SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-next', 'info', NULL, NULL, 'EMPTY_QUEUE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'EMPTY_QUEUE');
  END IF;

  -- Qui finisce il mestiere di questa funzione. Tutto ciò che decide se il job si può
  -- davvero prendere — stato, lease, fence, intent — sta dentro `video_job_claim`, che
  -- rilegge la riga sotto il proprio lock. Una riga sola, e nessuna copia.
  v_esito := public.video_job_claim(v_job_id, p_lease_owner, p_lease_seconds);

  IF COALESCE((v_esito ->> 'ok')::boolean, false) THEN
    PERFORM public._video_job_transition_log(
      'video-job-next', 'info', v_job_id, v_intent_id, NULL,
      pg_catalog.jsonb_build_object(
        'attempt', v_esito -> 'job' -> 'attempt',
        'fence_epoch', v_esito -> 'job' -> 'fence_epoch',
        'lease_seconds', p_lease_seconds
      )
    );
  ELSE
    -- Un candidato scelto e poi rifiutato non è normale amministrazione: fra la
    -- scansione e il claim è cambiato qualcosa sotto la riga del job. Va a `error` con
    -- il codice di claim accanto, perché è l'unico posto da cui si può ricostruire che
    -- cosa è successo.
    PERFORM public._video_job_transition_log(
      'video-job-next', 'error', v_job_id, v_intent_id, v_esito ->> 'code'
    );
  END IF;

  RETURN v_esito;
END
$$;

REVOKE ALL ON FUNCTION public.video_job_next(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_next(uuid, integer)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_job_claim — IDENTICA a `20260916190100_video_job_transitions.sql:161-284`, tranne DUE modifiche
-- ═══════════════════════════════════════════════════════════════════════════════
--
--   · la guardia `RETRY_NOT_DUE`, subito prima di `INVALID_STATE`: un job che sta
--     aspettando non si prende, nemmeno chiamando `video_job_claim` per id;
--   · `next_attempt_at = NULL` nell'UPDATE della presa in carico: finita l'attesa, il job
--     non aspetta più niente.
-- L'idempotenza della lease, `LEASE_ACTIVE`, `INTENT_INACTIVE`, l'incremento di `attempt`
-- e di `fence_epoch`, il calcolo della scadenza: tutto com'era.
CREATE OR REPLACE FUNCTION public.video_job_claim(
  p_job_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_job_id IS NULL
    OR p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT i.* INTO v_intent
  FROM public.video_intents AS i
  INNER JOIN public.video_jobs AS j ON j.intent_id = i.id
  WHERE j.id = p_job_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.status IN ('cancelled', 'superseded', 'published') THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, v_intent.id, 'INTENT_INACTIVE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_INACTIVE');
  END IF;

  -- Un retry identico non incrementa attempt/fence e non prolunga la lease:
  -- la risposta è la fotografia della prima acquisizione riuscita.
  IF v_job.status = 'processing'
    AND v_job.lease_owner = p_lease_owner
    AND v_job.lease_expires_at > v_now
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'info', p_job_id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object(
        'idempotent', true,
        'attempt', v_job.attempt,
        'fence_epoch', v_job.fence_epoch
      )
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
  END IF;

  IF v_job.status = 'processing' AND v_job.lease_expires_at > v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, v_intent.id, 'LEASE_ACTIVE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_ACTIVE');
  END IF;

  -- Un job rimesso in coda da `video_job_retry` aspetta la sua ora. Di norma non ci si
  -- arriva — `video_job_next` non lo sceglie finché non è dovuto — ma claim si può
  -- chiamare anche per id, e l'attesa vale anche lì: un ritentativo non si anticipa.
  IF v_job.status = 'queued' AND v_job.next_attempt_at > v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, v_intent.id, 'RETRY_NOT_DUE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'RETRY_NOT_DUE');
  END IF;

  IF v_job.status <> 'queued'
    AND NOT (
      v_job.status = 'processing'
      AND v_job.lease_expires_at IS NOT NULL
      AND v_job.lease_expires_at <= v_now
    )
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-claim', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.video_jobs
  SET status = 'processing',
      attempt = attempt + 1,
      fence_epoch = fence_epoch + 1,
      lease_owner = p_lease_owner,
      lease_expires_at = v_now + p_lease_seconds * interval '1 second',
      -- La presa in carico chiude l'attesa: da qui il job non aspetta più niente.
      next_attempt_at = NULL,
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-job-claim', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'lease_seconds', p_lease_seconds
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_job_claim(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_claim(uuid, uuid, integer)
  TO service_role;

-- Successo osservabile senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-job-retry-migration',
        'sorgente', 'server',
        'messaggio', 'Ritentativi dei job video installati',
        'fingerprint', 'video-job-retry-migration-v1',
        'contesto', jsonb_build_object(
          'rpc_nuove', 1,
          'rpc_riscritte', 2,
          'colonne_nuove', 2,
          'tentativi_massimi_ammessi', 10,
          'attesa_massima_secondi', 86400
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
