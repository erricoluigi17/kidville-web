-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.3 · «Sezioni e docenti per anno, fase B»
-- Un solo file per la PR; ogni compito SQL aggiunge una sezione in coda, con la sua testata.
-- Qui arrivano, nell'ordine: (4.3.1) la visibilità delle sezioni per i docenti e (4.3.2) l'invariante 8.
-- In coda arriveranno la rinomina delle sezioni per anno e la fase B dello specchio fra `alunni` e `frequenze`.
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 4.3.1 Le sezioni che un docente vede ──────────────────────────────────────────────────────────
--
-- Un docente vede le sezioni a cui è assegnato (`utenti_sezioni`) il cui anno, PER LA SEDE DELLA SEZIONE, è
-- `corrente` (scrivibile), `in_chiusura` o `chiuso` (sola lettura). Un anno `in_preparazione` o con
-- `iscrizioni_aperte` non compare MAI: le sezioni del prossimo anno si preparano, ma i docenti non le vedono
-- finché l'anno non è iniziato. Un anno `chiuso` compare solo se il docente è assegnato a quella sezione.
-- La sola lettura la impone il codice applicativo (la guardia dell'anno chiuso è ancora spenta): qui la si dichiara.
CREATE OR REPLACE FUNCTION public.sezioni_visibili_docente(p_utente uuid)
RETURNS TABLE (section_id uuid, sola_lettura boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT us.section_id, (a.stato::text <> 'corrente')
    FROM public.utenti_sezioni us
    JOIN public.sections s    ON s.id = us.section_id
    JOIN public.anni_sede a   ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
   WHERE us.utente_id = p_utente
     AND a.stato::text IN ('corrente', 'in_chiusura', 'chiuso')
$$;

-- Le sole sezioni SCRIVIBILI (quelle dell'anno attivo della loro sede): servono alle liste.
CREATE OR REPLACE FUNCTION public.sezioni_docente_anno_attivo(p_utente uuid)
RETURNS TABLE (section_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT us.section_id
    FROM public.utenti_sezioni us
    JOIN public.sections s ON s.id = us.section_id
    JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
   WHERE us.utente_id = p_utente
     AND a.id = public.anno_attivo(s.scuola_id)
$$;

REVOKE ALL ON FUNCTION public.sezioni_visibili_docente(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sezioni_docente_anno_attivo(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sezioni_visibili_docente(uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.sezioni_docente_anno_attivo(uuid) TO service_role;
