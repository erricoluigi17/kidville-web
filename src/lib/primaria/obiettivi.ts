import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

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
 * Ritorna [] se la scuola non ha configurato obiettivi per quella materia/livello
 * — e anche se la lettura FALLISCE, contratto storico di POST valutazioni e
 * /api/primaria/obiettivi. Il guasto però si logga: il filtro sta in un punto
 * solo, `leggiObiettiviDisponibili`, e questa è solo la sua forma «vuoto se
 * fallisce».
 */
export async function obiettiviDisponibili(
  supabase: SupabaseClient,
  materia: { codice: string; scuola_id: string },
  sectionId?: string | null,
): Promise<ObiettivoRow[]> {
  const r = await leggiObiettiviDisponibili(supabase, materia, sectionId)
  if (!r.ok) {
    logEvento('db', 'error', { operazione: 'primaria/obiettivi-disponibili', esito: 'obiettivi-non-letti' }, r.error)
    return []
  }
  return r.righe
}

export type LetturaObiettivi = { ok: true; righe: ObiettivoRow[] } | { ok: false; error: unknown }

/**
 * IL filtro (unico: `obiettiviDisponibili` lo avvolge). Una lettura FALLITA non
 * si confonde con «nessun obiettivo configurato»: per chi SCRIVE i collegamenti
 * (PATCH valutazioni) quel vuoto finto vorrebbe dire lasciare i collegamenti
 * com'erano e rispondere 200 — la modifica persa senza che nessuno lo sappia.
 * Il chiamante decide come loggare e cosa rispondere.
 */
export async function leggiObiettiviDisponibili(
  supabase: SupabaseClient,
  materia: { codice: string; scuola_id: string },
  sectionId?: string | null,
): Promise<LetturaObiettivi> {
  let livello: number | null = null
  if (sectionId) {
    const { data: sez, error: sezErr } = await supabase.from('sections').select('name').eq('id', sectionId).maybeSingle()
    if (sezErr) return { ok: false, error: sezErr }
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

  const { data, error } = await q
  if (error) return { ok: false, error }
  return { ok: true, righe: (data ?? []) as ObiettivoRow[] }
}
