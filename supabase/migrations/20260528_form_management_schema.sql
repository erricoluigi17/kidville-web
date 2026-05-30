-- ============================================================
-- KIDVILLE — Form Management: Modelli Dinamici + Firma OTP
-- Migration: 20260528_form_management_schema.sql
-- ============================================================
-- Separata dalla fase4 (forms_templates/forms_submissions) per
-- supportare schemi drag&drop multi-step, logiche condizionali,
-- scoring/pesi e firma OTP.
-- ============================================================

-- 0. Enum status
DO $$ BEGIN
  CREATE TYPE form_submission_status AS ENUM (
    'draft',
    'pending_signature',
    'completed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 1. form_models
--    schema JSONB → FormSchemaConfig (pages/steps, scoring, ecc.)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_models (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT        NOT NULL,
  description       TEXT,
  schema            JSONB       NOT NULL DEFAULT '{}',
  is_active         BOOLEAN     NOT NULL DEFAULT false,
  requires_signature BOOLEAN    NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger per updated_at automatico
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_form_models_updated_at ON form_models;
CREATE TRIGGER trg_form_models_updated_at
  BEFORE UPDATE ON form_models
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Indice GIN su schema per query ETL e logica condizionale
CREATE INDEX IF NOT EXISTS idx_form_models_schema_gin
  ON form_models USING GIN (schema);

-- Indice parziale per listing rapido dei form attivi
CREATE INDEX IF NOT EXISTS idx_form_models_active
  ON form_models (is_active)
  WHERE is_active = true;

-- ─────────────────────────────────────────────────────────────
-- 2. form_submissions
--    data JSONB → FormSubmissionData (risposte utente)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_submissions (
  id          UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    UUID                     NOT NULL
                REFERENCES form_models(id) ON DELETE CASCADE,
  user_id     UUID                     -- NULL per guest/genitori non ancora registrati
                REFERENCES auth.users(id) ON DELETE SET NULL,
  data        JSONB                    NOT NULL DEFAULT '{}',
  status      form_submission_status   NOT NULL DEFAULT 'draft',
  otp_secret  TEXT,                    -- SHA-256 hash del segreto OTP, mai plaintext
  signed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ              NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ              NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_form_submissions_updated_at ON form_submissions;
CREATE TRIGGER trg_form_submissions_updated_at
  BEFORE UPDATE ON form_submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Indice GIN su data per ETL, graduatorie e full-text JSONB search
CREATE INDEX IF NOT EXISTS idx_form_submissions_data_gin
  ON form_submissions USING GIN (data);

-- Indici B-tree per join e filtri comuni
CREATE INDEX IF NOT EXISTS idx_form_submissions_model_id
  ON form_submissions (model_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_user_id
  ON form_submissions (user_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_status
  ON form_submissions (status);

-- ─────────────────────────────────────────────────────────────
-- 3. Row Level Security
-- ─────────────────────────────────────────────────────────────
ALTER TABLE form_models      ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;

-- Helper: l'utente corrente è admin o staff?
-- (utenti.id == auth.uid() per convenzione di questo progetto)
CREATE OR REPLACE FUNCTION is_staff_or_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.utenti
    WHERE id = auth.uid()
      AND ruolo IN ('admin', 'maestra', 'teacher', 'staff', 'cuoca', 'coordinatore', 'educator')
  );
$$;

-- ── form_models ──────────────────────────────────────────────
-- SELECT: utenti autenticati vedono solo i modelli attivi
CREATE POLICY "fm_select_active_authenticated"
  ON form_models FOR SELECT
  TO authenticated
  USING (is_active = true);

-- SELECT: admin/staff vedono tutti (inclusi inattivi)
CREATE POLICY "fm_select_all_staff"
  ON form_models FOR SELECT
  TO authenticated
  USING (is_staff_or_admin());

-- INSERT / UPDATE / DELETE: solo admin/staff
CREATE POLICY "fm_insert_staff"
  ON form_models FOR INSERT
  TO authenticated
  WITH CHECK (is_staff_or_admin());

CREATE POLICY "fm_update_staff"
  ON form_models FOR UPDATE
  TO authenticated
  USING (is_staff_or_admin())
  WITH CHECK (is_staff_or_admin());

CREATE POLICY "fm_delete_staff"
  ON form_models FOR DELETE
  TO authenticated
  USING (is_staff_or_admin());

-- ── form_submissions ──────────────────────────────────────────
-- INSERT: qualsiasi utente autenticato (genitore) può compilare
-- user_id deve corrispondere all'uid per evitare impersonificazione
CREATE POLICY "fs_insert_authenticated"
  ON form_submissions FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

-- SELECT: proprietario oppure admin/staff
CREATE POLICY "fs_select_owner_or_staff"
  ON form_submissions FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR is_staff_or_admin()
  );

-- UPDATE: proprietario (aggiorna draft, firma OTP) oppure admin/staff
CREATE POLICY "fs_update_owner_or_staff"
  ON form_submissions FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR is_staff_or_admin()
  )
  WITH CHECK (
    user_id = auth.uid()
    OR is_staff_or_admin()
  );

-- DELETE: solo admin (ad es. per GDPR erasure)
CREATE POLICY "fs_delete_staff"
  ON form_submissions FOR DELETE
  TO authenticated
  USING (is_staff_or_admin());
