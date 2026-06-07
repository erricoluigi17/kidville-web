-- =============================================================================
-- PRIMARIA — F1.3 Orario: modello tempo scuola (27/29/40h) + campanelle +
-- griglia oraria settimanale (giorno×campanella → materia + docente).
-- =============================================================================
-- Idempotente. Le campanelle si generano dal modello tempo scuola (in API).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TEMPO SCUOLA per sezione (un modello attivo per sezione)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tempo_scuola (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  modello     INTEGER NOT NULL CHECK (modello IN (27, 29, 40)),
  giorni_settimana INTEGER NOT NULL DEFAULT 5 CHECK (giorni_settimana BETWEEN 5 AND 6),
  attivo      BOOLEAN NOT NULL DEFAULT true,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tempo_scuola_section_attivo
  ON public.tempo_scuola (section_id) WHERE attivo;

DROP TRIGGER IF EXISTS trg_tempo_scuola_updated_at ON public.tempo_scuola;
CREATE TRIGGER trg_tempo_scuola_updated_at
  BEFORE UPDATE ON public.tempo_scuola
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. CAMPANELLE (fasce orarie) per sezione e giorno
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campanelle (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id      UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  giorno_settimana INTEGER NOT NULL CHECK (giorno_settimana BETWEEN 1 AND 6),
  ordine          INTEGER NOT NULL,
  ora_inizio      TIME NOT NULL,
  ora_fine        TIME NOT NULL,
  tipo            TEXT NOT NULL DEFAULT 'lezione' CHECK (tipo IN ('lezione', 'intervallo', 'mensa')),
  creato_il       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (section_id, giorno_settimana, ordine)
);
CREATE INDEX IF NOT EXISTS idx_campanelle_section ON public.campanelle (section_id);

-- -----------------------------------------------------------------------------
-- 3. ORARIO SETTIMANALE (giorno×campanella → materia + docente)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orario_settimanale (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id    UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  campanella_id UUID NOT NULL REFERENCES public.campanelle(id) ON DELETE CASCADE,
  giorno_settimana INTEGER NOT NULL CHECK (giorno_settimana BETWEEN 1 AND 6),
  materia_id    UUID REFERENCES public.materie(id) ON DELETE SET NULL,
  docente_id    UUID REFERENCES public.utenti(id) ON DELETE SET NULL,
  note          TEXT,
  creato_il     TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (section_id, giorno_settimana, campanella_id)
);
CREATE INDEX IF NOT EXISTS idx_orario_section ON public.orario_settimanale (section_id);
CREATE INDEX IF NOT EXISTS idx_orario_docente ON public.orario_settimanale (docente_id);

DROP TRIGGER IF EXISTS trg_orario_updated_at ON public.orario_settimanale;
CREATE TRIGGER trg_orario_updated_at
  BEFORE UPDATE ON public.orario_settimanale
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tempo_scuola','campanelle','orario_settimanale'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS "service %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "service %1$s" ON public.%1$s FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
    EXECUTE format('DROP POLICY IF EXISTS "read %1$s" ON public.%1$s;', t);
    EXECUTE format('CREATE POLICY "read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (true);', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
