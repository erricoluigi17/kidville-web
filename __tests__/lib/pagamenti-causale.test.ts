import { describe, it, expect } from 'vitest'
import { causaleBonifico, haCodiceFiscale, rigaCausaleSollecito, sedeCausale, nomeCompleto } from '@/lib/pagamenti/causale'

// CF SINTETICO — non appartiene a nessuna persona reale (repo pubblico).
const CF_SINTETICO = 'TSTTST00T00T000T'

describe('sedeCausale', () => {
  it('maiuscolo, senza il prefisso «Kidville»', () => {
    expect(sedeCausale('Kidville Giugliano')).toBe('GIUGLIANO')
    expect(sedeCausale('kidville  napoli')).toBe('NAPOLI')
    expect(sedeCausale('Giugliano')).toBe('GIUGLIANO')
    expect(sedeCausale(null)).toBe('')
    expect(sedeCausale('  ')).toBe('')
  })
})

describe('causaleBonifico', () => {
  it('compone «{descrizione} - per il minore {Nome Cognome} - {CF} - {SEDE}»', () => {
    expect(causaleBonifico({ descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }))
      .toBe(`Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
  })

  it('normalizza CF (trim+maiuscolo) e sede', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: '  tsttst00t00t000t  ', sede: 'Kidville Giugliano' }))
      .toBe(`Retta - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
  })

  it('omette le parti assenti (senza CF / senza sede)', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi' }))
      .toBe('Retta - per il minore Mario Rossi')
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO }))
      .toBe(`Retta - per il minore Mario Rossi - ${CF_SINTETICO}`)
  })

  it('tollera campi mancanti senza spazi sporchi né «undefined»', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: null })).toBe('Retta - per il minore Mario')
    expect(causaleBonifico({ nome: null, cognome: null, codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })).toBe(`${CF_SINTETICO} - GIUGLIANO`)
    expect(causaleBonifico({})).toBe('')
  })
})

describe('nomeCompleto', () => {
  it('ripulisce spazi e campi assenti', () => {
    expect(nomeCompleto({ nome: 'Mario', cognome: 'Rossi' })).toBe('Mario Rossi')
    expect(nomeCompleto({ nome: null, cognome: 'Rossi' })).toBe('Rossi')
    expect(nomeCompleto({})).toBe('')
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
  it('include la causale completa (descrizione, minore, CF, sede)', () => {
    const riga = rigaCausaleSollecito({ descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })
    expect(riga.toLowerCase()).toContain('causale')
    expect(riga).toContain(`Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
  })

  it('senza CF resta utile (descrizione + minore) e senza «undefined»', () => {
    const riga = rigaCausaleSollecito({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: null })
    expect(riga).toContain('Retta - per il minore Mario Rossi')
    expect(riga).not.toContain('undefined')
  })

  it('senza dati ritorna stringa vuota', () => {
    expect(rigaCausaleSollecito({})).toBe('')
  })
})
