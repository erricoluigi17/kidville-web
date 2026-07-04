-- =============================================================================
-- PRIMARIA — F1.5 Valutazione in itinere (conforme O.M. 3/2025)
-- =============================================================================
-- Estende valutazioni (no voti numerici alla primaria): valutazione per obiettivi
-- con 4 dimensioni + giudizio descrittivo auto-generato (template) OPPURE giudizio
-- sintetico. Aggiunge: valutazione_obiettivi, giudizi_sintetici_scala (6 ufficiali),
-- giudizio_template (frammenti componibili). Idempotente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. valutazioni: campi per il modello in itinere
-- -----------------------------------------------------------------------------
ALTER TABLE public.valutazioni
  ADD COLUMN IF NOT EXISTS section_id        UUID REFERENCES public.sections(id),
  ADD COLUMN IF NOT EXISTS materia_id        UUID REFERENCES public.materie(id),
  ADD COLUMN IF NOT EXISTS modalita          TEXT CHECK (modalita IN ('dimensioni', 'sintetico')),
  ADD COLUMN IF NOT EXISTS dim_autonomia     BOOLEAN,
  ADD COLUMN IF NOT EXISTS dim_continuita    BOOLEAN,
  ADD COLUMN IF NOT EXISTS dim_tipologia     TEXT CHECK (dim_tipologia IN ('nota', 'non_nota')),
  ADD COLUMN IF NOT EXISTS dim_risorse       TEXT CHECK (dim_risorse IN ('interne', 'esterne', 'entrambe')),
  ADD COLUMN IF NOT EXISTS giudizio_sintetico TEXT,
  ADD COLUMN IF NOT EXISTS locked_il         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lock_tipo         TEXT;

CREATE INDEX IF NOT EXISTS idx_valutazioni_section ON public.valutazioni (section_id);
CREATE INDEX IF NOT EXISTS idx_valutazioni_materia_id ON public.valutazioni (materia_id);

-- -----------------------------------------------------------------------------
-- 2. valutazione_obiettivi (≥1 obbligatorio — enforce in API)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.valutazione_obiettivi (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  valutazione_id UUID NOT NULL REFERENCES public.valutazioni(id) ON DELETE CASCADE,
  obiettivo_id   UUID NOT NULL REFERENCES public.obiettivi_apprendimento(id) ON DELETE CASCADE,
  UNIQUE (valutazione_id, obiettivo_id)
);
CREATE INDEX IF NOT EXISTS idx_val_obiettivi_val ON public.valutazione_obiettivi (valutazione_id);

-- -----------------------------------------------------------------------------
-- 3. giudizi_sintetici_scala (configurabile per scuola, pre-seed 6 ufficiali)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.giudizi_sintetici_scala (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  etichetta TEXT NOT NULL,
  ordine    INTEGER NOT NULL DEFAULT 0,
  attivo    BOOLEAN NOT NULL DEFAULT true,
  creato_il TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, etichetta)
);

-- Seed dei 6 giudizi ufficiali (Allegato A O.M. 3/2025) per ogni scuola esistente.
INSERT INTO public.giudizi_sintetici_scala (scuola_id, etichetta, ordine)
SELECT s.id, v.etichetta, v.ordine
FROM public.schools s
CROSS JOIN (VALUES
  ('Ottimo', 1), ('Distinto', 2), ('Buono', 3),
  ('Discreto', 4), ('Sufficiente', 5), ('Non sufficiente', 6)
) AS v(etichetta, ordine)
ON CONFLICT (scuola_id, etichetta) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. giudizio_template (frammenti componibili per giudizio descrittivo auto)
-- -----------------------------------------------------------------------------
-- Frammenti per dimensione/valore. scuola_id NULL = default globale; una riga
-- per scuola può sovrascrivere il default. Il rendering compone i 4 frammenti.
CREATE TABLE IF NOT EXISTS public.giudizio_template (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id  UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  dimensione TEXT NOT NULL CHECK (dimensione IN ('autonomia', 'continuita', 'tipologia', 'risorse')),
  valore     TEXT NOT NULL,
  frammento  TEXT NOT NULL,
  attivo     BOOLEAN NOT NULL DEFAULT true,
  creato_il  TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_giudizio_template_global
  ON public.giudizio_template (dimensione, valore) WHERE scuola_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_giudizio_template_scuola
  ON public.giudizio_template (scuola_id, dimensione, valore) WHERE scuola_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_giudizio_template_updated_at ON public.giudizio_template;
CREATE TRIGGER trg_giudizio_template_updated_at
  BEFORE UPDATE ON public.giudizio_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed dei frammenti di default (globali, scuola_id NULL).
INSERT INTO public.giudizio_template (scuola_id, dimensione, valore, frammento)
SELECT NULL, v.dimensione, v.valore, v.frammento
FROM (VALUES
  ('autonomia',  'true',     'porta a termine le attività in autonomia'),
  ('autonomia',  'false',    'necessita di guida nello svolgimento delle attività'),
  ('continuita', 'true',     'in modo continuo e costante'),
  ('continuita', 'false',    'in modo non ancora continuo'),
  ('tipologia',  'nota',     'in situazioni note'),
  ('tipologia',  'non_nota', 'anche in situazioni nuove'),
  ('risorse',    'interne',  'utilizzando risorse proprie'),
  ('risorse',    'esterne',  'facendo ricorso a risorse fornite'),
  ('risorse',    'entrambe', 'utilizzando risorse proprie e fornite')
) AS v(dimensione, valore, frammento)
WHERE NOT EXISTS (
  SELECT 1 FROM public.giudizio_template t
  WHERE t.scuola_id IS NULL AND t.dimensione = v.dimensione AND t.valore = v.valore
);

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['valutazione_obiettivi','giudizi_sintetici_scala','giudizio_template'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS "service %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "service %1$s" ON public.%1$s FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
    EXECUTE format('DROP POLICY IF EXISTS "read %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (true);', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
