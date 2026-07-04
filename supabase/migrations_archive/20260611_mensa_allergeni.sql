-- =============================================================================
-- Modulo MENSA — Ingredienti per portata + Allergeni strutturati + Alert
-- =============================================================================
-- Estende il modulo mensa (20260610_mensa.sql) con:
--   * ingredienti per portata (testo libero, mostrato a cucina/genitori)
--   * allergeni per portata (lista di chiavi canoniche dei 14 allergeni UE)
--   * allergeni strutturati per alunno (oltre al testo libero `allergies`)
-- Il match allergia↔menu confronta alunni.allergeni (o inferiti dal testo)
-- con gli allergeni del menu del giorno → alert a segreteria/cuoca/insegnanti.
-- Idempotente.
-- =============================================================================

-- 1. Allergeni strutturati per alunno (chiavi canoniche, es. {'glutine','latte'}).
--    Il testo libero `alunni.allergies` resta come nota e fallback d'inferenza.
ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS allergeni TEXT[] DEFAULT '{}'::text[];

-- 2. Ingredienti + allergeni per portata sul menu a rotazione.
--    ingredienti: { primo, secondo, contorno, frutta } (testo)
--    allergeni:   { primo:[], secondo:[], contorno:[], frutta:[] } (chiavi)
ALTER TABLE public.mensa_menu_rotazione
  ADD COLUMN IF NOT EXISTS ingredienti JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS allergeni   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Stesse colonne sugli override per data (menu speciali).
ALTER TABLE public.mensa_menu_override
  ADD COLUMN IF NOT EXISTS ingredienti JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS allergeni   JSONB NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
