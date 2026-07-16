import { describe, it, expect } from 'vitest'
import { validateField, validatePage, isProvinceField } from '@/lib/forms/validate-fields'
import type { FormField } from '@/types/database.types'

const f = (over: Partial<FormField> & { id: string; type: FormField['type'] }): FormField => ({
  label: over.label ?? over.id,
  ...over,
})

describe('isProvinceField', () => {
  it('riconosce i campi provincia dal suffisso _province', () => {
    expect(isProvinceField(f({ id: 'birth_province', type: 'text' }))).toBe(true)
    expect(isProvinceField(f({ id: 'residence_province', type: 'text' }))).toBe(true)
    expect(isProvinceField(f({ id: 'children.0.birth_province', type: 'text' }))).toBe(true)
  })
  it('NON considera provincia i campi normali', () => {
    expect(isProvinceField(f({ id: 'nome', type: 'text' }))).toBe(false)
    expect(isProvinceField(f({ id: 'birth_city', type: 'text' }))).toBe(false)
    expect(isProvinceField(f({ id: 'province_note', type: 'text' }))).toBe(false)
  })
})

describe('validateField — required', () => {
  it('campo obbligatorio vuoto → messaggio italiano', () => {
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), '')).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), '   ')).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), undefined)).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), null)).toBe('Campo obbligatorio')
  })
  it('campo facoltativo vuoto → nessun errore (niente pattern/min su vuoto)', () => {
    expect(validateField(f({ id: 'birth_province', type: 'text', validation: { pattern: '^[A-Z]{2}$', max_length: 2 } }), '')).toBeNull()
    expect(validateField(f({ id: 'note', type: 'textarea', validation: { min_length: 5 } }), '')).toBeNull()
  })
  it('checkbox obbligatorio senza selezioni → obbligatorio', () => {
    expect(validateField(f({ id: 'scelte', type: 'checkbox', required: true, options: [{ label: 'A', value: 'a' }] }), [])).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'scelte', type: 'checkbox', required: true, options: [{ label: 'A', value: 'a' }] }), ['a'])).toBeNull()
  })
})

describe('validateField — pattern provincia', () => {
  const prov = f({ id: 'residence_province', type: 'text', required: true, placeholder: 'Es. RM', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } })
  it('sigla valida → nessun errore', () => {
    expect(validateField(prov, 'NA')).toBeNull()
  })
  it('nome per esteso (non normalizzato) → messaggio provincia chiaro', () => {
    const msg = validateField(prov, 'Napoli')
    expect(msg).toContain('sigla della provincia')
  })
  it('sigla minuscola → fallisce il pattern (case sensitive)', () => {
    expect(validateField(prov, 'na')).toContain('sigla della provincia')
  })
  it('usa il placeholder come esempio nel messaggio', () => {
    expect(validateField(prov, 'XYZ')).toBe('Inserisci la sigla della provincia (es. RM)')
  })
})

describe('validateField — provincia INESISTENTE (appartenenza all\'elenco reale)', () => {
  // Regressione della CAUSA RADICE 1: una sigla FORMALMENTE valida (2 lettere
  // maiuscole → passa il pattern ^[A-Z]{2}$) ma che NON è una provincia italiana
  // reale ('XY', 'ZZ', 'QQ') passava wizard e POST e moriva solo al pre-flight
  // dell'import in segreteria, dove l'operatore non può più correggerla. Ora
  // `validateField` valida l'APPARTENENZA all'elenco reale delle province.
  const prov = f({ id: 'residence_province', type: 'text', required: true, placeholder: 'Es. RM', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } })

  it('sigla formalmente valida ma inesistente → errore (non passa più il solo pattern)', () => {
    expect(validateField(prov, 'XY')).toContain('inesistente')
    expect(validateField(prov, 'ZZ')).toContain('inesistente')
    expect(validateField(prov, 'QQ')).toContain('inesistente')
  })
  it('sigla reale → nessun errore', () => {
    expect(validateField(prov, 'NA')).toBeNull()
    expect(validateField(prov, 'MI')).toBeNull()
    expect(validateField(prov, 'RM')).toBeNull()
  })

  // Su un campo provincia SENZA pattern maiuscolo la sigla reale passa anche
  // minuscola (appartenenza case-insensitive), mentre un nome per esteso resta
  // NON valido: la semantica è che il valore finale valido è una SIGLA.
  const provSenzaPattern = f({ id: 'birth_province', type: 'text', required: true, placeholder: 'Es. NA' })
  it('sigla reale minuscola → ok (appartenenza case-insensitive)', () => {
    expect(validateField(provSenzaPattern, 'na')).toBeNull()
    expect(validateField(provSenzaPattern, 'NA')).toBeNull()
  })
  it('nome per esteso → resta non valido (il valore finale valido è una sigla)', () => {
    expect(validateField(provSenzaPattern, 'Napoli')).not.toBeNull()
  })
  it('sigla inesistente anche senza pattern → errore', () => {
    expect(validateField(provSenzaPattern, 'XY')).toContain('inesistente')
  })
})

describe('validateField — pattern CAP e codice fiscale', () => {
  it('CAP non valido → messaggio dedicato', () => {
    const cap = f({ id: 'zip_code', type: 'text', validation: { pattern: '^[0-9]{5}$', min_length: 5, max_length: 5 } })
    expect(validateField(cap, '00100')).toBeNull()
    expect(validateField(cap, '12')).toContain('CAP')
  })
  it('codice fiscale non valido → messaggio dedicato', () => {
    const cf = f({ id: 'codice_fiscale', type: 'text', validation: { pattern: '^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$', min_length: 16, max_length: 16 } })
    expect(validateField(cf, 'RSSMRC99A01H501Z')).toBeNull()
    expect(validateField(cf, 'ABC')).toContain('codice fiscale')
  })
})

describe('validateField — lunghezze e tipi', () => {
  it('min_length', () => {
    expect(validateField(f({ id: 'nome', type: 'text', validation: { min_length: 2 } }), 'A')).toBe('Inserisci almeno 2 caratteri')
  })
  it('max_length', () => {
    expect(validateField(f({ id: 'civ', type: 'text', validation: { max_length: 3 } }), 'ABCD')).toBe('Inserisci al massimo 3 caratteri')
  })
  it('email non valida', () => {
    expect(validateField(f({ id: 'email', type: 'email' }), 'non-una-email')).toContain('email')
    expect(validateField(f({ id: 'email', type: 'email' }), 'a@b.it')).toBeNull()
  })
  it('numero non valido + min/max', () => {
    expect(validateField(f({ id: 'n', type: 'number' }), 'abc')).toContain('numero')
    expect(validateField(f({ id: 'n', type: 'number', validation: { min: 5 } }), '3')).toBe('Il valore minimo è 5')
    expect(validateField(f({ id: 'n', type: 'number', validation: { max: 5 } }), '9')).toBe('Il valore massimo è 5')
    expect(validateField(f({ id: 'n', type: 'number', validation: { min: 1, max: 10 } }), '5')).toBeNull()
  })
  it('data non valida', () => {
    expect(validateField(f({ id: 'd', type: 'date' }), 'non-data')).toContain('data')
    expect(validateField(f({ id: 'd', type: 'date' }), '2020-01-01')).toBeNull()
  })
  it('select fuori dalle opzioni', () => {
    const sel = f({ id: 'g', type: 'select', options: [{ label: 'M', value: 'M' }, { label: 'F', value: 'F' }] })
    expect(validateField(sel, 'X')).toBe('Selezione non valida')
    expect(validateField(sel, 'M')).toBeNull()
  })
  it('campi decorativi → mai errore', () => {
    expect(validateField(f({ id: 'h', type: 'section_header' }), undefined)).toBeNull()
    expect(validateField(f({ id: 'p', type: 'paragraph' }), undefined)).toBeNull()
    expect(validateField(f({ id: 's', type: 'signature' }), undefined)).toBeNull()
  })
})

describe('validatePage', () => {
  const fields: FormField[] = [
    f({ id: 'nome', type: 'text', required: true, validation: { min_length: 2 } }),
    f({ id: 'residence_province', type: 'text', required: true, validation: { pattern: '^[A-Z]{2}$', max_length: 2 } }),
    f({ id: 'note', type: 'textarea' }),
  ]
  it('ritorna solo i campi non validi, keyed per id', () => {
    const errs = validatePage(fields, { nome: 'A', residence_province: 'Napoli', note: '' })
    expect(Object.keys(errs).sort()).toEqual(['nome', 'residence_province'])
    expect(errs.nome).toBe('Inserisci almeno 2 caratteri')
    expect(errs.residence_province).toContain('sigla della provincia')
  })
  it('oggetto vuoto quando tutto è valido', () => {
    expect(validatePage(fields, { nome: 'Marco', residence_province: 'NA', note: 'ok' })).toEqual({})
  })
})
