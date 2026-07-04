import { describe, it, expect } from 'vitest'
import { buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'

// Helper: estrae il testo del primo elemento con il dato nome locale (FatturaPA
// usa elementi figli senza namespace; solo la radice è prefissata `p:`).
function tagText(xml: string, tag: string): string | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const el = doc.getElementsByTagName(tag)[0]
  return el ? el.textContent : null
}

const baseInput = (): FatturaPAInput => ({
  progressivoInvio: '00007',
  numero: '7',
  data: '2026-03-31',
  cedente: {
    piva: '12345678903',
    codiceFiscale: '12345678903',
    denominazione: 'Kidville Scuola Srl',
    regimeFiscale: 'RF01',
    sede: { indirizzo: 'Via Roma 1', cap: '00100', comune: 'Roma', provincia: 'RM', nazione: 'IT' },
  },
  cessionario: {
    codiceFiscale: 'FRNGLI80A41H501Z',
    nome: 'Giulia',
    cognome: 'Farina',
    sede: { indirizzo: 'Via Milano 9', cap: '00185', comune: 'Roma', provincia: 'RM', nazione: 'IT' },
  },
  righe: [{ descrizione: 'Retta di Marzo', quantita: 1, prezzoUnitario: 150 }],
})

describe('buildFatturaElettronicaXml', () => {
  it('produce un XML FatturaPA ben formato con versione FPR12', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    // nessun parsererror
    expect(doc.getElementsByTagName('parsererror').length).toBe(0)
    const root = doc.documentElement
    expect(root.localName).toBe('FatturaElettronica')
    expect(root.getAttribute('versione')).toBe('FPR12')
  })

  it('DatiTrasmissione: IdTrasmittente = Aruba PEC, CodiceDestinatario B2C, FormatoTrasmissione FPR12', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    // IdTrasmittente deve essere la P.IVA di Aruba PEC (obbligatorio, altrimenti errore 0094)
    const idPaesi = Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('IdPaese'))
    expect(idPaesi[0]?.textContent).toBe('IT')
    expect(tagText(xml, 'IdCodice')).toBe('01879020517')
    expect(tagText(xml, 'ProgressivoInvio')).toBe('00007')
    expect(tagText(xml, 'FormatoTrasmissione')).toBe('FPR12')
    expect(tagText(xml, 'CodiceDestinatario')).toBe('0000000')
  })

  it('CedentePrestatore: P.IVA, denominazione e regime fiscale della scuola', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    expect(xml).toContain('<Denominazione>Kidville Scuola Srl</Denominazione>')
    expect(tagText(xml, 'RegimeFiscale')).toBe('RF01')
  })

  it('CessionarioCommittente: persona fisica con CF, nome e cognome dell’intestatario', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    expect(xml).toContain('<CodiceFiscale>FRNGLI80A41H501Z</CodiceFiscale>')
    expect(tagText(xml, 'Nome')).toBe('Giulia')
    expect(tagText(xml, 'Cognome')).toBe('Farina')
  })

  it('DatiGeneraliDocumento: TD01, EUR, numero e importo totale', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    expect(tagText(xml, 'TipoDocumento')).toBe('TD01')
    expect(tagText(xml, 'Divisa')).toBe('EUR')
    expect(tagText(xml, 'Data')).toBe('2026-03-31')
    expect(tagText(xml, 'Numero')).toBe('7')
    expect(tagText(xml, 'ImportoTotaleDocumento')).toBe('150.00')
  })

  it('IVA 0% Natura N4 sia in dettaglio linea che in riepilogo, importi a 2 decimali', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    const aliquote = Array.from(
      new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('AliquotaIVA')
    ).map((e) => e.textContent)
    expect(aliquote).toEqual(['0.00', '0.00']) // linea + riepilogo
    const nature = Array.from(
      new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('Natura')
    ).map((e) => e.textContent)
    expect(nature).toEqual(['N4', 'N4'])
    expect(tagText(xml, 'PrezzoUnitario')).toBe('150.00')
    expect(tagText(xml, 'ImponibileImporto')).toBe('150.00')
    expect(tagText(xml, 'Imposta')).toBe('0.00')
  })

  it('NON include alcuna marca da bollo', () => {
    const xml = buildFatturaElettronicaXml(baseInput())
    expect(xml).not.toContain('DatiBollo')
    expect(xml).not.toContain('BolloVirtuale')
  })

  it('esegue l’escaping dei caratteri speciali XML nella descrizione', () => {
    const input = baseInput()
    input.righe = [{ descrizione: 'Retta & <Marzo>', prezzoUnitario: 10 }]
    const xml = buildFatturaElettronicaXml(input)
    expect(xml).toContain('Retta &amp; &lt;Marzo&gt;')
    // il documento resta ben formato
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.getElementsByTagName('parsererror').length).toBe(0)
  })

  it('somma più righe nell’importo totale documento', () => {
    const input = baseInput()
    input.righe = [
      { descrizione: 'Retta', prezzoUnitario: 150 },
      { descrizione: 'Mensa', prezzoUnitario: 49.5 },
    ]
    const xml = buildFatturaElettronicaXml(input)
    expect(tagText(xml, 'ImportoTotaleDocumento')).toBe('199.50')
    expect(tagText(xml, 'ImponibileImporto')).toBe('199.50')
  })
})
