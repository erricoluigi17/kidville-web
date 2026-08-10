// @vitest-environment node
/**
 * ALIQUOTA E NATURA — la regola che lo XSD NON vede, e che lo SdI applica lo stesso.
 *
 * ─── COSA C'ERA PRIMA, E PERCHÉ NESSUN TEST LO COGLIEVA ──────────────────────
 * Il generatore scriveva `<AliquotaIVA>` e `<Natura>` così come arrivavano, senza
 * nessun vincolo fra i due. Due combinazioni sono uno SCARTO CERTO:
 *   · `aliquota 0` senza `Natura`     → SDI **00401**
 *   · `aliquota > 0` con una `Natura` → SDI **00400**
 * Entrambe superano lo XSD ufficiale — è MISURATO qui sotto, non dedotto — perché il
 * vincolo sta nelle *regole di controllo* dello SdI, non nel tracciato. Il collaudo
 * XSD, che pure è la difesa più forte di questo modulo, su questo punto è cieco: un
 * test che si fida solo di lui certifica un documento che verrà rifiutato.
 *
 * ─── E ERA RAGGIUNGIBILE DALLA CONFIGURAZIONE ────────────────────────────────
 * `admin/settings/aruba:PATCH` validava le righe IVA con `z.unknown().optional()`:
 * una riga `{causale:'iscrizione', aliquota:0}` si salvava senza un fiato e arrivava
 * intatta fino allo SdI. Ora la regola vive in un posto solo (`verificaCoerenzaIva`)
 * ed è applicata su tre strade: all'ingresso della configurazione, prima di consumare
 * un numero, e nel generatore come ultima difesa.
 */
import { describe, it, expect } from 'vitest'
import {
  buildFatturaElettronicaXml,
  verificaCoerenzaIva,
  FatturaPAInputError,
  type FatturaPAInput,
} from '@/lib/aruba/fatturapa-xml'
import { validaFatturaPA } from './valida-xsd'

/** Dati societari (pubblici) del cedente + intestatario SINTETICO: il repo è pubblico. */
const fatturaTipo = (): FatturaPAInput => ({
  progressivoInvio: 'A26002328',
  numero: 'Asilo 2328/2026',
  data: '2026-03-31',
  cedente: {
    piva: '03394870616',
    codiceFiscale: '03394870616',
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    regimeFiscale: 'RF01',
    sede: { indirizzo: 'Via Silvio Pellico 7', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
  },
  cessionario: {
    codiceFiscale: 'RSSMRA80A01H501U',
    nome: 'Mario',
    cognome: 'Rossi',
    sede: { indirizzo: 'Via delle Prove 12', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
  },
  righe: [{ descrizione: 'Retta di frequenza - marzo 2026', quantita: 1, prezzoUnitario: 180 }],
})

describe('LA MISURA: lo XSD accetta ciò che lo SdI scarta', () => {
  it('un documento con `AliquotaIVA 22` E `Natura N4` è VALIDO per lo schema ufficiale', async () => {
    // Il documento non si può più generare (il costruttore lancia), quindi lo si
    // costruisce partendo da uno valido e infilando la Natura a mano: è l'unico modo
    // di misurare cosa vede davvero lo schema, invece di dedurlo.
    const valido = buildFatturaElettronicaXml({ ...fatturaTipo(), iva: { aliquota: 22 } })
    const incoerente = valido.replace(
      /(<AliquotaIVA>22\.00<\/AliquotaIVA>)/g,
      '$1\n        <Natura>N4</Natura>',
    )
    const esito = await validaFatturaPA(incoerente)
    expect(esito.errori, 'se lo XSD lo respingesse, questo controllo sarebbe superfluo').toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('un documento con `AliquotaIVA 0` e SENZA `Natura` è VALIDO per lo schema ufficiale', async () => {
    const valido = buildFatturaElettronicaXml({ ...fatturaTipo(), iva: { aliquota: 0, natura: 'N4' } })
    const incoerente = valido.replace(/\s*<Natura>N4<\/Natura>/g, '')
    expect(incoerente).not.toContain('<Natura>')
    const esito = await validaFatturaPA(incoerente)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })
})

describe('verificaCoerenzaIva — la regola in un posto solo', () => {
  it('aliquota 0 senza Natura: lancia, e nomina il codice 00401', () => {
    const errore = (() => {
      try {
        verificaCoerenzaIva({ aliquota: 0 })
        return null
      } catch (e) {
        return e
      }
    })()
    expect(errore).toBeInstanceOf(FatturaPAInputError)
    expect((errore as FatturaPAInputError).codiceSdi).toBe('00401')
    expect((errore as Error).message).toContain('N4')
  })

  it('aliquota > 0 con Natura: lancia, e nomina il codice 00400', () => {
    expect(() => verificaCoerenzaIva({ aliquota: 22, natura: 'N4' })).toThrow(FatturaPAInputError)
    try {
      verificaCoerenzaIva({ aliquota: 22, natura: 'N4' })
    } catch (e) {
      expect((e as FatturaPAInputError).codiceSdi).toBe('00400')
    }
  })

  it('le due combinazioni GIUSTE passano', () => {
    expect(() => verificaCoerenzaIva({ aliquota: 0, natura: 'N4' })).not.toThrow()
    expect(() => verificaCoerenzaIva({ aliquota: 22 })).not.toThrow()
    // Una natura scritta come stringa vuota è «assente», non «presente e vuota»:
    // è la forma in cui un pannello salva un campo cancellato.
    expect(() => verificaCoerenzaIva({ aliquota: 22, natura: '  ' })).not.toThrow()
  })

  it('un\'aliquota che non è un numero non passa per «zero»', () => {
    expect(() => verificaCoerenzaIva({ aliquota: Number('ventidue') })).toThrow(FatturaPAInputError)
    expect(() => verificaCoerenzaIva({ aliquota: -5, natura: 'N4' })).toThrow(FatturaPAInputError)
  })
})

describe('buildFatturaElettronicaXml — un documento incoerente non nasce nemmeno come stringa', () => {
  it('non produce XML con aliquota 0 e nessuna natura', () => {
    expect(() => buildFatturaElettronicaXml({ ...fatturaTipo(), iva: { aliquota: 0 } })).toThrow(
      FatturaPAInputError,
    )
  })

  it('non produce XML con aliquota 22 e natura N4', () => {
    expect(() =>
      buildFatturaElettronicaXml({ ...fatturaTipo(), iva: { aliquota: 22, natura: 'N4' } }),
    ).toThrow(FatturaPAInputError)
  })

  it('il DEFAULT (nessun blocco `iva`) resta l\'esente art. 10, con la dicitura DELLE FATTURE VERE', async () => {
    // La stringa è lettera per lettera quella misurata il 2026-08-10 su due
    // documenti veri scaricati da Aruba (`Asilo 2327/2026` e `FPR 1946/26`):
    // `Art.` maiuscolo, anno a DUE cifre. Fino a quel giorno qui c'era
    // `Esente art. 10 DPR 633/1972` — cioè esattamente la stringa che
    // `docs/fatturazione/tracciato-di-riferimento.md` elenca come «l'errore
    // facile», e nella stessa serie fiscale sarebbero convissute due diciture.
    const xml = buildFatturaElettronicaXml(fatturaTipo())
    expect(xml).toContain('<Natura>N4</Natura>')
    expect(xml).toContain('<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>')
    expect(xml).not.toContain('DPR 633/1972')
    expect((await validaFatturaPA(xml)).valido).toBe(true)
  })

  it('un riferimento normativo lungo viene troncato a 100 (String100LatinType), non a 200', async () => {
    // Il troncamento stava su `LIMITI.causale` (200): una dicitura configurata a
    // mano di 120 caratteri passava intatta e produceva un documento che viola il
    // `pattern` dello XSD (`{1,100}`) — scarto formale col numero già consumato.
    const xml = buildFatturaElettronicaXml({
      ...fatturaTipo(),
      iva: { aliquota: 0, natura: 'N4', riferimentoNormativo: 'R'.repeat(120) },
    })
    expect(xml).toContain(`<RiferimentoNormativo>${'R'.repeat(100)}</RiferimentoNormativo>`)
    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('il RIFERIMENTO NORMATIVO di una riga configurata arriva nel documento', async () => {
    // Fino al 2026-08-10 `emissione.ts` non lo passava MAI: `<RiferimentoNormativo>`
    // spariva proprio sulle righe esenti configurate a mano dalla sede.
    const xml = buildFatturaElettronicaXml({
      ...fatturaTipo(),
      iva: { aliquota: 0, natura: 'N2.2', riferimentoNormativo: 'Operazione non soggetta art. 2 DPR 633/1972' },
    })
    expect(xml).toContain('<Natura>N2.2</Natura>')
    expect(xml).toContain('<RiferimentoNormativo>Operazione non soggetta art. 2 DPR 633/1972</RiferimentoNormativo>')
    expect((await validaFatturaPA(xml)).valido).toBe(true)
  })
})
