import type { SupabaseClient } from '@supabase/supabase-js'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import type { NewsGrado, NewsScope } from '@/lib/news/tipi'

// =============================================================================
// Targeting delle News verso i figli di un genitore.
//
// `postVisibileAiFigli` è PURA e FAIL-CLOSED: senza un figlio dalla sede
// determinabile non mostra nulla (un globale cross-sede non deve trapelare
// quando scuola_id manca sull'anagrafica). `caricaFigliConTarget` è la sola
// funzione che tocca il DB — locale a news, NON importa da avvisi (perimetro
// chiuso: il pattern di derivazione target è ricopiato, non condiviso).
// =============================================================================

export interface PostTarget {
  scuola_id: string | null
  target_scope: NewsScope
  target_gradi: NewsGrado[] | null
  target_classes: string[] | null
}

export interface FiglioTarget {
  scuola_id: string | null
  classe_sezione: string | null
  grado: NewsGrado | null
}

/**
 * True se ALMENO un figlio (con sede determinabile) vede il post. Fail-closed:
 * un figlio senza `scuola_id` non conta; zero figli con sede → false.
 */
export function postVisibileAiFigli(post: PostTarget, figli: FiglioTarget[]): boolean {
  const conSede = (figli ?? []).filter((f) => !!f.scuola_id)
  if (conSede.length === 0) return false
  return conSede.some((f) => {
    const sedeOk = post.scuola_id == null || post.scuola_id === f.scuola_id
    if (!sedeOk) return false
    switch (post.target_scope) {
      case 'globale':
        return true
      case 'grado':
        return !!f.grado && (post.target_gradi ?? []).includes(f.grado)
      case 'classi':
        return !!f.classe_sezione && (post.target_classes ?? []).includes(f.classe_sezione)
      default:
        return false
    }
  })
}

/**
 * Carica i figli di un account genitore con i campi utili al targeting: sede,
 * sezione e grado. Il grado si deriva dalla sezione (`sections.school_type`),
 * con fallback su `alunni.section_id`. Best-effort: su errore [] (fail-closed a
 * monte in `postVisibileAiFigli`). PostgREST non lancia → si controlla `{ error }`.
 */
export async function caricaFigliConTarget(
  supabase: SupabaseClient,
  parentId: string,
): Promise<FiglioTarget[]> {
  const figliIds = await getFigliDiGenitore(supabase, parentId)
  if (figliIds.length === 0) return []

  const { data, error } = await supabase
    .from('alunni')
    .select('scuola_id, classe_sezione, section_id, sections:section_id ( school_type )')
    .in('id', figliIds)
  if (error || !data) return []

  return (data as unknown as AlunnoRow[]).map((a) => ({
    scuola_id: a.scuola_id ?? null,
    classe_sezione: a.classe_sezione ?? null,
    grado: gradoDiRiga(a),
  }))
}

type AlunnoRow = {
  scuola_id: string | null
  classe_sezione: string | null
  section_id: string | null
  sections: { school_type: string | null } | { school_type: string | null }[] | null
}

function gradoDiRiga(a: AlunnoRow): NewsGrado | null {
  const s = a.sections
  const st = Array.isArray(s) ? s[0]?.school_type : s?.school_type
  if (st === 'nido' || st === 'infanzia' || st === 'primaria') return st
  return null
}
