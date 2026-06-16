-- =============================================================================
-- Modulo MENSA & CUCINA
-- =============================================================================
-- Prenotazione/scalo giornaliero ticket (1 ticket = 1 pranzo), menu a rotazione
-- + override per data, impostazioni mensa. Si appoggia a ticket_mensa esistente
-- (saldo in pezzi) creato dal modulo pagamenti.
--
-- Convenzioni: gen_random_uuid(), set_updated_at(), FK -> alunni(id)/utenti(id)/
-- schools(id). Idempotente (IF NOT EXISTS / DO $$ … EXCEPTION).
--
-- MODELLO DATI REALE (vedi 20260602_pagamenti_core.sql):
--   * ticket_mensa(alunno_id PK, saldo_ticket INT, ultimo_carico)
--   * utenti(id, role/ruolo), alunni(id, classe_sezione, allergies, scuola_id)
--   * Auth app-level: utenti.id ≠ auth.uid().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PRENOTAZIONI MENSA (log giornaliero, cuore dello scalo ticket)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mensa_prenotazioni (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id      UUID NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  scuola_id      UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  data           DATE NOT NULL,
  stato          TEXT NOT NULL DEFAULT 'prenotato',  -- 'prenotato' | 'disdetto'
  origine        TEXT NOT NULL DEFAULT 'genitore',   -- 'genitore' | 'segreteria'
  ticket_scalato INTEGER NOT NULL DEFAULT 1,         -- pezzi scalati (audit/riaccredito)
  prenotato_da   UUID REFERENCES public.utenti(id),
  creato_il      TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (alunno_id, data)
);
CREATE INDEX IF NOT EXISTS idx_mensa_pren_scuola_data ON public.mensa_prenotazioni (scuola_id, data);
CREATE INDEX IF NOT EXISTS idx_mensa_pren_alunno_data ON public.mensa_prenotazioni (alunno_id, data);

DROP TRIGGER IF EXISTS trg_mensa_pren_updated_at ON public.mensa_prenotazioni;
CREATE TRIGGER trg_mensa_pren_updated_at
  BEFORE UPDATE ON public.mensa_prenotazioni
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. MENU A ROTAZIONE (settimana × giorno feriale)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mensa_menu_rotazione (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id        UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  settimana        INTEGER NOT NULL CHECK (settimana BETWEEN 1 AND 8),
  giorno_settimana INTEGER NOT NULL CHECK (giorno_settimana BETWEEN 1 AND 7),
  portate          JSONB NOT NULL DEFAULT '{}'::jsonb, -- { primo, secondo, contorno, frutta }
  note             TEXT,
  creato_il        TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, settimana, giorno_settimana)
);

DROP TRIGGER IF EXISTS trg_mensa_rotazione_updated_at ON public.mensa_menu_rotazione;
CREATE TRIGGER trg_mensa_rotazione_updated_at
  BEFORE UPDATE ON public.mensa_menu_rotazione
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. OVERRIDE MENU PER DATA (priorità sulla rotazione; chiusure)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mensa_menu_override (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  data        DATE NOT NULL,
  chiuso      BOOLEAN NOT NULL DEFAULT false,   -- true = niente mensa quel giorno
  portate     JSONB DEFAULT '{}'::jsonb,
  note        TEXT,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, data)
);

DROP TRIGGER IF EXISTS trg_mensa_override_updated_at ON public.mensa_menu_override;
CREATE TRIGGER trg_mensa_override_updated_at
  BEFORE UPDATE ON public.mensa_menu_override
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. IMPOSTAZIONI MENSA (su admin_settings esistente)
-- -----------------------------------------------------------------------------
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS mensa_cutoff_ora          TIME DEFAULT '09:30',
  ADD COLUMN IF NOT EXISTS mensa_giorni_attivi       INTEGER[] DEFAULT '{1,2,3,4,5}',
  ADD COLUMN IF NOT EXISTS mensa_settimane_rotazione INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS mensa_soglia_saldo_basso  INTEGER NOT NULL DEFAULT 5;

-- -----------------------------------------------------------------------------
-- 5. REALTIME (dashboard genitore/cucina live su prenotazione)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.mensa_prenotazioni;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_object THEN null; END $$;

-- -----------------------------------------------------------------------------
-- 6. RLS (defense-in-depth; enforcement app-level via service_role)
-- -----------------------------------------------------------------------------
ALTER TABLE public.mensa_prenotazioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service mensa pren" ON public.mensa_prenotazioni;
CREATE POLICY "service mensa pren" ON public.mensa_prenotazioni FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.mensa_menu_rotazione ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service mensa rotazione" ON public.mensa_menu_rotazione;
CREATE POLICY "service mensa rotazione" ON public.mensa_menu_rotazione FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read mensa rotazione" ON public.mensa_menu_rotazione;
CREATE POLICY "read mensa rotazione" ON public.mensa_menu_rotazione FOR SELECT TO authenticated USING (true);

ALTER TABLE public.mensa_menu_override ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service mensa override" ON public.mensa_menu_override;
CREATE POLICY "service mensa override" ON public.mensa_menu_override FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read mensa override" ON public.mensa_menu_override;
CREATE POLICY "read mensa override" ON public.mensa_menu_override FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
