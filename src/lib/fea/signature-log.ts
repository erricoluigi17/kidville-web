import type { SignatureMethod, SignatureLog } from './types'

const COMPLIANCE = 'CAD Art. 20 / DPR 445/2000'

const PROVIDER: Record<SignatureMethod, string> = {
  OTP_EMAIL: 'Firma OTP via email (FES)',
  CONFERMA_APP: 'Conferma in app (OTP disattivato dalle impostazioni scuola)',
}

export interface BuildSignatureLogInput {
  method: SignatureMethod
  email: string
  ip: string
  userAgent?: string
  /** Hash OTP (codeHash). Obbligatorio per OTP_EMAIL, assente per CONFERMA_APP. */
  hash?: string
  /** ISO della firma; default `now`. Iniettabile per determinismo nei test. */
  signedAt?: string
}

/**
 * Costruisce il log di firma canonico (D1). Centralizza la forma che prima era
 * duplicata in pagella/firma, presenze/giustifica e parent/forms/otp.
 */
export function buildSignatureLog(input: BuildSignatureLogInput): SignatureLog {
  const at = input.signedAt ?? new Date().toISOString()
  const log: SignatureLog = {
    method: input.method,
    provider: PROVIDER[input.method],
    email: input.email,
    ip: input.ip,
    user_agent: input.userAgent ?? 'N.D.',
    signed_at: at,
    timestamp: at,
    compliance: COMPLIANCE,
  }
  if (input.hash) log.hash = input.hash
  return log
}

/**
 * Estrae IP (primo hop di x-forwarded-for) e User-Agent dalla request.
 * Sostituisce il parsing duplicato `headers.get('x-forwarded-for')…` nelle route.
 */
export function extractRequestMeta(request: Request): { ip: string; userAgent: string } {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'N.D.'
  const userAgent = request.headers.get('user-agent')?.trim() || 'N.D.'
  return { ip, userAgent }
}
