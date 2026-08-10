// @vitest-environment node
/**
 * COLLAUDO DEL TRACCIATO — l'XML del generatore contro lo XSD ufficiale FatturaPA.
 *
 * ─── COSA AGGIUNGE A `fatturapa-xml.test.ts` ──────────────────────────────────
 * Quello confronta stringhe: dice che `<TipoDocumento>` contiene `TD01`. Questo
 * chiede allo schema dell'Agenzia delle Entrate se il documento è ACCETTABILE —
 * ordine degli elementi (`xs:sequence`), obbligatorietà, `pattern` sugli importi,
 * enumerazioni sui codici. È la differenza fra «il testo che mi aspettavo c'è» e
 * «lo SdI non lo scarterà»: un tracciato può superare il primo e affondare sul
 * secondo, e la notizia arriverebbe per PEC, giorni dopo, con un codice numerico.
 *
 * ─── LA METÀ CHE CONTA: LE PROVE NEGATIVE ─────────────────────────────────────
 * Un validatore mal collegato — schema non compilato, import irrisolto, esito
 * ignorato — dice `valido` a qualunque cosa, e un test che verifica solo il caso
 * buono lo certifica. Qui sotto ci sono tre XML volutamente sbagliati, uno per
 * ciascuna delle tre famiglie di controllo che ci interessano (ordine, valore
 * fuori enumerazione, elemento obbligatorio mancante). Se anche uno solo passasse,
 * la validazione non starebbe validando niente.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'
import { REGIMI_FISCALI } from '@/lib/fatturazione/cedente'
import {
  CARTELLA_XSD,
  NOME_SCHEMA_FATTURAPA,
  NOME_XMLDSIG,
  validaFatturaPA,
} from './valida-xsd'

/**
 * Le impronte dei due XSD scaricati il 2026-08-09 da `fatturapa.gov.it` e da `w3.org`.
 *
 * Non è pedanteria: senza questo lock, il modo più rapido di far passare un generatore
 * rotto sarebbe ritoccare lo schema. La provenienza dei file è la sola cosa che rende
 * credibile un verdetto di validità, e la si verifica qui, dove il verdetto viene dato.
 * Se una di queste due righe fallisce, la domanda giusta NON è «aggiorno l'hash?» ma
 * «chi ha toccato lo schema, e perché». Un aggiornamento vero (nuova versione pubblicata)
 * si fa riscaricando dagli URL scritti in `src/lib/aruba/xsd/README.md`.
 */
const IMPRONTE_ATTESE: Record<string, string> = {
  [NOME_SCHEMA_FATTURAPA]: '152944f6eef9f5d69ef6e955ee173b32142b00a8c1c5222fc97dfab5910e8a8c',
  [NOME_XMLDSIG]: '35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c',
}

/**
 * La fattura tipo di Kidville: cooperativa cedente (dato societario, pubblico),
 * intestatario PERSONA FISICA con dati SINTETICI — il repository è pubblico e le
 * famiglie vere non entrano nei test, nemmeno come esempio.
 */
const fatturaTipo = (): FatturaPAInput => ({
  progressivoInvio: '00007',
  numero: 'Asilo 2328/2026',
  data: '2026-03-31',
  cedente: {
    piva: '03394870616',
    codiceFiscale: '03394870616',
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    regimeFiscale: 'RF01',
    sede: {
      indirizzo: 'Via Silvio Pellico 7',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
      nazione: 'IT',
    },
  },
  cessionario: {
    codiceFiscale: 'RSSMRA80A01H501U',
    nome: 'Mario',
    cognome: 'Rossi',
    sede: {
      indirizzo: 'Via delle Prove 12',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
      nazione: 'IT',
    },
  },
  righe: [{ descrizione: 'Retta di frequenza - marzo 2026', quantita: 1, prezzoUnitario: 180 }],
})

describe('XSD ufficiale FatturaPA 1.2.3 — provenienza dei file', () => {
  it.each(Object.entries(IMPRONTE_ATTESE))(
    '%s è ancora il file pubblicato (sha256 invariato)',
    (nome, attesa) => {
      const impronta = createHash('sha256').update(readFileSync(CARTELLA_XSD + nome)).digest('hex')
      expect(impronta).toBe(attesa)
    },
  )

  it('lo schema dichiara la versione 1.2.3 e il namespace delle fatture', () => {
    const schema = readFileSync(CARTELLA_XSD + NOME_SCHEMA_FATTURAPA, 'utf8')
    expect(schema).toContain('version="1.2.3"')
    expect(schema).toContain(
      'targetNamespace="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"',
    )
  })
})

describe('buildFatturaElettronicaXml — validazione contro lo XSD', () => {
  it('la fattura tipo (esente art. 10, riga unica) è valida per lo schema', async () => {
    const esito = await validaFatturaPA(buildFatturaElettronicaXml(fatturaTipo()))
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('con la marca da bollo virtuale resta valida (DatiBollo nella posizione giusta)', async () => {
    const input = fatturaTipo()
    input.righe = [{ descrizione: 'Retta trimestrale', prezzoUnitario: 540 }]
    input.bollo = { importo: 2 }
    const esito = await validaFatturaPA(buildFatturaElettronicaXml(input))
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('con IVA al 22% e causale resta valida', async () => {
    const input = fatturaTipo()
    input.iva = { aliquota: 22 }
    input.causale = 'Servizi extra-scolastici del trimestre'
    const esito = await validaFatturaPA(buildFatturaElettronicaXml(input))
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('entrambi i sezionali reali passano il controllo di formato del Numero', async () => {
    for (const numero of ['Asilo 2328/2026', 'FPR 1947/26']) {
      const input = fatturaTipo()
      input.numero = numero
      const esito = await validaFatturaPA(buildFatturaElettronicaXml(input))
      expect(esito.errori, `numero «${numero}»`).toEqual([])
    }
  })

  // La prova che l'elenco `REGIMI_FISCALI` di `@/lib/fatturazione/cedente` — quello
  // con cui il pannello e il server accettano o rifiutano ciò che la segreteria
  // scrive — COINCIDE con l'enumerazione dello schema. Senza questo caso, l'elenco
  // sarebbe l'ennesima lista copiata a mano che nessuno confronta con la fonte: la
  // regex che c'era prima (`/^RF\d{2}$/`) è caduta esattamente così.
  it.each([...REGIMI_FISCALI])('il regime %s dell\'elenco è accettato dallo schema', async (regime) => {
    const input = fatturaTipo()
    input.cedente.regimeFiscale = regime
    const esito = await validaFatturaPA(buildFatturaElettronicaXml(input))
    expect(esito.errori, `regime «${regime}»`).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('più righe di dettaglio restano valide', async () => {
    const input = fatturaTipo()
    input.righe = [
      { descrizione: 'Retta di frequenza', prezzoUnitario: 180 },
      { descrizione: 'Servizio mensa', quantita: 20, prezzoUnitario: 4.5 },
    ]
    const esito = await validaFatturaPA(buildFatturaElettronicaXml(input))
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })
})

describe('prove NEGATIVE — lo schema deve rifiutare', () => {
  it('Data e Divisa invertiti violano la xs:sequence di DatiGeneraliDocumento', async () => {
    const xml = buildFatturaElettronicaXml(fatturaTipo())
    const rotto = xml.replace(
      /<Divisa>EUR<\/Divisa>\n(\s*)<Data>([^<]+)<\/Data>/,
      '<Data>$2</Data>\n$1<Divisa>EUR</Divisa>',
    )
    // La sostituzione deve avere davvero morso: un `replace` a vuoto renderebbe
    // questa prova negativa un doppione della positiva, e passerebbe per sempre.
    expect(rotto, 'lo scambio Data/Divisa non è avvenuto').not.toBe(xml)

    const esito = await validaFatturaPA(rotto)
    expect(esito.valido).toBe(false)
    expect(esito.errori.join('\n')).toContain('Divisa')
  })

  it('un TipoDocumento fuori enumerazione (TD99) viene rifiutato', async () => {
    const rotto = buildFatturaElettronicaXml(fatturaTipo()).replace('TD01', 'TD99')
    const esito = await validaFatturaPA(rotto)
    expect(esito.valido).toBe(false)
    expect(esito.errori.join('\n')).toContain('TipoDocumento')
  })

  // Sul VALORE del regime, e non solo sulla sua assenza: è il campo del cedente
  // con l'unica enumerazione chiusa, ed è quello che l'operatore scrive a mano.
  // `RF03` e `RF00` sono i due codici che sceglie chi conta a mano — e l'elenco
  // dello schema salta dal 02 al 04.
  it.each(['RF03', 'RF00', 'RF87'])(
    'un RegimeFiscale fuori enumerazione (%s) viene rifiutato',
    async (regime) => {
      const input = fatturaTipo()
      input.cedente.regimeFiscale = regime
      const esito = await validaFatturaPA(buildFatturaElettronicaXml(input))
      expect(esito.valido).toBe(false)
      expect(esito.errori.join('\n')).toContain('RegimeFiscale')
    },
  )

  it('senza RegimeFiscale il CedentePrestatore è incompleto e viene rifiutato', async () => {
    const rotto = buildFatturaElettronicaXml(fatturaTipo()).replace(
      /\s*<RegimeFiscale>[^<]*<\/RegimeFiscale>/,
      '',
    )
    expect(rotto).not.toContain('RegimeFiscale')
    const esito = await validaFatturaPA(rotto)
    expect(esito.valido).toBe(false)
    expect(esito.errori.join('\n')).toContain('RegimeFiscale')
  })
})

/**
 * ✅ I DUE DIFETTI CHE QUESTA VALIDAZIONE AVEVA MISURATO — ora chiusi, e sorvegliati.
 *
 * Fino al 2026-08-09 questo blocco si chiamava «DIFETTI NOTI» e descriveva il comportamento
 * ATTUALE invece di quello desiderato: `buildFatturaElettronicaXml` faceva l'escaping dei
 * metacaratteri XML (`&`, `<`, `>`) e nient'altro — non normalizzava i caratteri fuori da
 * Latin-1 e non troncava alle lunghezze massime del tracciato. Ne usciva un file ben formato,
 * che superava i test a stringhe, e che lo SdI SCARTA.
 *
 * Il commento di allora diceva: «quando il generatore verrà sistemato questi due test
 * diventeranno rossi: è il segnale, non un guasto. Vanno ROVESCIATI, non cancellati». È
 * successo esattamente così, ed è quello che si è fatto. Da qui in avanti sono la difesa: se
 * qualcuno toglie la normalizzazione o il troncamento, tornano rossi nel verso giusto.
 */
describe('caratteri fuori tracciato e lunghezze massime: normalizzati e troncati', () => {
  it('il trattino lungo non fa più scartare Descrizione e Causale: diventa un trattino', async () => {
    // La stringa è quella che l'emissione costruiva per le fatture divise fra genitori
    // separati: `${causaleBase} — quota ${label}`. Quel «—» è U+2014 EM DASH, sta fuori da
    // `[\p{IsBasicLatin}\p{IsLatin-1Supplement}]`, ed era scritto a mano nel sorgente: ogni
    // fattura di quel ramo nasceva invalida. Ora il sorgente usa un trattino normale E il
    // generatore translittera comunque, perché una causale la scrive anche un umano.
    const input = fatturaTipo()
    input.righe = [{ descrizione: 'Retta di marzo — quota madre', prezzoUnitario: 90 }]
    input.causale = 'Retta di marzo — quota madre'

    const xml = buildFatturaElettronicaXml(input)
    expect(xml).toContain('<Descrizione>Retta di marzo - quota madre</Descrizione>')
    expect(xml).not.toContain('—')

    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('gli altri caratteri tipografici passano: apostrofo curvo, virgolette, euro, puntini', async () => {
    // Sono quelli che una tastiera italiana e un correttore automatico producono DA SOLI:
    // il modo più probabile in cui una causale scritta a mano diventa uno scarto.
    const input = fatturaTipo()
    input.causale = 'Retta d’iscrizione “gennaio” — € 180…'
    input.righe = [{ descrizione: 'Retta d’iscrizione – 1° trimestre', prezzoUnitario: 180 }]

    const xml = buildFatturaElettronicaXml(input)
    expect(xml).toContain("Retta d&apos;iscrizione &quot;gennaio&quot; - EUR 180...")
    // «°» è U+00B0, cioè Latin-1 Supplement: il tracciato lo ammette e resta com'è.
    expect(xml).toContain('1° trimestre')

    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('le lunghezze massime del tracciato sono imposte prima di comporre l\'XML', async () => {
    // Denominazione: 80 caratteri. Causale: 200. Descrizione: 1000. Numero e
    // ProgressivoInvio: 20 e 10, e per giunta ASCII puro (`\p{IsBasicLatin}`, senza le
    // accentate). Il troncamento è l'ULTIMA difesa: chi emette logga un `warn` prima, così
    // chi ha configurato un modello troppo lungo lo scopre invece di subirlo.
    const input = fatturaTipo()
    input.causale = 'x'.repeat(201)
    input.cedente.denominazione = 'C'.repeat(120)
    input.progressivoInvio = '0'.repeat(15)

    const xml = buildFatturaElettronicaXml(input)
    expect(xml).toContain(`<Causale>${'x'.repeat(200)}</Causale>`)
    expect(xml).toContain(`<Denominazione>${'C'.repeat(80)}</Denominazione>`)
    expect(xml).toContain(`<ProgressivoInvio>${'0'.repeat(10)}</ProgressivoInvio>`)

    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })
})

describe('DatiPagamento, NumeroCivico e Provincia — i blocchi che mancavano', () => {
  it('il blocco pagamento (bonifico, unica soluzione, IBAN) è valido e sta DOPO DatiBeniServizi', async () => {
    const input = fatturaTipo()
    input.pagamento = {
      dataScadenza: '2026-04-15',
      // IBAN sintetico: il repository è pubblico e nessuna coordinata vera ci entra.
      iban: 'IT60X0542811101000000123456',
      beneficiario: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    }
    const xml = buildFatturaElettronicaXml(input)
    expect(xml).toContain('<CondizioniPagamento>TP02</CondizioniPagamento>')
    expect(xml).toContain('<ModalitaPagamento>MP05</ModalitaPagamento>')
    expect(xml).toContain('<DataScadenzaPagamento>2026-04-15</DataScadenzaPagamento>')
    expect(xml).toContain('<ImportoPagamento>180.00</ImportoPagamento>')
    // L'ordine è la cosa che lo schema controlla e che una regex non vede.
    expect(xml.indexOf('<DatiPagamento>')).toBeGreaterThan(xml.indexOf('</DatiBeniServizi>'))

    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('un IBAN malformato viene OMESSO invece di far scartare il documento intero', async () => {
    const input = fatturaTipo()
    input.pagamento = { iban: 'non-e-un-iban' }
    const xml = buildFatturaElettronicaXml(input)
    expect(xml).toContain('<DatiPagamento>')
    expect(xml).not.toContain('<IBAN>')

    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
  })

  it('NumeroCivico sta fra Indirizzo e CAP, e Provincia fra Comune e Nazione', async () => {
    const input = fatturaTipo()
    input.cessionario.sede = {
      indirizzo: 'Via delle Prove',
      numeroCivico: '12/B',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'ce', // minuscola: `ProvinciaType` vuole [A-Z]{2}
      nazione: 'IT',
    }
    const xml = buildFatturaElettronicaXml(input)
    const sede = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'))
    expect(sede).toContain('<NumeroCivico>12/B</NumeroCivico>')
    expect(sede).toContain('<Provincia>CE</Provincia>')
    expect(sede.indexOf('<NumeroCivico>')).toBeGreaterThan(sede.indexOf('<Indirizzo>'))
    expect(sede.indexOf('<NumeroCivico>')).toBeLessThan(sede.indexOf('<CAP>'))

    const esito = await validaFatturaPA(xml)
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('una provincia fuori forma («CES», «c») viene OMESSA: meglio un dato in meno di uno scarto', async () => {
    for (const provincia of ['CES', 'c', '']) {
      const input = fatturaTipo()
      input.cessionario.sede = { ...input.cessionario.sede, provincia }
      const xml = buildFatturaElettronicaXml(input)
      const sede = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'))
      expect(sede, `provincia «${provincia}»`).not.toContain('<Provincia>')
      const esito = await validaFatturaPA(xml)
      expect(esito.errori, `provincia «${provincia}»`).toEqual([])
    }
  })
})
