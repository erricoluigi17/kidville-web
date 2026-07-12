import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { genitoriDiAlunni } from '@/lib/notifiche/destinatari'

// =============================================================================
// Wrapper unico per i trigger di notifica: toggle per scuola → risoluzione
// destinatari → debounce opzionale → enqueue (buffer + push via dispatch).
// SEMPRE best-effort: non lancia mai verso la route chiamante.
// =============================================================================

export interface NotificaEventoParams {
  /** Tipo canonico (catalogo src/lib/notifiche/tipi.ts) — decide anche il toggle. */
  tipo: string
  /** Scuola per il gate del toggle (assente = fail-open, notifica attiva). */
  scuolaId?: string | null
  /** Destinatari espliciti (id utenti)… */
  utenteIds?: string[]
  /** …e/o alunni di cui notificare i genitori (le due liste si sommano). */
  alunnoIds?: string[]
  titolo: string
  corpo?: string | null
  link?: string | null
  entitaTipo?: string | null
  entitaId?: string | null
  /** Minuti di buffer prima dell'invio push. Default 10 (finestra di modifica). */
  bufferMin?: number
  /**
   * Debounce: elimina le notifiche pending (push non ancora inviata) con lo
   * stesso tipo+entita_id prima di ri-accodare — le raffiche collassano in una.
   */
  debounce?: boolean
}

export async function notificaEvento(supabase: SupabaseClient, params: NotificaEventoParams): Promise<void> {
  try {
    if (!(await isNotificaAbilitata(supabase, params.tipo, params.scuolaId ?? null))) return

    const destinatari = new Set<string>(params.utenteIds ?? [])
    if (params.alunnoIds?.length) {
      for (const id of await genitoriDiAlunni(supabase, params.alunnoIds)) destinatari.add(id)
    }
    if (destinatari.size === 0) return

    if (params.debounce && params.entitaId) {
      try {
        await supabase
          .from('notifiche')
          .delete()
          .eq('tipo', params.tipo)
          .eq('entita_id', params.entitaId)
          .is('push_inviata_il', null)
      } catch (e) {
        console.error('[notificaEvento] debounce fallito (non bloccante):', e)
      }
    }

    await enqueueNotifiche(supabase, {
      utenteIds: [...destinatari],
      tipo: params.tipo,
      titolo: params.titolo,
      corpo: params.corpo ?? null,
      link: params.link ?? null,
      entitaTipo: params.entitaTipo ?? null,
      entitaId: params.entitaId ?? null,
      bufferMin: params.bufferMin ?? 10,
      // Il toggle è già stato verificato qui sopra (config in cache: il
      // doppio check dentro enqueueNotifiche costa zero query).
      scuolaId: params.scuolaId ?? null,
    })
  } catch (err) {
    console.error('[notificaEvento] fallita (non bloccante):', err)
  }
}

/** Nome visualizzabile di un utente ("Nome Cognome", fallback su schema legacy). */
export async function nomeUtente(supabase: SupabaseClient, utenteId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('utenti')
      .select('nome, cognome, first_name, last_name')
      .eq('id', utenteId)
      .maybeSingle()
    if (!data) return null
    const nome = [data.first_name || data.nome, data.last_name || data.cognome].filter(Boolean).join(' ').trim()
    return nome || null
  } catch {
    return null
  }
}
