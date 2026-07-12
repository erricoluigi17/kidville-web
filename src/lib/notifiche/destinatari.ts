import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Risoluzione destinatari per le notifiche (id utenti). Tutte le funzioni sono
// best-effort: su errore tornano [] (la notifica semplicemente non parte).
// Fonte genitori: legame_genitori_alunni (mai utenti.scuola_id, non affidabile
// per i genitori). Fonte docenti: utenti_sezioni.
// =============================================================================

/** Genitori collegati agli alunni dati (distinti). */
export async function genitoriDiAlunni(supabase: SupabaseClient, alunnoIds: string[]): Promise<string[]> {
  if (!alunnoIds || alunnoIds.length === 0) return []
  try {
    const { data } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id')
      .in('alunno_id', alunnoIds)
    return [...new Set((data ?? []).map((l) => l.genitore_id as string).filter(Boolean))]
  } catch {
    return []
  }
}

/** Genitori degli alunni iscritti delle classi date (alunni.classe_sezione). */
export async function genitoriDiClassi(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  classi: string[],
): Promise<string[]> {
  if (!classi || classi.length === 0) return []
  try {
    let q = supabase.from('alunni').select('id').in('classe_sezione', classi)
    if (scuolaId) q = q.eq('scuola_id', scuolaId)
    const { data } = await q
    return genitoriDiAlunni(supabase, (data ?? []).map((a) => a.id as string))
  } catch {
    return []
  }
}

/** Genitori di tutti gli alunni della scuola (avvisi a scope globale). */
export async function genitoriDiScuola(supabase: SupabaseClient, scuolaId: string | null | undefined): Promise<string[]> {
  if (!scuolaId) return []
  try {
    const { data } = await supabase.from('alunni').select('id').eq('scuola_id', scuolaId)
    return genitoriDiAlunni(supabase, (data ?? []).map((a) => a.id as string))
  } catch {
    return []
  }
}

/**
 * Staff della scuola con uno dei ruoli dati (schema legacy doppio: il ruolo può
 * stare su `role` O `ruolo` — stesso pattern di panic-alert e mensa).
 */
export async function staffScuola(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  ruoli: string[],
): Promise<string[]> {
  if (!scuolaId || ruoli.length === 0) return []
  try {
    const ammessi = new Set(ruoli)
    const { data } = await supabase.from('utenti').select('id, role, ruolo').eq('scuola_id', scuolaId)
    return (data ?? [])
      .filter((u) => ammessi.has((u.role as string) ?? '') || ammessi.has((u.ruolo as string) ?? ''))
      .map((u) => u.id as string)
  } catch {
    return []
  }
}

/** L'altro partecipante di un thread chat (genitore ↔ docente). */
export async function controparteThread(
  supabase: SupabaseClient,
  threadId: string,
  senderId: string,
): Promise<{ utenteId: string; versoGenitore: boolean } | null> {
  try {
    const { data } = await supabase
      .from('chat_threads')
      .select('teacher_id, parent_id')
      .eq('id', threadId)
      .maybeSingle()
    if (!data) return null
    if (senderId === data.teacher_id && data.parent_id) return { utenteId: data.parent_id as string, versoGenitore: true }
    if (senderId === data.parent_id && data.teacher_id) return { utenteId: data.teacher_id as string, versoGenitore: false }
    return null
  } catch {
    return null
  }
}
