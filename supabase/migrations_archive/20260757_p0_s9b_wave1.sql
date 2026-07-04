-- P0/S9b Wave 1 (DL-046) — drop permissive su tabelle GIÀ service-role.
-- Verificato: register/lessons + notes/sign usano createAdminClient per queste
-- tabelle (createClient solo per auth.getUser); nessun accesso session/anon reale.
DROP POLICY IF EXISTS "allow_all_note" ON public.note_disciplinari;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.note_disciplinari;
DROP POLICY IF EXISTS "allow_all_registro" ON public.registro_orario;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.registro_orario;
DROP POLICY IF EXISTS "allow_all_firme" ON public.firme_docenti;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.firme_docenti;
DROP POLICY IF EXISTS "schools_select_anon" ON public.schools;
