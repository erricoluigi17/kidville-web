-- =============================================================================
-- Fix: assegna grado 'primaria' ai docenti già assegnati a sezioni primaria
-- ma privi del campo gradi. Idempotente.
-- =============================================================================

UPDATE public.utenti u
SET gradi = array_append(COALESCE(u.gradi, ARRAY[]::school_type_enum[]), 'primaria'::school_type_enum)
WHERE u.id IN (
  SELECT DISTINCT us.utente_id
  FROM public.utenti_sezioni us
  JOIN public.sections s ON s.id = us.section_id
  WHERE s.school_type = 'primaria'
)
AND NOT ('primaria'::school_type_enum = ANY(COALESCE(u.gradi, ARRAY[]::school_type_enum[])));
