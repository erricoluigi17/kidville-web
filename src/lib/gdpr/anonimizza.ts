import { createHash } from 'crypto'

// Diritto all'oblio (DL-034). Helper PURI per l'anonimizzazione: producono i
// patch di update PII (nessuna DELETE) e la validazione della doppia conferma.

/** Placeholder deterministico per un campo identificativo sovrascritto. */
export function placeholderFor(id: string): string {
  const h = createHash('sha256').update(String(id)).digest('hex').slice(0, 8).toUpperCase()
  return `CANCELLATO-${h}`
}

/**
 * Patch di anonimizzazione per `alunni`: l'identità è sostituita con placeholder,
 * le PII sensibili azzerate, e si marca `anonimizzato_il`.
 */
export function patchAlunno(id: string, at: string): Record<string, unknown> {
  const ph = placeholderFor(id)
  return {
    nome: ph,
    cognome: ph,
    codice_fiscale: null,
    fiscal_code: null,
    note_mediche: null,
    allergies: null,
    allergeni: null,
    residence_address: null,
    residence_city: null,
    zip_code: null,
    birth_city: null,
    birth_province: null,
    birth_nation: null,
    documento_path: null,
    invoice_holder_details: null,
    intestatario_fatture: null,
    retta_split_config: null,
    anonimizzato_il: at,
  }
}

/** Patch di anonimizzazione per `parents`: PII azzerate + auth sganciato. */
export function patchParent(id: string, at: string): Record<string, unknown> {
  const ph = placeholderFor(id)
  return {
    first_name: ph,
    last_name: ph,
    fiscal_code: null,
    emails: null,
    phone_numbers: null,
    residence_address: null,
    residence_city: null,
    zip_code: null,
    birth_city: null,
    birth_province: null,
    birth_nation: null,
    document_number: null,
    documento_path: null,
    auth_user_id: null, // sgancia l'accesso del genitore cancellato
    anonimizzato_il: at,
  }
}

/**
 * Bonifica dei `suggerimenti` di un movimento di riconciliazione: rimuove da ogni
 * elemento il campo `label` (= «Nome Cognome» dell'alunno, unico dato identificante
 * dentro il JSON), preservando i campi tecnici (pagamento_id, score, motivi, cf_match…).
 * Usato dal diritto all'oblio (DL-034) per bonificare i movimenti confermati collegati
 * all'alunno anonimizzato. Input non-array (null/oggetto) → `null` (niente da scrubbare).
 */
export function scrubSuggerimenti(suggerimenti: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(suggerimenti)) return null
  return suggerimenti.map((s) => {
    if (!s || typeof s !== 'object') return s as Record<string, unknown>
    const clone: Record<string, unknown> = { ...(s as Record<string, unknown>) }
    delete clone.label
    return clone
  })
}

/** Nominativo atteso per la doppia conferma: `COGNOME NOME` normalizzato. */
export function nomeConferma(alunno: { nome?: string | null; cognome?: string | null }): string {
  return `${(alunno.cognome ?? '').trim()} ${(alunno.nome ?? '').trim()}`.trim().toUpperCase()
}

/** Confronto della conferma digitata col nominativo, insensibile a maiuscole/spazi. */
export function confermaValida(input: unknown, alunno: { nome?: string | null; cognome?: string | null }): boolean {
  if (typeof input !== 'string' || input.trim().length === 0) return false
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase()
  return norm(input) === norm(nomeConferma(alunno))
}
