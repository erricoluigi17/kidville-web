-- ============================================================
-- KIDVILLE — RLS Granulari per il Registro Presenze
-- Migration: 20260505_attendance_rls_policies.sql
-- ============================================================
-- Nota: 20260503_presenze_schema.sql ha già creato policy permissive
-- (authenticated USING true). Questa migration le sostituisce con
-- policy granulari basate sul ruolo dell'utente autenticato.
-- ============================================================

-- 1. Drop delle policy precedenti permissive su `presenze`
DROP POLICY IF EXISTS "Enable read access for authenticated users" ON public.presenze;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.presenze;
DROP POLICY IF EXISTS "Enable update for authenticated users" ON public.presenze;

-- 2. Assicura RLS attivo (idempotente)
ALTER TABLE public.presenze ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. SELECT — Docenti: solo gli alunni delle proprie sezioni
-- ============================================================
-- Pattern: presenze.alunno_id → alunni.section_id → educator_sections.section_id
-- dove educator_sections.educator_id = auth.uid()
-- Coerente con il pattern già in uso in 20260511_registries_rls.sql

DROP POLICY IF EXISTS "Docenti possono leggere presenze proprie sezioni" ON public.presenze;
CREATE POLICY "Docenti possono leggere presenze proprie sezioni"
    ON public.presenze
    FOR SELECT
    TO authenticated
    USING (
        -- Verifica ruolo educator tramite adults table
        EXISTS (
            SELECT 1 FROM public.adults a
            WHERE a.id = auth.uid()
              AND a.role = 'educator'
        )
        AND alunno_id IN (
            -- Alunni nelle sezioni assegnate al docente
            SELECT al.id
            FROM public.alunni al
            JOIN public.educator_sections es ON al.section_id = es.section_id
            WHERE es.educator_id = auth.uid()
        )
    );

-- ============================================================
-- 4. SELECT — Admin/Coordinator: visione completa di tutte le classi
-- ============================================================
DROP POLICY IF EXISTS "Admin visione completa presenze" ON public.presenze;
CREATE POLICY "Admin visione completa presenze"
    ON public.presenze
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.adults a
            WHERE a.id = auth.uid()
              AND a.role IN ('admin', 'coordinator')
        )
    );

-- ============================================================
-- 5. SELECT — Fallback per utenti utenti (vecchia tabella auth)
-- ============================================================
-- Supporto per il sistema di autenticazione legacy che usa la tabella `utenti`
-- anziché `adults`. Da rimuovere dopo la migrazione completa degli utenti.
DROP POLICY IF EXISTS "Utenti autenticati lettura presenze legacy" ON public.presenze;
CREATE POLICY "Utenti autenticati lettura presenze legacy"
    ON public.presenze
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.utenti u
            WHERE u.id = auth.uid()
              AND u.ruolo IN ('admin', 'maestra', 'coordinatrice')
        )
    );

-- ============================================================
-- 6. INSERT — Solo docenti/admin autenticati
-- ============================================================
DROP POLICY IF EXISTS "Docenti e admin possono inserire presenze" ON public.presenze;
CREATE POLICY "Docenti e admin possono inserire presenze"
    ON public.presenze
    FOR INSERT
    TO authenticated
    WITH CHECK (
        -- Docenti: solo per i propri alunni
        (
            EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role = 'educator')
            AND alunno_id IN (
                SELECT al.id FROM public.alunni al
                JOIN public.educator_sections es ON al.section_id = es.section_id
                WHERE es.educator_id = auth.uid()
            )
        )
        OR
        -- Admin: qualsiasi alunno
        EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator'))
        OR
        -- Legacy utenti table
        EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.ruolo IN ('admin', 'maestra', 'coordinatrice'))
    );

-- ============================================================
-- 7. UPDATE — Stesso pattern di INSERT
-- ============================================================
DROP POLICY IF EXISTS "Docenti e admin possono aggiornare presenze" ON public.presenze;
CREATE POLICY "Docenti e admin possono aggiornare presenze"
    ON public.presenze
    FOR UPDATE
    TO authenticated
    USING (
        (
            EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role = 'educator')
            AND alunno_id IN (
                SELECT al.id FROM public.alunni al
                JOIN public.educator_sections es ON al.section_id = es.section_id
                WHERE es.educator_id = auth.uid()
            )
        )
        OR EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator'))
        OR EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.ruolo IN ('admin', 'maestra', 'coordinatrice'))
    )
    WITH CHECK (
        (
            EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role = 'educator')
            AND alunno_id IN (
                SELECT al.id FROM public.alunni al
                JOIN public.educator_sections es ON al.section_id = es.section_id
                WHERE es.educator_id = auth.uid()
            )
        )
        OR EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator'))
        OR EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.ruolo IN ('admin', 'maestra', 'coordinatrice'))
    );

-- ============================================================
-- 8. Policy RLS su delegati (stessa logica, era già permissiva)
-- ============================================================
DROP POLICY IF EXISTS "Enable read access for authenticated users" ON public.delegati;

DROP POLICY IF EXISTS "Docenti leggono delegati propri alunni" ON public.delegati;
CREATE POLICY "Docenti leggono delegati propri alunni"
    ON public.delegati
    FOR SELECT
    TO authenticated
    USING (
        (
            EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role = 'educator')
            AND alunno_id IN (
                SELECT al.id FROM public.alunni al
                JOIN public.educator_sections es ON al.section_id = es.section_id
                WHERE es.educator_id = auth.uid()
            )
        )
        OR EXISTS (SELECT 1 FROM public.adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator'))
        OR EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.ruolo IN ('admin', 'maestra', 'coordinatrice'))
    );
