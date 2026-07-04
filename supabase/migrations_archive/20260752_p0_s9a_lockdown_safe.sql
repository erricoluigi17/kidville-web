-- =============================================================================
-- P0 / S9a — RLS lockdown (sottoinsieme SICURO) + hardening funzioni.
--
-- Principio: una policy permissiva può essere droppata in sicurezza solo se OGNI
-- accesso server alla tabella usa il client service-role (che bypassa la RLS).
-- Le route che usano il client di SESSIONE (`createClient`, anon per header-identity
-- o authenticated per staff loggato) DIPENDONO dalle policy permissive: per quelle
-- tabelle il drop è rinviato al rollout per-famiglia (prima si migra la route a
-- service-role). Vedi P0_ROLLOUT_CHECKLIST.md.
--
-- Tabelle SICURE (solo service-role, verificato: nessuna route nel set session-client):
--   avvisi, avvisi_risposte, task_interni, valutazioni, mensa_menu_config,
--   mensa_class_menu_assignment, forms_submissions, forms_templates.
-- Idempotente (DROP POLICY IF EXISTS). La RLS resta ABILITATA (default-deny per
-- anon/authenticated; service-role passa).
-- =============================================================================

-- 1) Chiusura buco di sicurezza: `exec_sql(text)` è SECURITY DEFINER ed era
--    eseguibile da anon/authenticated via /rest/v1/rpc/exec_sql (SQL arbitrario
--    dal public API). Resta accessibile SOLO a service_role (usato dalle route
--    admin di migrazione, che girano service-role).
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM anon;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

-- 2) search_path fisso sulle funzioni segnalate (hardening; nessun cambio di
--    comportamento: operano su `public`).
ALTER FUNCTION public.exec_sql(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_staff_or_admin() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_alunno_section_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_incassi_ricalcola() SET search_path = public, pg_temp;
ALTER FUNCTION public.ricalcola_stato_pagamento(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.ricalcola_stato_padre(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.crea_quote_da_config(uuid, uuid, numeric, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.genera_rette_mensili(date) SET search_path = public, pg_temp;
ALTER FUNCTION public.genera_rette_anno(integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.genera_solleciti() SET search_path = public, pg_temp;
ALTER FUNCTION public.mensa_check_allergie_giornaliero() SET search_path = public, pg_temp;

-- 3) Drop policy permissive su tabelle SOLO service-role.
--    avvisi / avvisi_risposte / task_interni (TO public USING true)
DROP POLICY IF EXISTS "Allow all for service role" ON public.avvisi;
DROP POLICY IF EXISTS "Allow all for service role" ON public.avvisi_risposte;
DROP POLICY IF EXISTS "Allow all for service role" ON public.task_interni;
--    valutazioni — chiude l'esposizione anon dei VOTI degli alunni (era TO anon,authenticated)
DROP POLICY IF EXISTS "allow_all_valutazioni" ON public.valutazioni;
--    mensa (SELECT TO public)
DROP POLICY IF EXISTS "mensa_menu_config_select" ON public.mensa_menu_config;
DROP POLICY IF EXISTS "mensa_class_menu_assignment_select" ON public.mensa_class_menu_assignment;
--    modulistica legacy (TO public USING true)
DROP POLICY IF EXISTS "forms_submissions_all" ON public.forms_submissions;
DROP POLICY IF EXISTS "forms_templates_all" ON public.forms_templates;
