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

// Nomi (sections.name) delle sezioni assegnate a un utente — fonte canonica
// utenti_sezioni → sections. Nessun fallback euristico: senza legami → [].
export async function nomiSezioniDiUtente(supabase: SupabaseClient, utenteId: string): Promise<string[]> {
  const { data } = await supabase
    .from('utenti_sezioni')
    .select('sections(name)')
    .eq('utente_id', utenteId)
  type Row = { sections: { name?: string | null }[] | { name?: string | null } | null }
  return [...new Set(
    ((data ?? []) as Row[]).flatMap((r) => {
      const s = r.sections
      if (!s) return []
      return (Array.isArray(s) ? s : [s]).map((x) => x.name)
    }).filter((n): n is string => Boolean(n))
  )]
}

// Sezioni di un docente filtrate per grado scolastico (es. solo 'primaria').
// Restituisce le righe sections complete (id, name, school_type, scholastic_year).
export interface SezioneInfo {
  id: string
  name: string
  school_type: 'nido' | 'infanzia' | 'primaria'
  scholastic_year?: string | null
}

export async function sezioniDiUtentePerGrado(
  supabase: SupabaseClient,
  utenteId: string,
  schoolType: 'nido' | 'infanzia' | 'primaria'
): Promise<SezioneInfo[]> {
  const ids = await sezioniDiUtente(supabase, utenteId)
  if (ids.length === 0) return []
  const { data } = await supabase
    .from('sections')
    .select('id, name, school_type')
    .in('id', ids)
    .eq('school_type', schoolType)
  return (data ?? []) as SezioneInfo[]
}

// Materie insegnate da un docente in una specifica sezione (contitolarità +
// isolamento per disciplina). Fonte: utenti_sezioni_materie.
export async function materieDiDocenteInSezione(
  supabase: SupabaseClient,
  utenteId: string,
  sectionId: string
): Promise<string[]> {
  const { data } = await supabase
    .from('utenti_sezioni_materie')
    .select('materia_id')
    .eq('utente_id', utenteId)
    .eq('section_id', sectionId)
  return (data ?? []).map(r => r.materia_id as string)
}
