import type { SupabaseClient } from '@supabase/supabase-js'

// Fonte di verità del legame docente↔sezione: tabella utenti_sezioni
// (utenti.id ↔ sections.id). Sostituisce educator-sections.json e le mappe
// email→sezione hardcoded.

// Id degli utenti (docenti) assegnati a una sezione.
export async function docentiDiSezione(supabase: SupabaseClient, sectionId?: string | null): Promise<string[]> {
  if (!sectionId) return []
  const { data } = await supabase
    .from('utenti_sezioni')
    .select('utente_id')
    .eq('section_id', sectionId)
  return (data ?? []).map(r => r.utente_id as string)
}

// Id delle sezioni assegnate a un utente (docente).
export async function sezioniDiUtente(supabase: SupabaseClient, utenteId: string): Promise<string[]> {
  const { data } = await supabase
    .from('utenti_sezioni')
    .select('section_id')
    .eq('utente_id', utenteId)
  return (data ?? []).map(r => r.section_id as string)
}
