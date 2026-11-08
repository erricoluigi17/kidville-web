-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.4 · «Che cosa vede una famiglia» · M44a, le funzioni
-- Un solo file per le funzioni della PR; ogni compito SQL aggiunge una sezione in coda, con la sua testata.
-- INERTE: nessuna tabella la legge ancora e nessuna regola di accesso cambia. Le regole di accesso stanno nell'altra
-- migrazione della PR (M44b, version maggiore).
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 4.4.1 La manopola della chat ──────────────────────────────────────────────────────────────────
--
-- Nasce SPENTA, e la accende la PR 4.8: a manopola spenta le conversazioni con un docente non più assegnato restano
-- scrivibili come oggi. Le scritture su `anno_regole` le ferma il freno.
ALTER TABLE public.anno_regole
  ADD COLUMN IF NOT EXISTS chat_sola_lettura_dal_passaggio boolean NOT NULL DEFAULT false;

-- ── 4.4.1 I figli attivi di un genitore ───────────────────────────────────────────────────────────
--
-- «Chi frequenta ora». Non è «chi è mio figlio»: quella domanda resta a `getFigliDiGenitore` e a
-- `current_parent_student_ids()`, perché una voce di pagamento di un ritirato con dovuto aperto deve restare visibile.
--
-- Un figlio è attivo se la sua frequenza:
--   · sta nell'anno attivo DELLA SUA SEDE (`anno_attivo`): un trasferito ha due frequenze in due sedi, e conta quella viva;
--   · è `in_attesa` o `iscritto`. `sospeso` è un flag della frequenza, non uno stato: un figlio sospeso resta attivo;
--   · oggi (giorno di Roma) cade fra `data_ingresso` e `data_uscita`, estremi compresi.
-- Il confine sulle frequenze `origine = 'recupero'` riguarda le foto, non questa funzione: qui un recupero è come le altre.
--
-- Il legame ha DUE strade, e il codice le unisce da sempre (`getFigliDiGenitoreEsito` in `src/lib/anagrafiche/legami.ts`):
-- `legame_genitori_alunni` e `student_parents` con `parents.auth_user_id`. Con una sola, una parte delle famiglie
-- perderebbe i figli. Passano da `to_regclass` perché il database della CI può non averle: plpgsql risolve una tabella
-- solo quando esegue l'istruzione, quindi il ramo saltato non fallisce. Una tabella assente non ha legami da dare.
--
-- Indici: `legame_genitori_alunni_pkey (genitore_id, alunno_id)`, `parents_auth_user_id_key`,
-- `idx_student_parents_parent_id`; sulle frequenze `frequenze_una_viva_per_anno (alunno_id, anno_id) WHERE stato IN (…)`.
--
-- Solo `service_role`: con il parametro aperto a `authenticated` chiunque potrebbe enumerare i figli altrui. Dal browser
-- si passa da `figli_attivi_miei()`.
CREATE OR REPLACE FUNCTION public.figli_attivi(p_utente uuid)
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_figli uuid[] := '{}';
  v_ponte uuid[];
  v_oggi  date := public.giorno_roma(now());
BEGIN
  IF to_regclass('public.legame_genitori_alunni') IS NOT NULL THEN
    SELECT coalesce(array_agg(l.alunno_id), '{}') INTO v_figli
      FROM public.legame_genitori_alunni l
     WHERE l.genitore_id = p_utente;
  END IF;

  IF to_regclass('public.student_parents') IS NOT NULL AND to_regclass('public.parents') IS NOT NULL THEN
    SELECT coalesce(array_agg(sp.student_id), '{}') INTO v_ponte
      FROM public.parents p
      JOIN public.student_parents sp ON sp.parent_id = p.id
     WHERE p.auth_user_id = p_utente;
    v_figli := v_figli || v_ponte;
  END IF;

  RETURN QUERY
    SELECT f.alunno_id, f.id, f.section_id, f.scuola_id
      FROM public.frequenze f
     WHERE f.alunno_id = ANY (v_figli)
       AND f.stato IN ('in_attesa', 'iscritto')
       AND f.anno_sede_id = public.anno_attivo(f.scuola_id)
       AND f.data_ingresso <= v_oggi
       AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);
END
$$;

REVOKE ALL ON FUNCTION public.figli_attivi(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.figli_attivi(uuid) TO service_role;

-- Il wrapper senza parametri: l'unica cosa raggiungibile da `authenticated`. L'utente lo dice il token, non chi chiama.
CREATE OR REPLACE FUNCTION public.figli_attivi_miei()
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.alunno_id, f.frequenza_id, f.section_id, f.scuola_id FROM public.figli_attivi(auth.uid()) f
$$;

REVOKE ALL ON FUNCTION public.figli_attivi_miei() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.figli_attivi_miei() TO authenticated, service_role;
