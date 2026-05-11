-- ============================================================
-- KIDVILLE — RLS Policies per Anagrafiche
-- Migration: 20260511_registries_rls.sql
-- ============================================================

-- Abilitazione RLS sulle tabelle coinvolte
ALTER TABLE adults ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_adults ENABLE ROW LEVEL SECURITY;
ALTER TABLE educator_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE alunni ENABLE ROW LEVEL SECURITY;

-- 1. Policy per 'adults'
-- Admin/Segreteria: ALL
CREATE POLICY "Admin full access adults" ON adults
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator')
        )
    );

-- Utente loggato può vedere se stesso
CREATE POLICY "Adults can read themselves" ON adults
    FOR SELECT
    USING (id = auth.uid());

-- Educatori: SELECT limitato agli adulti associati ai propri alunni
CREATE POLICY "Educators can read linked adults" ON adults
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role = 'educator'
        )
        AND id IN (
            SELECT sa.adult_id 
            FROM student_adults sa
            JOIN alunni al ON sa.student_id = al.id
            JOIN educator_sections es ON al.section_id = es.section_id
            WHERE es.educator_id = auth.uid()
        )
    );

-- 2. Policy per 'student_adults'
-- Admin/Segreteria: ALL
CREATE POLICY "Admin full access student_adults" ON student_adults
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator')
        )
    );

-- Genitori: possono vedere i propri record di legame
CREATE POLICY "Parents can view own links" ON student_adults
    FOR SELECT
    USING (adult_id = auth.uid());

-- Educatori: possono vedere i legami dei propri alunni
CREATE POLICY "Educators can view links of their students" ON student_adults
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role = 'educator'
        )
        AND student_id IN (
            SELECT al.id FROM alunni al
            JOIN educator_sections es ON al.section_id = es.section_id
            WHERE es.educator_id = auth.uid()
        )
    );

-- 3. Policy per 'alunni' (Aggiornamento/Sovrascrittura se esistenti)
DROP POLICY IF EXISTS "Admin full access alunni" ON alunni;
CREATE POLICY "Admin full access alunni" ON alunni
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator')
        )
    );

DROP POLICY IF EXISTS "Educators can read own students" ON alunni;
CREATE POLICY "Educators can read own students" ON alunni
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role = 'educator'
        )
        AND section_id IN (
            SELECT section_id FROM educator_sections WHERE educator_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Parents can read own children" ON alunni;
CREATE POLICY "Parents can read own children" ON alunni
    FOR SELECT
    USING (
        id IN (
            SELECT student_id FROM student_adults WHERE adult_id = auth.uid()
        )
    );

-- 4. Policy per 'educator_sections'
-- Admin/Segreteria: ALL
CREATE POLICY "Admin full access educator_sections" ON educator_sections
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM adults a WHERE a.id = auth.uid() AND a.role IN ('admin', 'coordinator')
        )
    );

-- Educatori: possono vedere le proprie associazioni
CREATE POLICY "Educators can view own sections" ON educator_sections
    FOR SELECT
    USING (educator_id = auth.uid());
