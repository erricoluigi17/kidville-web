// =============================================================================
// Validazione generica dei campi di un form a partire dal suo SCHEMA.
//
// Perché esiste: il "Modulo d'iscrizione standard" dichiara nei suoi campi la
// validazione (`FormField.validation`: pattern/min_length/max_length + il
// `required` del campo) — ma finora NESSUNA superficie di compilazione la
// applicava. In produzione è così arrivata una provincia scritta per esteso
// (7 caratteri) che ha rotto l'import a valle (colonne `varchar(2)`).
//
// Questo modulo è la sorgente unica della regola di validazione, RIUSABILE sia
// dal client (wizard) sia dal server (POST /api/iscrizione): stesse regole,
// stessi messaggi, un solo posto da mantenere.
//
// I messaggi sono in ITALIANO, chiari e non tecnici: l'utente che compila il
// modulo non deve leggere una regex.
//
// NB: questo modulo NON normalizza (non converte "Napoli" → "NA"): valida e
// basta. La normalizzazione delle province è responsabilità del chiamante
// (`normalizzaProvincia` in `@/lib/anagrafiche/province`), che la esegue PRIMA
// di validare — così il valore normalizzato passa e quello irriconoscibile
// resta e fallisce il pattern.
//
// Le province, però, non si validano solo per FORMA: una sigla come "XY" o "ZZ"
// passa il pattern `^[A-Z]{2}$` ma NON è una provincia italiana reale. Perciò,
// oltre alla forma, si valida l'APPARTENENZA all'elenco reale (`isSiglaProvincia`),
// così un dato inesistente viene bloccato al primo controllo — nel wizard e nel
// POST — e non muore a valle, al pre-flight dell'import in segreteria (vicolo cieco).
// =============================================================================

import type { FormField } from '@/types/database.types'
import { isSiglaProvincia } from '@/lib/anagrafiche/province'

/** Tipi decorativi: non raccolgono un valore, non si validano mai. */
const TIPI_DECORATIVI = new Set(['section_header', 'paragraph', 'signature'])

/** Email "plausibile": non una validazione RFC completa, solo forma di base. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Data ISO `YYYY-MM-DD` (quella prodotta da `<input type="date">`). */
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Un campo è "provincia" se il suo id (eventualmente namespacizzato dal wizard,
 * es. `children.0.birth_province`) termina con `_province`.
 */
export function isProvinceField(field: FormField): boolean {
  return /_province$/i.test(field.id)
}

/** Ultimo segmento dell'id, senza il namespace `children.0.` / `adults.1.`. */
function idSemplice(id: string): string {
  const parti = id.split('.')
  return parti[parti.length - 1] ?? id
}

/** True se il valore è "vuoto" ai fini della validazione. */
function eVuoto(field: FormField, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (field.type === 'checkbox') return !Array.isArray(value) || value.length === 0
  if (field.type === 'consent') return value !== true
  return String(value).trim() === ''
}

/** Esempio da mostrare all'utente per una provincia, ricavato dal placeholder. */
function esempioProvincia(field: FormField): string {
  // placeholder tipo "Es. RM" → "RM"; fallback "NA".
  const p = (field.placeholder ?? '').replace(/^es\.?\s*/i, '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(p) ? p : 'NA'
}

/** Messaggio per un pattern fallito, scelto in base alla semantica del campo. */
function messaggioPattern(field: FormField, pattern: string): string {
  if (isProvinceField(field)) {
    return `Inserisci la sigla della provincia (es. ${esempioProvincia(field)})`
  }
  const id = idSemplice(field.id).toLowerCase()
  if (pattern === '^[0-9]{5}$' || id.includes('zip') || id.includes('cap')) {
    return 'Inserisci un CAP valido (5 cifre)'
  }
  if (id.includes('fiscal') || id.includes('codice_fiscale') || id === 'cf') {
    return 'Inserisci un codice fiscale valido (16 caratteri)'
  }
  const esempio = (field.placeholder ?? '').replace(/^es\.?\s*/i, '').trim()
  return esempio ? `Formato non valido. Esempio: ${esempio}` : 'Formato non valido'
}

/** True se `str` combacia INTERAMENTE con `pattern` (match completo). */
function combaciaPattern(str: string, pattern: string): boolean {
  try {
    const m = new RegExp(pattern).exec(str)
    // Match completo: la porzione riconosciuta deve coprire tutta la stringa.
    return m !== null && m[0] === str
  } catch {
    // Pattern non compilabile (schema malformato): non blocchiamo la compilazione
    // su una regola che non sappiamo interpretare.
    return true
  }
}

/**
 * Valida un singolo campo contro il suo schema.
 * Ritorna un messaggio d'errore in italiano, oppure `null` se il valore è valido.
 */
export function validateField(field: FormField, value: unknown): string | null {
  if (TIPI_DECORATIVI.has(field.type)) return null

  const vuoto = eVuoto(field, value)

  // 1) Obbligatorietà.
  if (field.required && vuoto) return 'Campo obbligatorio'

  // 2) Un campo facoltativo vuoto è valido: niente pattern/lunghezze sul vuoto.
  if (vuoto) return null

  // 3) Controlli per tipo (solo su valore presente).
  if (field.type === 'email' && !EMAIL_RE.test(String(value))) {
    return 'Inserisci un indirizzo email valido'
  }
  if (field.type === 'date' && !DATA_ISO_RE.test(String(value))) {
    return 'Inserisci una data valida'
  }
  if (field.type === 'number') {
    const n = Number(String(value).replace(',', '.'))
    if (!Number.isFinite(n)) return 'Inserisci un numero valido'
    if (field.validation?.min !== undefined && n < field.validation.min) {
      return `Il valore minimo è ${field.validation.min}`
    }
    if (field.validation?.max !== undefined && n > field.validation.max) {
      return `Il valore massimo è ${field.validation.max}`
    }
  }
  if ((field.type === 'select' || field.type === 'radio') && Array.isArray(field.options) && field.options.length > 0) {
    const ammessi = new Set(field.options.map((o) => o.value))
    if (!ammessi.has(String(value))) return 'Selezione non valida'
  }

  // 4) Regole dichiarate nello schema (`validation`).
  const str = String(value)
  const v = field.validation
  if (v?.pattern && !combaciaPattern(str, v.pattern)) {
    return messaggioPattern(field, v.pattern)
  }
  if (v?.min_length !== undefined && str.length < v.min_length) {
    return `Inserisci almeno ${v.min_length} caratteri`
  }
  if (v?.max_length !== undefined && str.length > v.max_length) {
    return `Inserisci al massimo ${v.max_length} caratteri`
  }

  // 5) Province: superata la FORMA, la sigla deve ESISTERE davvero. 'XY'/'ZZ'/'QQ'
  // passano il pattern ma non sono province reali → senza questo controllo
  // morirebbero solo al pre-flight dell'import, dove l'operatore non può correggere.
  // `isSiglaProvincia` è case-insensitive ('NA'/'na' → ok); un nome per esteso
  // ("Napoli") non è una sigla e resta non valido (il valore finale valido è una sigla;
  // sul client lo snap su blur e sul server la normalizzazione lo riducono PRIMA).
  if (isProvinceField(field) && !isSiglaProvincia(str)) {
    return `Sigla di provincia inesistente (es. ${esempioProvincia(field)})`
  }

  return null
}

/**
 * Valida un insieme di campi (una pagina/record) contro i valori forniti.
 * Ritorna una mappa `{ idCampo → messaggio }` con SOLO i campi non validi.
 *
 * Il chiamante decide quali campi passare: sul client si passano i soli campi
 * VISIBILI (logica condizionale); sul server si passa il template completo.
 */
export function validatePage(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields) {
    const msg = validateField(field, values[field.id])
    if (msg) out[field.id] = msg
  }
  return out
}
