/**
 * LE COLONNE CHE L'ANAGRAFICA DOCENTE LEGGE, una per una. Mai `select('*')`.
 *
 * `COLONNE_GATE` sono tutte del baseline e non passano da `selectResiliente`: è la
 * lettura che decide se aprire, e non deve mai «degradare». Le altre sì — il
 * database E2E della CI non riceve le migrazioni da solo, e una colonna recente che
 * manca deve diventare un campo «Non indicato», non un 500.
 */

export const COLONNE_GATE = 'id, section_id, scuola_id, stato, anonimizzato_il'

export const COLONNE_ELENCO = [
  'id', 'nome', 'cognome', 'section_id', 'data_nascita', 'gender',
  'allergies', 'allergeni', 'is_bes_dsa', 'usa_pannolino',
  'consenso_foto_sito', 'consenso_foto_social',
] as const

export const COLONNE_SCHEDA = [
  'id', 'nome', 'cognome', 'gender', 'data_nascita',
  'birth_city', 'birth_province', 'birth_nation', 'citizenship', 'codice_fiscale',
  'residence_address', 'residence_street_number', 'zip_code', 'residence_city', 'residence_province',
  'section_id', 'data_iscrizione',
  'allergies', 'allergeni', 'note_mediche', 'is_bes_dsa', 'usa_pannolino',
  'consenso_privacy', 'consenso_foto_sito', 'consenso_foto_social',
] as const

/** I campi di `parents` incorporati nei legami: niente documento, nascita, residenza. */
export const COLONNE_LEGAMI =
  'relation_type, is_primary, parents ( first_name, last_name, phone_numbers, emails, fiscal_code, anonimizzato_il )'

/** I delegati al ritiro: niente numero né file del documento. */
export const COLONNE_DELEGATI = 'first_name, last_name, relation'
