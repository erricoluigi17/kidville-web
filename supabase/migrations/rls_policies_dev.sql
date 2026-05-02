-- ============================================================
-- KIDVILLE — Policy RLS per accesso da app (dev)
-- Eseguire dall'SQL Editor di Supabase
-- ============================================================

-- Assicurati che RLS sia attivo sulle tabelle
ALTER TABLE alunni ENABLE ROW LEVEL SECURITY;
ALTER TABLE utenti ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventi_diario ENABLE ROW LEVEL SECURITY;

-- ALUNNI
DROP POLICY IF EXISTS "alunni_select_anon" ON alunni;
CREATE POLICY "alunni_select_anon" ON alunni FOR SELECT TO anon USING (true);

-- SCHOOLS
DROP POLICY IF EXISTS "schools_select_anon" ON schools;
CREATE POLICY "schools_select_anon" ON schools FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "schools_insert_anon" ON schools;
CREATE POLICY "schools_insert_anon" ON schools FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "schools_update_anon" ON schools;
CREATE POLICY "schools_update_anon" ON schools FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- UTENTI
DROP POLICY IF EXISTS "utenti_select_anon" ON utenti;
CREATE POLICY "utenti_select_anon" ON utenti FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "utenti_insert_anon" ON utenti;
CREATE POLICY "utenti_insert_anon" ON utenti FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "utenti_update_anon" ON utenti;
CREATE POLICY "utenti_update_anon" ON utenti FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- EVENTI_DIARIO (lettura + scrittura)
DROP POLICY IF EXISTS "eventi_diario_select_anon" ON eventi_diario;
CREATE POLICY "eventi_diario_select_anon" ON eventi_diario FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "eventi_diario_insert_anon" ON eventi_diario;
CREATE POLICY "eventi_diario_insert_anon" ON eventi_diario FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "eventi_diario_update_anon" ON eventi_diario;
CREATE POLICY "eventi_diario_update_anon" ON eventi_diario FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- LOCKER_CATALOG
DROP POLICY IF EXISTS "locker_catalog_select_anon" ON locker_catalog;
CREATE POLICY "locker_catalog_select_anon" ON locker_catalog FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "locker_catalog_insert_anon" ON locker_catalog;
CREATE POLICY "locker_catalog_insert_anon" ON locker_catalog FOR INSERT TO anon WITH CHECK (true);

-- LOCKER_INVENTORY
DROP POLICY IF EXISTS "locker_inventory_select_anon" ON locker_inventory;
CREATE POLICY "locker_inventory_select_anon" ON locker_inventory FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "locker_inventory_insert_anon" ON locker_inventory;
CREATE POLICY "locker_inventory_insert_anon" ON locker_inventory FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "locker_inventory_update_anon" ON locker_inventory;
CREATE POLICY "locker_inventory_update_anon" ON locker_inventory FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- LOCKER_REQUESTS
DROP POLICY IF EXISTS "locker_requests_select_anon" ON locker_requests;
CREATE POLICY "locker_requests_select_anon" ON locker_requests FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "locker_requests_update_anon" ON locker_requests;
CREATE POLICY "locker_requests_update_anon" ON locker_requests FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "locker_requests_insert_anon" ON locker_requests;
CREATE POLICY "locker_requests_insert_anon" ON locker_requests FOR INSERT TO anon WITH CHECK (true);

-- LOCKER_LOADS
DROP POLICY IF EXISTS "locker_loads_select_anon" ON locker_loads;
CREATE POLICY "locker_loads_select_anon" ON locker_loads FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "locker_loads_insert_anon" ON locker_loads;
CREATE POLICY "locker_loads_insert_anon" ON locker_loads FOR INSERT TO anon WITH CHECK (true);

-- ALUNNI (update + delete per anagrafica admin)
DROP POLICY IF EXISTS "alunni_update_anon" ON alunni;
CREATE POLICY "alunni_update_anon" ON alunni FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "alunni_insert_anon" ON alunni;
CREATE POLICY "alunni_insert_anon" ON alunni FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "alunni_delete_anon" ON alunni;
CREATE POLICY "alunni_delete_anon" ON alunni FOR DELETE TO anon USING (true);
