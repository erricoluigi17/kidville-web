import { describe, it, expect } from 'vitest'
import { causaleBonifico, haCodiceFiscale, rigaCausaleSollecito, sedeCausale, nomeCompleto, renderCausale, DEFAULT_CAUSALE_TEMPLATE } from '@/lib/pagamenti/causale'

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

describe('renderCausale (motore a segnaposto per-categoria)', () => {
  it('rende un modello CUSTOM sostituendo i segnaposto', () => {
    expect(renderCausale('ISCRIZIONE {nome} {cognome} - {sede}', { nome: 'Mario', cognome: 'Rossi', sede: 'Kidville Giugliano' }))
      .toBe('ISCRIZIONE Mario Rossi - GIUGLIANO')
  })

  it('OMETTE un segmento coi soli segnaposto vuoti («per il minore {nome_completo}» sparisce senza nome)', () => {
    // segmento con placeholder ma tutti vuoti → via del tutto (niente label penzolante)
    expect(renderCausale('Retta - per il minore {nome_completo}', { descrizione: 'x', nome: null, cognome: null }))
      .toBe('Retta')
    expect(renderCausale('per il minore {nome_completo}', {})).toBe('')
  })

  it('MANTIENE il testo FISSO privo di segnaposto', () => {
    expect(renderCausale('Contributo volontario - {nome_completo}', { nome: 'Ada', cognome: 'Neri' }))
      .toBe('Contributo volontario - Ada Neri')
    // segmento di solo testo fisso: resta anche se gli altri spariscono
    expect(renderCausale('Contributo volontario - {codice_fiscale}', { nome: 'Ada', cognome: 'Neri' }))
      .toBe('Contributo volontario')
  })

  it('supporta i nuovi segnaposto {mese} {anno} {importo} {scadenza}', () => {
    expect(renderCausale('{descrizione} {mese} {anno} - {importo} - scad. {scadenza}', {
      descrizione: 'Retta', mese: 'settembre', anno: '2026', importo: '€ 150,00', scadenza: '30/09/2026',
    })).toBe('Retta settembre 2026 - € 150,00 - scad. 30/09/2026')
    // mese/anno assenti → il segmento che li contiene sparisce, il resto resta
    expect(renderCausale('{descrizione} {mese} {anno} - {importo}', {
      descrizione: 'Retta', importo: '€ 150,00',
    })).toBe('Retta - € 150,00')
  })

  it('DIFESA: un template NON-stringa ricade sul predefinito (niente crash su .split)', () => {
    const dati = { descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: 'TSTTST00T00T000T', sede: 'Kidville Giugliano' }
    const atteso = renderCausale(DEFAULT_CAUSALE_TEMPLATE, dati)
    for (const t of [999, {}, [], null, undefined]) {
      expect(renderCausale(t as unknown as string, dati)).toBe(atteso)
    }
  })

  it('il PREDEFINITO è retro-compatibile con la causale storica', () => {
    expect(renderCausale(DEFAULT_CAUSALE_TEMPLATE, { descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }))
      .toBe(`Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
    // le parti assenti si omettono, esattamente come il formato storico
    expect(renderCausale(DEFAULT_CAUSALE_TEMPLATE, { descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi' }))
      .toBe('Retta - per il minore Mario Rossi')
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
