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
