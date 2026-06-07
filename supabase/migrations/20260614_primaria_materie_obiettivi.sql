-- =============================================================================
-- PRIMARIA — F1.1 Cataloghi: Materie (per classe/livello con preset editabile)
-- + Obiettivi di apprendimento (per materia × livello).
-- =============================================================================
-- Idempotente. RLS pattern: service_role FOR ALL + authenticated FOR SELECT.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PRESET MATERIE (template editabile per livello 1-5). Globale (no scuola).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.materie_preset (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  livello     INTEGER NOT NULL CHECK (livello BETWEEN 1 AND 5),
  nome        TEXT NOT NULL,
  codice      TEXT NOT NULL,
  e_civica    BOOLEAN NOT NULL DEFAULT false,
  turno_mensa BOOLEAN NOT NULL DEFAULT false,
  ordine      INTEGER NOT NULL DEFAULT 0,
  attivo      BOOLEAN NOT NULL DEFAULT true,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (livello, codice)
);

-- Seed del preset standard per ogni livello 1-5 (discipline scuola primaria).
INSERT INTO public.materie_preset (livello, nome, codice, e_civica, turno_mensa, ordine)
SELECT g.livello, v.nome, v.codice, v.e_civica, v.turno_mensa, v.ordine
FROM generate_series(1, 5) AS g(livello)
CROSS JOIN (VALUES
  ('Italiano',             'italiano',   false, false, 1),
  ('Matematica',           'matematica', false, false, 2),
  ('Storia',               'storia',     false, false, 3),
  ('Geografia',            'geografia',  false, false, 4),
  ('Scienze',              'scienze',    false, false, 5),
  ('Inglese',              'inglese',    false, false, 6),
  ('Arte e Immagine',      'arte',       false, false, 7),
  ('Musica',               'musica',     false, false, 8),
  ('Educazione Fisica',    'ed_fisica',  false, false, 9),
  ('Tecnologia',           'tecnologia', false, false, 10),
  ('Religione/Alternativa','religione',  false, false, 11),
  ('Educazione Civica',    'ed_civica',  true,  false, 12),
  ('Mensa',                'mensa',      false, true,  13)
) AS v(nome, codice, e_civica, turno_mensa, ordine)
ON CONFLICT (livello, codice) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. MATERIE per sezione (catalogo effettivo, derivato dal preset ed editabile)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.materie (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  section_id  UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  codice      TEXT NOT NULL,
  e_civica    BOOLEAN NOT NULL DEFAULT false,
  turno_mensa BOOLEAN NOT NULL DEFAULT false,
  ordine      INTEGER NOT NULL DEFAULT 0,
  attiva      BOOLEAN NOT NULL DEFAULT true,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (section_id, codice)
);
CREATE INDEX IF NOT EXISTS idx_materie_section ON public.materie (section_id);
CREATE INDEX IF NOT EXISTS idx_materie_scuola  ON public.materie (scuola_id);

DROP TRIGGER IF EXISTS trg_materie_updated_at ON public.materie;
CREATE TRIGGER trg_materie_updated_at
  BEFORE UPDATE ON public.materie
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. OBIETTIVI DI APPRENDIMENTO (curricolo d'istituto): materia × livello
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.obiettivi_apprendimento (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id      UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  materia_codice TEXT NOT NULL,
  livello        INTEGER NOT NULL CHECK (livello BETWEEN 1 AND 5),
  codice         TEXT,
  descrizione    TEXT NOT NULL,
  attivo         BOOLEAN NOT NULL DEFAULT true,
  creato_il      TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, materia_codice, livello, codice)
);
CREATE INDEX IF NOT EXISTS idx_obiettivi_materia ON public.obiettivi_apprendimento (scuola_id, materia_codice, livello);

DROP TRIGGER IF EXISTS trg_obiettivi_updated_at ON public.obiettivi_apprendimento;
CREATE TRIGGER trg_obiettivi_updated_at
  BEFORE UPDATE ON public.obiettivi_apprendimento
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['materie_preset','materie','obiettivi_apprendimento'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS "service %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "service %1$s" ON public.%1$s FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
    EXECUTE format('DROP POLICY IF EXISTS "read %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (true);', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
