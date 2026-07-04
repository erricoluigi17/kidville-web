-- =============================================================================
-- PRIMARIA — Fase 2: Fascicolo personale (RBAC ristretto + audit accessi)
-- =============================================================================
-- Modello di protezione (decisione di prodotto, da PRD §3 Fascicolo):
-- RBAC ristretto + audit accessi. Cifratura demandata a Supabase Storage; NO
-- crittografia applicativa AES. L'accesso ai file sensibili passa SEMPRE dalle
-- API (service_role + check applicativo `puoAccedereFascicolo`); il bucket
-- resta privato e nessun URL pubblico viene esposto (solo signed URL a tempo).
-- Estende student_documents (BES/DSA già esistente). Idempotente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. document_type_enum: aggiunge 'pdp' (oltre a diagnosi/pei/104)
-- -----------------------------------------------------------------------------
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'pdp';

-- -----------------------------------------------------------------------------
-- 2. student_documents: campi per RBAC contitolari + metadati
-- -----------------------------------------------------------------------------
ALTER TABLE public.student_documents
  ADD COLUMN IF NOT EXISTS section_id   UUID REFERENCES public.sections(id),
  ADD COLUMN IF NOT EXISTS caricato_da  UUID REFERENCES public.utenti(id),
  ADD COLUMN IF NOT EXISTS descrizione  TEXT,
  ADD COLUMN IF NOT EXISTS file_name    TEXT,
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

CREATE INDEX IF NOT EXISTS idx_student_documents_student ON public.student_documents (student_id);
CREATE INDEX IF NOT EXISTS idx_student_documents_section ON public.student_documents (section_id);

-- Backfill section_id dalla sezione corrente dell'alunno (best-effort).
UPDATE public.student_documents d
SET section_id = a.section_id
FROM public.alunni a
WHERE d.student_id = a.id AND d.section_id IS NULL AND a.section_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. fascicolo_accessi_audit (log IMMODIFICABILE: solo INSERT + SELECT)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fascicolo_accessi_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id    UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  documento_id UUID,
  utente_id    UUID REFERENCES public.utenti(id),
  azione       TEXT NOT NULL CHECK (azione IN ('list', 'view', 'download', 'upload', 'delete')),
  finalita     TEXT,
  ip           TEXT,
  user_agent   TEXT,
  creato_il    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fasc_audit_alunno ON public.fascicolo_accessi_audit (alunno_id, creato_il DESC);
CREATE INDEX IF NOT EXISTS idx_fasc_audit_utente ON public.fascicolo_accessi_audit (utente_id);

-- RLS: student_documents (service full, authenticated read — l'enforcement RBAC è applicativo).
ALTER TABLE public.student_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service student_documents" ON public.student_documents;
CREATE POLICY "service student_documents" ON public.student_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read student_documents" ON public.student_documents;
CREATE POLICY "read student_documents" ON public.student_documents FOR SELECT TO authenticated USING (true);

-- RLS: audit immodificabile — service_role può inserire/leggere; authenticated solo lettura.
-- Nessuna policy di UPDATE/DELETE: il log non è alterabile via API.
ALTER TABLE public.fascicolo_accessi_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service insert fascicolo_audit" ON public.fascicolo_accessi_audit;
CREATE POLICY "service insert fascicolo_audit" ON public.fascicolo_accessi_audit FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS "service read fascicolo_audit" ON public.fascicolo_accessi_audit;
CREATE POLICY "service read fascicolo_audit" ON public.fascicolo_accessi_audit FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS "read fascicolo_audit" ON public.fascicolo_accessi_audit;
CREATE POLICY "read fascicolo_audit" ON public.fascicolo_accessi_audit FOR SELECT TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- 4. Bucket sensitive_documents: assicura che resti PRIVATO (no URL pubblici)
-- -----------------------------------------------------------------------------
UPDATE storage.buckets SET public = false WHERE id = 'sensitive_documents';

NOTIFY pgrst, 'reload schema';
