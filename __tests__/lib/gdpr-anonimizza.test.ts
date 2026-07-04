import { describe, it, expect } from 'vitest'
import {
  placeholderFor, patchAlunno, patchParent, nomeConferma, confermaValida,
} from '@/lib/gdpr/anonimizza'

describe('placeholderFor', () => {
  it('deterministico e marcato CANCELLATO', () => {
    const p = placeholderFor('al-123')
    expect(p).toMatch(/^CANCELLATO-/)
    expect(placeholderFor('al-123')).toBe(p)
    expect(placeholderFor('al-999')).not.toBe(p)
  })
})

describe('patchAlunno', () => {
  it('sovrascrive i campi PII identificativi + marca anonimizzato_il', () => {
    const at = '2026-06-27T00:00:00Z'
    const patch = patchAlunno('al-1', at)
    // identità sostituita
    expect(patch.nome).toMatch(/^CANCELLATO-/)
    expect(patch.cognome).toMatch(/^CANCELLATO-/)
    // PII sensibili azzerate
    expect(patch.codice_fiscale).toBeNull()
    expect(patch.note_mediche).toBeNull()
    expect(patch.documento_path).toBeNull()
    expect(patch.anonimizzato_il).toBe(at)
  })
})

describe('patchParent', () => {
  it('sovrascrive PII genitore + sgancia auth_user_id', () => {
    const patch = patchParent('p-1', '2026-06-27T00:00:00Z')
    expect(patch.first_name).toMatch(/^CANCELLATO-/)
    expect(patch.last_name).toMatch(/^CANCELLATO-/)
    expect(patch.fiscal_code).toBeNull()
    expect(patch.emails).toBeNull()
    expect(patch.auth_user_id).toBeNull()
    expect(patch.anonimizzato_il).toBeTruthy()
  })
})

describe('nomeConferma / confermaValida', () => {
  const alunno = { nome: 'Marco', cognome: 'Rossi' }
  it('nomeConferma = COGNOME NOME', () => {
    expect(nomeConferma(alunno)).toBe('ROSSI MARCO')
  })
  it('conferma valida ignora maiuscole/spazi', () => {
    expect(confermaValida('  rossi   marco ', alunno)).toBe(true)
    expect(confermaValida('ROSSI MARCO', alunno)).toBe(true)
  })
  it('conferma errata → false', () => {
    expect(confermaValida('Rossi Luca', alunno)).toBe(false)
    expect(confermaValida('', alunno)).toBe(false)
  })
})
