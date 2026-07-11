/**
 * Generatore XML FatturaPA 1.2.2 — tracciato per lo SDI via Aruba.
 *
 * Funzione PURA (nessun I/O): mappa un input strutturato sul tracciato
 * `FatturaElettronicaPrivati` (FPR12, B2C). IVA parametrica via `input.iva`
 * (default storico: 0% / Natura N4, esente art. 10 DPR 633/1972) e marca da
 * bollo virtuale via `input.bollo` (blocco DatiBollo, dovuta sugli esenti
 * oltre € 77,47). IdTrasmittente = Aruba PEC (obbligatorio per il canale
 * API, altrimenti errore 0094).
 */

/** P.IVA di Aruba PEC S.p.A. — obbligatoria come IdTrasmittente sul canale API Aruba. */
export const ARUBA_PEC_PIVA = '01879020517'
const NATURA_ESENTE = 'N4'
const RIFERIMENTO_NORMATIVO = 'Esente art. 10 DPR 633/1972'

export interface SedeFiscale {
  indirizzo: string
  cap: string
  comune: string
  provincia?: string
  nazione?: string // default IT
}

export interface CedenteInput {
  piva: string
  codiceFiscale?: string
  denominazione: string
  regimeFiscale: string // es. RF01, RF19
  sede: SedeFiscale
}

export interface CessionarioInput {
  codiceFiscale: string
  nome: string
  cognome: string
  sede: SedeFiscale
}

export interface RigaFattura {
  descrizione: string
  quantita?: number // default 1
  prezzoUnitario: number
}

export interface IvaFattura {
  aliquota: number
  /** Natura per aliquota 0 (es. N4); omessa → nessun tag Natura. */
  natura?: string
  riferimentoNormativo?: string
}

export interface FatturaPAInput {
  progressivoInvio: string
  numero: string
  data: string // YYYY-MM-DD
  cedente: CedenteInput
  cessionario: CessionarioInput
  righe: RigaFattura[]
  causale?: string
  /** IVA di righe/riepilogo; assente = esente art. 10 (default storico). */
  iva?: IvaFattura
  /** Bollo assolto in modo virtuale (documenti esenti oltre € 77,47). */
  bollo?: { importo: number }
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function importo(n: number): string {
  return n.toFixed(2)
}

function sedeXml(sede: SedeFiscale): string {
  const prov = sede.provincia ? `        <Provincia>${esc(sede.provincia)}</Provincia>\n` : ''
  return (
    `      <Sede>\n` +
    `        <Indirizzo>${esc(sede.indirizzo)}</Indirizzo>\n` +
    `        <CAP>${esc(sede.cap)}</CAP>\n` +
    `        <Comune>${esc(sede.comune)}</Comune>\n` +
    prov +
    `        <Nazione>${esc(sede.nazione || 'IT')}</Nazione>\n` +
    `      </Sede>`
  )
}

export function buildFatturaElettronicaXml(input: FatturaPAInput): string {
  const { cedente, cessionario, righe } = input
  const totale = righe.reduce((acc, r) => acc + (r.quantita ?? 1) * r.prezzoUnitario, 0)

  const iva = input.iva ?? { aliquota: 0, natura: NATURA_ESENTE, riferimentoNormativo: RIFERIMENTO_NORMATIVO }
  const naturaXml = iva.natura ? `        <Natura>${esc(iva.natura)}</Natura>\n` : ''
  const imposta = (totale * iva.aliquota) / 100

  const linee = righe
    .map((r, i) => {
      const q = r.quantita ?? 1
      const tot = q * r.prezzoUnitario
      return (
        `      <DettaglioLinee>\n` +
        `        <NumeroLinea>${i + 1}</NumeroLinea>\n` +
        `        <Descrizione>${esc(r.descrizione)}</Descrizione>\n` +
        `        <Quantita>${importo(q)}</Quantita>\n` +
        `        <PrezzoUnitario>${importo(r.prezzoUnitario)}</PrezzoUnitario>\n` +
        `        <PrezzoTotale>${importo(tot)}</PrezzoTotale>\n` +
        `        <AliquotaIVA>${importo(iva.aliquota)}</AliquotaIVA>\n` +
        naturaXml +
        `      </DettaglioLinee>`
      )
    })
    .join('\n')

  const cedenteCf = cedente.codiceFiscale
    ? `        <CodiceFiscale>${esc(cedente.codiceFiscale)}</CodiceFiscale>\n`
    : ''
  const causale = input.causale
    ? `        <Causale>${esc(input.causale)}</Causale>\n`
    : ''
  // Posizione da schema: DatiBollo sta tra Numero e ImportoTotaleDocumento.
  const datiBollo = input.bollo
    ? `        <DatiBollo>\n` +
      `          <BolloVirtuale>SI</BolloVirtuale>\n` +
      `          <ImportoBollo>${importo(input.bollo.importo)}</ImportoBollo>\n` +
      `        </DatiBollo>\n`
    : ''
  const rifNormativo = iva.riferimentoNormativo
    ? `        <RiferimentoNormativo>${esc(iva.riferimentoNormativo)}</RiferimentoNormativo>\n`
    : ''

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<p:FatturaElettronica versione="FPR12"` +
    ` xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"` +
    ` xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `  <FatturaElettronicaHeader>\n` +
    `    <DatiTrasmissione>\n` +
    `      <IdTrasmittente>\n` +
    `        <IdPaese>IT</IdPaese>\n` +
    `        <IdCodice>${ARUBA_PEC_PIVA}</IdCodice>\n` +
    `      </IdTrasmittente>\n` +
    `      <ProgressivoInvio>${esc(input.progressivoInvio)}</ProgressivoInvio>\n` +
    `      <FormatoTrasmissione>FPR12</FormatoTrasmissione>\n` +
    `      <CodiceDestinatario>0000000</CodiceDestinatario>\n` +
    `    </DatiTrasmissione>\n` +
    `    <CedentePrestatore>\n` +
    `      <DatiAnagrafici>\n` +
    `        <IdFiscaleIVA>\n` +
    `          <IdPaese>IT</IdPaese>\n` +
    `          <IdCodice>${esc(cedente.piva)}</IdCodice>\n` +
    `        </IdFiscaleIVA>\n` +
    cedenteCf +
    `        <Anagrafica>\n` +
    `          <Denominazione>${esc(cedente.denominazione)}</Denominazione>\n` +
    `        </Anagrafica>\n` +
    `        <RegimeFiscale>${esc(cedente.regimeFiscale)}</RegimeFiscale>\n` +
    `      </DatiAnagrafici>\n` +
    sedeXml(cedente.sede) +
    `\n    </CedentePrestatore>\n` +
    `    <CessionarioCommittente>\n` +
    `      <DatiAnagrafici>\n` +
    `        <CodiceFiscale>${esc(cessionario.codiceFiscale)}</CodiceFiscale>\n` +
    `        <Anagrafica>\n` +
    `          <Nome>${esc(cessionario.nome)}</Nome>\n` +
    `          <Cognome>${esc(cessionario.cognome)}</Cognome>\n` +
    `        </Anagrafica>\n` +
    `      </DatiAnagrafici>\n` +
    sedeXml(cessionario.sede) +
    `\n    </CessionarioCommittente>\n` +
    `  </FatturaElettronicaHeader>\n` +
    `  <FatturaElettronicaBody>\n` +
    `    <DatiGenerali>\n` +
    `      <DatiGeneraliDocumento>\n` +
    `        <TipoDocumento>TD01</TipoDocumento>\n` +
    `        <Divisa>EUR</Divisa>\n` +
    `        <Data>${esc(input.data)}</Data>\n` +
    `        <Numero>${esc(input.numero)}</Numero>\n` +
    datiBollo +
    `        <ImportoTotaleDocumento>${importo(totale)}</ImportoTotaleDocumento>\n` +
    causale +
    `      </DatiGeneraliDocumento>\n` +
    `    </DatiGenerali>\n` +
    `    <DatiBeniServizi>\n` +
    linee +
    `\n      <DatiRiepilogo>\n` +
    `        <AliquotaIVA>${importo(iva.aliquota)}</AliquotaIVA>\n` +
    naturaXml +
    `        <ImponibileImporto>${importo(totale)}</ImponibileImporto>\n` +
    `        <Imposta>${importo(imposta)}</Imposta>\n` +
    rifNormativo +
    `      </DatiRiepilogo>\n` +
    `    </DatiBeniServizi>\n` +
    `  </FatturaElettronicaBody>\n` +
    `</p:FatturaElettronica>\n`
  )
}
