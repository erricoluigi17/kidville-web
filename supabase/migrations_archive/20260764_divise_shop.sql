-- 20260764 — Divise shop (piano-app-100, batch fix step 13/14)
-- Catalogo divise/uniformi + ordini genitore. La Segreteria gestisce il catalogo
-- (articolo, taglie, prezzo); il genitore ordina dallo shop e l'ordine genera un
-- pagamento da saldare offline (nessun gateway). I prezzi/totale sono SEMPRE
-- ricalcolati server-side; le righe ordine "congelano" nome+prezzo dell'articolo
-- al momento dell'ordine (snapshot storico, resiste a modifiche/eliminazioni del catalogo).
--
-- scuola_id soft-ref schools (registry P3.4b, nessun FK). parent_id soft-ref: nel
-- modello identità app il genitore vive in `utenti` (demo) o solo in `parents` col
-- ponte, quindi niente FK. alunno_id/pagamento_id hanno FK reali.
-- RLS abilitata, service_role attivo (enforcement app-level). Idempotente
-- (CREATE TABLE/INDEX IF NOT EXISTS + DROP/CREATE POLICY): applicata già live.

-- ─── divise_articoli (catalogo) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.divise_articoli (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id    UUID NOT NULL,                                  -- soft-ref schools
  nome         TEXT NOT NULL,
  descrizione  TEXT,
  taglie       TEXT[] NOT NULL DEFAULT '{}',
  prezzo       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (prezzo >= 0),
  attivo       BOOLEAN NOT NULL DEFAULT true,
  ordine       INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_divise_articoli_scuola ON public.divise_articoli (scuola_id, attivo);

-- ─── divise_ordini ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.divise_ordini (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id     UUID NOT NULL,                                 -- soft-ref schools
  alunno_id     UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  parent_id     UUID,                                          -- soft-ref utenti/parents (app parentId)
  stato         TEXT NOT NULL DEFAULT 'inviato' CHECK (stato IN ('inviato','confermato','consegnato','annullato')),
  totale        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (totale >= 0),
  pagamento_id  UUID REFERENCES public.pagamenti(id) ON DELETE SET NULL,
  note          TEXT,
  creato_il     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_divise_ordini_scuola    ON public.divise_ordini (scuola_id, creato_il DESC);
CREATE INDEX IF NOT EXISTS idx_divise_ordini_alunno    ON public.divise_ordini (alunno_id);
CREATE INDEX IF NOT EXISTS idx_divise_ordini_parent    ON public.divise_ordini (parent_id);
CREATE INDEX IF NOT EXISTS idx_divise_ordini_pagamento ON public.divise_ordini (pagamento_id);

-- ─── divise_ordini_righe ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.divise_ordini_righe (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordine_id       UUID NOT NULL REFERENCES public.divise_ordini(id) ON DELETE CASCADE,
  articolo_id     UUID REFERENCES public.divise_articoli(id) ON DELETE SET NULL,
  articolo_nome   TEXT NOT NULL,                               -- snapshot nome al momento dell'ordine
  taglia          TEXT NOT NULL,
  quantita        INTEGER NOT NULL CHECK (quantita > 0),
  prezzo_unitario NUMERIC(10,2) NOT NULL CHECK (prezzo_unitario >= 0)
);
CREATE INDEX IF NOT EXISTS idx_divise_righe_ordine ON public.divise_ordini_righe (ordine_id);

-- ─── RLS (deny-by-default, service_role attivo) ──────────────────────────────
ALTER TABLE public.divise_articoli     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.divise_ordini       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.divise_ordini_righe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service divise_articoli" ON public.divise_articoli;
CREATE POLICY "service divise_articoli" ON public.divise_articoli FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service divise_ordini" ON public.divise_ordini;
CREATE POLICY "service divise_ordini" ON public.divise_ordini FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service divise_ordini_righe" ON public.divise_ordini_righe;
CREATE POLICY "service divise_ordini_righe" ON public.divise_ordini_righe FOR ALL TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';

-- ROLLBACK
-- DROP TABLE IF EXISTS public.divise_ordini_righe;
-- DROP TABLE IF EXISTS public.divise_ordini;
-- DROP TABLE IF EXISTS public.divise_articoli;
