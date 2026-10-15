import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { logEvento } from '@/lib/logging/logger'
import { erroreQueryStorico } from './db'

/** Archivio applicativo degli originali: non è app_log e non ne modifica la redazione. */
export async function conservaRevisione(db: SupabaseClient, input: {
  attore: AppUser; scuolaId: string; alunnoId?: string | null; sectionId?: string | null
  modulo: string; entitaId: string; giornoCompetenza: string; contenuto: unknown
}): Promise<void> {
  const { error } = await db.from('storici_revisioni').insert({
    scuola_id: input.scuolaId, alunno_id: input.alunnoId ?? null, section_id: input.sectionId ?? null,
    attore_id: input.attore.id, modulo: input.modulo, entita_id: input.entitaId,
    giorno_competenza: input.giornoCompetenza, contenuto: input.contenuto,
  })
  if (error) {
    logEvento('registro', 'error', { operazione: 'storici/conserva-revisione', esito: 'originale-non-conservato', entita_id: input.entitaId }, error)
    erroreQueryStorico('conserva-revisione', error)
  }
  logEvento('registro', 'info', { operazione: 'storici/conserva-revisione', esito: 'originale-conservato', entita_id: input.entitaId })
}
