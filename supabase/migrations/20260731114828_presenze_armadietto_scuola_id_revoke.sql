-- Completa 20260731114449: la funzione trigger `fn_scuola_id_da_alunno` è SOLO
-- un trigger e nessun ruolo client deve poterla eseguire. In Supabase anon e
-- authenticated ricevono EXECUTE per GRANT esplicito (ALTER DEFAULT PRIVILEGES),
-- quindi REVOKE FROM PUBLIC non basta. Difesa in profondità, stessa forma di
-- `fn_form_submission_etl`.
REVOKE EXECUTE ON FUNCTION public.fn_scuola_id_da_alunno() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_scuola_id_da_alunno() TO service_role;
