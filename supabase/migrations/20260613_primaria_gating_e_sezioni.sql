-- =============================================================================
-- PRIMARIA — F1.0 Fondamenta: gating funzioni + classificazione docente +
-- standardizzazione legame alunno↔classe su section_id.
-- =============================================================================
-- Idempotente. Estende tabelle esistenti (utenti, admin_settings, alunni).
-- Riusa l'enum esistente school_type_enum ('nido','infanzia','primaria') per il
-- grado del docente (multi-valore: un docente può essere misto).
-- Auth è app-level: l'enforcement reale è nelle query API. Le policy RLS
-- restano allineate al pattern del progetto (service_role + read authenticated).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CLASSIFICAZIONE DOCENTE (grado) — campo esplicito multi-valore su utenti
-- -----------------------------------------------------------------------------
ALTER TABLE public.utenti
  ADD COLUMN IF NOT EXISTS gradi school_type_enum[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.utenti.gradi IS
  'Gradi scolastici a cui il docente è abilitato (nido/infanzia/primaria). Multi-valore: docente misto. Guida le funzioni visibili.';

-- -----------------------------------------------------------------------------
-- 2. CONFIG GLOBALE in admin_settings: matrice funzioni + vincoli + buffer
-- -----------------------------------------------------------------------------
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS funzioni_matrice            JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS timelock_giorni_classe_orale     INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS timelock_giorni_scritto_pratico  INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS notif_buffer_valutazioni_min     INTEGER NOT NULL DEFAULT 10;

COMMENT ON COLUMN public.admin_settings.funzioni_matrice IS
  'Matrice preset+override grado→funzioni abilitate. Es: {"primaria":{"registro":true,...},"infanzia":{"diario":true,...}}';

-- Seed/preset della matrice di default dove non ancora configurata.
UPDATE public.admin_settings
SET funzioni_matrice = jsonb_build_object(
  'primaria', jsonb_build_object(
    'registro', true, 'valutazioni', true, 'note', true,
    'orario', true, 'appello', true, 'diario', false
  ),
  'infanzia', jsonb_build_object(
    'diario', true, 'appello', true, 'gallery', true,
    'registro', false, 'valutazioni', false, 'note', false, 'orario', false
  ),
  'nido', jsonb_build_object(
    'diario', true, 'appello', true, 'gallery', true,
    'registro', false, 'valutazioni', false, 'note', false, 'orario', false
  )
)
WHERE funzioni_matrice = '{}'::jsonb;

-- -----------------------------------------------------------------------------
-- 3. STANDARDIZZAZIONE alunni.section_id (canonico) ← backfill da classe_sezione
-- -----------------------------------------------------------------------------
-- alunni.section_id esiste già (20260506). Allineiamo i record con section_id
-- NULL facendo match per nome sezione nello stesso scuola_id (case/space-insensitive).
UPDATE public.alunni a
SET section_id = s.id
FROM public.sections s
WHERE a.section_id IS NULL
  AND a.classe_sezione IS NOT NULL
  AND s.scuola_id = a.scuola_id
  AND lower(replace(s.name, ' ', '')) = lower(replace(a.classe_sezione, ' ', ''));

-- Log dei non abbinati (non blocca la migrazione): vanno riallineati a mano.
DO $$
DECLARE n_unmatched INTEGER;
BEGIN
  SELECT count(*) INTO n_unmatched
  FROM public.alunni
  WHERE section_id IS NULL AND classe_sezione IS NOT NULL AND classe_sezione <> '';
  IF n_unmatched > 0 THEN
    RAISE NOTICE 'PRIMARIA backfill: % alunni senza section_id abbinato (classe_sezione non corrisponde a nessuna sezione). Riallineare da admin.', n_unmatched;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alunni_section ON public.alunni (section_id);

NOTIFY pgrst, 'reload schema';
