-- P0/S7 — Estende la RLS pagamenti allo spazio identità `parents`.
--
-- Le policy esistenti legano l'identità genitore allo spazio `utenti`/`legame`
-- (`legame.genitore_id = auth.uid()`), che NON copre i 92 parents reali.
-- Qui AGGIUNGIAMO una policy per-tabella legata allo spazio `parents`. È ADDITIVA
-- (le policy permissive si combinano in OR): non tocca staff/service/legacy e può
-- solo concedere a un genitore l'accesso ai pagamenti dei PROPRI figli.
--
-- Helper SECURITY DEFINER: `parents`/`student_parents` hanno RLS che nega la
-- lettura ad `authenticated`, quindi una subquery inline nelle policy
-- restituirebbe vuoto. La funzione gira coi privilegi dell'owner (bypassa quella
-- RLS) ma filtra rigidamente su `auth.uid()`, quindi ritorna SOLO i figli del
-- chiamante. Riusata anche da S9.

CREATE OR REPLACE FUNCTION public.current_parent_student_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT sp.student_id
  FROM public.student_parents sp
  JOIN public.parents p ON p.id = sp.parent_id
  WHERE p.auth_user_id = auth.uid()
$$;

REVOKE ALL ON FUNCTION public.current_parent_student_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_parent_student_ids() FROM anon;
GRANT EXECUTE ON FUNCTION public.current_parent_student_ids() TO authenticated;

CREATE POLICY "parent read pagamenti figli (parents space)"
  ON public.pagamenti FOR SELECT TO authenticated
  USING (alunno_id IN (SELECT public.current_parent_student_ids()));

CREATE POLICY "parent read incassi figli (parents space)"
  ON public.incassi FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.pagamenti pg
      WHERE pg.id = incassi.pagamento_id
        AND pg.alunno_id IN (SELECT public.current_parent_student_ids())
    )
  );

CREATE POLICY "parent read quote figli (parents space)"
  ON public.pagamenti_quote FOR SELECT TO authenticated
  USING (
    pagamento_id IN (
      SELECT pg.id FROM public.pagamenti pg
      WHERE pg.alunno_id IN (SELECT public.current_parent_student_ids())
    )
  );

-- Rollback:
--   DROP POLICY "parent read pagamenti figli (parents space)" ON public.pagamenti;
--   DROP POLICY "parent read incassi figli (parents space)" ON public.incassi;
--   DROP POLICY "parent read quote figli (parents space)" ON public.pagamenti_quote;
--   DROP FUNCTION public.current_parent_student_ids();
