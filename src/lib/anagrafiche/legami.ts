import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Risoluzione condivisa dei legami genitore(account)↔alunno.
//
// Due sorgenti storiche:
//  - `legame_genitori_alunni` (runtime): account `utenti` ↔ `alunni`, usata da
//    mensa/chat/pagamenti/primaria.
//  - `student_parents` (anagrafica/ETL): record `parents` ↔ `alunni`, collegata
//    all'account via ponte `parents.auth_user_id`.
// Possono divergere (un legame presente solo in una delle due). Questo helper fa
// l'UNIONE robusta delle due, così la risoluzione dei figli non dipende da quale
// tabella contiene il legame. È la fonte unica lato codice in vista del
// consolidamento fisico (VIEW) successivo.
// =============================================================================

/** Alunni (id) collegati a un ACCOUNT genitore (utenti.id), unione runtime+anagrafica. */
export async function getFigliDiGenitore(
  supabase: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const ids = new Set<string>();

  const { data: runtime } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId);
  for (const r of runtime ?? []) if (r.alunno_id) ids.add(r.alunno_id as string);

  // Ponte anagrafico: parents di questo account → student_parents.
  const { data: parentRows } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', accountId);
  const parentIds = (parentRows ?? []).map((p) => p.id as string);
  if (parentIds.length > 0) {
    const { data: sp } = await supabase
      .from('student_parents')
      .select('student_id')
      .in('parent_id', parentIds);
    for (const r of sp ?? []) if (r.student_id) ids.add(r.student_id as string);
  }

  return [...ids];
}

/** True se l'account genitore è collegato all'alunno (runtime O anagrafica). */
export async function genitoreHasFiglio(
  supabase: SupabaseClient,
  accountId: string,
  alunnoId: string,
): Promise<boolean> {
  // Fast-path runtime (una sola query nel caso comune).
  const { data: r } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', accountId)
    .eq('alunno_id', alunnoId)
    .maybeSingle();
  if (r) return true;
  // Fallback anagrafico.
  const figli = await getFigliDiGenitore(supabase, accountId);
  return figli.includes(alunnoId);
}
