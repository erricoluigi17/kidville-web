import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/email/send'

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
