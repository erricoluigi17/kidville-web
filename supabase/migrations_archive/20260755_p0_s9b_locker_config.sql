-- P0/S9b (Armadietto) — drop policy permissive su locker_config (DL-044).
-- L'unico accessor (`/api/locker/materials`) è ora service-role; nessun browser anon.
DROP POLICY IF EXISTS "auth_gestisce_locker_config" ON public.locker_config;
DROP POLICY IF EXISTS "tutti_leggono_locker_config" ON public.locker_config;
