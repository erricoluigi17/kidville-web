-- ============================================================
-- KIDVILLE — Estensione Tabella task_interni (Fase 3.3)
-- Migration: 20260524_task_interni_extended.sql
-- ============================================================

ALTER TABLE task_interni 
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'todo', -- 'todo', 'in_progress', 'completed'
    ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'urgent'
    ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'generale', -- 'genitore', 'amministrativo', 'servizio', 'manutenzione'
    ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES public.alunni(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES public.utenti(id) ON DELETE SET NULL, -- Referenzia utenti(id) per compatibilità legacy
    ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS target_role VARCHAR(50), -- es. 'educator', 'coordinator', 'admin'
    ADD COLUMN IF NOT EXISTS target_scope VARCHAR(20) DEFAULT 'single', -- 'single', 'class', 'role', 'global'
    ADD COLUMN IF NOT EXISTS compiti JSONB DEFAULT '[]'::jsonb; -- Compiti suddivisi con relativi assegnatari e stati

-- Aggiorna lo stato iniziale per i record preesistenti
UPDATE task_interni 
SET status = CASE WHEN completato = true THEN 'completed' ELSE 'todo' END 
WHERE status IS NULL;

-- Creazione indici per query veloci
CREATE INDEX IF NOT EXISTS idx_task_interni_status ON task_interni(status);
CREATE INDEX IF NOT EXISTS idx_task_interni_student ON task_interni(student_id);
CREATE INDEX IF NOT EXISTS idx_task_interni_target_role ON task_interni(target_role);
CREATE INDEX IF NOT EXISTS idx_task_interni_target_scope ON task_interni(target_scope);
