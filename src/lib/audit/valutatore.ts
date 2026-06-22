import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'

// =============================================================================
// Preservazione del VALUTATORE (firma FEA / "vero valutatore").
//
// I campi che rappresentano l'autore della valutazione/firma (valutazioni.maestra_id,
// note_disciplinari.maestra_id, firme_docenti.maestra_id, scrutinio_giudizi.proposto_da)
// NON devono MAI assumere l'identità della Segreteria/Direzione. Per l'educator
// l'autore è sé stesso; per staff/segreteria l'autore deve essere un docente
// TITOLARE selezionato esplicitamente (docenteId), validato sulla sezione/materia.
// =============================================================================

/** True se l'utente è titolare/contitolare della sezione (eventualmente per materia). */
export async function isTitolareSezione(
  supabase: SupabaseClient,
  utenteId: string,
  sectionId: string,
  materiaId?: string | null,
): Promise<boolean> {
  if (materiaId) {
    const { data } = await supabase
      .from('utenti_sezioni_materie')
      .select('utente_id')
      .eq('utente_id', utenteId)
      .eq('section_id', sectionId)
      .eq('materia_id', materiaId)
      .limit(1)
    if (data && data.length) return true
  }
  const { data: us } = await supabase
    .from('utenti_sezioni')
    .select('utente_id')
    .eq('utente_id', utenteId)
    .eq('section_id', sectionId)
    .limit(1)
  return !!(us && us.length)
}

/** Primo titolare (docente) di una materia in una sezione, o null. */
export async function titolareDiMateria(
  supabase: SupabaseClient,
  sectionId: string,
  materiaId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('utenti_sezioni_materie')
    .select('utente_id')
    .eq('section_id', sectionId)
    .eq('materia_id', materiaId)
    .limit(1)
  return data && data.length ? (data[0].utente_id as string) : null
}

/**
 * Determina l'identità del valutatore (firma/autore) da scrivere su una entità
 * valutativa. educator → sé stesso. staff/segreteria → docente TITOLARE indicato
 * in `docenteId`, validato su sezione (ed eventualmente materia); 422 se mancante
 * o non valido (mai forgiare la firma sulla Segreteria).
 */
export async function risolviValutatore(
  supabase: SupabaseClient,
  attore: AppUser,
  sectionId: string,
  opts: { docenteId?: string | null; materiaId?: string | null } = {},
): Promise<{ valutatoreId: string; response?: undefined } | { valutatoreId?: undefined; response: NextResponse }> {
  if (attore.role === 'educator') {
    return { valutatoreId: attore.id }
  }
  const docenteId = opts.docenteId
  if (!docenteId) {
    return {
      response: NextResponse.json(
        { error: 'Seleziona il docente titolare: la firma/valutazione deve restare del docente, non della Segreteria.' },
        { status: 422 },
      ),
    }
  }
  const ok = await isTitolareSezione(supabase, docenteId, sectionId, opts.materiaId)
  if (!ok) {
    return {
      response: NextResponse.json(
        { error: 'Il docente selezionato non è titolare/contitolare di questa classe.' },
        { status: 422 },
      ),
    }
  }
  return { valutatoreId: docenteId }
}
