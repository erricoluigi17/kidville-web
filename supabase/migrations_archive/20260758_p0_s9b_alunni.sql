-- P0/S9b Wave 2 (DL-046) — drop alunni_select_anon.
-- Migrati a service-role gli ultimi lettori session-client di alunni
-- (attendance/monthly, diary/students, locker/requests, locker/inventory);
-- gli altri (gallery/diary/panic) usavano già admin. Resta la policy genitore
-- additiva (20260722); anon = default-deny; service-role passa.
DROP POLICY IF EXISTS "alunni_select_anon" ON public.alunni;
