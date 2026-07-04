-- =============================================================================
-- PRIMARIA — Fase 3+: giudizio descrittivo di scrutinio per voto
-- =============================================================================
-- Per ogni livello di classe (1..5), materia (codice) e periodo di scrutinio,
-- definisce il testo del giudizio associato a ciascun voto della scala sintetica
-- (etichetta). In pagella il testo si associa AUTOMATICAMENTE al voto assegnato.
-- Distinto dal giudizio_descrittivo "generico" della scala (usato in itinere).
-- Compilare un livello (es. 1) vale per tutte le sezioni di quel livello.
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.scrutinio_giudizio_descrittivo (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id            UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  livello              INTEGER NOT NULL CHECK (livello BETWEEN 1 AND 5),
  materia_codice       TEXT NOT NULL,
  periodo_id           UUID NOT NULL REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE,
  etichetta_voto       TEXT NOT NULL,
  giudizio_descrittivo TEXT NOT NULL,
  creato_il            TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, livello, materia_codice, periodo_id, etichetta_voto)
);
CREATE INDEX IF NOT EXISTS idx_scrut_giud_descr_lookup
  ON public.scrutinio_giudizio_descrittivo (scuola_id, livello, materia_codice, periodo_id);

DROP TRIGGER IF EXISTS trg_scrut_giud_descr_updated_at ON public.scrutinio_giudizio_descrittivo;
CREATE TRIGGER trg_scrut_giud_descr_updated_at
  BEFORE UPDATE ON public.scrutinio_giudizio_descrittivo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.scrutinio_giudizio_descrittivo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo;
CREATE POLICY "service scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo;
CREATE POLICY "read scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo
  FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
