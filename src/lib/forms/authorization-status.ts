import { archiveErasurePending } from './signed-path'
import type { FormField } from '@/types/database.types'
import { logEvento } from '@/lib/logging/logger'
import { campoVisibile } from './conditional'
import { recordOf, signatureSignedAt, validSignatureEvidence, validateFrozenSignedDocument } from './signed-document'

export type AuthorizationState = 'risposta_assente' | 'firma_mancante' | 'consenso_negato_o_incompleto' | 'firma_da_verificare' | 'autorizzato' | 'risposta_ricevuta'
export interface AuthorizationStatus {
  signed: boolean
  autorizzato: boolean
  stato_autorizzazione: AuthorizationState
  signed_at: string | null
  metodo: string | null
}
export const AUTHORIZATION_LABELS: Record<AuthorizationState, string> = {
  risposta_assente: 'Risposta assente', firma_mancante: 'Firma mancante',
  consenso_negato_o_incompleto: 'Consenso negato o incompleto', firma_da_verificare: 'Firma da verificare',
  autorizzato: 'Autorizzato', risposta_ricevuta: 'Risposta ricevuta',
}

/** Una compilazione firmata prevale su una bozza; dentro ogni gruppo vince la più recente. */
export function preferredSubmission(submissions: Record<string, unknown>[]): Record<string, unknown> | null {
  const instant = (s: Record<string, unknown>) => Date.parse(signatureSignedAt(s.signature_log) ?? String(s.created_at ?? '')) || 0
  return [...submissions].sort((a, b) => Number(b.is_signed === true) - Number(a.is_signed === true) || instant(b) - instant(a) || String(a.id).localeCompare(String(b.id), 'it-IT'))[0] ?? null
}

/** Stato calcolato dal server. Il modello corrente non modifica i consensi già congelati. */
export function authorizationStatus(template: Record<string, unknown>, submission: Record<string, unknown> | null): AuthorizationStatus {
  const base: AuthorizationStatus = { signed: false, autorizzato: false, stato_autorizzazione: 'risposta_assente', signed_at: null, metodo: null }
  if (!submission) return base
  const log = recordOf(submission.signature_log)
  const signedAt = signatureSignedAt(log)
  if (archiveErasurePending(log)) return { ...base, stato_autorizzazione: 'firma_da_verificare' }
  if (template.form_type === 'gradimento' || template.form_type === 'sondaggio') {
    return { ...base, stato_autorizzazione: 'risposta_ricevuta' }
  }
  if (submission.is_signed !== true) return { ...base, stato_autorizzazione: 'firma_mancante' }
  const paper = submission.origine === 'cartaceo'
  const metodo = paper ? 'Cartaceo' : log?.method === 'OTP_EMAIL' ? 'OTP email' : log?.method === 'CONFERMA_APP' ? 'Conferma app' : null
  const unverified: AuthorizationStatus = { ...base, signed_at: signedAt, metodo, stato_autorizzazione: 'firma_da_verificare' }
  if (paper) {
    const valid = log?.method === 'PROXY_CARTACEO' && typeof log.acquisito_da === 'string' && log.acquisito_da.trim().length > 0 &&
      signedAt !== null && typeof submission.pdf_path === 'string' && submission.pdf_path.trim().length > 0
    return valid ? { ...unverified, signed: true, autorizzato: true, stato_autorizzazione: 'autorizzato' } : unverified
  }
  if (!validSignatureEvidence(log)) return unverified
  let fields = Array.isArray(template.fields) ? template.fields as FormField[] : []
  let answers = recordOf(submission.answers) ?? {}
  if (log && ('document_snapshot' in log || 'document_hash' in log)) {
    try {
      const snapshot = validateFrozenSignedDocument(submission)
      if (snapshot.school_id !== template.scuola_id) return unverified
      fields = snapshot.form.fields as FormField[]
      answers = snapshot.answers
    } catch (error) {
      logEvento('modulistica', 'warn', { operazione: 'forms/authorization-status', esito: 'firma-da-verificare', entita_id: typeof submission.id === 'string' ? submission.id : null }, error)
      return unverified
    }
  }
  const requiredConsents = fields.filter((field) => field.required === true && (field.type === 'checkbox' || field.type === 'consent') && campoVisibile(field, answers))
  const autorizzato = requiredConsents.every((field) => answers[field.id] === true)
  return { signed: true, autorizzato, stato_autorizzazione: autorizzato ? 'autorizzato' : 'consenso_negato_o_incompleto', signed_at: signedAt, metodo }
}
