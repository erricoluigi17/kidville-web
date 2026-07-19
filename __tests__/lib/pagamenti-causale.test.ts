import { describe, it, expect } from 'vitest'
import { causaleBonifico, haCodiceFiscale, rigaCausaleSollecito } from '@/lib/pagamenti/causale'

// CF SINTETICO — non appartiene a nessuna persona reale (repo pubblico).
const CF_SINTETICO = 'TSTTST00T00T000T'

describe('causaleBonifico', () => {
  it('compone "Nome Cognome CF"', () => {
    expect(causaleBonifico({ nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO }))
      .toBe(`Mario Rossi ${CF_SINTETICO}`)
  })

  it('normalizza il CF (trim + maiuscolo)', () => {
    expect(causaleBonifico({ nome: 'Mario', cognome: 'Rossi', codiceFiscale: '  tsttst00t00t000t  ' }))
      .toBe(`Mario Rossi ${CF_SINTETICO}`)
  })

  it('senza CF ritorna solo "Nome Cognome"', () => {
    expect(causaleBonifico({ nome: 'Mario', cognome: 'Rossi', codiceFiscale: null }))
      .toBe('Mario Rossi')
  })

  it('tollera nome o cognome mancante senza produrre spazi sporchi o "undefined"', () => {
    expect(causaleBonifico({ nome: 'Mario', cognome: null, codiceFiscale: null })).toBe('Mario')
    expect(causaleBonifico({ nome: null, cognome: null, codiceFiscale: CF_SINTETICO })).toBe(CF_SINTETICO)
    expect(causaleBonifico({})).toBe('')
  })
})

describe('haCodiceFiscale', () => {
  it('true solo con CF valorizzato', () => {
    expect(haCodiceFiscale(CF_SINTETICO)).toBe(true)
    expect(haCodiceFiscale('   ')).toBe(false)
    expect(haCodiceFiscale('')).toBe(false)
    expect(haCodiceFiscale(null)).toBe(false)
    expect(haCodiceFiscale(undefined)).toBe(false)
  })
})

describe('rigaCausaleSollecito', () => {
  it('con CF include la causale completa col codice fiscale', () => {
    const riga = rigaCausaleSollecito({ nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO })
    expect(riga.toLowerCase()).toContain('causale')
    expect(riga).toContain(`Mario Rossi ${CF_SINTETICO}`)
  })

  it('senza CF invita a indicare nome e cognome del bambino', () => {
    const riga = rigaCausaleSollecito({ nome: 'Mario', cognome: 'Rossi', codiceFiscale: null })
    expect(riga).toContain('Mario Rossi')
    expect(riga.toLowerCase()).toContain('nome e cognome')
    expect(riga).not.toContain('undefined')
  })
})
