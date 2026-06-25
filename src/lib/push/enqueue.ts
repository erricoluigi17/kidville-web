import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Core module-agnostico per accodare notifiche bufferizzate (servizio Push P1).
//
// Inserisce una riga `notifiche` per utente con `invio_programmato_il = now +
// bufferMin`. Il dispatch effettivo (push) avviene quando il cron generico
// drena il buffer (vedi notifiche_dispatch_tick + /api/push/dispatch).
// Best-effort: gli errori non bloccano il flusso chiamante.
// =============================================================================

export interface EnqueueNotificheParams {
  utenteIds: string[]
  tipo: string
  titolo: string
  corpo?: string | null
  link?: string | null
  entitaTipo?: string | null
  entitaId?: string | null
  /** Minuti di buffer prima che la notifica sia inviabile. Default 0 (subito). */
  bufferMin?: number
}

export async function enqueueNotifiche(
  supabase: SupabaseClient,
  params: EnqueueNotificheParams
): Promise<void> {
  const utenti = [...new Set(params.utenteIds ?? [])].filter(Boolean)
  if (utenti.length === 0) return

  const programmato = new Date(Date.now() + (params.bufferMin ?? 0) * 60_000).toISOString()
  const rows = utenti.map((uid) => ({
    utente_id: uid,
    tipo: params.tipo,
    titolo: params.titolo,
    corpo: params.corpo ?? null,
    link: params.link ?? null,
    entita_tipo: params.entitaTipo ?? null,
    entita_id: params.entitaId ?? null,
    invio_programmato_il: programmato,
  }))

  try {
    await supabase.from('notifiche').insert(rows)
  } catch (err) {
    console.error('[enqueueNotifiche] insert fallito (non bloccante):', err)
  }
}
