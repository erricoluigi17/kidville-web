import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Obiettivi di apprendimento disponibili per una valutazione in itinere.
//
// Sorgente unica di verità del filtro (scuola_id, materia_codice, livello) usata
// SIA dall'endpoint che popola il selettore docente (/api/primaria/obiettivi)
// SIA dall'enforcement "valutazione legata a ≥1 obiettivo" (DL-015) nella POST
// valutazioni: i due DEVONO usare lo stesso filtro, altrimenti l'enforcement
// bloccherebbe materie/livelli per cui il selettore non mostra alcun obiettivo.
// =============================================================================

export interface ObiettivoRow {
  id: string
  codice: string | null
  descrizione: string
  livello: number
}

/** Livello (1-5) dedotto dal nome sezione (es. "3A" → 3). */
export function livelloDaSezioneName(name?: string | null): number | null {
  const m = name?.match(/[1-5]/)
  return m ? Number(m[0]) : null
}

/**
 * Obiettivi attivi per la materia (e livello dedotto dalla sezione, se passata).
 * Ritorna [] se la scuola non ha configurato obiettivi per quella materia/livello.
 */
export async function obiettiviDisponibili(
  supabase: SupabaseClient,
  materia: { codice: string; scuola_id: string },
  sectionId?: string | null,
): Promise<ObiettivoRow[]> {
  let livello: number | null = null
  if (sectionId) {
    const { data: sez } = await supabase.from('sections').select('name').eq('id', sectionId).single()
    livello = livelloDaSezioneName(sez?.name)
  }

  let q = supabase
    .from('obiettivi_apprendimento')
    .select('id, codice, descrizione, livello')
    .eq('scuola_id', materia.scuola_id)
    .eq('materia_codice', materia.codice)
    .eq('attivo', true)
    .order('codice')
  if (livello) q = q.eq('livello', livello)

  const { data } = await q
  return (data ?? []) as ObiettivoRow[]
}
