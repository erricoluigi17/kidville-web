-- Transizioni atomiche del lifecycle dei job video.
--
-- Le RPC sono accessibili soltanto al service role. Tutte acquisiscono i lock
-- nello stesso ordine (intent, poi job), così la futura pubblicazione può usare
-- lo stesso ordine senza introdurre deadlock. Claim e completamento sono
-- protetti da lease + fence_epoch: un worker scaduto non può più scrivere.

CREATE OR REPLACE FUNCTION public._video_job_transition_log(
  p_event text,
  p_level text,
  p_job_id uuid,
  p_intent_id uuid,
  p_code text DEFAULT NULL,
  p_context jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- Il logging è deliberatamente fail-open: osservabilità e dati applicativi
  -- non condividono il destino della transazione.
  BEGIN
    IF pg_catalog.to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
      PERFORM public.app_log_registra(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'livello', p_level,
          'evento', p_event,
          'sorgente', 'server',
          'messaggio', 'Transizione lifecycle job video',
          'fingerprint', p_event || COALESCE(':' || p_code, ''),
          'contesto', pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'job_id', p_job_id,
              'intent_id', p_intent_id,
              'code', p_code
            ) || COALESCE(p_context, '{}'::jsonb)
          )
        )
      ));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END
$$;

REVOKE ALL ON FUNCTION public._video_job_transition_log(text, text, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.video_job_uploaded(
  p_job_id uuid,
  p_owner_id uuid,
  p_source_size bigint,
  p_source_mime text
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
    OR p_owner_id IS NULL
    OR p_source_size IS NULL
    OR p_source_size < 1
    OR p_source_size > 2000000000
    OR p_source_mime IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_source_mime)) < 1
    OR pg_catalog.char_length(p_source_mime) > 255
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-uploaded', 'error', p_job_id, NULL, 'BAD_INPUT'
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
      'video-job-uploaded', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-uploaded', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-job-uploaded', 'error', p_job_id, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;

  IF v_intent.status IN ('cancelled', 'superseded', 'published') THEN
    PERFORM public._video_job_transition_log(
      'video-job-uploaded', 'error', p_job_id, v_intent.id, 'INTENT_INACTIVE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_INACTIVE');
  END IF;

  IF v_job.status = 'awaiting_upload' THEN
    UPDATE public.video_jobs
    SET status = 'queued',
        source_size = p_source_size,
        source_mime = p_source_mime,
        updated_at = v_now
    WHERE id = p_job_id
    RETURNING * INTO v_job;
  ELSIF v_job.status IN ('queued', 'processing', 'ready') THEN
    IF v_job.source_size IS DISTINCT FROM p_source_size
      OR v_job.source_mime IS DISTINCT FROM p_source_mime
    THEN
      PERFORM public._video_job_transition_log(
        'video-job-uploaded', 'error', p_job_id, v_intent.id, 'SOURCE_CONFLICT'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SOURCE_CONFLICT');
    END IF;
  ELSE
    PERFORM public._video_job_transition_log(
      'video-job-uploaded', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  PERFORM public._video_job_transition_log(
    'video-job-uploaded', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('status', v_job.status, 'source_size', p_source_size)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_job_uploaded(uuid, uuid, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_uploaded(uuid, uuid, bigint, text)
  TO service_role;

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

CREATE OR REPLACE FUNCTION public.video_job_heartbeat(
  p_job_id uuid,
  p_fence_epoch bigint,
  p_lease_owner uuid
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
  IF p_job_id IS NULL OR p_fence_epoch IS NULL OR p_lease_owner IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-job-heartbeat', 'error', p_job_id, NULL, 'BAD_INPUT'
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
      'video-job-heartbeat', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-heartbeat', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.fence_epoch IS DISTINCT FROM p_fence_epoch THEN
    PERFORM public._video_job_transition_log(
      'video-job-heartbeat', 'error', p_job_id, v_intent.id, 'FENCE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');
  END IF;
  IF v_job.status <> 'processing' THEN
    PERFORM public._video_job_transition_log(
      'video-job-heartbeat', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-job-heartbeat', 'error', p_job_id, v_intent.id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-heartbeat', 'error', p_job_id, v_intent.id, 'LEASE_EXPIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_EXPIRED');
  END IF;

  UPDATE public.video_jobs
  SET lease_expires_at = v_now + interval '5 minutes',
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-job-heartbeat', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'lease_seconds', 300
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_job_heartbeat(uuid, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_heartbeat(uuid, bigint, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.video_job_ready(
  p_job_id uuid,
  p_fence_epoch bigint,
  p_lease_owner uuid,
  p_output_path text,
  p_output_size bigint,
  p_probe_json jsonb
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
  v_duration numeric;
BEGIN
  IF p_job_id IS NULL
    OR p_fence_epoch IS NULL
    OR p_lease_owner IS NULL
    OR p_output_path IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_output_path)) < 1
    OR pg_catalog.char_length(p_output_path) > 1024
    OR p_output_size IS NULL
    OR p_output_size < 1
    OR p_output_size > 2000000000
    OR p_probe_json IS NULL
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  IF pg_catalog.jsonb_typeof(p_probe_json) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_probe_json -> 'durationSeconds') IS DISTINCT FROM 'number'
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_duration := (p_probe_json ->> 'durationSeconds')::numeric;
  IF v_duration <= 0 OR v_duration > 180 THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'BAD_INPUT'
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
      'video-job-ready', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.fence_epoch IS DISTINCT FROM p_fence_epoch THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'FENCE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');
  END IF;

  IF v_job.status = 'ready' THEN
    IF v_job.output_bucket = 'video_processing'
      AND v_job.output_path = p_output_path
      AND v_job.output_size = p_output_size
      AND v_job.probe_json = p_probe_json
    THEN
      PERFORM public._video_job_transition_log(
        'video-job-ready', 'info', p_job_id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('idempotent', true, 'fence_epoch', v_job.fence_epoch)
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
    END IF;
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'OUTPUT_CONFLICT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OUTPUT_CONFLICT');
  END IF;

  IF v_job.status <> 'processing' THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'LEASE_EXPIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_EXPIRED');
  END IF;

  UPDATE public.video_jobs
  SET status = 'ready',
      output_bucket = 'video_processing',
      output_path = p_output_path,
      output_size = p_output_size,
      probe_json = p_probe_json,
      error_code = NULL,
      verified_at = v_now,
      original_delete_after = v_now + interval '7 days',
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-job-ready', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'output_size', p_output_size
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
EXCEPTION WHEN unique_violation THEN
  PERFORM public._video_job_transition_log(
    'video-job-ready', 'error', p_job_id, v_intent.id, 'OUTPUT_CONFLICT'
  );
  RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OUTPUT_CONFLICT');
END
$$;

REVOKE ALL ON FUNCTION public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.video_job_fail(
  p_job_id uuid,
  p_fence_epoch bigint,
  p_lease_owner uuid,
  p_error_code text,
  p_rejected boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_status text;
  v_now timestamptz;
BEGIN
  IF p_job_id IS NULL
    OR p_fence_epoch IS NULL
    OR p_lease_owner IS NULL
    OR p_error_code IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_error_code)) < 1
    OR pg_catalog.char_length(p_error_code) > 80
    OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
    OR p_rejected IS NULL
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;
  v_status := CASE WHEN p_rejected THEN 'rejected' ELSE 'failed' END;

  SELECT i.* INTO v_intent
  FROM public.video_intents AS i
  INNER JOIN public.video_jobs AS j ON j.intent_id = i.id
  WHERE j.id = p_job_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.fence_epoch IS DISTINCT FROM p_fence_epoch THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, v_intent.id, 'FENCE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');
  END IF;

  IF v_job.status IN ('failed', 'rejected') THEN
    IF v_job.status = v_status AND v_job.error_code = p_error_code THEN
      PERFORM public._video_job_transition_log(
        'video-job-fail', 'info', p_job_id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('idempotent', true, 'fence_epoch', v_job.fence_epoch)
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
    END IF;
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, v_intent.id, 'ERROR_CONFLICT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'ERROR_CONFLICT');
  END IF;

  IF v_job.status <> 'processing' THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, v_intent.id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-fail', 'error', p_job_id, v_intent.id, 'LEASE_EXPIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_EXPIRED');
  END IF;

  UPDATE public.video_jobs
  SET status = v_status,
      error_code = p_error_code,
      original_delete_after = v_now + interval '7 days',
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-job-fail', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'status', v_status,
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'error_code', p_error_code
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_job_fail(uuid, bigint, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_fail(uuid, bigint, uuid, text, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.video_job_cancel(
  p_job_id uuid,
  p_owner_id uuid
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
  IF p_job_id IS NULL OR p_owner_id IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-job-cancel', 'error', p_job_id, NULL, 'BAD_INPUT'
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
      'video-job-cancel', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-cancel', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-job-cancel', 'error', p_job_id, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;
  IF v_intent.status = 'published' THEN
    PERFORM public._video_job_transition_log(
      'video-job-cancel', 'error', p_job_id, v_intent.id, 'INTENT_PUBLISHED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_PUBLISHED');
  END IF;

  -- Il cancel di un allegato News revoca l'intero intento confermato. Gli altri
  -- job restano intatti: possono concludere una lease già acquisita, ma l'intent
  -- revocato non potrà essere pubblicato e non accetta claim futuri.
  IF v_intent.status IN ('pending', 'confirmed', 'action_required') THEN
    UPDATE public.video_intents
    SET status = 'cancelled',
        revoked_at = v_now,
        updated_at = v_now
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  END IF;

  IF v_job.status = 'cancelled' THEN
    PERFORM public._video_job_transition_log(
      'video-job-cancel', 'info', p_job_id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true, 'fence_epoch', v_job.fence_epoch)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
  END IF;

  UPDATE public.video_jobs
  SET status = 'cancelled',
      fence_epoch = fence_epoch + 1,
      lease_owner = NULL,
      lease_expires_at = NULL,
      -- Se l'originale esiste ancora, il cleanup diventa subito eseguibile.
      -- Se è già stato eliminato, la scadenza deve restare <= deleted_at per
      -- rispettare il vincolo storico della tabella.
      original_delete_after = LEAST(
        COALESCE(original_delete_after, v_now),
        v_now,
        COALESCE(original_deleted_at, v_now)
      ),
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-job-cancel', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'intent_status', v_intent.status
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_job_cancel(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_cancel(uuid, uuid)
  TO service_role;
