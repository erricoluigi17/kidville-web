import type { FormField } from '@/types/database.types'

/**
 * Template prestampato per l'iscrizione di nuovi alunni.
 *
 * Ogni FormField ha `id` = nome colonna DB di destinazione (senza prefisso tabella),
 * così i dati raccolti sono già pronti per l'import:
 *   - CHILD_FIELDS  → tabella `alunni`
 *   - ADULT_FIELDS  → tabella `adults`
 * `db_mapping` resta valorizzato (table.column) per riferimento/ETL.
 */

const CF_PATTERN = '^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$'
const CAP_PATTERN = '^[0-9]{5}$'
const PROV_PATTERN = '^[A-Z]{2}$'

// ── Campi ALUNNO (→ alunni) ────────────────────────────────────
export const CHILD_FIELDS: FormField[] = [
  { id: 'nome', type: 'text', label: 'Nome', required: true, db_mapping: 'alunni.nome', placeholder: 'Es. Marco', validation: { min_length: 2, max_length: 50 } },
  { id: 'cognome', type: 'text', label: 'Cognome', required: true, db_mapping: 'alunni.cognome', placeholder: 'Es. Rossi', validation: { min_length: 2, max_length: 50 } },
  { id: 'gender', type: 'select', label: 'Sesso', required: true, db_mapping: 'alunni.gender', options: [{ label: 'Maschio', value: 'M' }, { label: 'Femmina', value: 'F' }] },
  { id: 'data_nascita', type: 'date', label: 'Data di Nascita', required: true, db_mapping: 'alunni.data_nascita' },
  { id: 'codice_fiscale', type: 'text', label: 'Codice Fiscale', required: true, db_mapping: 'alunni.codice_fiscale', placeholder: 'Es. RSSMRC99A01H501Z', validation: { pattern: CF_PATTERN, min_length: 16, max_length: 16 } },
  { id: 'birth_city', type: 'text', label: 'Comune di Nascita', required: false, db_mapping: 'alunni.birth_city', placeholder: 'Es. Roma', validation: { max_length: 100 } },
  { id: 'birth_province', type: 'text', label: 'Provincia di Nascita', required: false, db_mapping: 'alunni.birth_province', placeholder: 'Es. RM', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
  { id: 'residence_address', type: 'text', label: 'Indirizzo di Residenza', required: false, db_mapping: 'alunni.residence_address', placeholder: 'Es. Via Roma, 1', validation: { max_length: 200 } },
  { id: 'residence_city', type: 'text', label: 'Comune di Residenza', required: false, db_mapping: 'alunni.residence_city', placeholder: 'Es. Roma', validation: { max_length: 100 } },
  { id: 'zip_code', type: 'text', label: 'CAP', required: false, db_mapping: 'alunni.zip_code', placeholder: 'Es. 00100', validation: { pattern: CAP_PATTERN, min_length: 5, max_length: 5 } },
  { id: 'allergies', type: 'textarea', label: 'Allergie / Intolleranze', required: false, db_mapping: 'alunni.allergies', placeholder: 'Descrivi eventuali allergie o intolleranze alimentari', validation: { max_length: 500 } },
  { id: 'note_mediche', type: 'textarea', label: 'Note Mediche (BES, DSA, patologie)', required: false, db_mapping: 'alunni.note_mediche', placeholder: 'Eventuali note mediche o certificazioni', validation: { max_length: 1000 } },
  { id: 'documento_path', type: 'file', label: "Documento d'identità del minore", required: true, db_mapping: 'alunni.documento_path' },
]

// ── Campi ADULTO (→ adults) ────────────────────────────────────
export const ADULT_FIELDS: FormField[] = [
  { id: 'ruolo', type: 'select', label: 'Ruolo', required: true, options: [
    { label: 'Madre', value: 'mother' },
    { label: 'Padre', value: 'father' },
    { label: 'Tutore', value: 'tutor' },
    { label: 'Delegato', value: 'delegate' },
  ] },
  { id: 'first_name', type: 'text', label: 'Nome', required: true, db_mapping: 'parents.first_name', placeholder: 'Es. Maria', validation: { min_length: 2, max_length: 50 } },
  { id: 'last_name', type: 'text', label: 'Cognome', required: true, db_mapping: 'parents.last_name', placeholder: 'Es. Rossi', validation: { min_length: 2, max_length: 50 } },
  { id: 'fiscal_code', type: 'text', label: 'Codice Fiscale', required: true, db_mapping: 'parents.fiscal_code', placeholder: 'Es. RSSMRA75B41F205X', validation: { pattern: CF_PATTERN, min_length: 16, max_length: 16 } },
  { id: 'birth_date', type: 'date', label: 'Data di Nascita', required: false, db_mapping: 'parents.birth_date' },
  { id: 'birth_place', type: 'text', label: 'Comune di Nascita', required: false, db_mapping: 'parents.birth_place', placeholder: 'Es. Milano', validation: { max_length: 100 } },
  { id: 'birth_province', type: 'text', label: 'Provincia di Nascita', required: false, db_mapping: 'parents.birth_province', placeholder: 'Es. MI', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
  { id: 'document_type', type: 'select', label: 'Tipo Documento', required: true, db_mapping: 'parents.document_type', options: [
    { label: "Carta d'Identità", value: 'CI' },
    { label: 'Passaporto', value: 'PP' },
    { label: 'Patente', value: 'DL' },
  ] },
  { id: 'document_number', type: 'text', label: 'Numero Documento', required: true, db_mapping: 'parents.document_number', placeholder: 'Es. AB1234567', validation: { max_length: 50 } },
  { id: 'address', type: 'text', label: 'Indirizzo di Residenza', required: false, db_mapping: 'parents.address', placeholder: 'Es. Via Roma, 1', validation: { max_length: 200 } },
  { id: 'residence_city', type: 'text', label: 'Comune di Residenza', required: false, db_mapping: 'parents.residence_city', placeholder: 'Es. Roma', validation: { max_length: 100 } },
  { id: 'zip_code', type: 'text', label: 'CAP', required: false, db_mapping: 'parents.zip_code', placeholder: 'Es. 00100', validation: { pattern: CAP_PATTERN, min_length: 5, max_length: 5 } },
  { id: 'email', type: 'email', label: 'Email', required: false, db_mapping: 'parents.emails', placeholder: 'Es. maria.rossi@email.it' },
  { id: 'phone', type: 'phone', label: 'Numero di Telefono', required: false, db_mapping: 'parents.phones', placeholder: 'Es. +39 333 1234567' },
  { id: 'documento_path', type: 'file', label: "Documento d'identità", required: true, db_mapping: 'parents.documento_path' },
]

export const ENROLLMENT_LIMITS = {
  maxChildren: 6,
  minAdults: 1,
  maxAdults: 4,
}

export const ADULT_ROLE_LABELS: Record<string, string> = {
  mother: 'Madre',
  father: 'Padre',
  tutor: 'Tutore',
  delegate: 'Delegato',
}
