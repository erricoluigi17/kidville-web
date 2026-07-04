import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'

// =============================================================================
// Audit delle scritture sulle funzioni docente (diff prima/dopo).
//
// Ogni scrittura (docente o segreteria/direzione) registra autore, plesso,
// classe, entità, azione e il valore PRIMA/DOPO in `audit_scritture_docente`.
// È un log immodificabile (RLS: solo INSERT/SELECT). L'enforcement resta
// applicativo (client service-role), come nel resto della codebase.
//
// Best-effort: un errore di audit NON deve mai far fallire la scrittura
// principale → tutto incapsulato in try/catch silenzioso.
// =============================================================================

export type AzioneScrittura = 'insert' | 'update' | 'delete'

export interface LogScritturaInput {
  /** Chi sta scrivendo (da requireDocente: auth.user). */
  attore: AppUser
  /** Tipo entità: 'presenze' | 'registro' | 'valutazione' | 'nota' | 'scrutinio' | 'fascicolo' | 'diario' | 'armadietto' | 'task' | 'avviso' ... */
  entitaTipo: string
  entitaId?: string | null
  azione: AzioneScrittura
  scuolaId?: string | null
  sectionId?: string | null
  /** Stato precedente (null per insert). */
  valorePrima?: unknown
  /** Stato successivo (null per delete). */
  valoreDopo?: unknown
}

/**
 * Registra una scrittura nell'audit. Non lancia mai: in caso di errore logga e
 * prosegue, così l'operazione utente non viene compromessa.
 */
export async function logScrittura(
  supabase: SupabaseClient,
  input: LogScritturaInput,
): Promise<void> {
  try {
    await supabase.from('audit_scritture_docente').insert({
      attore_id: input.attore.id,
      attore_ruolo: input.attore.role ?? null,
      scuola_id: input.scuolaId ?? input.attore.scuola_id ?? null,
      section_id: input.sectionId ?? null,
      entita_tipo: input.entitaTipo,
      entita_id: input.entitaId ?? null,
      azione: input.azione,
      valore_prima: (input.valorePrima ?? null) as never,
      valore_dopo: (input.valoreDopo ?? null) as never,
    })
  } catch (err) {
    console.error('[audit_scritture_docente] log fallito (non bloccante):', err)
  }
}
