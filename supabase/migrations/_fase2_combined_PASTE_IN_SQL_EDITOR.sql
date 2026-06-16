-- =============================================================================
-- KIDVILLE — Scuola Primaria FASE 2 — migrazioni combinate (idempotenti)
-- Incolla TUTTO questo file in: Supabase Dashboard -> SQL Editor -> Run.
-- Sicuro da rieseguire. Generato concatenando le 4 migrazioni di Fase 2.
-- =============================================================================


-- >>>>>>>>>>>>>>>>>>>>>>>>>> 20260628_primaria_scrutinio.sql >>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- PRIMARIA — Fase 2: Scrutinio + Pagella (conforme O.M. 3/2025 §9)
-- =============================================================================
-- Sessione collegiale di scrutinio per classe×periodo. Per ogni alunno si
-- consolida un giudizio sintetico per disciplina (Ed.Civica inclusa, è una
-- materia) + un giudizio del comportamento (separato) + un giudizio globale.
-- Periodi configurabili dall'admin. Workflow: proposta docente → chiusura
-- dirigente (lock) → generazione pagella PDF statica.
-- Riusa giudizi_sintetici_scala (6 giudizi ufficiali, vedi 20260618).
-- Idempotente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. scrutinio_periodi (N periodi configurabili per scuola/anno)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scrutinio_periodi (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id       UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  anno_scolastico TEXT NOT NULL,
  nome            TEXT NOT NULL,
  ordine          INTEGER NOT NULL DEFAULT 0,
  data_inizio     DATE,
  data_fine       DATE,
  attivo          BOOLEAN NOT NULL DEFAULT true,
  creato_il       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, anno_scolastico, nome)
);
CREATE INDEX IF NOT EXISTS idx_scrut_periodi_scuola ON public.scrutinio_periodi (scuola_id, anno_scolastico);

-- -----------------------------------------------------------------------------
-- 2. scrutini (una sessione per classe×periodo)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scrutini (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  periodo_id  UUID NOT NULL REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE,
  stato       TEXT NOT NULL DEFAULT 'aperto' CHECK (stato IN ('aperto', 'chiuso')),
  chiuso_da   UUID REFERENCES public.utenti(id),
  chiuso_il   TIMESTAMPTZ,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (section_id, periodo_id)
);
CREATE INDEX IF NOT EXISTS idx_scrutini_section ON public.scrutini (section_id);

-- -----------------------------------------------------------------------------
-- 3. scrutinio_giudizi (un giudizio sintetico per alunno×disciplina)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scrutinio_giudizi (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrutinio_id       UUID NOT NULL REFERENCES public.scrutini(id) ON DELETE CASCADE,
  alunno_id          UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  materia_id         UUID NOT NULL REFERENCES public.materie(id) ON DELETE CASCADE,
  giudizio_sintetico TEXT,
  proposto_da        UUID REFERENCES public.utenti(id),
  proposto_il        TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scrutinio_id, alunno_id, materia_id)
);
CREATE INDEX IF NOT EXISTS idx_scrut_giudizi_scrut ON public.scrutinio_giudizi (scrutinio_id);
CREATE INDEX IF NOT EXISTS idx_scrut_giudizi_alunno ON public.scrutinio_giudizi (alunno_id);

DROP TRIGGER IF EXISTS trg_scrut_giudizi_updated_at ON public.scrutinio_giudizi;
CREATE TRIGGER trg_scrut_giudizi_updated_at
  BEFORE UPDATE ON public.scrutinio_giudizi
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. scrutinio_comportamento (giudizio descrittivo del comportamento, separato)
--    + giudizio globale dell'alunno per il periodo.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scrutinio_comportamento (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrutinio_id    UUID NOT NULL REFERENCES public.scrutini(id) ON DELETE CASCADE,
  alunno_id       UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  giudizio_testo  TEXT,
  scala_valore    TEXT,
  giudizio_globale TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scrutinio_id, alunno_id)
);
CREATE INDEX IF NOT EXISTS idx_scrut_comp_scrut ON public.scrutinio_comportamento (scrutinio_id);

DROP TRIGGER IF EXISTS trg_scrut_comp_updated_at ON public.scrutinio_comportamento;
CREATE TRIGGER trg_scrut_comp_updated_at
  BEFORE UPDATE ON public.scrutinio_comportamento
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. pagelle (PDF statico archiviato + traccia firma applicativa dirigente)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pagelle (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrutinio_id     UUID NOT NULL REFERENCES public.scrutini(id) ON DELETE CASCADE,
  alunno_id        UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  file_url         TEXT,
  generata_il      TIMESTAMPTZ DEFAULT NOW(),
  generata_da      UUID REFERENCES public.utenti(id),
  firma_applicativa JSONB,
  UNIQUE (scrutinio_id, alunno_id)
);
CREATE INDEX IF NOT EXISTS idx_pagelle_alunno ON public.pagelle (alunno_id);

-- -----------------------------------------------------------------------------
-- 6. RLS (service_role full, authenticated read) — pattern di progetto
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'scrutinio_periodi','scrutini','scrutinio_giudizi','scrutinio_comportamento','pagelle'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS "service %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "service %1$s" ON public.%1$s FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
    EXECUTE format('DROP POLICY IF EXISTS "read %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (true);', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';


-- >>>>>>>>>>>>>>>>>>>>>>>>>> 20260629_primaria_scrutinio_audit.sql >>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- PRIMARIA — Fase 2: estende sblocchi_audit per gli sblocchi di scrutinio.
-- =============================================================================
-- Un dirigente può riaprire uno scrutinio chiuso (override tracciato). Riusa la
-- tabella di audit esistente aggiungendo 'scrutinio' tra le entità ammesse.
-- Idempotente.
-- =============================================================================

ALTER TABLE public.sblocchi_audit DROP CONSTRAINT IF EXISTS sblocchi_audit_entita_tipo_check;
ALTER TABLE public.sblocchi_audit
  ADD CONSTRAINT sblocchi_audit_entita_tipo_check
  CHECK (entita_tipo IN ('registro', 'valutazione', 'nota', 'scrutinio'));

NOTIFY pgrst, 'reload schema';


-- >>>>>>>>>>>>>>>>>>>>>>>>>> 20260630_fascicolo_rbac_audit.sql >>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>> 20260631_presenze_giust_firma.sql >>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- PRIMARIA — Fase 2: firma applicativa (FES) sulla giustifica genitore.
-- =============================================================================
-- La giustifica online dell'assenza/ritardo/uscita è ora protetta da conferma
-- OTP email (riuso del flusso FES dei moduli). Tracciamo la firma nel record
-- presenza. Idempotente.
-- =============================================================================

ALTER TABLE public.presenze
  ADD COLUMN IF NOT EXISTS giustificazione_firma JSONB;

NOTIFY pgrst, 'reload schema';

