import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeTicket } from '@/lib/auth/otp-ticket'
import { schemaAssente } from '@/lib/news/schema-assente'

// =============================================================================
// Cancellazione account via risorsa web PUBBLICA (C5 §1 — Google Play Data safety).
//
// A differenza del percorso in-app (genitore autenticato), qui l'identità non è
// nota: la si prova per POSSESSO DELLA CASELLA, con un magic-link firmato. Si
// riusano le primitive HMAC di `otp-ticket.ts` (makeTicket/verifyTicket/
// consumeTicket) — nessuna nuova crittografia — adattandole all'EMAIL invece che
// a uno userId autenticato.
//
// La pagina non cancella nulla: registra una richiesta `pending` (canale
// 'pubblico_email') che la Direzione evade da /admin/gdpr, esattamente come il
// percorso in-app.
// =============================================================================

/**
 * TTL del magic-link di conferma. Un link cliccabile via email è più adatto di
 * un OTP da ritrascrivere a un utente che potrebbe non avere più l'app: 1 ora è
 * un compromesso fra usabilità (tempo di aprire la mail) e finestra d'attacco —
 * e il link comunque non cancella niente, apre solo una richiesta lavorabile.
 */
export const CANCELLAZIONE_LINK_TTL_MS = 60 * 60 * 1000 // 1 ora

export interface TicketCancellazione {
  code: string
  expiry: number
  ticket: string
}

/**
 * Crea il ticket firmato per la conferma via email. `code` è un nonce casuale ad
 * alta entropia (128 bit), non un OTP da digitare: viaggia nel magic-link insieme
 * al `ticket`, che è HMAC(secret, email:code:expiry) e lega l'email — cambiarla
 * invalida la verifica. Senza il segreto il ticket non è forgiabile.
 */
export function creaTicketCancellazione(email: string, now: number = Date.now()): TicketCancellazione {
  const code = randomBytes(16).toString('hex')
  const expiry = now + CANCELLAZIONE_LINK_TTL_MS
  const ticket = makeTicket(email, code, expiry)
  return { code, expiry, ticket }
}

/**
 * Costruisce il link pubblico di conferma. L'email è un parametro FIRMATO dal
 * ticket (non un segreto): compare in chiaro nel link, ma il link va solo alla
 * casella che quell'email identifica.
 */
export function costruisciLinkConferma(params: {
  baseUrl: string
  email: string
  code: string
  expiry: number
  ticket: string
}): string {
  const u = new URL('/cancellazione-account/conferma', params.baseUrl)
  u.searchParams.set('email', params.email)
  u.searchParams.set('code', params.code)
  u.searchParams.set('expiry', String(params.expiry))
  u.searchParams.set('ticket', params.ticket)
  return u.toString()
}

export interface GenitoreRisolto {
  parentId: string
  scuolaId: string | null
}

export interface RisoluzioneGenitore {
  /** Il genitore NON anonimizzato che corrisponde all'email, o null se non esiste. */
  genitore: GenitoreRisolto | null
  /** Errore DB INATTESO (né schema assente né nessun match): il chiamante logga e risponde 500. */
  error: unknown
}

/**
 * Risolve un genitore NON anonimizzato dall'email.
 *
 * Usata sia dal POST iniziale (dove la risposta è generica per anti-enumerazione:
 * `genitore` null → nessuna email inviata, ma stessa risposta 200) sia dalla
 * conferma. NON rivela nulla di per sé: si limita a mappare email → parent.
 *
 * PostgREST non lancia: si controlla `{ error }`. Uno schema assente (DB E2E CI
 * non migrato) degrada a "nessun genitore"; un errore inatteso viene PROPAGATO
 * al chiamante, che lo logga.
 *
 * L'email si confronta case-insensitive (ILIKE) con i metacaratteri LIKE (%, _, \)
 * neutralizzati, e con un RICONTROLLO ESATTO lato JS che scarta ogni falso
 * positivo residuo del wildcard.
 */
export async function risolviGenitorePerEmail(
  admin: SupabaseClient,
  email: string,
): Promise<RisoluzioneGenitore> {
  const norm = email.trim().toLowerCase()
  if (!norm) return { genitore: null, error: null }

  // Escape dei metacaratteri di ILIKE così il pattern è un match esatto
  // case-insensitive e non un wildcard (`_`/`%` matcherebbero altre righe).
  const pattern = norm.replace(/([\\%_])/g, '\\$1')

  const { data: utenti, error: errU } = await admin
    .from('utenti')
    .select('id, email, scuola_id')
    .ilike('email', pattern)
    .limit(10)
  if (errU) {
    if (schemaAssente(errU)) return { genitore: null, error: null }
    return { genitore: null, error: errU }
  }

  // Ricontrollo esatto lato JS: elimina i falsi positivi del wildcard ILIKE.
  const utente = (utenti ?? []).find(
    (u) => typeof (u as { email?: unknown }).email === 'string' &&
      ((u as { email: string }).email).toLowerCase() === norm,
  ) as { id: string; scuola_id: string | null } | undefined
  if (!utente) return { genitore: null, error: null }

  const { data: parent, error: errP } = await admin
    .from('parents')
    .select('id, anonimizzato_il')
    .eq('id', utente.id)
    .maybeSingle()
  if (errP) {
    if (schemaAssente(errP)) return { genitore: null, error: null }
    return { genitore: null, error: errP }
  }
  if (!parent || (parent as { anonimizzato_il?: unknown }).anonimizzato_il) {
    return { genitore: null, error: null }
  }

  return { genitore: { parentId: utente.id, scuolaId: utente.scuola_id ?? null }, error: null }
}
