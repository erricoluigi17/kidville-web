-- =============================================================================
-- MERCHANDISE · Fase B (branch feat/contabilita-merchandise, step B1)
--   Le tabelle legacy `divise_*` NON vengono rinominate (evita rotture su
--   intestatari.ts, baseline e dati di prod). Si aggiungono:
--   • merch_fornitori: anagrafica fornitori per scuola.
--   • merch_ordini_fornitore: ordini d'acquisto (PO) numerati per scuola/anno,
--     uno per fornitore, con snapshot del nome fornitore.
--   • merch_po_numerazione + prossimo_numero_po(): numerazione atomica dei PO
--     (stesso pattern di fatture/ricevute).
--   • merch_rettifiche: movimenti di magazzino (carichi/resi/scarichi/inventario)
--     → base della giacenza automatica.
--   • divise_articoli += categoria, fornitore_id, prezzo_acquisto.
--   • divise_ordini_righe += stato logistico PER RIGA
--     (da_ordinare/ordinato/arrivato/consegnato/annullato), origine
--     (fornitore/magazzino), ordine_fornitore_id, timestamp di ciclo + nota.
--   Backfill degli stati riga dallo stato legacy della testata (invariata).
-- RLS deny-by-default + policy service_role. Idempotente.
-- =============================================================================

-- --- Anagrafica fornitori -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.merch_fornitori (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id  uuid NOT NULL,
  nome       text NOT NULL,
  referente  text,
  email      text,
  telefono   text,
  piva       text,
  indirizzo  text,
  note       text,
  attivo     boolean NOT NULL DEFAULT true,
  creato_da  uuid,
  creato_il  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_merch_fornitori_scuola
  ON public.merch_fornitori (scuola_id, attivo);

-- --- Numerazione ordini d'acquisto (PO) per scuola/anno -----------------------
CREATE TABLE IF NOT EXISTS public.merch_po_numerazione (
  scuola_id     uuid NOT NULL,
  anno          int  NOT NULL,
  ultimo_numero int  NOT NULL DEFAULT 0,
  PRIMARY KEY (scuola_id, anno)
);

CREATE OR REPLACE FUNCTION public.prossimo_numero_po(p_scuola uuid, p_anno int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_num int;
BEGIN
  INSERT INTO public.merch_po_numerazione (scuola_id, anno, ultimo_numero)
  VALUES (p_scuola, p_anno, 1)
  ON CONFLICT (scuola_id, anno)
  DO UPDATE SET ultimo_numero = public.merch_po_numerazione.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_num;
  RETURN v_num;
END $$;

REVOKE EXECUTE ON FUNCTION public.prossimo_numero_po(uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prossimo_numero_po(uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prossimo_numero_po(uuid, int) TO service_role;

-- --- Ordini d'acquisto (PO), uno per fornitore --------------------------------
CREATE TABLE IF NOT EXISTS public.merch_ordini_fornitore (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id      uuid NOT NULL,
  fornitore_id   uuid REFERENCES public.merch_fornitori(id) ON DELETE SET NULL,
  fornitore_nome text NOT NULL,
  numero         text NOT NULL,
  anno           int  NOT NULL,
  stato          text NOT NULL DEFAULT 'aperto',
  note           text,
  creato_da      uuid,
  creato_il      timestamptz NOT NULL DEFAULT now(),
  chiuso_il      timestamptz,
  CONSTRAINT merch_ordini_fornitore_stato_check
    CHECK (stato = ANY (ARRAY['aperto'::text, 'chiuso'::text, 'annullato'::text])),
  UNIQUE (scuola_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_merch_ordini_fornitore_scuola
  ON public.merch_ordini_fornitore (scuola_id, creato_il DESC);

-- --- Movimenti di magazzino (giacenza automatica) -----------------------------
CREATE TABLE IF NOT EXISTS public.merch_rettifiche (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id      uuid NOT NULL,
  articolo_id    uuid REFERENCES public.divise_articoli(id) ON DELETE SET NULL,
  articolo_nome  text NOT NULL,
  taglia         text NOT NULL DEFAULT '',
  quantita_delta int  NOT NULL,
  motivo         text NOT NULL DEFAULT 'carico',
  nota           text,
  creato_da      uuid,
  creato_il      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_rettifiche_delta_check CHECK (quantita_delta <> 0),
  CONSTRAINT merch_rettifiche_motivo_check
    CHECK (motivo = ANY (ARRAY['carico'::text, 'reso'::text, 'scarico'::text, 'inventario'::text, 'correzione'::text]))
);
CREATE INDEX IF NOT EXISTS idx_merch_rettifiche_articolo
  ON public.merch_rettifiche (scuola_id, articolo_id, taglia);

-- --- Estensioni catalogo articoli ---------------------------------------------
ALTER TABLE public.divise_articoli
  ADD COLUMN IF NOT EXISTS categoria text NOT NULL DEFAULT 'divisa';
ALTER TABLE public.divise_articoli
  ADD COLUMN IF NOT EXISTS fornitore_id uuid REFERENCES public.merch_fornitori(id) ON DELETE SET NULL;
ALTER TABLE public.divise_articoli
  ADD COLUMN IF NOT EXISTS prezzo_acquisto numeric(10,2);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'divise_articoli_categoria_check'
  ) THEN
    ALTER TABLE public.divise_articoli
      ADD CONSTRAINT divise_articoli_categoria_check
      CHECK (categoria = ANY (ARRAY['divisa'::text, 'materiale'::text, 'libri'::text, 'gadget'::text, 'altro'::text]));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_divise_articoli_fornitore
  ON public.divise_articoli (fornitore_id);

-- --- Stato logistico PER RIGA + tracciabilità ciclo ---------------------------
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS stato text;                          -- backfill sotto, poi NOT NULL
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS origine text NOT NULL DEFAULT 'fornitore';
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS ordine_fornitore_id uuid
    REFERENCES public.merch_ordini_fornitore(id) ON DELETE SET NULL;
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS ordinato_il   timestamptz;
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS arrivato_il   timestamptz;
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS consegnato_il timestamptz;
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS consegnato_da uuid;
ALTER TABLE public.divise_ordini_righe
  ADD COLUMN IF NOT EXISTS nota text;

-- Backfill stato riga dallo stato legacy della testata (solo righe non ancora
-- valorizzate → idempotente: al secondo run la colonna è già NOT NULL e piena).
UPDATE public.divise_ordini_righe r
SET stato = CASE o.stato
      WHEN 'confermato' THEN 'ordinato'
      WHEN 'consegnato' THEN 'consegnato'
      WHEN 'annullato'  THEN 'annullato'
      ELSE 'da_ordinare'
    END
FROM public.divise_ordini o
WHERE r.ordine_id = o.id AND r.stato IS NULL;
-- Righe orfane (testata assente) → da_ordinare
UPDATE public.divise_ordini_righe SET stato = 'da_ordinare' WHERE stato IS NULL;
-- Timestamp di consegna approssimato per le righe consegnate nel backfill
UPDATE public.divise_ordini_righe r
SET consegnato_il = o.creato_il
FROM public.divise_ordini o
WHERE r.ordine_id = o.id AND r.stato = 'consegnato' AND r.consegnato_il IS NULL;

ALTER TABLE public.divise_ordini_righe ALTER COLUMN stato SET DEFAULT 'da_ordinare';
ALTER TABLE public.divise_ordini_righe ALTER COLUMN stato SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'divise_ordini_righe_stato_check'
  ) THEN
    ALTER TABLE public.divise_ordini_righe
      ADD CONSTRAINT divise_ordini_righe_stato_check
      CHECK (stato = ANY (ARRAY['da_ordinare'::text, 'ordinato'::text, 'arrivato'::text, 'consegnato'::text, 'annullato'::text]));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'divise_ordini_righe_origine_check'
  ) THEN
    ALTER TABLE public.divise_ordini_righe
      ADD CONSTRAINT divise_ordini_righe_origine_check
      CHECK (origine = ANY (ARRAY['fornitore'::text, 'magazzino'::text]));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_divise_righe_stato
  ON public.divise_ordini_righe (stato);
CREATE INDEX IF NOT EXISTS idx_divise_righe_ordine_fornitore
  ON public.divise_ordini_righe (ordine_fornitore_id);

-- --- RLS deny-by-default + policy service_role (pattern baseline) --------------
ALTER TABLE public.merch_fornitori ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service merch_fornitori" ON public.merch_fornitori;
CREATE POLICY "service merch_fornitori" ON public.merch_fornitori
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.merch_fornitori TO service_role;

ALTER TABLE public.merch_po_numerazione ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service merch_po_numerazione" ON public.merch_po_numerazione;
CREATE POLICY "service merch_po_numerazione" ON public.merch_po_numerazione
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.merch_po_numerazione TO service_role;

ALTER TABLE public.merch_ordini_fornitore ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service merch_ordini_fornitore" ON public.merch_ordini_fornitore;
CREATE POLICY "service merch_ordini_fornitore" ON public.merch_ordini_fornitore
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.merch_ordini_fornitore TO service_role;

ALTER TABLE public.merch_rettifiche ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service merch_rettifiche" ON public.merch_rettifiche;
CREATE POLICY "service merch_rettifiche" ON public.merch_rettifiche
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.merch_rettifiche TO service_role;
