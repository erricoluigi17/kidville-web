-- P0/S4 — Ponte identità genitori.
-- Collega `parents` a `auth.users` SENZA ripuntare la PK `parents.id`
-- (referenziata da `student_parents` + altre FK). La colonna è nullable:
-- resta NULL finché la Segreteria non emette le credenziali (S6/S11).
-- Staff: NON serve alcun ponte — `utenti.id` è già FK → `auth.users` (utenti_id_fkey).

ALTER TABLE public.parents
  ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_parents_auth_user_id ON public.parents(auth_user_id);

COMMENT ON COLUMN public.parents.auth_user_id IS
  'P0: Supabase Auth uid del genitore (login). NULL finché la Segreteria non emette le credenziali. La PK parents.id resta invariata.';

-- Rollback: DROP INDEX IF EXISTS idx_parents_auth_user_id; ALTER TABLE public.parents DROP COLUMN IF EXISTS auth_user_id;
