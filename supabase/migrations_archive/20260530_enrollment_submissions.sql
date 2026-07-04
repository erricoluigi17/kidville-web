-- Iscrizione nuovi alunni — tabella raccolta + colonne documento
-- Idempotente (IF NOT EXISTS). Applicabile via /api/admin/apply-enrollment-migration

-- 1. Tabella raccolta invii del form pubblico di iscrizione
CREATE TABLE IF NOT EXISTS public.enrollment_submissions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id        UUID,
  data             JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { children:[...], adults:[...] }
  status           TEXT        NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  assigned_classes JSONB       DEFAULT '{}'::jsonb,           -- { childIndex: "Sezione" }
  imported_at      TIMESTAMPTZ,
  credentials      JSONB,                                     -- { email, password } del referente
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.enrollment_submissions ENABLE ROW LEVEL SECURITY;
-- Nessuna policy anon: accesso solo via service-role (route server). Locked by default.

-- 2. Colonna documento d'identità sull'alunno
ALTER TABLE public.alunni  ADD COLUMN IF NOT EXISTS documento_path TEXT;

-- 3. Colonne documento sull'adulto (parents)
ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS documento_path  TEXT;
ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_type   VARCHAR(50);
ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);

NOTIFY pgrst, 'reload schema';
