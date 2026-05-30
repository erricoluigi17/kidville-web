import type { FormField } from '@/types/database.types'

export interface AnagraficaPresetField {
  presetId: string
  toFormField: () => FormField
}

export interface AnagraficaGroup {
  groupId: 'bambino' | 'madre' | 'padre' | 'delegato'
  label: string
  accent: 'sky' | 'rose' | 'indigo' | 'amber'
  fields: AnagraficaPresetField[]
}

function preset(id: string, config: Omit<FormField, 'id'>): AnagraficaPresetField {
  return { presetId: id, toFormField: () => ({ id: crypto.randomUUID(), ...config }) }
}

const CF_PATTERN = '^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$'
const CAP_PATTERN = '^[0-9]{5}$'
const PROV_PATTERN = '^[A-Z]{2}$'
const DOC_OPTIONS = [
  { label: "Carta d'Identità", value: 'CI' },
  { label: 'Passaporto', value: 'PP' },
  { label: 'Patente', value: 'DL' },
]

// ── Bambino ────────────────────────────────────────────────────
const BAMBINO_FIELDS: AnagraficaPresetField[] = [
  preset('bambino.nome', {
    type: 'text', label: 'Nome', required: true,
    db_mapping: 'alunni.nome', placeholder: 'Es. Marco',
    validation: { min_length: 2, max_length: 50 },
  }),
  preset('bambino.cognome', {
    type: 'text', label: 'Cognome', required: true,
    db_mapping: 'alunni.cognome', placeholder: 'Es. Rossi',
    validation: { min_length: 2, max_length: 50 },
  }),
  preset('bambino.gender', {
    type: 'select', label: 'Sesso', required: true,
    db_mapping: 'alunni.gender',
    options: [{ label: 'Maschio', value: 'M' }, { label: 'Femmina', value: 'F' }],
  }),
  preset('bambino.data_nascita', {
    type: 'date', label: 'Data di Nascita', required: true,
    db_mapping: 'alunni.data_nascita',
  }),
  preset('bambino.codice_fiscale', {
    type: 'text', label: 'Codice Fiscale', required: true,
    db_mapping: 'alunni.codice_fiscale', placeholder: 'Es. RSSMRC99A01H501Z',
    validation: { pattern: CF_PATTERN, min_length: 16, max_length: 16 },
  }),
  preset('bambino.birth_city', {
    type: 'text', label: 'Comune di Nascita', required: false,
    db_mapping: 'alunni.birth_city', placeholder: 'Es. Roma',
    validation: { max_length: 100 },
  }),
  preset('bambino.birth_province', {
    type: 'text', label: 'Provincia di Nascita', required: false,
    db_mapping: 'alunni.birth_province', placeholder: 'Es. RM',
    validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 },
  }),
  preset('bambino.residence_address', {
    type: 'text', label: 'Indirizzo di Residenza', required: false,
    db_mapping: 'alunni.residence_address', placeholder: 'Es. Via Roma, 1',
    validation: { max_length: 200 },
  }),
  preset('bambino.residence_city', {
    type: 'text', label: 'Comune di Residenza', required: false,
    db_mapping: 'alunni.residence_city', placeholder: 'Es. Roma',
    validation: { max_length: 100 },
  }),
  preset('bambino.zip_code', {
    type: 'text', label: 'CAP', required: false,
    db_mapping: 'alunni.zip_code', placeholder: 'Es. 00100',
    validation: { pattern: CAP_PATTERN, min_length: 5, max_length: 5 },
  }),
  preset('bambino.allergies', {
    type: 'textarea', label: 'Allergie / Intolleranze', required: false,
    db_mapping: 'alunni.allergies',
    placeholder: 'Descrivi eventuali allergie o intolleranze alimentari',
    validation: { max_length: 500 },
  }),
  preset('bambino.note_mediche', {
    type: 'textarea', label: 'Note Mediche', required: false,
    db_mapping: 'alunni.note_mediche',
    placeholder: 'Note BES, DSA, patologie particolari',
    validation: { max_length: 1000 },
  }),
  preset('bambino.is_bes_dsa', {
    type: 'select', label: 'BES / DSA', required: false,
    db_mapping: 'alunni.is_bes_dsa',
    options: [{ label: 'No', value: 'false' }, { label: 'Sì', value: 'true' }],
  }),
  preset('bambino.classe_sezione', {
    type: 'text', label: 'Classe / Sezione', required: false,
    db_mapping: 'alunni.classe_sezione', placeholder: 'Es. Girasoli',
    validation: { max_length: 20 },
  }),
]

// ── Genitore helper ────────────────────────────────────────────
function makeAdultFields(prefix: 'madre' | 'padre' | 'delegato', nomeLabel: string, cognomeLabel: string): AnagraficaPresetField[] {
  const genderOptions = prefix === 'madre'
    ? [{ label: 'Femmina', value: 'F' }, { label: 'Maschio', value: 'M' }]
    : [{ label: 'Maschio', value: 'M' }, { label: 'Femmina', value: 'F' }]

  const base: AnagraficaPresetField[] = [
    preset(`${prefix}.first_name`, {
      type: 'text', label: nomeLabel, required: true,
      db_mapping: 'adults.first_name', placeholder: 'Es. Maria',
      validation: { min_length: 2, max_length: 50 },
    }),
    preset(`${prefix}.last_name`, {
      type: 'text', label: cognomeLabel, required: true,
      db_mapping: 'adults.last_name', placeholder: 'Es. Rossi',
      validation: { min_length: 2, max_length: 50 },
    }),
    preset(`${prefix}.fiscal_code`, {
      type: 'text', label: 'Codice Fiscale', required: prefix !== 'delegato',
      db_mapping: 'adults.fiscal_code', placeholder: 'Es. RSSMRA75B41F205X',
      validation: { pattern: CF_PATTERN, min_length: 16, max_length: 16 },
    }),
    preset(`${prefix}.birth_date`, {
      type: 'date', label: 'Data di Nascita', required: false,
      db_mapping: 'adults.birth_date',
    }),
    preset(`${prefix}.birth_place`, {
      type: 'text', label: 'Comune di Nascita', required: false,
      db_mapping: 'adults.birth_place', placeholder: 'Es. Milano',
      validation: { max_length: 100 },
    }),
    preset(`${prefix}.birth_province`, {
      type: 'text', label: 'Provincia di Nascita', required: false,
      db_mapping: 'adults.birth_province', placeholder: 'Es. MI',
      validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 },
    }),
    preset(`${prefix}.birth_nation`, {
      type: 'text', label: 'Nazione di Nascita', required: false,
      db_mapping: 'adults.birth_nation', placeholder: 'Es. Italia',
      validation: { max_length: 100 },
    }),
    preset(`${prefix}.gender`, {
      type: 'select', label: 'Sesso', required: false,
      db_mapping: 'adults.gender', options: genderOptions,
    }),
    preset(`${prefix}.citizenship`, {
      type: 'text', label: 'Cittadinanza', required: false,
      db_mapping: 'adults.citizenship', placeholder: 'Es. Italiana',
      validation: { max_length: 100 },
    }),
    preset(`${prefix}.document_type`, {
      type: 'select', label: 'Tipo Documento', required: prefix === 'delegato',
      db_mapping: 'adults.document_type', options: DOC_OPTIONS,
    }),
    preset(`${prefix}.document_number`, {
      type: 'text', label: 'Numero Documento', required: prefix === 'delegato',
      db_mapping: 'adults.document_number', placeholder: 'Es. AB1234567',
      validation: { max_length: 50 },
    }),
    preset(`${prefix}.address`, {
      type: 'text', label: 'Indirizzo di Residenza', required: false,
      db_mapping: 'adults.address', placeholder: 'Es. Via Roma, 1',
      validation: { max_length: 200 },
    }),
    preset(`${prefix}.residence_city`, {
      type: 'text', label: 'Comune di Residenza', required: false,
      db_mapping: 'adults.residence_city', placeholder: 'Es. Roma',
      validation: { max_length: 100 },
    }),
    preset(`${prefix}.zip_code`, {
      type: 'text', label: 'CAP', required: false,
      db_mapping: 'adults.zip_code', placeholder: 'Es. 00100',
      validation: { pattern: CAP_PATTERN, min_length: 5, max_length: 5 },
    }),
    preset(`${prefix}.emails`, {
      type: 'email', label: 'Email', required: false,
      db_mapping: 'adults.emails', placeholder: 'Es. mario.rossi@email.it',
    }),
    preset(`${prefix}.phones`, {
      type: 'phone', label: 'Numero di Telefono', required: prefix === 'delegato',
      db_mapping: 'adults.phones', placeholder: 'Es. +39 333 1234567',
    }),
  ]

  return base
}

// ── Gruppi ────────────────────────────────────────────────────
export const ANAGRAFICA_GROUPS: AnagraficaGroup[] = [
  {
    groupId: 'bambino',
    label: 'Bambino',
    accent: 'sky',
    fields: BAMBINO_FIELDS,
  },
  {
    groupId: 'madre',
    label: 'Madre',
    accent: 'rose',
    fields: makeAdultFields('madre', 'Nome Madre', 'Cognome Madre'),
  },
  {
    groupId: 'padre',
    label: 'Padre',
    accent: 'indigo',
    fields: makeAdultFields('padre', 'Nome Padre', 'Cognome Padre'),
  },
  {
    groupId: 'delegato',
    label: 'Delegato / Tutore',
    accent: 'amber',
    fields: makeAdultFields('delegato', 'Nome Delegato', 'Cognome Delegato'),
  },
]
