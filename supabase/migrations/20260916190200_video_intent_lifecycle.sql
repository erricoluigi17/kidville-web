-- Ciclo di vita degli intent video: apertura, conferma, pubblicazione atomica,
-- revisione, ritiro — e lo scrittore della coda `video_outbox`.
--
-- Completa `20260916190100_video_job_transitions.sql`, che si ferma al singolo job
-- (claim, lease, heartbeat, ready, fail, cancel). Qui si governa l'INTENT: l'oggetto
-- che dice «questo utente, in questa sede, vuole pubblicare questa cosa», e che può
-- avere più job sotto di sé (una News con tre allegati) o uno solo (una Galleria).
--
-- Tutte le funzioni sono service-only e ripetono, senza scorciatoie, le quattro
-- discipline che il critico di V04 ha pagato e che non vanno reinventate:
--
--   1. l'ordine di lock è SEMPRE intent → job. Due ordini diversi sulle stesse due
--      righe sono un deadlock che si manifesta solo sotto carico;
--   2. `clock_timestamp()` si prende DOPO aver acquisito i lock. Preso prima, è
--      l'istante in cui si è entrati in coda, non quello in cui si è scritto: una
--      lease calcolata su quell'istante nasce già consumata dal tempo d'attesa;
--   3. dopo il lock si RILEGGE, e si riverifica che la riga sia ancora quella che si
--      era letta prima (`IS DISTINCT FROM` → `INTENT_CHANGED_RETRY`);
--   4. il confronto fra due valori che possono essere NULL si scrive
--      `IS DISTINCT FROM`, mai `<>`. Lo scope globale di una News HA `scuola_id`
--      NULL: `NULL <> NULL` è NULL, cioè «non rifiutare», cioè pubblicare in una
--      sede qualsiasi un contenuto che non ne aveva nessuna.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PERCHÉ QUI NON C'È NESSUNA POLICY SU `storage.objects`
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il piano di V02 lasciava scritto: «Manca la policy di scrittura su
-- `storage.objects` per `video_originals`: senza, un upload TUS col token di sessione
-- prende 403 al primo byte». La premessa è vera, la conclusione no. Misurato il
-- 2026-09-17 sul progetto di produzione, in sola lettura:
--
--   · `storage.objects` ha `relrowsecurity = true` e ZERO policy (`pg_policies`
--     nello schema `storage` ritorna 0 righe), mentre `authenticated` possiede il
--     GRANT di tabella su INSERT. RLS accesa senza policy nega tutto: un upload TUS
--     presentato con il JWT di sessione dell'utente prenderebbe davvero 403;
--
--   · MA quella policy **questa migrazione non potrebbe scriverla**. `storage.objects`
--     appartiene a `supabase_storage_admin`; il ruolo che applica le migrazioni è
--     `postgres`, che NON è superuser (`rolsuper = false`) e NON è membro di quel
--     ruolo: `pg_has_role(current_user, relowner, 'USAGE')` ritorna **false**. Un
--     `CREATE POLICY ... ON storage.objects` fallirebbe con 42501 «must be owner of
--     table objects» — non in prova, ma in produzione, a metà di un rilascio;
--
--   · E soprattutto: **la firma basta, e la policy non serve**. Supabase Storage
--     1.73.1 (versione letta da `GET /storage/v1/version` sul nostro progetto)
--     espone una seconda rotta TUS, `/storage/v1/upload/resumable/sign`, che
--     autentica con l'intestazione `x-signature` — il token che
--     `createSignedUploadUrl()` genera lato server con la chiave di servizio — e che
--     nel codice di storage-api è registrata su `dbSuperUser`: verifica la firma
--     PRIMA di qualunque controllo JWT, quindi non passa affatto da RLS.
--     Misurato dal vivo sul nostro endpoint il 2026-09-17, quattro `POST` senza
--     alcuna credenziale:
--
--       /storage/v1/upload/resumable/sign         → 412  «Tus-Resumable Required»
--       /storage/v1/upload/resumable              → 400  «Invalid Compact JWS»
--       /storage/v1/upload/resumable/inesistente  → 400  «Invalid Compact JWS»
--       /storage/v1/inesistente                   → 404  «Route POST:/inesistente not found»
--
--     La riga che dimostra la tesi è la prima: la rotta firmata ARRIVA al gestore TUS
--     e si lamenta di un'intestazione di protocollo, mentre la gemella non firmata non
--     ci arriva mai, perché il controllo JWT la respinge prima. Le altre due servono a
--     dire dove sta il confine, e vanno lette insieme: `/upload/resumable/*` è
--     registrata come rotta jolly CON il controllo JWT, quindi assorbe qualunque
--     sottopercorso sconosciuto e risponde esattamente come la gemella. Un caso di
--     controllo scelto lì dentro non è un caso di controllo — è l'errore con cui una
--     stesura precedente di questa stessa nota dichiarava un `404` che non esiste, su
--     tre risposte che erano due. Il controllo vero si sceglie FUORI da quel prefisso,
--     ed è la quarta riga.
--
-- CONSEGUENZA DI PROGETTO, da rispettare in V07/V10: il browser non presenta MAI un
-- token di sessione allo Storage. La route conia la firma con la chiave di servizio e
-- restituisce al client il percorso + il token; il client carica con `tus-js-client`
-- su `/upload/resumable/sign` mettendo il token in `x-signature`. È anche il modello
-- di accesso che questo repository ha già ovunque, ed è scritto nelle migrazioni dei
-- bucket del 2026-07-31: «le scritture passano tutte dal client service-role».
--
-- Resta il vincolo sulla FORMA del percorso: `original_path` deve cominciare con
-- l'uuid del proprietario. Qui va detto con precisione che cosa compra e che cosa NON
-- compra, perché la stesura precedente di questa nota lo attribuiva all'oblio GDPR e
-- la misura dice il contrario:
--
--   · NON è l'indice dell'oblio, e usarlo come tale non cancellerebbe niente.
--     `REGISTRO_BUCKET_OBLIO` (`src/lib/gdpr/esegui.ts`) cancella per
--     `CanaleOblio = 'alunno' | 'genitore'`, e ogni sua voce si aggancia a una colonna
--     del bambino o del genitore. Il prefisso di questo percorso è invece l'uuid di
--     CHI CARICA — un insegnante, il gate è `requireDocente` — quindi elencare la
--     cartella di un insegnante non trova il video di un bambino. E `video_originals`
--     / `video_processing` in quel registro non compaiono affatto: zero occorrenze,
--     verificato. Il buco è già tracciato dove va chiuso, cioè nella voce IN_CODA di
--     `20260916190000` in `__tests__/architecture/migrazioni-complete.test.ts`, che
--     ordina di registrare i due bucket quando la migrazione si applica.
--
--   · Quello che il vincolo compra davvero, ed è il motivo per cui resta: ogni
--     originale è attribuibile al proprio caricatore senza interrogare il database, e
--     la pulizia per caricatore — un insegnante che lascia la scuola, una cartella
--     rimasta orfana dopo un intent mai confermato — diventa un `list` per prefisso
--     invece di una scansione del bucket. E siccome il percorso lo propone il client
--     nella richiesta che conia la firma, il vincolo impedisce a chi carica di
--     scrivere dentro la cartella di un altro caricatore.
--
-- Lo impongono `video_intent_open` e `video_intent_add_job`, non un commento.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- `action_required` PRIMA DELLA CONFERMA: NON SI ALLARGA IL CHECK
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `video_intents_stato_tempi_chk` ammette `action_required` soltanto con
-- `confirmed_at IS NOT NULL`. Quindi un job che fallisce PRIMA della conferma lascia
-- l'intent `pending` con un job `failed`, e non esiste uno stato d'intent che
-- l'interfaccia possa leggere per dire «serve il tuo intervento».
--
-- La decisione è: **il CHECK resta com'è, e finché l'intent è `pending` l'interfaccia
-- legge lo stato del JOB.** Due ragioni, entrambe misurabili sullo schema:
--
--   · `pending` significa «l'utente non ha ancora confermato»: non c'è niente da
--     riparare a livello di intent, perché l'intent non è ancora un impegno a
--     pubblicare. La cosa rotta è un singolo caricamento, ed è un fatto del job —
--     che ha già `status`, `error_code` e `attempt` per raccontarlo;
--   · `video_intents` non ha nessuna colonna per dire QUALE job è in difficoltà.
--     Un `action_required` prima della conferma sarebbe uno stato senza contenuto,
--     e renderebbe `confirmed_at` ambiguo: oggi quel campo dice «l'utente si è
--     impegnato», domani direbbe due cose diverse a seconda del ramo.
--
-- Chi implementerà V07 (stato) e V11/V12 (interfaccia) parta da qui invece di
-- inventare due risposte diverse: intent `pending` → si mostra lo stato dei job;
-- intent `confirmed` in poi → si mostra lo stato dell'intent.

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_open — apre intent + primo job, idempotente sulla chiave del client
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- L'idempotenza non è una comodità: il telefono che perde la rete rispedisce la
-- stessa richiesta, e senza di lei ogni ritentativo aprirebbe un intent nuovo con un
-- originale nuovo — cioè moltiplicherebbe i video da conservare e da cancellare.
-- La chiave è l'UNIQUE `(owner_id, channel, idempotency_key)` già dichiarata su
-- `video_jobs`: al secondo giro si RITORNA il job esistente, non si solleva
-- `unique_violation`.
CREATE OR REPLACE FUNCTION public.video_intent_open(
  p_owner_id uuid,
  p_scuola_id uuid,
  p_channel text,
  p_requested_action text,
  p_payload jsonb,
  p_idempotency_key text,
  p_original_path text,
  p_target_id uuid,
  p_expected_target_version timestamptz
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
  v_vincolo text;
BEGIN
  IF p_owner_id IS NULL
    OR p_channel IS NULL
    OR p_channel NOT IN ('gallery', 'news')
    OR p_requested_action IS NULL
    OR p_requested_action NOT IN ('attach_private', 'submit_proposal', 'publish', 'schedule')
    OR p_payload IS NULL
    OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR p_idempotency_key IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) < 1
    OR pg_catalog.char_length(p_idempotency_key) > 128
    OR p_original_path IS NULL
    OR pg_catalog.char_length(p_original_path) > 1024
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-open', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- Il percorso dell'originale deve stare nella cartella del proprietario: è il
  -- prefisso con cui l'oblio GDPR trova i file di una persona. Vedi la testata.
  IF p_original_path NOT LIKE p_owner_id::text || '/%' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-open', 'error', NULL, NULL, 'ORIGINAL_PATH_SCOPE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ORIGINAL_PATH_SCOPE');
  END IF;

  -- Lo scope senza sede esiste per una News globale dichiarata, e per nient'altro.
  -- Lo ripete anche `video_intents_scuola_scope_chk`, ma un check_violation grezzo
  -- arriva al chiamante come 500: qui diventa un codice che la route sa tradurre.
  IF p_scuola_id IS NULL
    AND NOT (p_channel = 'news' AND COALESCE(p_payload ->> 'scope' = 'global', false))
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-open', 'error', NULL, NULL, 'SCOPE_REQUIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SCOPE_REQUIRED');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE owner_id = p_owner_id
    AND channel = p_channel
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    -- Ritentativo: si rilegge sotto lock, nell'ordine intent → job.
    SELECT * INTO v_intent
    FROM public.video_intents
    WHERE id = v_job.intent_id
    FOR UPDATE;

    SELECT * INTO v_job
    FROM public.video_jobs
    WHERE id = v_job.id
    FOR UPDATE;

    IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
      PERFORM public._video_job_transition_log(
        'video-intent-open', 'error', v_job.id, v_intent.id, 'INTENT_CHANGED_RETRY'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
    END IF;

    v_now := pg_catalog.clock_timestamp();

    -- Stessa chiave, altro contenuto: non è un ritentativo, è un errore del
    -- chiamante. Restituire il vecchio job lo farebbe caricare su un originale che
    -- non è il suo, e il runner transcodificherebbe il video sbagliato.
    IF v_intent.scuola_id IS DISTINCT FROM p_scuola_id
      OR v_intent.channel IS DISTINCT FROM p_channel
      OR v_job.original_path IS DISTINCT FROM p_original_path
    THEN
      PERFORM public._video_job_transition_log(
        'video-intent-open', 'error', v_job.id, v_intent.id, 'IDEMPOTENCY_CONFLICT'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT');
    END IF;

    PERFORM public._video_job_transition_log(
      'video-intent-open', 'info', v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true, 'revision', v_intent.revision)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'intent', pg_catalog.to_jsonb(v_intent),
      'job', pg_catalog.to_jsonb(v_job)
    );
  END IF;

  BEGIN
    INSERT INTO public.video_intents(
      owner_id, scuola_id, channel, target_id, revision,
      expected_target_version, requested_action, payload, status
    ) VALUES (
      p_owner_id, p_scuola_id, p_channel, p_target_id, 1,
      p_expected_target_version, p_requested_action, p_payload, 'pending'
    )
    RETURNING * INTO v_intent;

    INSERT INTO public.video_jobs(
      owner_id, scuola_id, channel, idempotency_key, intent_id,
      original_bucket, original_path, status
    ) VALUES (
      p_owner_id, p_scuola_id, p_channel, p_idempotency_key, v_intent.id,
      'video_originals', p_original_path, 'awaiting_upload'
    )
    RETURNING * INTO v_job;
  EXCEPTION WHEN unique_violation THEN
    -- QUALE indice ha rifiutato si LEGGE, non si deduce. Qui ne possono scattare tre
    -- (la chiave del client, l'originale, il target), e la deduzione «se la chiave
    -- non c'è, allora era l'originale» ne copriva due su tre: un conflitto sul TARGET
    -- usciva come `ORIGINAL_PATH_TAKEN`, cioè mandava la route a dire all'utente di
    -- scegliere un altro file mentre il file era libero. Misurato: due `open` sullo
    -- stesso `p_target_id`, con chiavi e originali diversi, e
    -- `count(*) FROM video_jobs WHERE original_path = <il secondo>` uguale a 0.
    GET STACKED DIAGNOSTICS v_vincolo = CONSTRAINT_NAME;

    IF v_vincolo = 'video_intents_target_revision_unico_idx' THEN
      PERFORM public._video_job_transition_log(
        'video-intent-open', 'error', NULL, NULL, 'TARGET_CONFLICT'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TARGET_CONFLICT');
    END IF;

    IF v_vincolo = 'video_jobs_originale_unico' THEN
      -- L'originale è già assegnato a un altro job: due job sullo stesso file si
      -- sovrascriverebbero a vicenda.
      PERFORM public._video_job_transition_log(
        'video-intent-open', 'error', NULL, NULL, 'ORIGINAL_PATH_TAKEN'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ORIGINAL_PATH_TAKEN');
    END IF;

    IF v_vincolo IS DISTINCT FROM 'video_jobs_owner_channel_idempotency_key_key' THEN
      -- Un indice che questa funzione non conosce. Tradurlo in uno dei codici noti è
      -- esattamente il difetto appena chiuso: il prossimo indice aggiunto allo schema
      -- lo riaprirebbe in silenzio. Si dice che non lo si sa, e il nome va nel log.
      PERFORM public._video_job_transition_log(
        'video-intent-open', 'error', NULL, NULL, 'UNIQUE_CONFLICT',
        pg_catalog.jsonb_build_object('vincolo', v_vincolo)
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'UNIQUE_CONFLICT');
    END IF;

    -- Resta la chiave del client: due richieste gemelle in volo, e la perdente arriva
    -- qui. La vincente ha già committato (l'indice unico l'ha fatta attendere),
    -- quindi la rilettura la vede.
    SELECT * INTO v_job
    FROM public.video_jobs
    WHERE owner_id = p_owner_id
      AND channel = p_channel
      AND idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      -- La chiave ha rifiutato ma la riga non c'è: la gemella ha preso l'indice e poi
      -- ha fatto rollback. Non c'è niente da restituire, e inventare un codice di
      -- dominio per un incidente di concorrenza è come nasce una diagnosi sbagliata.
      PERFORM public._video_job_transition_log(
        'video-intent-open', 'error', NULL, NULL, 'UNIQUE_CONFLICT',
        pg_catalog.jsonb_build_object('vincolo', v_vincolo, 'gemella_annullata', true)
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'UNIQUE_CONFLICT');
    END IF;

    SELECT * INTO v_intent
    FROM public.video_intents
    WHERE id = v_job.intent_id;

    PERFORM public._video_job_transition_log(
      'video-intent-open', 'info', v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true, 'concorrente', true)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'intent', pg_catalog.to_jsonb(v_intent),
      'job', pg_catalog.to_jsonb(v_job)
    );
  END;

  PERFORM public._video_job_transition_log(
    'video-intent-open', 'info', v_job.id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('revision', v_intent.revision, 'channel', p_channel)
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'intent', pg_catalog.to_jsonb(v_intent),
    'job', pg_catalog.to_jsonb(v_job)
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_open(
  uuid, uuid, text, text, jsonb, text, text, uuid, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_open(
  uuid, uuid, text, text, jsonb, text, text, uuid, timestamptz
) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_add_job — il secondo, terzo, quarto allegato di una News
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Solo mentre l'intent è `pending`. Dopo la conferma l'utente si è impegnato su un
-- insieme preciso di video: aggiungerne un altro cambierebbe ciò che ha confermato
-- senza che ne sappia niente, e `video_intent_finalize` aspetterebbe un job che
-- l'utente non ha mai visto.
CREATE OR REPLACE FUNCTION public.video_intent_add_job(
  p_intent_id uuid,
  p_owner_id uuid,
  p_revision integer,
  p_idempotency_key text,
  p_original_path text
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
  v_vincolo text;
BEGIN
  IF p_intent_id IS NULL
    OR p_owner_id IS NULL
    OR p_revision IS NULL
    OR p_revision < 1
    OR p_idempotency_key IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) < 1
    OR pg_catalog.char_length(p_idempotency_key) > 128
    OR p_original_path IS NULL
    OR pg_catalog.char_length(p_original_path) > 1024
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  IF p_original_path NOT LIKE p_owner_id::text || '/%' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, p_intent_id, 'ORIGINAL_PATH_SCOPE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ORIGINAL_PATH_SCOPE');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;
  IF v_intent.revision IS DISTINCT FROM p_revision THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, v_intent.id, 'REVISION_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_MISMATCH');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE owner_id = p_owner_id
    AND channel = v_intent.channel
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_job.intent_id IS DISTINCT FROM v_intent.id
      OR v_job.original_path IS DISTINCT FROM p_original_path
    THEN
      PERFORM public._video_job_transition_log(
        'video-intent-add-job', 'error', v_job.id, v_intent.id, 'IDEMPOTENCY_CONFLICT'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT');
    END IF;
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'info', v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
  END IF;

  IF v_intent.status <> 'pending' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  -- Una Galleria è un video SOLO, e il vincolo dello schema è sul CONTEGGIO, non sul
  -- canale: `video_jobs_gallery_intent_unico_idx ON video_jobs(intent_id) WHERE
  -- channel = 'gallery'` vieta il SECONDO job di un intent galleria, non il primo.
  -- Scritto sul canale, questo guard rifiutava anche un intent galleria con ZERO job
  -- — cioè proprio la revisione che `video_intent_supersede` crea vuota: quella
  -- revisione non poteva più ricevere il proprio video e `finalize` rispondeva per
  -- sempre `NO_JOBS`. Metà dei canali non poteva essere revisionata.
  -- Il conteggio si legge sotto il lock dell'intent, che ogni strada per attaccare un
  -- job prende per prima; l'indice resta l'arbitro finale ed è gestito qui sotto.
  IF v_intent.channel = 'gallery'
    AND EXISTS (SELECT 1 FROM public.video_jobs WHERE intent_id = v_intent.id)
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, v_intent.id, 'SINGLE_JOB_CHANNEL'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SINGLE_JOB_CHANNEL');
  END IF;

  BEGIN
    INSERT INTO public.video_jobs(
      owner_id, scuola_id, channel, idempotency_key, intent_id,
      original_bucket, original_path, status
    ) VALUES (
      v_intent.owner_id, v_intent.scuola_id, v_intent.channel, p_idempotency_key,
      v_intent.id, 'video_originals', p_original_path, 'awaiting_upload'
    )
    RETURNING * INTO v_job;
  EXCEPTION WHEN unique_violation THEN
    -- Come in `video_intent_open`: l'indice che ha rifiutato si legge. Qui ne possono
    -- scattare tre, e dichiararli tutti `ORIGINAL_PATH_TAKEN` diceva «scegli un altro
    -- file» a chi aveva sbagliato tutt'altro.
    GET STACKED DIAGNOSTICS v_vincolo = CONSTRAINT_NAME;

    IF v_vincolo = 'video_jobs_gallery_intent_unico_idx' THEN
      PERFORM public._video_job_transition_log(
        'video-intent-add-job', 'error', NULL, v_intent.id, 'SINGLE_JOB_CHANNEL'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SINGLE_JOB_CHANNEL');
    END IF;

    IF v_vincolo = 'video_jobs_originale_unico' THEN
      PERFORM public._video_job_transition_log(
        'video-intent-add-job', 'error', NULL, v_intent.id, 'ORIGINAL_PATH_TAKEN'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ORIGINAL_PATH_TAKEN');
    END IF;

    IF v_vincolo = 'video_jobs_owner_channel_idempotency_key_key' THEN
      -- La gemella con la stessa chiave ha vinto la corsa fra la rilettura qui sopra
      -- e questo INSERT: è un ritentativo concorrente, non un errore del chiamante.
      SELECT * INTO v_job
      FROM public.video_jobs
      WHERE owner_id = p_owner_id
        AND channel = v_intent.channel
        AND idempotency_key = p_idempotency_key;

      IF FOUND AND v_job.original_path IS NOT DISTINCT FROM p_original_path THEN
        PERFORM public._video_job_transition_log(
          'video-intent-add-job', 'info', v_job.id, v_intent.id, NULL,
          pg_catalog.jsonb_build_object('idempotent', true, 'concorrente', true)
        );
        RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
      END IF;
      PERFORM public._video_job_transition_log(
        'video-intent-add-job', 'error', NULL, v_intent.id, 'IDEMPOTENCY_CONFLICT'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT');
    END IF;

    PERFORM public._video_job_transition_log(
      'video-intent-add-job', 'error', NULL, v_intent.id, 'UNIQUE_CONFLICT',
      pg_catalog.jsonb_build_object('vincolo', v_vincolo)
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'UNIQUE_CONFLICT');
  END;

  PERFORM public._video_job_transition_log(
    'video-intent-add-job', 'info', v_job.id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('revision', v_intent.revision)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_add_job(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_add_job(uuid, uuid, integer, text, text)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_confirm — `pending` → `confirmed`
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- È il punto in cui il telefono può chiudere l'app: la conferma PRECEDE la fine della
-- codifica, altrimenti l'utente dovrebbe restare a guardare una barra per tre minuti.
-- Perciò qui non si guarda lo stato dei job: si guarda che l'utente sia quello, che
-- la revisione sia quella attesa, e che l'intent non sia già stato chiuso da qualcun
-- altro. La prontezza la pretende `video_intent_finalize`, che è l'unico punto in cui
-- qualcosa diventa visibile alle famiglie.
--
-- Non blocca i job: non ne tocca nessuno, e prendere lock su righe che non si scrivono
-- allunga la finestra di attesa senza aggiungere nessuna garanzia. Contro un claim
-- concorrente basta il lock sull'intent, che `video_job_claim` acquisisce per primo.
CREATE OR REPLACE FUNCTION public.video_intent_confirm(
  p_intent_id uuid,
  p_owner_id uuid,
  p_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_intent_id IS NULL OR p_owner_id IS NULL OR p_revision IS NULL OR p_revision < 1 THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;
  IF v_intent.revision IS DISTINCT FROM p_revision THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'error', NULL, v_intent.id, 'REVISION_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_MISMATCH');
  END IF;

  IF v_intent.status = 'confirmed' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'info', NULL, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'intent', pg_catalog.to_jsonb(v_intent));
  END IF;
  IF v_intent.status IN ('cancelled', 'superseded') THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'error', NULL, v_intent.id, 'INTENT_REVOKED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_REVOKED');
  END IF;
  IF v_intent.status <> 'pending' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-confirm', 'error', NULL, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.video_intents
  SET status = 'confirmed',
      confirmed_at = v_now,
      updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  PERFORM public._video_job_transition_log(
    'video-intent-confirm', 'info', NULL, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('revision', v_intent.revision)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'intent', pg_catalog.to_jsonb(v_intent));
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_confirm(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_confirm(uuid, uuid, integer)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_finalize — il cuore: target, chiusura dell'intent e outbox, atomici
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- COSA GARANTISCE, detto per esteso perché V08 e V09 ci si appoggeranno:
-- in una sola transazione l'intent lega a sé il `target_id`, passa a `published` e
-- accoda l'evento in `video_outbox`. O succedono tutte e tre, o nessuna. Non esiste
-- l'istante in cui un target risulta pubblicato e la coda non lo sa, né il contrario.
--
-- COSA NON FA, ed è altrettanto importante: non scrive la riga di dominio (il media
-- della Galleria, l'articolo di News) e non rivaluta i permessi. I gate — ruolo, sede,
-- consenso foto — restano in TypeScript e sono già stati attraversati un istante
-- prima; duplicarli in SQL significa avere due verità che invecchiano separatamente,
-- ed è un difetto che questo repository ha già pagato. Qui si riverifica soltanto che
-- lo scope con cui si sta scrivendo sia ancora quello con cui i permessi erano stati
-- valutati.
--
-- L'ORDINE DEI LOCK non è decorativo: prima l'intent, poi TUTTI i suoi job con
-- `ORDER BY id`. L'ordine deterministico è ciò che impedisce a due finalize di due
-- intent che condividono dei job (non succede oggi, ma lo schema non lo vieta) di
-- incrociarsi. `clock_timestamp()` arriva dopo entrambi.
CREATE OR REPLACE FUNCTION public.video_intent_finalize(
  p_intent_id uuid,
  p_owner_id uuid,
  p_revision integer,
  p_scuola_id uuid,
  p_channel text,
  p_target_id uuid,
  p_event_type text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
  v_totale integer;
  v_pronti integer;
BEGIN
  IF p_intent_id IS NULL
    OR p_owner_id IS NULL
    OR p_revision IS NULL
    OR p_revision < 1
    OR p_channel IS NULL
    OR p_channel NOT IN ('gallery', 'news')
    OR p_target_id IS NULL
    OR p_event_type IS NULL
    OR pg_catalog.char_length(p_event_type) < 1
    OR pg_catalog.char_length(p_event_type) > 80
    OR p_event_type !~ '^[a-z][a-z0-9_.-]*$'
    OR p_payload IS NULL
    OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR pg_catalog.octet_length(p_payload::text) > 4096
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Tutti i job dell'intent, in ordine di id. È anche il punto in cui un
  -- `video_job_cancel` concorrente si mette in coda: lui prende l'intent per primo,
  -- quindi delle due l'una — o ha già committato e sotto trova `cancelled`, o
  -- aspetta che questa transazione finisca e trova `published`. Un solo vincitore.
  PERFORM 1
  FROM public.video_jobs
  WHERE intent_id = v_intent.id
  ORDER BY id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;

  -- Idempotenza: un ritentativo con lo stesso target ritorna quel target e NON
  -- riscrive niente — né `published_at`, né una seconda riga di outbox.
  IF v_intent.status = 'published' THEN
    IF v_intent.target_id IS NOT DISTINCT FROM p_target_id THEN
      PERFORM public._video_job_transition_log(
        'video-intent-finalize', 'info', NULL, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('idempotent', true, 'revision', v_intent.revision)
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'intent', pg_catalog.to_jsonb(v_intent));
    END IF;
    -- Stesso intent, altro target: qualcuno ha pubblicato due cose diverse con lo
    -- stesso impegno. Restituire in silenzio il vecchio nasconderebbe il difetto.
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'TARGET_CONFLICT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TARGET_CONFLICT');
  END IF;

  IF v_intent.status IN ('cancelled', 'superseded') THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'INTENT_REVOKED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_REVOKED');
  END IF;
  IF v_intent.status <> 'confirmed' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'NOT_CONFIRMED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_CONFIRMED');
  END IF;

  IF v_intent.revision IS DISTINCT FROM p_revision THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'REVISION_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_MISMATCH');
  END IF;

  -- Lo scope che il chiamante ha appena usato per rivalutare i permessi deve essere
  -- ancora quello dell'intent. `IS DISTINCT FROM` e non `<>`: per una News globale
  -- `scuola_id` è NULL, e `NULL <> NULL` vale NULL — cioè «non rifiutare», cioè
  -- pubblicare in una sede a caso un contenuto che non ne aveva nessuna.
  IF v_intent.channel IS DISTINCT FROM p_channel
    OR v_intent.scuola_id IS DISTINCT FROM p_scuola_id
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'SCOPE_CHANGED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SCOPE_CHANGED');
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE status = 'ready' AND verified_at IS NOT NULL
         )::integer
  INTO v_totale, v_pronti
  FROM public.video_jobs
  WHERE intent_id = v_intent.id;

  IF v_totale = 0 THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'NO_JOBS'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NO_JOBS');
  END IF;

  -- `verified_at` e non il solo `status = 'ready'`: è la data in cui l'output è stato
  -- RILETTO e verificato, e su di essa si calcola la scadenza dell'originale. Uno
  -- stato `ready` senza verifica sarebbe una promessa senza prova.
  IF v_pronti <> v_totale THEN
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, v_intent.id, 'JOBS_NOT_READY',
      pg_catalog.jsonb_build_object('totale', v_totale, 'pronti', v_pronti)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'JOBS_NOT_READY',
      'totale', v_totale, 'pronti', v_pronti
    );
  END IF;

  BEGIN
    UPDATE public.video_intents
    SET target_id = p_target_id,
        status = 'published',
        published_at = v_now,
        updated_at = v_now
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  EXCEPTION WHEN unique_violation THEN
    -- `video_intents_target_revision_unico_idx`: un altro intent dello stesso
    -- proprietario, stesso canale e stessa revisione ha già preso quel target.
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'error', NULL, p_intent_id, 'TARGET_CONFLICT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TARGET_CONFLICT');
  END;

  BEGIN
    INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
    VALUES (v_intent.id, v_intent.revision, p_event_type, p_payload);
  EXCEPTION WHEN unique_violation THEN
    -- L'UNIQUE `(intent_id, revision, event_type)` è la rete: l'evento c'era già.
    -- Non è un errore, è la definizione di «accodato una volta sola».
    PERFORM public._video_job_transition_log(
      'video-intent-finalize', 'info', NULL, v_intent.id, 'OUTBOX_ALREADY_QUEUED'
    );
  END;

  PERFORM public._video_job_transition_log(
    'video-intent-finalize', 'info', NULL, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'revision', v_intent.revision,
      'job_pubblicati', v_totale,
      'event_type', p_event_type
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'intent', pg_catalog.to_jsonb(v_intent));
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_finalize(
  uuid, uuid, integer, uuid, text, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_finalize(
  uuid, uuid, integer, uuid, text, uuid, text, jsonb
) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_supersede — la revisione nuova nasce come intent NUOVO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Non è una preferenza di stile: `video_intents_revision_immutabile_guard` VIETA di
-- incrementare `revision` in posto, perché `video_outbox` la referenzia con una FK su
-- `(intent_id, revision)`. Cambiarla sotto la coda significherebbe che un evento già
-- accodato racconta una revisione che non esiste più.
--
-- L'uuid del nuovo intent lo sceglie il CHIAMANTE. È ciò che rende la funzione
-- ripetibile: al secondo giro si ritrova quell'uuid e lo si restituisce, invece di
-- creare una terza revisione a ogni ritentativo di rete.
--
-- Un intent `published` PUÒ essere superato — è la modifica di una News già online —
-- e lo schema lo ammette: il ramo `superseded` del CHECK non pretende
-- `published_at IS NULL`, a differenza del ramo `cancelled`. Per questo un ritiro di
-- ciò che è già pubblicato passa da qui e non da `video_intent_revoke`.
--
-- E proprio perché è l'altra strada per chiudere un intent, fa sui job ciò che fa
-- `revoke`: spegne quelli non conclusi, alza il `fence_epoch` e fissa la scadenza dei
-- loro originali. Il dettaglio, con le due misure che l'hanno imposto, sta accanto
-- all'UPDATE.
CREATE OR REPLACE FUNCTION public.video_intent_supersede(
  p_intent_id uuid,
  p_owner_id uuid,
  p_revision integer,
  p_nuovo_intent_id uuid,
  p_requested_action text,
  p_payload jsonb,
  p_expected_target_version timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_nuovo public.video_intents%ROWTYPE;
  v_azione text;
  v_payload jsonb;
  v_now timestamptz;
  v_spenti integer;
BEGIN
  IF p_intent_id IS NULL
    OR p_owner_id IS NULL
    OR p_revision IS NULL
    OR p_revision < 1
    OR p_nuovo_intent_id IS NULL
    OR p_nuovo_intent_id = p_intent_id
    OR (p_requested_action IS NOT NULL
        AND p_requested_action NOT IN ('attach_private', 'submit_proposal', 'publish', 'schedule'))
    OR (p_payload IS NOT NULL AND pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object')
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Ordine di lock intent → job, come ovunque. Qui i job si SCRIVONO davvero — vanno
  -- spenti più sotto, vedi il blocco dopo l'UPDATE — quindi vanno bloccati, e
  -- l'orologio arriva dopo entrambi i lock.
  PERFORM 1
  FROM public.video_jobs
  WHERE intent_id = v_intent.id
  ORDER BY id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;
  IF v_intent.revision IS DISTINCT FROM p_revision THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, v_intent.id, 'REVISION_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_MISMATCH');
  END IF;
  IF v_intent.status = 'cancelled' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, v_intent.id, 'INTENT_REVOKED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_REVOKED');
  END IF;

  IF v_intent.status = 'superseded' THEN
    SELECT * INTO v_nuovo FROM public.video_intents WHERE id = p_nuovo_intent_id;
    IF FOUND AND v_nuovo.owner_id = v_intent.owner_id
      AND v_nuovo.revision = v_intent.revision + 1
    THEN
      PERFORM public._video_job_transition_log(
        'video-intent-supersede', 'info', NULL, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('idempotent', true, 'revision', v_nuovo.revision)
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'intent', pg_catalog.to_jsonb(v_nuovo));
    END IF;
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, v_intent.id, 'ALREADY_SUPERSEDED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_SUPERSEDED');
  END IF;

  v_azione := COALESCE(p_requested_action, v_intent.requested_action);
  v_payload := COALESCE(p_payload, v_intent.payload);

  -- Lo scope della nuova revisione è quello della vecchia: cambiare sede o canale
  -- non è una revisione, è un altro contenuto, e si apre con `video_intent_open`.
  IF v_intent.scuola_id IS NULL
    AND NOT (v_intent.channel = 'news' AND COALESCE(v_payload ->> 'scope' = 'global', false))
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, v_intent.id, 'SCOPE_REQUIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SCOPE_REQUIRED');
  END IF;

  BEGIN
    INSERT INTO public.video_intents(
      id, owner_id, scuola_id, channel, target_id, revision,
      expected_target_version, requested_action, payload, status
    ) VALUES (
      p_nuovo_intent_id, v_intent.owner_id, v_intent.scuola_id, v_intent.channel,
      v_intent.target_id, v_intent.revision + 1,
      COALESCE(p_expected_target_version, v_intent.expected_target_version),
      v_azione, v_payload, 'pending'
    )
    RETURNING * INTO v_nuovo;
  EXCEPTION WHEN unique_violation THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'error', NULL, v_intent.id, 'REVISION_TAKEN'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_TAKEN');
  END;

  UPDATE public.video_intents
  SET status = 'superseded',
      revoked_at = v_now,
      updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  -- I job della revisione superata si spengono, esattamente come fa
  -- `video_intent_revoke`. L'asimmetria fra i due modi di chiudere un intent — dopo
  -- entrambi non si pubblica più, ma solo `revoke` toccava i job — costava due cose,
  -- misurate su PGlite prima di questa correzione:
  --
  --   (a) un worker con la lease ancora in corso chiudeva comunque il proprio job
  --       (`video_job_ready` rispondeva `{"ok":true}` con `fence_epoch` rimasto a 1) e
  --       produceva l'output di una revisione che nessuno pubblicherà;
  --   (b) un job non ancora concluso restava con `original_delete_after` NULL, cioè
  --       INVISIBILE a `video_jobs_retention_originali_idx` (`WHERE
  --       original_deleted_at IS NULL AND original_delete_after IS NOT NULL`): 0 righe
  --       su 1. L'originale — il video di un minore in un bucket privato — non aveva
  --       nessuna data di cancellazione, per sempre.
  --
  -- Si spengono SOLO i job non conclusi, e le due esclusioni hanno motivi diversi.
  -- Un job `ready` NON si tocca: il suo originale ha già una scadenza esatta
  -- (`verified_at + 7 giorni`, la scrive `video_job_ready` e la impone
  -- `video_jobs_original_ttl_chk`), quindi il guasto (b) non lo riguarda — e siccome
  -- un intent `published` PUÒ essere superato, quell'output è proprio il video che le
  -- famiglie stanno guardando finché la revisione nuova non pubblica: spegnerlo
  -- toglierebbe dalla vista il contenuto vivo. `failed` e `rejected` restano dove
  -- sono, come in `revoke`: portano il proprio `error_code` e la propria scadenza, e
  -- riscriverli cancellerebbe il motivo del guasto.
  WITH spenti AS (
    UPDATE public.video_jobs
    SET status = 'cancelled',
        fence_epoch = fence_epoch + 1,
        lease_owner = NULL,
        lease_expires_at = NULL,
        original_delete_after = LEAST(
          COALESCE(original_delete_after, v_now),
          v_now,
          COALESCE(original_deleted_at, v_now)
        ),
        updated_at = v_now
    WHERE intent_id = v_intent.id
      AND status IN ('awaiting_upload', 'queued', 'processing')
    RETURNING id
  )
  SELECT count(*)::integer INTO v_spenti FROM spenti;

  -- La revisione superata porta con sé i propri originali, che nessuno pubblicherà
  -- più: la retention deve saperlo, o quei file restano sette giorni in più di
  -- quanto serva. Sono video di minori: il tempo in più non è gratis.
  BEGIN
    INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
    VALUES (
      v_intent.id, v_intent.revision, 'intent.superseded',
      pg_catalog.jsonb_build_object(
        'intent_successivo', v_nuovo.id,
        'revisione_successiva', v_nuovo.revision,
        'job_spenti', v_spenti
      )
    );
  EXCEPTION WHEN unique_violation THEN
    PERFORM public._video_job_transition_log(
      'video-intent-supersede', 'info', NULL, v_intent.id, 'OUTBOX_ALREADY_QUEUED'
    );
  END;

  PERFORM public._video_job_transition_log(
    'video-intent-supersede', 'info', NULL, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'revisione_precedente', v_intent.revision,
      'revisione_successiva', v_nuovo.revision,
      'job_spenti', v_spenti
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'intent', pg_catalog.to_jsonb(v_nuovo),
    'job_spenti', v_spenti
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_supersede(
  uuid, uuid, integer, uuid, text, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_supersede(
  uuid, uuid, integer, uuid, text, jsonb, timestamptz
) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_revoke — l'intent muore e la coda lo sa
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Cancella anche i job non ancora conclusi, alzando `fence_epoch` esattamente come fa
-- `video_job_cancel`: un worker che sta transcodificando con la lease precedente non
-- potrà più chiudere il proprio job, perché `video_job_ready` confronta il fence.
-- Senza quell'incremento il ritiro sarebbe una dichiarazione d'intenti e il video
-- comparirebbe comunque.
--
-- Un intent GIÀ PUBBLICATO non si ritira da qui, e non per prudenza: il CHECK
-- `video_intents_stato_tempi_chk` pretende `published_at IS NULL` sul ramo
-- `cancelled`, quindi l'UPDATE fallirebbe con un 23514 anonimo. Per togliere dalla
-- vista qualcosa di pubblicato si usa `video_intent_supersede`.
CREATE OR REPLACE FUNCTION public.video_intent_revoke(
  p_intent_id uuid,
  p_owner_id uuid,
  p_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
  v_cancellati integer;
BEGIN
  IF p_intent_id IS NULL OR p_owner_id IS NULL OR p_revision IS NULL OR p_revision < 1 THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  PERFORM 1
  FROM public.video_jobs
  WHERE intent_id = v_intent.id
  ORDER BY id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;
  IF v_intent.revision IS DISTINCT FROM p_revision THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'error', NULL, v_intent.id, 'REVISION_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_MISMATCH');
  END IF;
  IF v_intent.status = 'published' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'error', NULL, v_intent.id, 'INTENT_PUBLISHED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_PUBLISHED');
  END IF;
  IF v_intent.status = 'superseded' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'error', NULL, v_intent.id, 'ALREADY_SUPERSEDED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_SUPERSEDED');
  END IF;

  IF v_intent.status <> 'cancelled' THEN
    UPDATE public.video_intents
    SET status = 'cancelled',
        revoked_at = v_now,
        updated_at = v_now
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  END IF;

  -- `failed` e `rejected` restano dove sono: portano il proprio `error_code` e la
  -- propria scadenza, e riscriverli cancellerebbe il motivo del guasto.
  WITH spenti AS (
    UPDATE public.video_jobs
    SET status = 'cancelled',
        fence_epoch = fence_epoch + 1,
        lease_owner = NULL,
        lease_expires_at = NULL,
        original_delete_after = LEAST(
          COALESCE(original_delete_after, v_now),
          v_now,
          COALESCE(original_deleted_at, v_now)
        ),
        updated_at = v_now
    WHERE intent_id = v_intent.id
      AND status NOT IN ('cancelled', 'failed', 'rejected')
    RETURNING id
  )
  SELECT count(*)::integer INTO v_cancellati FROM spenti;

  BEGIN
    INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
    VALUES (
      v_intent.id, v_intent.revision, 'intent.revoked',
      pg_catalog.jsonb_build_object('job_cancellati', v_cancellati)
    );
  EXCEPTION WHEN unique_violation THEN
    PERFORM public._video_job_transition_log(
      'video-intent-revoke', 'info', NULL, v_intent.id, 'OUTBOX_ALREADY_QUEUED'
    );
  END;

  PERFORM public._video_job_transition_log(
    'video-intent-revoke', 'info', NULL, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('revision', v_intent.revision, 'job_cancellati', v_cancellati)
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'intent', pg_catalog.to_jsonb(v_intent),
    'job_cancellati', v_cancellati
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_revoke(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_revoke(uuid, uuid, integer)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Lo scrittore della coda: claim → sent, oppure claim → fail
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `video_outbox` esisteva dal 2026-09-16 senza nessuno che la leggesse. Una coda che
-- nessuno svuota non è una coda: è una tabella che cresce, e l'unica cosa che
-- garantisce — «l'effetto successivo al commit non si perde» — resta una promessa.
--
-- Il claim usa `FOR UPDATE SKIP LOCKED`: due worker che partono insieme prendono
-- eventi diversi invece di mettersi in fila. Il filtro `lease_expires_at <= v_now` fa
-- due mestieri, e chi lo semplificherà se ne ricordi: riprende gli eventi di un worker
-- morto, ed È il backoff — `video_outbox_fail` non rilascia la lease, la sposta avanti.
-- `attempts < 25` non è un numero a caso —
-- è il tetto di `video_outbox_attempts_chk`: incrementare oltre farebbe fallire
-- l'UPDATE con un 23514 invece di lasciare l'evento in quarantena.
CREATE OR REPLACE FUNCTION public.video_outbox_claim(
  p_lease_owner uuid,
  p_lease_seconds integer,
  p_limite integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_eventi jsonb;
BEGIN
  IF p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
    OR p_limite IS NULL
    OR p_limite < 1
    OR p_limite > 100
  THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-claim', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- Qui non c'è nessun ordine di lock da rispettare — si tocca una tabella sola — e
  -- l'istante serve dentro la stessa istruzione che acquisisce il lock.
  v_now := pg_catalog.clock_timestamp();

  WITH presi AS (
    SELECT id
    FROM public.video_outbox
    WHERE sent_at IS NULL
      AND attempts < 25
      AND (lease_expires_at IS NULL OR lease_expires_at <= v_now)
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_outbox AS o
    SET attempts = o.attempts + 1,
        lease_owner = p_lease_owner,
        lease_expires_at = v_now + p_lease_seconds * interval '1 second',
        updated_at = v_now
    FROM presi
    WHERE o.id = presi.id
    RETURNING o.*
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.created_at, a.id), '[]'::jsonb)
  INTO v_eventi
  FROM aggiornati AS a;

  PERFORM public._video_job_transition_log(
    'video-outbox-claim', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('presi', pg_catalog.jsonb_array_length(v_eventi))
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'eventi', v_eventi);
END
$$;

REVOKE ALL ON FUNCTION public.video_outbox_claim(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_outbox_claim(uuid, integer, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.video_outbox_sent(
  p_evento_id uuid,
  p_lease_owner uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_evento public.video_outbox%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_evento_id IS NULL OR p_lease_owner IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-sent', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_evento
  FROM public.video_outbox
  WHERE id = p_evento_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-sent', 'error', NULL, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_evento.sent_at IS NOT NULL THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-sent', 'info', NULL, v_evento.intent_id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'evento', pg_catalog.to_jsonb(v_evento));
  END IF;
  IF v_evento.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-sent', 'error', NULL, v_evento.intent_id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;

  UPDATE public.video_outbox
  SET sent_at = v_now,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE id = v_evento.id
  RETURNING * INTO v_evento;

  PERFORM public._video_job_transition_log(
    'video-outbox-sent', 'info', NULL, v_evento.intent_id, NULL,
    pg_catalog.jsonb_build_object('attempts', v_evento.attempts, 'event_type', v_evento.event_type)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'evento', pg_catalog.to_jsonb(v_evento));
END
$$;

REVOKE ALL ON FUNCTION public.video_outbox_sent(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_outbox_sent(uuid, uuid)
  TO service_role;

-- Un invio fallito NON rilascia la lease: la SPOSTA avanti di un'attesa crescente.
--
-- La lease è l'unica forma di ritardo che questo schema possiede. `video_outbox` non
-- ha nessuna colonna di backoff — id, intent_id, revision, event_type, payload,
-- attempts, lease_owner, lease_expires_at, sent_at, created_at, updated_at, e basta —
-- e `video_outbox_lease_chk` vieta perfino di tenere una scadenza senza il suo
-- proprietario, quindi «aspettare» qui si scrive in un modo solo: lasciare la lease al
-- suo posto con una scadenza più in là.
--
-- La prima stesura la rilasciava, con questa motivazione: «il worker sa già di aver
-- fallito, e far attendere la coda un timeout che nessuno sta aspettando è tempo
-- regalato». Ottimizzava il guasto PERMANENTE a spese di quello TRANSITORIO, che per
-- un transactional outbox è il caso normale. Misurato su PGlite: un solo evento in
-- coda, lease dichiarata di 600 secondi, un worker che ridrena subito — **25 tentativi
-- bruciati in 16 millisecondi**, poi `attempts = 25` e il claim non lo rivede più.
-- L'evento bruciato è quello di `video_intent_finalize`, cioè l'unica riga che dice
-- «aggancia questo video alla sua News»: un 5xx di passaggio, o una News non ancora
-- visibile, e il video non viene agganciato mai più, senza che nulla riprovi.
--
-- L'attesa raddoppia da 5 secondi e si ferma a 900: i 25 tentativi coprono così circa
-- quattro ore e mezza, che è la durata di un rilascio andato male o di una rete che
-- torna. `attempts` resta come il claim l'ha lasciato — è il contatore che porta
-- l'evento in quarantena a 25, e azzerarlo qui renderebbe il tetto irraggiungibile.
CREATE OR REPLACE FUNCTION public.video_outbox_fail(
  p_evento_id uuid,
  p_lease_owner uuid,
  p_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_evento public.video_outbox%ROWTYPE;
  v_now timestamptz;
  v_attesa_secondi integer;
BEGIN
  IF p_evento_id IS NULL
    OR p_lease_owner IS NULL
    OR p_error_code IS NULL
    OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
  THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-fail', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_evento
  FROM public.video_outbox
  WHERE id = p_evento_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-fail', 'error', NULL, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_evento.sent_at IS NOT NULL THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-fail', 'error', NULL, v_evento.intent_id, 'ALREADY_SENT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_SENT');
  END IF;
  IF v_evento.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-fail', 'error', NULL, v_evento.intent_id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;

  -- 5 · 2^(tentativi-1), con il tetto a 900 secondi. `GREATEST(attempts, 1)` non è
  -- superstizione: solo `video_outbox_claim` assegna una lease e incrementa, quindi
  -- qui `attempts` vale già almeno 1 — ma un esponente negativo darebbe un'attesa
  -- frazionaria, cioè nessuna attesa, che è esattamente il guasto appena chiuso.
  v_attesa_secondi := LEAST(
    (5 * (2 ^ LEAST(GREATEST(v_evento.attempts, 1) - 1, 8)))::integer,
    900
  );

  UPDATE public.video_outbox
  SET lease_owner = p_lease_owner,
      lease_expires_at = v_now + v_attesa_secondi * interval '1 second',
      updated_at = v_now
  WHERE id = v_evento.id
  RETURNING * INTO v_evento;

  PERFORM public._video_job_transition_log(
    'video-outbox-fail', 'error', NULL, v_evento.intent_id, p_error_code,
    pg_catalog.jsonb_build_object(
      'attempts', v_evento.attempts,
      'event_type', v_evento.event_type,
      'attesa_secondi', v_attesa_secondi
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'evento', pg_catalog.to_jsonb(v_evento),
    'attesa_secondi', v_attesa_secondi
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_outbox_fail(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_outbox_fail(uuid, uuid, text)
  TO service_role;

-- Successo osservabile, senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-intent-lifecycle-migration',
        'sorgente', 'server',
        'messaggio', 'RPC ciclo di vita intent video installate',
        'fingerprint', 'video-intent-lifecycle-migration-v1',
        'contesto', jsonb_build_object(
          'rpc_intent', 6,
          'rpc_outbox', 3,
          'policy_storage', 0
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
