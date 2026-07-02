-- =============================================================================
-- KIDVILLE — Segreteria/Direzione: fondamenta (ruolo, multi-plesso, audit)
-- Migration: 20260718_segreteria_direzione_foundation.sql  (idempotente)
-- Rif. PRD §3 (RBAC) + nuova §12 (Segreteria/Direzione — accesso scrittura per classe).
--
-- Obiettivo: dare al ruolo Segreteria (un solo plesso) e alla Direzione
-- (più plessi) accesso in SCRITTURA a tutte le funzioni docente RIUSANDO le
-- schermate/endpoint del docente. Questa migrazione introduce SOLO l'infra:
--   1) ruolo applicativo 'segreteria' (free-text utenti.ruolo, NON enum)
--   2) ponte multi-plesso utenti_scuole (per la Direzione = ruolo admin)
--   3) audit immodificabile delle scritture docente con diff prima/dopo
--   4) admin_settings.segreteria_config (toggle notifica al docente titolare)
-- Nessun cambiamento di comportamento per i docenti già esistenti.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ruolo 'segreteria'
-- -----------------------------------------------------------------------------
-- I valori vivi di ruolo stanno nel free-text `utenti.ruolo` (VARCHAR): l'enum
-- `adult_role_enum` NON contiene neppure 'genitore'/'cuoca' e NON va alterato.
-- `loadAppUser` legge `role || ruolo`. Provisioning Segreteria:
--     UPDATE public.utenti SET role = NULL, ruolo = 'segreteria' WHERE id = '...';
-- La Direzione resta il ruolo 'admin'. Nessuna ALTER TYPE qui (idempotenza).

-- -----------------------------------------------------------------------------
-- 2. utenti_scuole — ponte multi-plesso (Direzione = admin con più scuole)
-- -----------------------------------------------------------------------------
-- segreteria/educator/coordinator restano sul singolo utenti.scuola_id.
-- Solo la Direzione (admin) può essere associata a più plessi qui; in assenza
-- di righe, l'helper applicativo `scuoleDiUtente` ricade su [utenti.scuola_id].
CREATE TABLE IF NOT EXISTS public.utenti_scuole (
  utente_id  UUID NOT NULL REFERENCES public.utenti(id)  ON DELETE CASCADE,
  scuola_id  UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  creato_il  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (utente_id, scuola_id)
);
CREATE INDEX IF NOT EXISTS idx_utenti_scuole_utente ON public.utenti_scuole (utente_id);
CREATE INDEX IF NOT EXISTS idx_utenti_scuole_scuola ON public.utenti_scuole (scuola_id);

COMMENT ON TABLE public.utenti_scuole IS
  'Ponte multi-plesso: plessi (schools) su cui un utente può operare. Usato per la Direzione (admin) che segue più sedi. Segreteria/docenti restano sul singolo utenti.scuola_id.';

-- RLS: service_role pieno; authenticated solo lettura (enforcement applicativo via service-role).
ALTER TABLE public.utenti_scuole ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service utenti_scuole" ON public.utenti_scuole;
CREATE POLICY "service utenti_scuole" ON public.utenti_scuole FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "read utenti_scuole" ON public.utenti_scuole;
CREATE POLICY "read utenti_scuole" ON public.utenti_scuole FOR SELECT TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- 3. audit_scritture_docente — log IMMODIFICABILE delle scritture (diff prima/dopo)
-- -----------------------------------------------------------------------------
-- Traccia OGNI scrittura sulle funzioni docente (docente o segreteria/direzione):
-- chi (attore_id+ruolo), su quale plesso/classe, quale entità, azione, e il
-- valore PRIMA e DOPO (diff JSONB). Estende "accesso tracciato" (PRD §3/§12).
CREATE TABLE IF NOT EXISTS public.audit_scritture_docente (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attore_id     UUID REFERENCES public.utenti(id),
  attore_ruolo  TEXT,
  scuola_id     UUID REFERENCES public.schools(id),
  section_id    UUID REFERENCES public.sections(id) ON DELETE SET NULL,
  entita_tipo   TEXT NOT NULL,
  entita_id     UUID,
  azione        TEXT NOT NULL CHECK (azione IN ('insert', 'update', 'delete')),
  valore_prima  JSONB,
  valore_dopo   JSONB,
  creato_il     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_scritt_section ON public.audit_scritture_docente (section_id, creato_il DESC);
CREATE INDEX IF NOT EXISTS idx_audit_scritt_attore  ON public.audit_scritture_docente (attore_id, creato_il DESC);
CREATE INDEX IF NOT EXISTS idx_audit_scritt_entita  ON public.audit_scritture_docente (entita_tipo, entita_id);

COMMENT ON TABLE public.audit_scritture_docente IS
  'Audit immodificabile delle scritture sulle funzioni docente: attore (docente/segreteria/direzione), plesso, classe, entità, azione e diff valore_prima/valore_dopo. PRD §3/§12.';

-- RLS: audit immodificabile — service_role inserisce/legge; authenticated solo
-- lettura. Nessuna policy UPDATE/DELETE: il log non è alterabile via API.
ALTER TABLE public.audit_scritture_docente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service insert audit_scritture" ON public.audit_scritture_docente;
CREATE POLICY "service insert audit_scritture" ON public.audit_scritture_docente FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS "service read audit_scritture" ON public.audit_scritture_docente;
CREATE POLICY "service read audit_scritture" ON public.audit_scritture_docente FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS "read audit_scritture" ON public.audit_scritture_docente;
CREATE POLICY "read audit_scritture" ON public.audit_scritture_docente FOR SELECT TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- 4. admin_settings.segreteria_config — toggle notifica al docente titolare
-- -----------------------------------------------------------------------------
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS segreteria_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.admin_settings.segreteria_config IS
  'Config Segreteria/Direzione: notifica_docente (bool) = avvisa il docente titolare quando segreteria/direzione scrive sulla sua classe. PRD §12.';

-- Seed default: notifica al docente attiva (trasparenza) dove non già impostato.
UPDATE public.admin_settings
SET segreteria_config = jsonb_build_object('notifica_docente', true)
WHERE segreteria_config = '{}'::jsonb OR segreteria_config IS NULL;

NOTIFY pgrst, 'reload schema';
