import { describe, it, expect } from 'vitest'
import {
  articoloMinore,
  modelloCausale,
  renderCausale,
  CHIAVE_CAUSALE_DEFAULT,
  DEFAULT_CAUSALE_TEMPLATE,
  PLACEHOLDER_CAUSALE,
} from '@/lib/pagamenti/causale'
import {
  causaleFattura,
  eccedeLimiteFatturaPA,
  lunghezzaCausaleFatturaPA,
  DEFAULT_CAUSALE_FATTURA_TEMPLATE,
  LIMITE_CAUSALE_FATTURAPA,
  VINCOLO_CAUSALE_FATTURAPA,
} from '@/lib/pagamenti/causale-fattura'
import { buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'

/**
 * ⚠️ CODICI FISCALI SINTETICI E IMPOSSIBILI, stessa convenzione di
 * `__tests__/lib/fiscale/codice-fiscale.test.ts`: cognome/nome `XXXYYY`, codice
 * catastale `Z999` (i codici `Z…` sono stati esteri e il 999 non è assegnato),
 * carattere di controllo `X` qualsiasi — quindi la checksum non torna. Nessuno di
 * questi codici può appartenere a una persona vera: il repository è pubblico e il
 * dominio sono minori.
 *
 * `A15` = 15 gennaio, maschio. `A55` = 15 gennaio, femmina (al giorno si sommano 40).
 * `ARR` = lo stesso 55 in OMOCODIA (5 → R).
 */
const CF_MASCHIO = 'XXXYYY20A15Z999X'
const CF_FEMMINA = 'XXXYYY20A55Z999X'
const CF_FEMMINA_OMOCODIA = 'XXXYYY20ARRZ999X'

describe('{minore} — l’articolo si legge nel codice fiscale, non si indovina', () => {
  it('maschio → «del minore», femmina → «della minore»', () => {
    expect(articoloMinore(CF_MASCHIO)).toBe('del minore')
    expect(articoloMinore(CF_FEMMINA)).toBe('della minore')
  })

  it('riconosce il femminile anche con l’OMOCODIA (le cifre diventano lettere)', () => {
    // Se il parser leggesse `RR` come «non un numero» e ricadesse su un maschile di
    // comodo, su una fattura elettronica uscirebbe «a favore del minore» per una
    // bambina — e un documento fiscale si corregge solo con una nota di variazione.
    expect(articoloMinore(CF_FEMMINA_OMOCODIA)).toBe('della minore')
  })

  it('codice fiscale assente o illeggibile → stringa VUOTA, mai un maschile di comodo', () => {
    expect(articoloMinore(null)).toBe('')
    expect(articoloMinore(undefined)).toBe('')
    expect(articoloMinore('')).toBe('')
    expect(articoloMinore('   ')).toBe('')
    expect(articoloMinore('non-un-codice')).toBe('')
    // Giorno 00: la forma torna, il giorno no → illeggibile, non «maschio».
    expect(articoloMinore('TSTTST00T00T000T')).toBe('')
  })

  it('tollera minuscole e spazi (capita incollando da un PDF)', () => {
    expect(articoloMinore('xxxyyy20a55z999x')).toBe('della minore')
    expect(articoloMinore('XXX YYY 20A15 Z999X')).toBe('del minore')
  })

  it('è un segnaposto reso da renderCausale, e senza CF il segmento resta leggibile', () => {
    expect(renderCausale('a favore {minore} {nome_completo}', { nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_MASCHIO }))
      .toBe('a favore del minore Mario Rossi')
    // Niente doppio spazio dove l’articolo manca: «a favore  Mario Rossi» sarebbe
    // finito così com’è dentro l’XML della fattura.
    expect(renderCausale('a favore {minore} {nome_completo}', { nome: 'Mario', cognome: 'Rossi' }))
      .toBe('a favore Mario Rossi')
    // Nome e CF assenti insieme → il segmento sparisce, «a favore» compreso.
    expect(renderCausale('Retta - a favore {minore} {nome_completo}', { descrizione: 'x' })).toBe('Retta')
  })

  it('è nel catalogo dei segnaposto dell’editor (senza, il chip non esisterebbe)', () => {
    const voce = PLACEHOLDER_CAUSALE.find((p) => p.chiave === 'minore')
    expect(voce, 'il segnaposto {minore} non è nel catalogo PLACEHOLDER_CAUSALE').toBeDefined()
    expect(voce!.label.trim()).not.toBe('')
    expect(voce!.esempio).toBe('del minore')
  })
})

describe('modelloCausale — categoria → «Predefinito» → modello di fabbrica', () => {
  const FABBRICA = 'DI FABBRICA {descrizione}'

  it('la riga della categoria vince su tutto', () => {
    expect(modelloCausale({ default: 'D', retta: 'R' }, 'retta', FABBRICA)).toBe('R')
  })

  it('senza riga per la categoria si usa il «Predefinito»', () => {
    expect(modelloCausale({ default: 'D', mensa: 'M' }, 'retta', FABBRICA)).toBe('D')
    expect(modelloCausale({ default: 'D' }, null, FABBRICA)).toBe('D')
    expect(modelloCausale({ default: 'D' }, undefined, FABBRICA)).toBe('D')
  })

  it('senza «Predefinito» si usa il modello di fabbrica', () => {
    expect(modelloCausale({}, 'retta', FABBRICA)).toBe(FABBRICA)
    expect(modelloCausale(null, 'retta', FABBRICA)).toBe(FABBRICA)
    expect(modelloCausale(undefined, undefined, FABBRICA)).toBe(FABBRICA)
  })

  it('una riga VUOTA o di soli spazi conta come assente (svuotare = tornare al Predefinito)', () => {
    // È la promessa che l’editor fa a chi cancella un campo. Con `??` la stringa
    // vuota sarebbe stata un modello valido, e la causale sarebbe uscita vuota.
    expect(modelloCausale({ default: 'D', retta: '' }, 'retta', FABBRICA)).toBe('D')
    expect(modelloCausale({ default: 'D', retta: '   ' }, 'retta', FABBRICA)).toBe('D')
    expect(modelloCausale({ default: '', retta: '' }, 'retta', FABBRICA)).toBe(FABBRICA)
  })

  it('un valore NON-stringa in archivio non diventa un modello (righe salvate prima del filtro)', () => {
    expect(modelloCausale({ default: 'D', retta: 123 }, 'retta', FABBRICA)).toBe('D')
    expect(modelloCausale({ default: { a: 1 }, retta: null }, 'retta', FABBRICA)).toBe(FABBRICA)
  })

  it('la chiave del «Predefinito» è quella che usa l’editor', () => {
    expect(CHIAVE_CAUSALE_DEFAULT).toBe('default')
    expect(modelloCausale({ [CHIAVE_CAUSALE_DEFAULT]: 'D' }, 'retta', FABBRICA)).toBe('D')
  })

  it('vale anche per il BONIFICO: è la stessa regola, non una copia', () => {
    expect(modelloCausale({}, 'retta', DEFAULT_CAUSALE_TEMPLATE)).toBe(DEFAULT_CAUSALE_TEMPLATE)
  })
})

describe('causaleFattura — la causale del documento fiscale', () => {
  const DATI = {
    descrizione: 'Retta Settembre 2026',
    nome: 'Mario',
    cognome: 'Rossi',
    codiceFiscale: CF_MASCHIO,
    sede: 'Kidville <Sede>',
    mese: 'settembre',
    anno: '2026',
  }

  it('il modello di fabbrica è quello che la segreteria scrive a mano', () => {
    expect(causaleFattura({ dati: DATI }))
      .toBe(`Retta Settembre 2026 - a favore del minore Mario Rossi - CF: ${CF_MASCHIO}`)
  })

  it('la femmina prende «della minore»', () => {
    expect(causaleFattura({ dati: { ...DATI, codiceFiscale: CF_FEMMINA } }))
      .toBe(`Retta Settembre 2026 - a favore della minore Mario Rossi - CF: ${CF_FEMMINA}`)
  })

  it('senza codice fiscale NON resta un «CF:» penzolante', () => {
    // È la ragione per cui i separatori del modello sono « - »: il segmento coi soli
    // segnaposto vuoti sparisce invece di finire mozzato dentro l’XML.
    expect(causaleFattura({ dati: { ...DATI, codiceFiscale: null } }))
      .toBe('Retta Settembre 2026 - a favore Mario Rossi')
  })

  it('usa il modello della CATEGORIA quando c’è, altrimenti il «Predefinito»', () => {
    const config = {
      default: 'FATTURA {descrizione} - {nome_completo}',
      mensa: 'Servizio mensa {mese} {anno} - {nome_completo}',
    }
    expect(causaleFattura({ config, slugCategoria: 'mensa', dati: DATI }))
      .toBe('Servizio mensa settembre 2026 - Mario Rossi')
    expect(causaleFattura({ config, slugCategoria: 'retta', dati: DATI }))
      .toBe('FATTURA Retta Settembre 2026 - Mario Rossi')
  })

  it('la causale scritta a mano sul pagamento VINCE su qualunque modello', () => {
    expect(causaleFattura({
      config: { default: 'FATTURA {descrizione}' },
      slugCategoria: 'retta',
      causaleManuale: 'Contributo straordinario laboratorio musicale',
      dati: DATI,
    })).toBe('Contributo straordinario laboratorio musicale')
  })

  it('una causale manuale VUOTA o di soli spazi non conta come scelta', () => {
    for (const manuale of ['', '   ', null, undefined]) {
      expect(causaleFattura({ causaleManuale: manuale, dati: DATI }))
        .toBe(`Retta Settembre 2026 - a favore del minore Mario Rossi - CF: ${CF_MASCHIO}`)
    }
  })

  it('la causale manuale passa dal motore: su un testo semplice è idempotente', () => {
    // Ri-emettere una fattura non deve cambiare la causale già trasmessa allo SDI:
    // `emissione.ts` riscrive `pagamenti.fattura_causale` con la causale composta, e
    // quella stringa rientra da qui al tentativo successivo.
    const composta = causaleFattura({ dati: DATI })
    expect(causaleFattura({ causaleManuale: composta, dati: DATI })).toBe(composta)
  })

  it('un modello malformato non fa esplodere l’emissione (ricade sul predefinito del motore)', () => {
    const atteso = renderCausale(DEFAULT_CAUSALE_TEMPLATE, DATI)
    expect(causaleFattura({ config: { default: 999 }, dati: DATI }))
      .toBe(`Retta Settembre 2026 - a favore del minore Mario Rossi - CF: ${CF_MASCHIO}`)
    // …e anche un modello non-stringa passato per errore come manuale non lancia.
    expect(causaleFattura({ causaleManuale: 42 as unknown as string, dati: DATI })).not.toBe('')
    expect(atteso).toContain('Mario Rossi')
  })

  it('senza dati non inventa niente', () => {
    expect(causaleFattura({ dati: {} })).toBe('')
  })
})

describe('il limite del campo 2.1.1.11 (Causale) di FatturaPA', () => {
  it('è 200 caratteri', () => {
    expect(LIMITE_CAUSALE_FATTURAPA).toBe(200)
  })

  it('il modello di fabbrica ci sta dentro coi dati d’esempio', () => {
    expect(eccedeLimiteFatturaPA(causaleFattura({
      dati: { descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_MASCHIO },
    }))).toBe(false)
  })

  it('riconosce il superamento sul carattere esatto (200 sì, 201 no)', () => {
    expect(eccedeLimiteFatturaPA('x'.repeat(200))).toBe(false)
    expect(eccedeLimiteFatturaPA('x'.repeat(201))).toBe(true)
    expect(eccedeLimiteFatturaPA('')).toBe(false)
    expect(eccedeLimiteFatturaPA(null as unknown as string)).toBe(false)
  })

  it('una descrizione lunga fa sforare il modello di fabbrica (il caso che il pannello avvisa)', () => {
    const causale = causaleFattura({
      dati: { descrizione: 'Contributo '.repeat(20), nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_MASCHIO },
    })
    expect(causale.length).toBeGreaterThan(LIMITE_CAUSALE_FATTURAPA)
    expect(eccedeLimiteFatturaPA(causale)).toBe(true)
  })

  it('il modello di fabbrica nomina i segnaposto attesi (se cambia, l’anteprima cambia con lui)', () => {
    expect(DEFAULT_CAUSALE_FATTURA_TEMPLATE)
      .toBe('{descrizione} - a favore {minore} {nome_completo} - CF: {codice_fiscale}')
  })
})

/**
 * LA MISURA SI FA SULLA STRINGA CHE FINISCE NEL TRACCIATO, non su quella che si ha
 * in mano — ed è la correzione di un difetto misurato il 2026-08-10.
 *
 * `<Causale>` riceve `testoLatin(causale, 200)`, che prima TRANSLITTERA e poi tronca:
 * `€` → `EUR` (1 carattere che ne diventa 3), `…` → `...`, `™` → `(TM)`. Contando la
 * stringa d'ingresso, una causale di esattamente 200 caratteri che contiene un `€` —
 * cioè il chip `{importo}`, il cui esempio è proprio «€ 150,00» — risultava «dentro il
 * limite», e sul documento usciva mozzata a metà cifra. Il gate del log
 * (`causale-troncata`, in `@/lib/aruba/emissione`) usava la stessa misura sbagliata,
 * quindi il taglio era anche MUTO.
 *
 * Ogni caso qui sotto verifica l'EQUIVALENZA fra il verdetto e il documento vero:
 * `eccedeLimiteFatturaPA` è `true` ⟺ l'XML tronca davvero.
 */
const fatturaCon = (causale: string): FatturaPAInput => ({
  progressivoInvio: '00001',
  numero: 'Asilo 1/2026',
  data: '2026-09-30',
  cedente: {
    piva: '03394870616',
    codiceFiscale: '03394870616',
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    regimeFiscale: 'RF01',
    sede: { indirizzo: 'Via Silvio Pellico 7', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
  },
  // Intestatario SINTETICO: stessa convenzione del resto del file (catastale `Z999`,
  // carattere di controllo che non torna). Il repository è pubblico.
  cessionario: {
    codiceFiscale: CF_MASCHIO,
    nome: 'Mario',
    cognome: 'Rossi',
    sede: { indirizzo: 'Via delle Prove 12', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
  },
  righe: [{ descrizione: 'Retta di frequenza', quantita: 1, prezzoUnitario: 150 }],
  causale,
})

/** Il contenuto dell'elemento `<Causale>` così com'è nell'XML prodotto. */
function causaleNelDocumento(causale: string): string {
  const xml = buildFatturaElettronicaXml(fatturaCon(causale))
  return xml.match(/<Causale>([\s\S]*?)<\/Causale>/)?.[1] ?? ''
}

describe('quanto è lunga DAVVERO una causale: la misura è quella del tracciato', () => {
  it('la translitterazione ALLUNGA, e il conteggio se ne accorge', () => {
    // Un solo carattere d'ingresso, tre nel documento.
    expect(lunghezzaCausaleFatturaPA('€')).toBe(3)
    expect(lunghezzaCausaleFatturaPA('…')).toBe(3)
    expect(lunghezzaCausaleFatturaPA('™')).toBe(4)
    // …e accorcia: ciò che il tracciato non sa scrivere sparisce, i doppi spazi si
    // comprimono. Contare «tanto poi è uguale» non è vero in nessuna delle due direzioni.
    expect(lunghezzaCausaleFatturaPA('a☃b')).toBe(2)
    expect(lunghezzaCausaleFatturaPA('a  b')).toBe(3)
  })

  it('IL CASO DEL PANNELLO: 200 caratteri con «€ 150,00» in coda SFORANO davvero', () => {
    // È l'input esatto che fino al 2026-08-10 il pannello mostrava «200/200» in nero,
    // senza avviso: 191 «y» + spazio + l'esempio del chip {importo}.
    const causale = `${'y'.repeat(191)} € 150,00`
    expect(causale.length).toBe(200) // «sta dentro», se si conta la stringa sbagliata
    expect(lunghezzaCausaleFatturaPA(causale)).toBe(202)
    expect(eccedeLimiteFatturaPA(causale)).toBe(true)

    // E la prova che il verdetto non è un'opinione: l'XML vero taglia l'importo.
    const nelDocumento = causaleNelDocumento(causale)
    expect(nelDocumento.length).toBe(LIMITE_CAUSALE_FATTURAPA)
    expect(nelDocumento.endsWith('EUR 150,')).toBe(true)
    expect(nelDocumento.endsWith('EUR 150,00')).toBe(false)
  })

  it('l’equivalenza vale nei due sensi, sul carattere esatto', () => {
    // 198 «y» + spazio + «€» → 198 + 1 + 3 = 202 nel tracciato: eccede, e viene tagliato.
    const eccede = `${'y'.repeat(198)} €`
    expect(eccedeLimiteFatturaPA(eccede)).toBe(true)
    expect(causaleNelDocumento(eccede).length).toBe(LIMITE_CAUSALE_FATTURAPA)

    // 196 «y» + spazio + «€» → 196 + 1 + 3 = 200 esatti: NON eccede, e non si perde
    // nemmeno un carattere. Senza questo caso il test passerebbe anche con una
    // funzione che risponde sempre «sì».
    const alPelo = `${'y'.repeat(196)} €`
    expect(lunghezzaCausaleFatturaPA(alPelo)).toBe(LIMITE_CAUSALE_FATTURAPA)
    expect(eccedeLimiteFatturaPA(alPelo)).toBe(false)
    expect(causaleNelDocumento(alPelo)).toBe(`${'y'.repeat(196)} EUR`)
  })

  it('il vincolo esportato porta il limite E la misura insieme (il pannello non può prendersene metà)', () => {
    // È la forma che impedisce il difetto di ripetersi: chi mostra il conteggio riceve
    // la funzione che lo rende vero, non il solo numero 200.
    expect(VINCOLO_CAUSALE_FATTURAPA.limiteCaratteri).toBe(LIMITE_CAUSALE_FATTURAPA)
    expect(VINCOLO_CAUSALE_FATTURAPA.perTracciato(`${'y'.repeat(191)} € 150,00`))
      .toBe(`${'y'.repeat(191)} EUR 150,00`)
    // …e la riduzione è IDEMPOTENTE: applicarla all'anteprima già normalizzata non
    // cambia più niente (altrimenti il conteggio a schermo mentirebbe di nuovo).
    const unaVolta = VINCOLO_CAUSALE_FATTURAPA.perTracciato('Retta … € 150,00')
    expect(VINCOLO_CAUSALE_FATTURAPA.perTracciato(unaVolta)).toBe(unaVolta)
  })
})
