// Tipi pubblici del servizio FEA in-house (DL-001).
// FEA realizzata in-house: OTP email + identità da sessione + ricevuta
// inattaccabile (SHA-256/IP/UA/timestamp) + audit immutabile.

/** Metodo di firma usato per produrre l'evidenza FES. */
export type SignatureMethod = 'OTP_EMAIL' | 'CONFERMA_APP'

/**
 * Forma canonica del log di firma (signature_log) — superset retro-compatibile
 * dei tre flussi storici (pagella/giustifica usano `timestamp`; forms usa
 * `user_agent`). `signed_at` e `timestamp` sono sempre valorizzati allo stesso
 * ISO per non rompere i lettori esistenti.
 */
export interface SignatureLog {
  method: SignatureMethod
  provider: string
  email: string
  ip: string
  user_agent: string
  signed_at: string
  timestamp: string
  /** Hash non reversibile del codice OTP (assente per CONFERMA_APP). */
  hash?: string
  compliance: string
}

/** Policy di completamento firma documenti (DL-007). */
export type CompletionPolicy = 'any-one' | 'all-required'

/** Slot firmatario (1 riga per firmatario su `fea_signatures`). */
export interface SignerSlot {
  entita_tipo: string
  entita_id: string
  slot_index: number
  signer_user_id: string | null
  stato: 'pending' | 'signed'
  completion_policy: CompletionPolicy
  signature_log: SignatureLog | null
  firmato_il: string | null
}

/** Dati per costruire la ricevuta di firma inattaccabile (PDF). */
export interface ReceiptPayload {
  title: string
  entitaTipo: string
  entitaId: string
  schoolName?: string
  signer: { name?: string | null; email: string }
  signature: SignatureLog
  /** Contenuto firmato: entra nell'hash documentale (prova di inattaccabilità). */
  documentPayload: unknown
  /** Slot firmatari (firma congiunta): se >1 viene stampata la tabella firme. */
  slots?: SignerSlot[]
}
