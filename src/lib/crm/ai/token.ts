/**
 * CRM ASSISTENTE FAMIGLIE · TOKEN.
 *
 * Il token va consegnato una sola volta. Per conservarne un riferimento si usano
 * l'impronta SHA-256 e gli ultimi quattro caratteri; il token non va nei log.
 */

import { createHash, randomBytes } from 'node:crypto'

export const PREFISSO_TOKEN = 'kvai_'
export const FORMA_TOKEN = new RegExp(`^${PREFISSO_TOKEN}[A-Za-z0-9_-]{43}$`)

export function generaToken(): { token: string; impronta: string; coda: string } {
  const token = PREFISSO_TOKEN + randomBytes(32).toString('base64url')
  return { token, impronta: improntaToken(token), coda: token.slice(-4) }
}

export function improntaToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function tokenDaRichiesta(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (header === null) return null
  // Solo lo schema Bearer è insensibile alle maiuscole; il prefisso del token è esatto.
  const token = /^Bearer (\S+)$/i.exec(header)?.[1]
  return token && FORMA_TOKEN.test(token) ? token : null
}
