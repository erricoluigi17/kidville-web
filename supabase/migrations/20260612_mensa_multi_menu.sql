-- ============================================================
-- Mensa: multi-menu con assegnazione classi e data di vigore
-- ============================================================

-- 1. Menu nominati per scuola (es. "Nido", "Infanzia e Primaria")
CREATE TABLE IF NOT EXISTS public.mensa_menu_config (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id  UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  nome       TEXT NOT NULL,
  ordine     INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Assegnazione classe → menu con data di vigore.
--    La riga con attivo_dal <= data più recente (per quella classe) è quella attiva.
CREATE TABLE IF NOT EXISTS public.mensa_class_menu_assignment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id      UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  classe         TEXT NOT NULL,
  menu_config_id UUID NOT NULL REFERENCES public.mensa_menu_config(id) ON DELETE CASCADE,
  attivo_dal     DATE NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mensa_class_menu_scuola_classe
  ON public.mensa_class_menu_assignment(scuola_id, classe, attivo_dal DESC);

-- 3. Collegare rotazione e override a un menu (nullable: NULL = menu unico legacy)
ALTER TABLE public.mensa_menu_rotazione
  ADD COLUMN IF NOT EXISTS menu_config_id UUID REFERENCES public.mensa_menu_config(id) ON DELETE SET NULL;

ALTER TABLE public.mensa_menu_override
  ADD COLUMN IF NOT EXISTS menu_config_id UUID REFERENCES public.mensa_menu_config(id) ON DELETE SET NULL;

-- Rimpiazzare il vecchio vincolo UNIQUE sulla rotazione con uno che supporta multi-menu.
-- Usiamo partial unique indexes: uno per le righe legacy (menu_config_id IS NULL),
-- uno per le righe multi-menu (menu_config_id IS NOT NULL).
ALTER TABLE public.mensa_menu_rotazione
  DROP CONSTRAINT IF EXISTS mensa_menu_rotazione_scuola_id_settimana_giorno_settimana_key;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_rot_legacy
  ON public.mensa_menu_rotazione(scuola_id, settimana, giorno_settimana)
  WHERE menu_config_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_rot_menu
  ON public.mensa_menu_rotazione(scuola_id, menu_config_id, settimana, giorno_settimana)
  WHERE menu_config_id IS NOT NULL;

-- Rimpiazzare il vecchio vincolo UNIQUE sull'override.
ALTER TABLE public.mensa_menu_override
  DROP CONSTRAINT IF EXISTS mensa_menu_override_scuola_id_data_key;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_ovr_legacy
  ON public.mensa_menu_override(scuola_id, data)
  WHERE menu_config_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_ovr_menu
  ON public.mensa_menu_override(scuola_id, menu_config_id, data)
  WHERE menu_config_id IS NOT NULL;

-- 4. RLS (service role ha full access; enforcement applicativo)
ALTER TABLE public.mensa_menu_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensa_class_menu_assignment ENABLE ROW LEVEL SECURITY;

-- Genitore/staff: lettura libera (stessa policy delle altre tabelle mensa)
DROP POLICY IF EXISTS "mensa_menu_config_select" ON public.mensa_menu_config;
CREATE POLICY "mensa_menu_config_select" ON public.mensa_menu_config
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "mensa_class_menu_assignment_select" ON public.mensa_class_menu_assignment;
CREATE POLICY "mensa_class_menu_assignment_select" ON public.mensa_class_menu_assignment
  FOR SELECT USING (true);
