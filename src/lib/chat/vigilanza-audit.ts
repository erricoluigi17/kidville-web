/**
 * VIGILANZA CHAT — il registro di chi ha letto le conversazioni altrui.
 *
 * La supervisione delle conversazioni genitore↔insegnante (`/admin/messaggi`,
 * scheda «Tutti i messaggi») è **silenziosa per decisione del titolare**
 * (2026-09-09): i due interlocutori non vedono nulla, nessun avviso in chat.
 * In cambio, ogni lettura lascia una riga qui, e il registro lo legge SOLO la
 * Direzione (`admin`, `coordinator`) — non la segreteria, che è la parte
 * sorvegliata. Nessuna esenzione: anche le letture della Direzione ci finiscono.
 *
 * ─── PERCHÉ NON È BEST-EFFORT COME `logAccessoFascicolo` ─────────────────────
 * `logAccessoFascicolo` (`src/lib/primaria/fascicolo-rbac.ts:108`) inghiotte
 * ogni errore, e ha ragione: bloccare un'insegnante che apre un PEI durante un
 * colloquio sarebbe peggio del buco. Qui il compromesso è rovesciato. La
 * vigilanza è invisibile ai sorvegliati, e questa riga è l'UNICO contrappeso:
 * una lettura non tracciata è esattamente la cosa che non deve esistere. Quindi
 * questa funzione non decide — RIFERISCE se ha tracciato, e la route sceglie.
 * `admin/chat/messages:GET` sceglie di non far uscire il contenuto.
 *
 * ─── L'UNICA ECCEZIONE: LO SCHEMA ASSENTE ───────────────────────────────────
 * Il DB E2E della CI non è migrato. Se la tabella non c'è (42P01/PGRST205) si
 * ritorna `tracciato: true` e si va avanti: altrimenti la CI diventerebbe rossa
 * su una funzione che in produzione funziona. È la stessa degradazione di
 * `assertConversazioneNonSospesa`.
 *
 * ─── PRIVACY ────────────────────────────────────────────────────────────────
 * `termine` (la parola cercata) e `user_agent` finiscono in TABELLA e MAI in un
 * log. Non ci si appoggia alla lista bianca di `redact`: non si passano proprio.
 * Nella riga di log entrano solo uuid ed enumerati — quel che serve a sapere
 * QUALE accesso è rimasto non tracciato, non cosa contenesse.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'

export type AzioneVigilanza = 'lettura' | 'ricerca'
export type EsitoVigilanza = 'ok' | 'fuori-scope'

export interface AccessoVigilanza {
  operatore: AppUser
  azione: AzioneVigilanza
  /** Presente per `lettura`; assente per `ricerca`, che non ha un thread solo. */
  threadId?: string | null
  alunnoId?: string | null
  /** Sede del bambino AL MOMENTO della lettura: si scrive, non si deduce dopo. */
  scuolaId?: string | null
  /** Quanti messaggi ha effettivamente visto (o quanti risultati ha avuto). */
  nMessaggi?: number | null
  /** Solo per `ricerca`: la parola cercata. In tabella sì, nei log MAI. */
  termine?: string | null
  esito?: EsitoVigilanza
  request?: Request
}

/**
 * Scrive una riga nel registro. Ritorna `{ tracciato: false }` SOLO quando la
 * scrittura è fallita per un motivo vero: chi chiama deve decidere cosa farne.
 */
export async function registraAccessoVigilanza(
  supabase: SupabaseClient,
  opts: AccessoVigilanza,
): Promise<{ tracciato: boolean }> {
  try {
    const ip = opts.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
    const userAgent = opts.request?.headers.get('user-agent') || null

    // PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo un
    // registro rifiutato sparirebbe in silenzio — cioè il difetto che questa
    // funzione esiste per chiudere.
    const { error } = await supabase.from('chat_vigilanza_accessi').insert({
      operatore_id: opts.operatore.id,
      operatore_ruolo: opts.operatore.role,
      azione: opts.azione,
      esito: opts.esito ?? 'ok',
      thread_id: opts.threadId ?? null,
      alunno_id: opts.alunnoId ?? null,
      scuola_id: opts.scuolaId ?? null,
      n_messaggi: opts.nMessaggi ?? null,
      termine: opts.termine ?? null,
      ip,
      user_agent: userAgent,
    })

    if (!error) return { tracciato: true }
    // Tabella assente (DB E2E della CI non migrato): non è un guasto, è un
    // ambiente. Si va avanti, altrimenti la CI è rossa su codice sano.
    if (schemaAssente(error)) return { tracciato: true }
    segnalaVigilanzaNonTracciata(opts, error)
    return { tracciato: false }
  } catch (err) {
    segnalaVigilanzaNonTracciata(opts, err)
    return { tracciato: false }
  }
}

/**
 * A log vanno SOLO l'azione, l'esito e gli uuid. Restano fuori `termine` (testo
 * scritto dall'operatore), `user_agent` e `ip`: serve sapere QUALE accesso non è
 * stato registrato, non ricostruirne il contenuto altrove.
 */
function segnalaVigilanzaNonTracciata(opts: AccessoVigilanza, err: unknown): void {
  logEvento(
    'chat',
    'error',
    {
      operazione: 'registraAccessoVigilanza',
      azione: opts.azione,
      esito: 'vigilanza-non-tracciata',
      thread_id: opts.threadId ?? null,
      operatore_id: opts.operatore.id,
    },
    err,
  )
}
