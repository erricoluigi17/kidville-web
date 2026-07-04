-- P0/Step3 — Policy di LETTURA genitore (spazio parents) per le tabelle parent-facing.
--
-- ADDITIVE e DORMIENTI: vengono aggiunte sotto le policy permissive esistenti
-- (`allow_all_*`/`*_anon`), che continuano a "vincere" finché non verranno rimosse
-- (S9). Quindi NESSUN cambiamento di comportamento ora. Pre-stage del lockdown:
-- quando in S9 si droppano le permissive, queste diventano la regola effettiva.
--
-- Tutte usano l'helper SECURITY DEFINER `current_parent_student_ids()` (creato in
-- 20260721) che ritorna SOLO i figli del chiamante (`auth.uid()`).

CREATE POLICY "parent read alunni figli (parents space)"
  ON public.alunni FOR SELECT TO authenticated
  USING (id IN (SELECT public.current_parent_student_ids()));

CREATE POLICY "parent read presenze figli (parents space)"
  ON public.presenze FOR SELECT TO authenticated
  USING (alunno_id IN (SELECT public.current_parent_student_ids()));

CREATE POLICY "parent read diario figli (parents space)"
  ON public.eventi_diario FOR SELECT TO authenticated
  USING (alunno_id IN (SELECT public.current_parent_student_ids()));

-- Valutazioni: solo quelle PUBBLICATE (vincolo famiglie/O.M.).
CREATE POLICY "parent read valutazioni figli (parents space)"
  ON public.valutazioni FOR SELECT TO authenticated
  USING (alunno_id IN (SELECT public.current_parent_student_ids()) AND pubblicato = true);

CREATE POLICY "parent read note figli (parents space)"
  ON public.note_disciplinari FOR SELECT TO authenticated
  USING (alunno_id IN (SELECT public.current_parent_student_ids()));

-- Galleria: media broadcast OPPURE taggati su un proprio figlio.
CREATE POLICY "parent read galleria figli (parents space)"
  ON public.galleria_media_v2 FOR SELECT TO authenticated
  USING (
    is_broadcast = true
    OR tag_students && ARRAY(SELECT public.current_parent_student_ids())
  );

-- Rollback: DROP POLICY ... (uno per tabella, stessi nomi sopra).
