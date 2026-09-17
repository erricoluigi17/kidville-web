-- Coordinamento durevole della pipeline video HEVC / Full HD.
--
-- Questa migrazione è soltanto additiva: crea intent, job e outbox, dichiara i
-- due bucket di lavorazione privati e porta a 2.000.000.000 byte i bucket finali.
-- Non pubblica file, non converte lo storico e non implementa le transizioni:
-- claim, lease, ready, cancel e finalize arriveranno nelle RPC dedicate.
--
-- PRECONDIZIONE OPERATIVA: il limite Storage globale del progetto va portato ad
-- almeno 2.000.000.000 byte PRIMA di applicare questa migrazione in produzione.
-- Supabase applica il minimo tra limite globale e limite del bucket; alzare solo
-- storage.buckets non aggira il tetto globale e farebbe fallire l'upload prima
-- del probe reale. La configurazione del progetto non è modificabile da SQL.

CREATE TABLE IF NOT EXISTS public.video_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.utenti(id) ON DELETE RESTRICT,
  scuola_id uuid REFERENCES public.schools(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  target_id uuid,
  revision integer NOT NULL DEFAULT 1,
  expected_target_version timestamptz,
  requested_action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT video_intents_channel_chk
    CHECK (channel IN ('gallery', 'news')),
  CONSTRAINT video_intents_revision_chk
    CHECK (revision >= 1),
  CONSTRAINT video_intents_id_revision_key
    UNIQUE (id, revision),
  CONSTRAINT video_intents_requested_action_chk
    CHECK (requested_action IN (
      'attach_private', 'submit_proposal', 'publish', 'schedule'
    )),
  CONSTRAINT video_intents_payload_chk
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT video_intents_status_chk
    CHECK (status IN (
      'pending', 'confirmed', 'published', 'action_required',
      'cancelled', 'superseded'
    )),
  -- NULL non significa "sede sconosciuta": è ammesso soltanto per una News il
  -- cui bordo API abbia dichiarato esplicitamente lo scope globale nel payload.
  CONSTRAINT video_intents_scuola_scope_chk
    CHECK (
      scuola_id IS NOT NULL
      OR (channel = 'news' AND COALESCE(payload ->> 'scope' = 'global', false))
    ),
  CONSTRAINT video_intents_tempi_chk
    CHECK (updated_at >= created_at),
  CONSTRAINT video_intents_stato_tempi_chk
    CHECK (
      (status = 'pending'
        AND confirmed_at IS NULL AND revoked_at IS NULL AND published_at IS NULL)
      OR (status IN ('confirmed', 'action_required')
        AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND published_at IS NULL)
      OR (status = 'published'
        AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND published_at IS NOT NULL)
      OR (status = 'cancelled'
        AND revoked_at IS NOT NULL AND published_at IS NULL)
      OR (status = 'superseded' AND revoked_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.video_intents IS
  'Intento esplicito e revisionato di collegare o pubblicare video. Lo scope senza scuola è consentito soltanto a News globali dichiarate; il payload è validato anche al bordo API.';
COMMENT ON COLUMN public.video_intents.expected_target_version IS
  'Versione ottimistica del target come timestamptz, compatibile con updated_at delle News.';

-- Scope e revisione identificano l'intent: una modifica crea un nuovo UUID e
-- porta il precedente a superseded. Renderli immutabili impedisce che job o
-- outbox già collegati conservino uno scope o una revisione diventati falsi.
CREATE OR REPLACE FUNCTION public.video_intents_identita_immutabile_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
  THEN
    RAISE EXCEPTION 'video_intents_job_scope_immutabile: owner, channel e scuola non sono modificabili'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'video_intents_revision_immutabile: creare un nuovo intent UUID per la nuova revisione'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.video_intents_identita_immutabile_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_video_intents_identita_immutabile ON public.video_intents;
CREATE TRIGGER trg_video_intents_identita_immutabile
  BEFORE UPDATE OF owner_id, scuola_id, channel, revision
  ON public.video_intents
  FOR EACH ROW EXECUTE FUNCTION public.video_intents_identita_immutabile_guard();

CREATE UNIQUE INDEX IF NOT EXISTS video_intents_target_revision_unico_idx
  ON public.video_intents(owner_id, channel, target_id, revision)
  WHERE target_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.video_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.utenti(id) ON DELETE RESTRICT,
  scuola_id uuid REFERENCES public.schools(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  idempotency_key text NOT NULL,
  intent_id uuid NOT NULL REFERENCES public.video_intents(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'awaiting_upload',
  original_bucket text NOT NULL DEFAULT 'video_originals',
  original_path text NOT NULL,
  source_size bigint,
  source_mime text,
  output_bucket text,
  output_path text,
  output_size bigint,
  probe_json jsonb,
  attempt integer NOT NULL DEFAULT 0,
  fence_epoch bigint NOT NULL DEFAULT 0,
  lease_owner uuid,
  lease_expires_at timestamptz,
  error_code text,
  verified_at timestamptz,
  original_delete_after timestamptz,
  original_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT video_jobs_owner_channel_idempotency_key_key
    UNIQUE (owner_id, channel, idempotency_key),
  CONSTRAINT video_jobs_originale_unico
    UNIQUE (original_bucket, original_path),
  CONSTRAINT video_jobs_output_unico
    UNIQUE (output_bucket, output_path),
  CONSTRAINT video_jobs_channel_chk
    CHECK (channel IN ('gallery', 'news')),
  CONSTRAINT video_jobs_scuola_scope_chk
    CHECK (scuola_id IS NOT NULL OR channel = 'news'),
  CONSTRAINT video_jobs_idempotency_key_chk
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT video_jobs_status_chk
    CHECK (status IN (
      'awaiting_upload', 'queued', 'processing', 'ready',
      'rejected', 'failed', 'cancelled'
    )),
  CONSTRAINT video_jobs_originale_chk
    CHECK (
      original_bucket = 'video_originals'
      AND char_length(original_path) BETWEEN 1 AND 1024
    ),
  CONSTRAINT video_jobs_source_size_chk
    CHECK (source_size IS NULL OR source_size BETWEEN 1 AND 2000000000),
  CONSTRAINT video_jobs_source_mime_chk
    CHECK (source_mime IS NULL OR char_length(source_mime) BETWEEN 1 AND 255),
  CONSTRAINT video_jobs_source_coppia_chk
    CHECK ((source_size IS NULL) = (source_mime IS NULL)),
  CONSTRAINT video_jobs_output_chk
    CHECK (
      (output_bucket IS NULL AND output_path IS NULL AND output_size IS NULL)
      OR (
        output_bucket IS NOT NULL
        AND output_bucket = 'video_processing'
        AND output_path IS NOT NULL
        AND char_length(output_path) BETWEEN 1 AND 1024
        AND (output_size IS NULL OR output_size BETWEEN 1 AND 2000000000)
      )
    ),
  CONSTRAINT video_jobs_probe_chk
    CHECK (
      probe_json IS NULL
      OR CASE
        WHEN jsonb_typeof(probe_json) = 'object'
          AND jsonb_typeof(probe_json -> 'durationSeconds') = 'number'
        THEN (probe_json ->> 'durationSeconds')::numeric > 0
          AND (probe_json ->> 'durationSeconds')::numeric <= 180
        ELSE false
      END
    ),
  CONSTRAINT video_jobs_attempt_chk
    CHECK (attempt >= 0),
  CONSTRAINT video_jobs_fence_epoch_chk
    CHECK (fence_epoch >= 0),
  CONSTRAINT video_jobs_lease_chk
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (
        lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND status = 'processing'
      )
    ),
  CONSTRAINT video_jobs_processing_lease_chk
    CHECK (status <> 'processing' OR lease_owner IS NOT NULL),
  CONSTRAINT video_jobs_error_code_chk
    CHECK (
      error_code IS NULL
      OR char_length(error_code) BETWEEN 1 AND 80
    ),
  CONSTRAINT video_jobs_stato_errore_chk
    CHECK (status NOT IN ('rejected', 'failed') OR error_code IS NOT NULL),
  CONSTRAINT video_jobs_ready_chk
    CHECK (
      status <> 'ready'
      OR (
        source_size IS NOT NULL
        AND source_mime IS NOT NULL
        AND output_bucket IS NOT NULL
        AND output_bucket = 'video_processing'
        AND output_path IS NOT NULL
        AND output_size IS NOT NULL
        AND probe_json IS NOT NULL
        AND verified_at IS NOT NULL
        AND original_delete_after IS NOT NULL
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT video_jobs_original_ttl_chk
    CHECK (
      status <> 'ready'
      OR original_delete_after = verified_at + interval '7 days'
    ),
  CONSTRAINT video_jobs_original_deleted_chk
    CHECK (
      original_deleted_at IS NULL
      OR (
        original_delete_after IS NOT NULL
        AND original_deleted_at >= original_delete_after
      )
    ),
  CONSTRAINT video_jobs_tempi_chk
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE public.video_jobs IS
  'Job server-side per upload TUS, probe reale e transcodifica. Input e output arrivano a 2.000.000.000 byte; la durata massima verificata è 180 secondi.';
COMMENT ON COLUMN public.video_jobs.fence_epoch IS
  'Token monotono usato dalle future RPC di lease per impedire a un worker scaduto di completare il job.';
COMMENT ON COLUMN public.video_jobs.original_delete_after IS
  'Per un output ready è esattamente verified_at + 7 giorni. Falliti e abbandonati ricevono una scadenza separata dal processo di retention.';

-- La FK semplice protegge la vita dell'intent; il trigger sotto protegge anche
-- owner, canale e sede, usando IS NOT DISTINCT FROM per lo scope globale NULL.
CREATE OR REPLACE FUNCTION public.video_jobs_intent_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.video_intents AS i
    WHERE i.id = NEW.intent_id
      AND i.owner_id = NEW.owner_id
      AND i.channel = NEW.channel
      AND i.scuola_id IS NOT DISTINCT FROM NEW.scuola_id
  ) THEN
    RAISE EXCEPTION 'video_jobs_intent_scope_fk: intent, owner, channel e scuola non coincidono'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.video_jobs_intent_scope_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_video_jobs_intent_scope ON public.video_jobs;
CREATE TRIGGER trg_video_jobs_intent_scope
  BEFORE INSERT OR UPDATE OF intent_id, owner_id, scuola_id, channel
  ON public.video_jobs
  FOR EACH ROW EXECUTE FUNCTION public.video_jobs_intent_scope_guard();

CREATE UNIQUE INDEX IF NOT EXISTS video_jobs_gallery_intent_unico_idx
  ON public.video_jobs(intent_id)
  WHERE channel = 'gallery';
CREATE INDEX IF NOT EXISTS video_jobs_coda_idx
  ON public.video_jobs(status, created_at)
  WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS video_jobs_retention_originali_idx
  ON public.video_jobs(original_delete_after)
  WHERE original_deleted_at IS NULL AND original_delete_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.video_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL,
  revision integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  lease_owner uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT video_outbox_intent_id_revision_event_type_key
    UNIQUE (intent_id, revision, event_type),
  CONSTRAINT video_outbox_intent_revision_fk
    FOREIGN KEY (intent_id, revision)
    REFERENCES public.video_intents(id, revision) ON DELETE RESTRICT,
  CONSTRAINT video_outbox_revision_chk
    CHECK (revision >= 1),
  CONSTRAINT video_outbox_event_type_chk
    CHECK (
      char_length(event_type) BETWEEN 1 AND 80
      AND event_type ~ '^[a-z][a-z0-9_.-]*$'
    ),
  -- L'outbox trasporta identificatori e codici, non snapshot di record o testo
  -- libero. Il limite impedisce che diventi per errore un duplicato del payload.
  CONSTRAINT video_outbox_payload_minimo_chk
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
  CONSTRAINT video_outbox_attempts_chk
    CHECK (attempts BETWEEN 0 AND 25),
  CONSTRAINT video_outbox_lease_chk
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND sent_at IS NULL)
    ),
  CONSTRAINT video_outbox_sent_chk
    CHECK (sent_at IS NULL OR (lease_owner IS NULL AND lease_expires_at IS NULL)),
  CONSTRAINT video_outbox_tempi_chk
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE public.video_outbox IS
  'Outbox service-only per gli effetti successivi al commit. Payload massimo 4 KiB e privo di snapshot o dati personali.';

CREATE INDEX IF NOT EXISTS video_outbox_da_inviare_idx
  ON public.video_outbox(created_at)
  WHERE sent_at IS NULL;

-- Nessuna policy: anon e authenticated non hanno una porta diretta. FORCE RLS
-- mantiene la chiusura anche se in futuro cambia l'owner; service_role usa il
-- proprio BYPASSRLS e riceve soltanto i privilegi CRUD necessari.
ALTER TABLE public.video_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.video_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_outbox FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.video_intents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.video_jobs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.video_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.video_intents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.video_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.video_outbox TO service_role;

-- MIME volutamente generico (NULL): formato, codec, durata e dimensioni reali
-- sono decisi da ffprobe dopo l'upload, non dal Content-Type dichiarato dal client.
-- Entrambi i bucket restano privati anche su riapplicazione della migrazione.
INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('video_originals', 'video_originals', false, 2000000000, NULL),
  ('video_processing', 'video_processing', false, 2000000000, NULL)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    updated_at = now();

-- I bucket di dominio `gallery`, `news` e `news_bozze` restano a 52.428.800 byte.
--
-- Questa migrazione, fino al 2026-09-17, li portava a 2.000.000.000. Era un numero che non
-- abilitava niente e toglieva una rete: l'unico codice che depositerà un MP4 Full HD in
-- `gallery` è il finalizer, che non esiste ancora (V08/V09). Nel frattempo quel 2 GB
-- rendeva rosso `__tests__/architecture/bucket-storage-dichiarati.test.ts`, che confronta il
-- limite della migrazione con `TETTO_GALLERIA_BYTE` (`src/lib/gallery/limiti.ts`) e con la
-- ricetta in `src/app/api/gallery/upload/route.ts`: tre fonti che devono dire lo stesso numero.
--
-- L'aumento torna insieme al finalizer, e allora le tre fonti smettono di descrivere la stessa
-- regola: il bucket è il tetto dell'OGGETTO (sale), `TETTO_GALLERIA_BYTE` è il tetto di ciò
-- che il BROWSER può spedire da sé (resta 50 MiB). Il lock va riscritto in quella forma nello
-- stesso commit, non allentato: un `<=` senza le uguaglianze accanto lo rende decorativo.
--
-- I video non passano di qui: entrano in `video_originals`, lavorano in `video_processing` —
-- entrambi privati e già a 2 GB qui sopra — e arrivano in `gallery` solo per copia service-role.

-- Successo osservabile senza trasformare un guasto del logger in un guasto della
-- migrazione. Il payload contiene solo nomi tecnici e numeri, nessun dato utente.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-schema-migration',
        'sorgente', 'server',
        'messaggio', 'Schema coordinamento video installato',
        'fingerprint', 'video-schema-migration-v1',
        'contesto', jsonb_build_object(
          'tabelle', 3,
          'bucket_privati', 2,
          'limite_byte', 2000000000
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
