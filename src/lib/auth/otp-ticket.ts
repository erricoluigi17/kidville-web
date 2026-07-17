import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/email/send'
import { logEvento } from '@/lib/logging/logger'

/**
 * OTP via email a "ticket firmato" (FES), riusabile da più flussi:
 * firma moduli, giustifiche, ecc.
 *
 * Il ticket = HMAC-SHA256(secret, email:code:expiry): essendo keyed, il client
 * non può derivare il codice dal ticket né alterarne i parametri firmati. Il
 * server non deve persistere il codice: ricalcola l'HMAC in verifica.
 */

export const OTP_TTL_MS = 10 * 60 * 1000 // 10 minuti

function ticketSecret(): string {
  return (
    process.env.OTP_TICKET_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'kidville-dev-secret'
  )
}

export function makeTicket(email: string, code: string, expiry: number): string {
  return createHmac('sha256', ticketSecret()).update(`${email}:${code}:${expiry}`).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex')
    const bb = Buffer.from(b, 'hex')
    return ba.length === bb.length && timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/** Verifica scadenza + ticket. Ritorna { ok } o { ok:false, error }. */
export function verifyTicket(
  email: string,
  code: string,
  expiry: number,
  ticket: string
): { ok: true } | { ok: false; error: string } {
  if (!code || !expiry || !ticket) return { ok: false, error: 'Parametri OTP mancanti' }
  if (Date.now() > Number(expiry)) return { ok: false, error: 'Codice scaduto, richiedine uno nuovo' }
  const expected = makeTicket(email, String(code), Number(expiry))
  if (!safeEqualHex(expected, String(ticket))) return { ok: false, error: 'Codice non valido' }
  return { ok: true }
}

/** Hash non reversibile del codice, per il log di firma (FES). */
export function codeHash(email: string, code: string, expiry: number): string {
  const h = createHash('sha256').update(`${email}:${code}:${expiry}`).digest('hex')
  return `SHA256-${h.slice(0, 32).toUpperCase()}`
}

/**
 * jti dell'uso singolo: identificatore deterministico del ticket (M5).
 *
 * Deriva dal ticket via hash non reversibile: non richiede di cambiare il
 * formato del ticket né la verifica HMAC. Lo store dei jti consumati
 * (`otp_ticket_consumati`) rende il ticket usa-e-getta.
 */
export function ticketJti(ticket: string): string {
  return createHash('sha256').update(`otp-jti:${ticket}`).digest('hex')
}

/**
 * Consuma il ticket OTP (uso singolo, anti-replay M5): inserisce il jti nello
 * store `otp_ticket_consumati`. L'atomicità è garantita dalla chiave primaria —
 * la PRIMA firma inserisce, ogni replay collide (23505).
 *
 * Ritorna:
 *  - `{ ok: true }`     ticket fresco consumato (o store non ancora migrato → degrado pulito);
 *  - `{ replay: true }` ticket già usato → il chiamante risponde 409.
 *
 * DEGRADO PULITO: sul DB E2E CI (non migrato) la tabella non esiste → PostgREST
 * risponde `42P01`/`PGRST205`: si prosegue (il backstop resta l'indice unique su
 * `forms_submissions`). Un errore DB inatteso è fail-open (non blocca una firma
 * legittima), ma loggato.
 */
export async function consumeTicket(
  supabase: SupabaseClient,
  ticket: string,
  operazione: string
): Promise<{ ok: true } | { replay: true }> {
  const jti = ticketJti(ticket)
  // PostgREST non lancia: si controlla il valore di ritorno.
  const { error } = await supabase.from('otp_ticket_consumati').insert({ jti })
  if (!error) return { ok: true }

  const code = (error as { code?: string }).code ?? ''
  // Replay: jti già presente (violazione chiave primaria).
  if (code === '23505') return { replay: true }
  // Store assente sul DB E2E CI non migrato → degrado pulito.
  if (['42P01', 'PGRST205', 'PGRST204', '42703'].includes(code)) {
    logEvento('otp', 'warn', {
      operazione,
      azione: 'nonce_store_assente',
      esito: 'degradato',
      error_code: code,
    })
    return { ok: true }
  }
  // Errore DB inatteso sullo store: fail-open (il vincolo unique su
  // forms_submissions impedisce comunque la firma duplicata), ma segnalato.
  logEvento('otp', 'error', {
    operazione,
    azione: 'nonce_errore',
    esito: 'fallito',
    error_code: code,
  })
  return { ok: true }
}

export async function getUserEmail(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.from('utenti').select('email').eq('id', userId).maybeSingle()
  return data?.email ?? null
}

/**
 * Genera e invia un OTP all'email del genitore/utente. Ritorna i parametri da
 * rispedire in verifica (più devCode in sviluppo, quando non c'è provider email).
 */
export async function sendOtp(
  supabase: SupabaseClient,
  userId: string,
  opts?: { subject?: string; intro?: string }
): Promise<{ email: string; expiry: number; ticket: string; sent: boolean; devCode?: string } | { error: string }> {
  const email = await getUserEmail(supabase, userId)
  if (!email) return { error: 'Email non trovata per l’utente' }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiry = Date.now() + OTP_TTL_MS
  const ticket = makeTicket(email, code, expiry)

  const intro = opts?.intro ?? 'Il tuo codice di conferma è'
  const sent = await sendEmail({
    to: email,
    subject: opts?.subject ?? 'Codice di conferma — Kidville',
    text: `${intro}: ${code}\n\nIl codice è valido per 10 minuti.`,
  })

  return {
    email,
    expiry,
    ticket,
    sent,
    ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
  }
}
