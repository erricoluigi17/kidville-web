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
  { id: 'birth_nation', type: 'text', label: 'Nazione di Nascita', required: true, db_mapping: 'alunni.birth_nation', placeholder: 'Es. Italia', validation: { max_length: 100 } },
  { id: 'citizenship', type: 'text', label: 'Cittadinanza', required: true, db_mapping: 'alunni.citizenship', placeholder: 'Es. Italiana', validation: { max_length: 100 } },
  { id: 'residence_address', type: 'text', label: 'Indirizzo di Residenza', required: false, db_mapping: 'alunni.residence_address', placeholder: 'Es. Via Roma', validation: { max_length: 200 } },
  { id: 'residence_street_number', type: 'text', label: 'Numero Civico', required: true, db_mapping: 'alunni.residence_street_number', placeholder: 'Es. 123', validation: { max_length: 20 } },
  { id: 'residence_city', type: 'text', label: 'Comune di Residenza', required: false, db_mapping: 'alunni.residence_city', placeholder: 'Es. Roma', validation: { max_length: 100 } },
  { id: 'residence_province', type: 'text', label: 'Provincia di Residenza', required: true, db_mapping: 'alunni.residence_province', placeholder: 'Es. RM', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
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
  { id: 'birth_nation', type: 'text', label: 'Nazione di Nascita', required: true, db_mapping: 'parents.birth_nation', placeholder: 'Es. Italia', validation: { max_length: 100 } },
  { id: 'citizenship', type: 'text', label: 'Cittadinanza', required: true, db_mapping: 'parents.citizenship', placeholder: 'Es. Italiana', validation: { max_length: 100 } },
  { id: 'document_type', type: 'select', label: 'Tipo Documento', required: true, db_mapping: 'parents.document_type', options: [
    { label: "Carta d'Identità", value: 'CI' },
    { label: 'Passaporto', value: 'PP' },
    { label: 'Patente', value: 'DL' },
  ] },
  { id: 'document_number', type: 'text', label: 'Numero Documento', required: true, db_mapping: 'parents.document_number', placeholder: 'Es. AB1234567', validation: { max_length: 50 } },
  { id: 'address', type: 'text', label: 'Indirizzo di Residenza', required: false, db_mapping: 'parents.address', placeholder: 'Es. Via Roma', validation: { max_length: 200 } },
  { id: 'residence_street_number', type: 'text', label: 'Numero Civico', required: true, db_mapping: 'parents.residence_street_number', placeholder: 'Es. 123', validation: { max_length: 20 } },
  { id: 'residence_city', type: 'text', label: 'Comune di Residenza', required: false, db_mapping: 'parents.residence_city', placeholder: 'Es. Roma', validation: { max_length: 100 } },
  { id: 'residence_province', type: 'text', label: 'Provincia di Residenza', required: true, db_mapping: 'parents.residence_province', placeholder: 'Es. RM', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },
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

// ── Consensi (→ enrollment_submissions.consents_log) ───────────────────────
/**
 * Blocchi di consenso del modulo pubblico d'iscrizione.
 *
 * ⚠️ Qui NON si chiede il consenso per allergie, note mediche o certificati.
 * Non è una dimenticanza: per una scuola quei dati si trattano su una base
 * giuridica che non è il consenso (art. 9.2.g GDPR + art. 2-sexies, c. 2,
 * lett. bb del Codice privacy). Chiederlo sarebbe peggio che non chiederlo —
 * un consenso che non si può rifiutare, perché senza l'allergia la Scuola non
 * può preparare il pasto in sicurezza, non è libero, e un consenso non libero
 * non vale nulla. Si finirebbe per trattare dati sanitari di minori credendo di
 * avere una base, e non avendola.
 *
 * Quello che serve davvero è **l'informativa al punto di raccolta** (art. 13) e
 * la prova che sia stata data: da qui la presa visione, obbligatoria.
 *
 * Le foto sono l'unico caso in cui il consenso è la base giusta, perché
 * rifiutarlo non costa nulla al bambino. È **granulare per canale**: un consenso
 * raccolto per la galleria riservata non copre la pubblicazione sul sito né sui
 * social (provv. Garante 725 del 27/11/2025).
 */
export const CONSENSI_FIELDS: FormField[] = [
  {
    id: 'presa_visione_informativa',
    type: 'consent',
    label: 'Ho letto l’informativa sulla privacy',
    required: true,
    text:
      'Dichiaro di aver preso visione dell’informativa sul trattamento dei dati personali. ' +
      'I dati necessari all’iscrizione e alla sicurezza del bambino — comprese allergie, ' +
      'intolleranze ed eventuali indicazioni sanitarie — sono trattati dalla Scuola per motivi ' +
      'di interesse pubblico rilevante nel settore dell’istruzione, e per questi non è ' +
      'richiesto il consenso: la loro comunicazione è però necessaria, perché senza di essa ' +
      'la Scuola non può predisporre in sicurezza il servizio.',
    link: '/privacy',
  },
  {
    id: 'consenso_foto_galleria',
    type: 'consent',
    label: 'Fotografie e video nella galleria riservata alle famiglie della sezione',
    required: false,
    text:
      'Acconsento alla pubblicazione di fotografie e video che ritraggono mio figlio nella galleria ' +
      'dell’app, visibile alle sole famiglie della sua sezione. Il consenso è facoltativo e ' +
      'revocabile in qualsiasi momento: il rifiuto non pregiudica in alcun modo l’iscrizione.',
  },
  {
    id: 'consenso_foto_sito',
    type: 'consent',
    label: 'Fotografie sul sito web della Scuola',
    required: false,
    text:
      'Acconsento alla pubblicazione di fotografie che ritraggono mio figlio sul sito web della ' +
      'Scuola. Consenso distinto da quello per la galleria riservata, facoltativo e revocabile.',
  },
  {
    id: 'consenso_foto_social',
    type: 'consent',
    label: 'Fotografie sui canali social della Scuola',
    required: false,
    text:
      'Acconsento alla pubblicazione di fotografie che ritraggono mio figlio sui canali social della ' +
      'Scuola. Consenso distinto dai precedenti, facoltativo e revocabile.',
  },
]

// ── Dove atterra ciascun consenso foto ────────────────────────────────────────
/**
 * `field_id` del modulo → colonna di `alunni` che lo registra.
 *
 * ⚠️ ESISTE PERCHÉ È GIÀ SUCCESSO. Fino al 2026-07-31 solo `consenso_foto_galleria`
 * aveva una destinazione (`alunni.consenso_privacy`). Gli altri due — risposti da
 * **141 famiglie** — venivano raccolti, congelati in `consents_log` e poi
 * dimenticati: nessuna colonna, nessun lettore. Una famiglia che aveva NEGATO la
 * pubblicazione sui social credeva di averla negata, e nel sistema il suo «no»
 * era indistinguibile dal «sì» della famiglia accanto. Un dato raccolto e poi
 * ignorato è peggio di un dato mancante: è una promessa non mantenuta
 * (art. 5 §2 e art. 7 §1 GDPR).
 *
 * Questa mappa è la SINGOLA fonte di verità del legame consenso→colonna, ed è
 * lockata da `__tests__/api/iscrizioni-consensi-foto-per-canale.test.ts`: un
 * quarto canale aggiunto a `CONSENSI_FIELDS` senza destinazione fa fallire il
 * gate, invece di restare in silenzio per mesi.
 */
export const CONSENSI_FOTO_CANALI = {
  // Galleria riservata alle famiglie della sezione (app, dietro login).
  consenso_foto_galleria: 'consenso_privacy',
  // Sito web della Scuola: canale PUBBLICO, servito senza login (bucket `news`).
  consenso_foto_sito: 'consenso_foto_sito',
  // Canali social della Scuola: pubblicazione fuori dai sistemi della Scuola.
  consenso_foto_social: 'consenso_foto_social',
} as const

export type CanaleConsensoFoto = keyof typeof CONSENSI_FOTO_CANALI

/**
 * Versione del TESTO dei consensi qui sopra. Va cambiata quando il testo cambia:
 * è ciò che viene archiviato insieme a una dichiarazione di pubblicazione, così
 * fra due anni si sa a quale formulazione la famiglia aveva risposto.
 */
export const CONSENSI_VERSIONE = '2026-07-31'
