import type { SupabaseClient } from '@supabase/supabase-js'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import { figliAttiviDi, type RigaFiglioAttivo } from '@/lib/anno/visibilita-genitore'
import { logErrore } from '@/lib/logging/logger'
import type { NewsGrado, NewsScope } from '@/lib/news/tipi'

// =============================================================================
// Targeting delle News verso i figli di un genitore.
//
// `postVisibileAiFigli` è PURA e FAIL-CLOSED: senza un figlio dalla sede
// determinabile non mostra nulla (un globale cross-sede non deve trapelare
// quando scuola_id manca sull'anagrafica). `caricaFigliConTarget` è la sola
// funzione che tocca il DB — locale a news, NON importa da avvisi (perimetro
// chiuso: il pattern di derivazione target è ricopiato, non condiviso).
//
// PR 4.4: stessa regola della policy `news_posts` di M44b
// (`20261108204853_anno_visibilita_genitore_policy.sql`). I figli vengono da
// `figli_attivi` e la classe si confronta per uuid di sezione. Il nome resta per
// lo storico (`lib/storici/adattatori/servizi-comunicazioni.ts`, che non legge gli
// uuid) e per il database senza lo schema dell'anno.
// =============================================================================

export interface PostTarget {
  scuola_id: string | null
  target_scope: NewsScope
  target_gradi: NewsGrado[] | null
  target_classes: string[] | null
  /** `undefined`: la colonna non è stata letta, e la classe si confronta per nome. `null` o vuoto: per uuid non arriva a nessuno. */
  target_section_ids?: string[] | null
}

export interface FiglioTarget {
  scuola_id: string | null
  classe_sezione: string | null
  grado: NewsGrado | null
  section_id?: string | null
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
        if (post.target_section_ids !== undefined) {
          return !!f.section_id && (post.target_section_ids ?? []).includes(f.section_id)
        }
        return !!f.classe_sezione && (post.target_classes ?? []).includes(f.classe_sezione)
      default:
        return false
    }
  })
}

/** Gli uuid delle sezioni servono al filtro, e non escono: il contratto verso il client resta quello di prima. */
export function senzaSezioniTarget<T extends { target_section_ids?: unknown }>(post: T): T {
  const copia = { ...post }
  delete copia.target_section_ids
  return copia
}

/**
 * Carica i figli di un account genitore con i campi utili al targeting: sede,
 * sezione e grado. Figli attivi per la funzione SQL; col database senza lo schema
 * dell'anno, i figli collegati di prima. Un guasto dà [] (fail-closed a monte in
 * `postVisibileAiFigli`), e la riga `error` l'ha già scritta `leggiVisibilita`.
 */
export async function caricaFigliConTarget(
  supabase: SupabaseClient,
  parentId: string,
): Promise<FiglioTarget[]> {
  const attivi = await figliAttiviDi(supabase, parentId)
  if (attivi.stato === 'guasto') return []
  if (attivi.stato === 'ok') return figliDalleFrequenze(supabase, attivi.righe)

  // Il grado si deriva dalla sezione (`sections.school_type`), con fallback su
  // `alunni.section_id`. Best-effort: su errore []. PostgREST non lancia → si
  // controlla `{ error }`.
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
    section_id: a.section_id ?? null,
  }))
}

/**
 * Un elemento per frequenza viva: `postVisibileAiFigli` guarda ciascuna con la sua sede, e il bambino vivo in due sedi vale per
 * tutte e due. Il grado che non si legge resta `null`: un post per grado non arriva, e tutto il resto sì.
 */
async function figliDalleFrequenze(supabase: SupabaseClient, righe: RigaFiglioAttivo[]): Promise<FiglioTarget[]> {
  const sezioni = [...new Set(righe.map((r) => r.section_id).filter((s): s is string => !!s))]
  const gradi = new Map<string, NewsGrado>()
  if (sezioni.length > 0) {
    const { data, error } = await supabase.from('sections').select('id, school_type').in('id', sezioni)
    if (error) logErrore({ operazione: 'news/target:sezioni', stato: 500, evento: 'news' }, error)
    for (const s of (data ?? []) as Array<{ id: string; school_type: string | null }>) {
      const grado = gradoDaTipo(s.school_type)
      if (grado) gradi.set(s.id, grado)
    }
  }
  return righe.map((r) => ({
    scuola_id: r.scuola_id,
    classe_sezione: null,
    grado: (r.section_id && gradi.get(r.section_id)) || null,
    section_id: r.section_id,
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
  return gradoDaTipo(Array.isArray(s) ? s[0]?.school_type : s?.school_type)
}

function gradoDaTipo(st: string | null | undefined): NewsGrado | null {
  if (st === 'nido' || st === 'infanzia' || st === 'primaria') return st
  return null
}
