import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { genitoriDiAlunni } from '@/lib/notifiche/destinatari'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// Wrapper unico per i trigger di notifica: toggle per scuola → risoluzione
// destinatari → debounce opzionale → enqueue (buffer + push via dispatch).
// SEMPRE best-effort: non lancia mai verso la route chiamante.
//
// "NON LANCIA MAI" NON VUOL DIRE "NON SI VEDE". Il contratto vale — un avviso non
// spedito non deve trasformare in 500 un salvataggio riuscito, e le 28 route ci
// contano — ma è precisamente per questo che qui dentro il guasto DEVE lasciare
// una riga: è l'unico posto in cui esiste. Chi sta sopra non lo vedrà mai, per
// costruzione. Prima c'erano due console.error: nessuno li redigeva, nessuno li
// leggeva, e in `app_log` non arrivava niente.
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
      // Il `try` resta, ma NON è più lui a portare il log: PostgREST non lancia, la `delete`
      // ritorna `{ error }`, e un log appeso solo al catch qui era codice morto. Il try copre
      // il guasto di trasporto e — soprattutto — garantisce che un debounce fallito non salti
      // l'enqueue qui sotto: meglio una notifica doppia che nessuna notifica.
      try {
        const { error } = await supabase
          .from('notifiche')
          .delete()
          .eq('tipo', params.tipo)
          .eq('entita_id', params.entitaId)
          .is('push_inviata_il', null)
        if (error) {
          // `warn`, non `error`: il debounce è una comodità (collassa le raffiche in una
          // notifica sola). Se salta, la notifica parte lo stesso — il destinatario ne riceve
          // una in più, non una in meno. Il risultato è salvo, il contorno è degradato.
          logEvento('notifica', 'warn', {
            operazione: 'notificaEvento',
            esito: 'debounce-fallito',
            tipo: params.tipo,
          }, error)
        }
      } catch (e) {
        logEvento('notifica', 'warn', {
          operazione: 'notificaEvento',
          esito: 'debounce-non-eseguito',
          tipo: params.tipo,
        }, e)
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
    // Qui è saltata la PREPARAZIONE della notifica (toggle, lookup dei destinatari, enqueue):
    // il messaggio non partirà, e la route chiamante — che non vede l'eccezione, per contratto —
    // risponderà 200 come se tutto fosse andato a posto. È un dato perso: livello `error`.
    // Non si rilancia (il contratto è quello, e le route ci contano): si LOGGA e si torna.
    logEvento('notifica', 'error', {
      operazione: 'notificaEvento',
      esito: 'notifica-non-accodata',
      tipo: params.tipo,
    }, err)
  }
}

/**
 * Nome visualizzabile di un utente ("Nome Cognome", fallback su schema legacy).
 *
 * Stessa malattia degli altri: `{ data }` scartava `error` e il `catch` taceva. La lettura può
 * fallire — e allora il titolo della notifica esce con il nome generico, che è un degrado
 * accettabile ma NON invisibile (regola 6: un catch che non logga è un bug).
 */
export async function nomeUtente(supabase: SupabaseClient, utenteId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('utenti')
      .select('nome, cognome, first_name, last_name')
      .eq('id', utenteId)
      .maybeSingle()
    if (error) {
      // `warn`: la notifica parte comunque, con il fallback testuale. Risultato salvo.
      logEvento('db', 'warn', {
        operazione: 'nomeUtente',
        esito: 'utente-non-letto',
      }, error)
      return null
    }
    if (!data) return null
    const nome = [data.first_name || data.nome, data.last_name || data.cognome].filter(Boolean).join(' ').trim()
    return nome || null
  } catch (e) {
    logEvento('db', 'warn', {
      operazione: 'nomeUtente',
      esito: 'utente-non-letto',
    }, e)
    return null
  }
}
