import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Flag per-modulo «essenziale: sempre firmabile» (salute/sicurezza).
//
// Un modulo con `sempre_firmabile = true` resta firmabile anche da un genitore
// SOSPESO per morosità (matrice sospensione v2): sono i consensi che non si
// possono bloccare (autorizzazioni mediche, sicurezza). Vive su `form_models`
// (Sistema A) e `forms_templates` (Sistema B).
//
// DEGRADAZIONE (DB E2E CI non migrato): la colonna può non esistere → SELECT
// ritorna 42703. In quel caso — e per QUALUNQUE errore di lettura — si torna
// `false`: il comportamento resta quello BLOCCANTE odierno (fail-closed verso
// la sospensione), mai si apre il blocco per un guasto di lettura.
// =============================================================================

export type TabellaModulo = 'form_models' | 'forms_templates'

/** True se il modulo è flaggato «sempre firmabile». Best-effort: su qualunque
 *  errore di lettura torna false (blocco attivo). */
export async function leggiSempreFirmabile(
  supabase: SupabaseClient,
  tabella: TabellaModulo,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from(tabella)
    .select('sempre_firmabile')
    .eq('id', id)
    .maybeSingle()
  if (error) return false
  return (data as { sempre_firmabile?: boolean } | null)?.sempre_firmabile === true
}
