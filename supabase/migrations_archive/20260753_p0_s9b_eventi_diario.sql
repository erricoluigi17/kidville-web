-- =============================================================================
-- P0 / S9b (Diario) — drop policy permissive anon su `eventi_diario`.
--
-- Prerequisito soddisfatto (DL-040): tutti gli accessi server a `eventi_diario`
-- usano ora service-role (`/api/diary/entries` migrato; `educator-sections`/
-- `admin/wipe` già admin; `debug-supabase` sigillato→404 in prod). Nessun accesso
-- dal client anon del browser. RLS resta ABILITATA: la policy genitore additiva
-- (`20260722`) resta per le letture authenticated; anon → default-deny; service-role passa.
-- Idempotente.
-- =============================================================================

DROP POLICY IF EXISTS "eventi_diario_insert_anon" ON public.eventi_diario;
DROP POLICY IF EXISTS "eventi_diario_select_anon" ON public.eventi_diario;
DROP POLICY IF EXISTS "eventi_diario_update_anon" ON public.eventi_diario;
