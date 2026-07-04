-- 20260763 — Certificato delle Competenze (D.M. 14/2024) · RECONCILE schema live
--
-- Contesto: le tabelle `certificati_competenze` e `certificato_competenza_livelli`
-- ESISTONO SOLO sul DB live (create in P5 dalla migrazione `20260760_p5_certificati_competenze`,
-- versione 20260627140051) ma il relativo FILE non è mai finito nel repo: lo slot
-- 20260760 è stato riusato dal batch app-completion (form_submissions_gestione).
-- Questa migrazione riporta lo schema in version-control così che un `db reset`
-- da zero riproduca le tabelle. È IDEMPOTENTE (CREATE TABLE IF NOT EXISTS +
-- CREATE INDEX IF NOT EXISTS): sul DB live, dove le tabelle già esistono, è un no-op.
--
-- Schema riprodotto 1:1 dall'introspezione live (information_schema + pg_constraint):
--  · certificati_competenze: bozza→generato→firmato, unico per (alunno, anno);
--  · certificato_competenza_livelli: livello A/B/C/D per competenza, unico per certificato.
-- RLS abilitata senza policy (deny-by-default; enforcement app-level via service_role).

-- ─── certificati_competenze ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.certificati_competenze (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id          UUID NOT NULL,                                                  -- soft-ref schools (registry P3.4b)
  alunno_id          UUID NOT NULL REFERENCES public.alunni(id)   ON DELETE CASCADE,
  section_id         UUID REFERENCES public.sections(id)          ON DELETE SET NULL,
  scrutinio_id       UUID REFERENCES public.scrutini(id)          ON DELETE SET NULL,
  anno_scolastico    TEXT NOT NULL,
  stato              TEXT NOT NULL DEFAULT 'bozza' CHECK (stato IN ('bozza','generato','firmato')),
  file_url           TEXT,
  firma_applicativa  JSONB,
  generato_da        UUID,                                                           -- soft-ref utenti
  generato_il        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alunno_id, anno_scolastico)
);
CREATE INDEX IF NOT EXISTS idx_certificati_competenze_alunno  ON public.certificati_competenze (alunno_id);
CREATE INDEX IF NOT EXISTS idx_certificati_competenze_section ON public.certificati_competenze (section_id);

-- ─── certificato_competenza_livelli ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.certificato_competenza_livelli (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certificato_id     UUID NOT NULL REFERENCES public.certificati_competenze(id) ON DELETE CASCADE,
  competenza_codice  TEXT NOT NULL,
  livello            TEXT CHECK (livello IN ('A','B','C','D')),
  note               TEXT,
  ordine             INTEGER NOT NULL DEFAULT 0,
  UNIQUE (certificato_id, competenza_codice)
);
CREATE INDEX IF NOT EXISTS idx_cert_competenza_livelli_cert ON public.certificato_competenza_livelli (certificato_id);

-- ─── RLS (deny-by-default, service_role attivo lato app) ─────────────────────
ALTER TABLE public.certificati_competenze          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificato_competenza_livelli  ENABLE ROW LEVEL SECURITY;
