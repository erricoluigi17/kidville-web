import { describe, it, expect } from 'vitest'
import { buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'

const base: FatturaPAInput = {
  progressivoInvio: '00001',
  numero: '1',
  data: '2026-07-10',
  cedente: {
    piva: '12345678903',
    denominazione: 'Kidville Srl',
    regimeFiscale: 'RF01',
    sede: { indirizzo: 'Via Roma 1', cap: '00100', comune: 'Roma', provincia: 'RM' },
  },
  cessionario: {
    codiceFiscale: 'FRNGLI80A41H501Z',
    nome: 'Giulia',
    cognome: 'Farina',
    sede: { indirizzo: 'Via Milano 9', cap: '00185', comune: 'Roma' },
  },
  righe: [{ descrizione: 'Retta di Marzo', prezzoUnitario: 150 }],
}

describe('buildFatturaElettronicaXml — bollo e IVA parametrica', () => {
  it('default invariato: esente N4 art.10, NESSUN DatiBollo', () => {
    const xml = buildFatturaElettronicaXml(base)
    expect(xml).toContain('<AliquotaIVA>0.00</AliquotaIVA>')
    expect(xml).toContain('<Natura>N4</Natura>')
    expect(xml).toContain('Esente art. 10 DPR 633/1972')
    expect(xml).not.toContain('<DatiBollo>')
  })

  it('bollo → blocco DatiBollo virtuale prima di ImportoTotaleDocumento', () => {
    const xml = buildFatturaElettronicaXml({ ...base, bollo: { importo: 2 } })
    expect(xml).toContain('<DatiBollo>')
    expect(xml).toContain('<BolloVirtuale>SI</BolloVirtuale>')
    expect(xml).toContain('<ImportoBollo>2.00</ImportoBollo>')
    expect(xml.indexOf('<DatiBollo>')).toBeLessThan(xml.indexOf('<ImportoTotaleDocumento>'))
    expect(xml.indexOf('<Numero>')).toBeLessThan(xml.indexOf('<DatiBollo>'))
  })

  it('iva con aliquota > 0: niente Natura, Imposta calcolata', () => {
    const xml = buildFatturaElettronicaXml({ ...base, iva: { aliquota: 5 } })
    expect(xml).toContain('<AliquotaIVA>5.00</AliquotaIVA>')
    expect(xml).not.toContain('<Natura>')
    expect(xml).toContain('<Imposta>7.50</Imposta>')
    expect(xml).not.toContain('RiferimentoNormativo')
  })

  it('iva esente con natura/riferimento personalizzati', () => {
    const xml = buildFatturaElettronicaXml({
      ...base,
      iva: { aliquota: 0, natura: 'N2.2', riferimentoNormativo: 'Fuori campo IVA' },
    })
    expect(xml).toContain('<Natura>N2.2</Natura>')
    expect(xml).toContain('<RiferimentoNormativo>Fuori campo IVA</RiferimentoNormativo>')
    expect(xml).not.toContain('N4')
  })
})
