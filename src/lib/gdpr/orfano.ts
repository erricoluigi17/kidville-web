import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * True se il genitore ha ALMENO un altro figlio ancora iscritto (≠ alunno escluso
 * e non anonimizzato). Usato dall'oblio per decidere se anonimizzare il genitore
 * (solo se "orfano": nessun figlio iscritto residuo).
 */
export async function parentHaAltriFigliIscritti(
  supabase: SupabaseClient,
  parentId: string,
  excludeAlunnoId: string
): Promise<boolean> {
  const { data: links } = await supabase
    .from('student_parents')
    .select('student_id')
    .eq('parent_id', parentId)
  const altri = (links ?? [])
    .map((l: { student_id: string }) => l.student_id)
    .filter((sid: string) => sid !== excludeAlunnoId)
  if (altri.length === 0) return false

  const { data: figli } = await supabase
    .from('alunni')
    .select('id, stato, anonimizzato_il')
    .in('id', altri)
  return (figli ?? []).some(
    (f: { stato: string | null; anonimizzato_il: string | null }) =>
      f.stato === 'iscritto' && !f.anonimizzato_il
  )
}
