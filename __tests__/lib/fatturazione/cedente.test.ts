import { describe, it, expect } from 'vitest'
import {
  CAMPI_CEDENTE,
  CEDENTE_COOPERATIVA,
  LUNGHEZZE_CEDENTE,
  REGIMI_FISCALI,
  REGIME_FISCALE_DEFAULT,
  cedenteCompleto,
  cedenteDaConfig,
  componiIndirizzo,
  partitaIvaValida,
  primoNonVuoto,
  validaCedente,
  type AnagraficaCedente,
} from '@/lib/fatturazione/cedente'
import { codiceFiscaleIntestatarioValido } from '@/lib/fatturazione/cessionario'
import { ARUBA_PEC_PIVA, LIMITI, buildFatturaElettronicaXml, type FatturaPAInput } from '@/lib/aruba/fatturapa-xml'

// =============================================================================
// IL DIFETTO CHE QUESTO FILE ESISTE PER IMPEDIRE
//
// Il pannello Aruba raccoglieva la sede legale come UNA STRINGA LIBERA
// (`aruba_config.fiscal.sede`); `emissione.ts` leggeva invece `fiscal.cap` e
// `fiscal.comune` come campi SEPARATI, che quel pannello non ha mai scritto.
// L'XML usciva con `<CAP></CAP><Comune></Comune>` e lo SDI lo scartava (codici
// 00423 / 00200). Nessun test era rosso, perché tutti i test dell'XML partivano
// da un input GIÀ COMPLETO scritto a mano nel test: nessuno partiva dalla
// CONFIGURAZIONE, che è il punto in cui il dato si perdeva.
//
// Qui si parte dalla configurazione. Le due asserzioni che contano sono che
// `<CAP>` e `<Comune>` non escano MAI vuoti, e che con una configurazione
// incompleta non esca nessuna fattura invece di una fattura sbagliata.
// =============================================================================

/** Il resto del documento: non è l'oggetto del test, serve solo a chiudere l'XML. */
function fattura(cedente: FatturaPAInput['cedente']): string {
  return buildFatturaElettronicaXml({
    progressivoInvio: '02328',
    numero: '2328',
    data: '2026-08-09',
    cedente,
    cessionario: {
      // Dati SINTETICI: nel repository (pubblico) non entrano persone vere.
      codiceFiscale: 'RSSMRA80A01H501U',
      nome: 'Mario',
      cognome: 'Rossi',
      sede: { indirizzo: 'Via Esempio 1', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
    },
    righe: [{ descrizione: 'Retta di agosto', quantita: 1, prezzoUnitario: 180 }],
    causale: 'Retta di agosto',
  })
}

function testo(xml: string, tag: string): string | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const el = doc.getElementsByTagName(tag)[0]
  return el ? el.textContent : null
}

describe('cedenteDaConfig → CedentePrestatore, partendo dalla configurazione vera', () => {
  it('la configurazione reale della cooperativa produce un cedente completo', () => {
    const esito = cedenteDaConfig(CEDENTE_COOPERATIVA)
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.piva).toBe('03394870616')
    expect(esito.cedente.codiceFiscale).toBe('03394870616')
    expect(esito.cedente.regimeFiscale).toBe('RF01')
    // Indirizzo e civico restano SEPARATI fino all'XML: `IndirizzoType` ha un
    // `<NumeroCivico>` apposta, fra `<Indirizzo>` e `<CAP>`, e per il cessionario
    // lo si scriveva già. Il commento che stava qui diceva il contrario («il
    // tracciato ha <Indirizzo>, non <NumeroCivico>»): era falso, e la
    // composizione a mano rischiava di far cadere il civico nel troncamento a 60
    // caratteri dell'indirizzo. Le ricevute restano una riga sola: quella è
    // `componiIndirizzo`, in `datiStruttura`.
    expect(esito.cedente.sede.indirizzo).toBe('Via Silvio Pellico')
    expect(esito.cedente.sede.numeroCivico).toBe('7')
    expect(esito.cedente.sede.cap).toBe('81030')
    expect(esito.cedente.sede.comune).toBe('Cesa')
    expect(esito.cedente.sede.provincia).toBe('CE')
    expect(esito.cedente.sede.nazione).toBe('IT')
  })

  it('L\'XML NON esce con <CAP> o <Comune> vuoti — è il difetto che faceva scartare la fattura', () => {
    const esito = cedenteDaConfig(CEDENTE_COOPERATIVA)
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    const xml = fattura(esito.cedente)

    // Il tag vuoto è il difetto, e va cercato per com'era: `<CAP></CAP>`.
    expect(xml).not.toMatch(/<CAP>\s*<\/CAP>/)
    expect(xml).not.toMatch(/<Comune>\s*<\/Comune>/)
    expect(xml).not.toMatch(/<Indirizzo>\s*<\/Indirizzo>/)
    expect(xml).not.toMatch(/<Denominazione>\s*<\/Denominazione>/)

    // …e i valori sono quelli della configurazione, non un default nascosto.
    expect(xml).toContain('<CAP>81030</CAP>')
    expect(xml).toContain('<Comune>Cesa</Comune>')
    expect(xml).toContain('<Provincia>CE</Provincia>')
    expect(xml).toContain('<Indirizzo>Via Silvio Pellico</Indirizzo>')
    // Il civico esce nel SUO elemento, come per il cessionario.
    const cedenteXml = xml.slice(xml.indexOf('<CedentePrestatore>'), xml.indexOf('</CedentePrestatore>'))
    expect(cedenteXml).toContain('<NumeroCivico>7</NumeroCivico>')
    expect(cedenteXml.indexOf('<NumeroCivico>')).toBeGreaterThan(cedenteXml.indexOf('<Indirizzo>'))
    expect(cedenteXml.indexOf('<NumeroCivico>')).toBeLessThan(cedenteXml.indexOf('<CAP>'))
    expect(testo(xml, 'RegimeFiscale')).toBe('RF01')
    // Il documento resta ben formato con dentro l'apostrofo della denominazione.
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.getElementsByTagName('parsererror').length).toBe(0)
    expect(testo(xml, 'Denominazione')).toBe(CEDENTE_COOPERATIVA.denominazione)
  })

  it('la vecchia configurazione (sede legale in UNA stringa libera) non produce nessuna fattura', () => {
    // È esattamente ciò che il pannello Aruba salvava: `sede` piena, `cap` e
    // `comune` mai scritti. Prima usciva un XML con i tag vuoti; ora non esce
    // niente, e si sa quali campi mancano.
    const esito = cedenteDaConfig(null, {
      piva: '03394870616',
      cf: '03394870616',
      ragione_sociale: CEDENTE_COOPERATIVA.denominazione,
      sede: 'Via Silvio Pellico 7, 81030 Cesa (CE)',
      regime: 'RF01',
    })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.mancanti).toEqual(['indirizzo', 'cap', 'comune', 'provincia'])
    expect(esito.errori.cap).toBe('mancante')
    expect(esito.errori.comune).toBe('mancante')
    // Il messaggio dice all'operatore dove si ripara, non solo che è rotto.
    expect(esito.messaggio).toContain('CAP')
    expect(esito.messaggio).toContain('Dati fiscali')
  })

  it('`fiscale_config` prevale, `aruba_config.fiscal` resta il ripiego di chi era già configurato', () => {
    const esito = cedenteDaConfig(
      { denominazione: 'Cooperativa Nuova', piva: '03394870616', indirizzo: 'Via Nuova', numero_civico: '3' },
      { ragione_sociale: 'Vecchia Ragione', piva: '11111111111', cap: '81030', comune: 'Cesa', provincia: 'ce' },
    )
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.denominazione).toBe('Cooperativa Nuova')
    expect(esito.cedente.piva).toBe('03394870616')
    expect(esito.cedente.sede.indirizzo).toBe('Via Nuova')
    expect(esito.cedente.sede.numeroCivico).toBe('3')
    // I campi che `fiscale_config` non ha arrivano dal ripiego, la provincia
    // normalizzata in maiuscolo (lo SDI vuole la sigla).
    expect(esito.cedente.sede.cap).toBe('81030')
    expect(esito.cedente.sede.provincia).toBe('CE')
  })

  it('una chiave salvata VUOTA non azzera il ripiego (è "non configurata", non "configurata a nulla")', () => {
    const esito = cedenteDaConfig(
      { denominazione: '', piva: '', indirizzo: 'Via Silvio Pellico', numero_civico: '7', cap: '', comune: '', provincia: '' },
      {
        ragione_sociale: CEDENTE_COOPERATIVA.denominazione,
        piva: '03394870616',
        cap: '81030',
        comune: 'Cesa',
        provincia: 'CE',
      },
    )
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.sede.cap).toBe('81030')
    expect(esito.cedente.sede.comune).toBe('Cesa')
  })

  it('configurazione del tutto assente: nessuna fattura, e l\'elenco completo di cosa manca', () => {
    const esito = cedenteDaConfig(null, null)
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    // Il regime fiscale NON è fra i mancanti: vuoto vale RF01.
    expect(esito.mancanti).toEqual(['denominazione', 'piva', 'indirizzo', 'cap', 'comune', 'provincia'])
    expect(esito.mancanti).not.toContain('regime_fiscale')
    expect(esito.mancanti).not.toContain('numero_civico')
  })

  it('il regime fiscale vuoto vale RF01, quello scritto male è un errore', () => {
    const base: AnagraficaCedente = { ...CEDENTE_COOPERATIVA, regime_fiscale: '' }
    const esito = cedenteDaConfig(base)
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.regimeFiscale).toBe(REGIME_FISCALE_DEFAULT)

    const rotto = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, regime_fiscale: 'ordinario' })
    expect(rotto.ok).toBe(false)
    if (rotto.ok) return
    expect(rotto.errori.regime_fiscale).toBe('formato')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // «RF» PIÙ DUE CIFRE NON È UN REGIME FISCALE.
  //
  // Fino al 2026-08-10 il controllo era `/^RF\d{2}$/`: `RF03` e `RF00` — i due
  // codici che sceglie chi conta a mano — passavano il pannello e l'emissione,
  // che ALLOCA un numero sul sezionale prima di comporre l'XML. Risultato: un
  // progressivo bruciato su un registro fiscale e uno scarto SDI che si scopre
  // per PEC. `RF03` non esiste: l'enumerazione dello schema salta dal 02 al 04.
  // ───────────────────────────────────────────────────────────────────────────
  it('un regime fuori enumerazione non passa: RF03 e RF00 NON esistono', () => {
    for (const regime of ['RF03', 'RF00', 'RF87', 'RF99', 'RF1', 'XX01']) {
      const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, regime_fiscale: regime })
      expect(esito.ok, `regime «${regime}»`).toBe(false)
      if (esito.ok) continue
      expect(esito.errori.regime_fiscale, `regime «${regime}»`).toBe('formato')
      expect(esito.mancanti).toContain('regime_fiscale')
    }
  })

  it('tutti e 19 i regimi dello schema passano, e ne escono in maiuscolo', () => {
    // Non solo RF01: chi ha un forfettario (RF19) o un regime speciale deve poter
    // fatturare. `RF20` è compreso — il messaggio d'errore diceva «RF01…RF19» e
    // l'avrebbe lasciato fuori a parole.
    expect(REGIMI_FISCALI).toHaveLength(19)
    expect(REGIMI_FISCALI).not.toContain('RF03')
    for (const regime of REGIMI_FISCALI) {
      const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, regime_fiscale: regime })
      expect(esito.ok, `regime «${regime}»`).toBe(true)
      if (!esito.ok) continue
      expect(esito.cedente.regimeFiscale).toBe(regime)
    }
    // Scritto minuscolo è lo stesso regime, non un documento da far scartare:
    // nel tracciato ci finisce comunque in maiuscolo.
    const minuscolo = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, regime_fiscale: 'rf19' })
    expect(minuscolo.ok).toBe(true)
    if (!minuscolo.ok) return
    expect(minuscolo.cedente.regimeFiscale).toBe('RF19')
  })

  it('un CAP di 4 cifre è un difetto quanto un CAP assente (lo SDI scarta uguale)', () => {
    const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, cap: '8103' })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.errori.cap).toBe('formato')
  })
})

describe('validaCedente — le stesse regole del pannello e del server', () => {
  it('i dati reali della cooperativa passano la validazione (il precompilato non è una bugia)', () => {
    expect(validaCedente(CEDENTE_COOPERATIVA)).toEqual({})
    expect(cedenteCompleto(CEDENTE_COOPERATIVA)).toBe(true)
  })

  it('obbligatori: denominazione, P.IVA, indirizzo, CAP, comune, provincia', () => {
    expect(validaCedente({})).toEqual({
      denominazione: 'mancante',
      piva: 'mancante',
      indirizzo: 'mancante',
      cap: 'mancante',
      comune: 'mancante',
      provincia: 'mancante',
    })
  })

  it('P.IVA di 11 cifre, provincia di 2 lettere, CAP di 5 cifre', () => {
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, piva: '0339487061' }).piva).toBe('formato')
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, piva: '0339487061X' }).piva).toBe('formato')
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, provincia: 'Caserta' }).provincia).toBe('formato')
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, provincia: 'C1' }).provincia).toBe('formato')
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, cap: '810300' }).cap).toBe('formato')
  })

  it('il codice fiscale è facoltativo, ma se c\'è vale 11 cifre (ente) o 16 caratteri (persona)', () => {
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, codice_fiscale: '' }).codice_fiscale).toBeUndefined()
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, codice_fiscale: 'RSSMRA80A01H501U' }).codice_fiscale).toBeUndefined()
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, codice_fiscale: '12345' }).codice_fiscale).toBe('formato')
  })

  it('gli spazi ai bordi non contano come dato: «  » è vuoto', () => {
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, comune: '   ' }).comune).toBe('mancante')
  })

  it('CAMPI_CEDENTE elenca tutte e sole le chiavi dell\'anagrafica', () => {
    expect([...CAMPI_CEDENTE].sort()).toEqual(Object.keys(CEDENTE_COOPERATIVA).sort())
  })
})

describe('componiIndirizzo / primoNonVuoto', () => {
  it('via e civico si uniscono con uno spazio, e il civico mancante non lascia code', () => {
    expect(componiIndirizzo('Via Silvio Pellico', '7')).toBe('Via Silvio Pellico 7')
    expect(componiIndirizzo('Via Silvio Pellico', '')).toBe('Via Silvio Pellico')
    expect(componiIndirizzo('  Via Silvio Pellico  ', '  7 ')).toBe('Via Silvio Pellico 7')
    expect(componiIndirizzo('', '')).toBe('')
  })

  it('primoNonVuoto salta le stringhe vuote e quelle di soli spazi', () => {
    expect(primoNonVuoto('', '  ', 'terzo')).toBe('terzo')
    expect(primoNonVuoto(null, undefined)).toBe('')
  })
})

// =============================================================================
// UNA SOLA DEFINIZIONE DI «CODICE FISCALE», PER IL CEDENTE COME PER CHI RICEVE.
//
// Fino al 2026-08-10 questo modulo aveva la sua regex —
// `^[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]$` — cioè ESATTAMENTE la
// forma che `cessionario.ts` dichiara sbagliata a parole: nei codici omocodici
// l'Agenzia sostituisce le cifre con `L M N P Q R S T U V`, e quella regex
// rifiuta un codice fiscale VERO. Conseguenza misurabile: un cedente persona
// fisica con codice omocodico non riusciva a salvare l'anagrafica (il pannello
// gli diceva «è di 11 cifre o 16 caratteri» su un valore corretto) e
// `cedenteDaConfig` rispondeva `ok:false`, cioè 503 e nessuna fattura.
// =============================================================================
describe('il codice fiscale del cedente segue la regola dell\'intestatario, omocodia compresa', () => {
  // Dati SINTETICI: nel repository (pubblico) non entrano persone vere.
  const OMOCODICO = 'RSSMRALMA0MH50MU'

  it('un codice omocodico è valido qui come lo è per il cessionario', () => {
    expect(codiceFiscaleIntestatarioValido(OMOCODICO)).toBe(true)
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, codice_fiscale: OMOCODICO }).codice_fiscale).toBeUndefined()
    const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, codice_fiscale: OMOCODICO })
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.codiceFiscale).toBe(OMOCODICO)
  })

  it('le due strade danno la STESSA risposta, valore per valore', () => {
    // Il difetto non era «una regex severa»: era che la stessa domanda aveva due
    // risposte in due file. Qui si misura che non ne abbia più due.
    for (const cf of [OMOCODICO, 'RSSMRA80A01H501U', '03394870616', '12345', 'RSSMRA80A01H501', 'XXXX99X99X999X', '']) {
      const atteso = cf === '' ? undefined : codiceFiscaleIntestatarioValido(cf) ? undefined : 'formato'
      expect(validaCedente({ ...CEDENTE_COOPERATIVA, codice_fiscale: cf }).codice_fiscale, `cf «${cf}»`).toBe(atteso)
    }
  })

  it('incollato a gruppi passa la validazione E arriva nel tracciato senza spazi', () => {
    // «RSS MRA 80A01 H501U» è un dato giusto scritto come lo copia un gestionale.
    // Accettarlo e poi scriverlo con dentro gli spazi sarebbe peggio che
    // rifiutarlo: il documento partirebbe e lo SDI lo scarterebbe.
    const conSpazi = 'RSS MRA 80A01 H501U'
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, codice_fiscale: conSpazi }).codice_fiscale).toBeUndefined()
    const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, codice_fiscale: conSpazi, piva: '033 9487 0616' })
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.codiceFiscale).toBe('RSSMRA80A01H501U')
    expect(esito.cedente.piva).toBe('03394870616')
    const xml = fattura(esito.cedente)
    expect(testo(xml, 'CodiceFiscale')).toBe('RSSMRA80A01H501U')
    // `<IdCodice>` compare due volte (trasmittente Aruba, poi cedente): si guarda
    // il documento intero, dove nessuno dei due valori porta spazi dentro.
    expect(xml).toContain('<IdCodice>03394870616</IdCodice>')
    expect(xml).not.toContain('033 9487')
    expect(xml).not.toContain('RSS MRA')
  })
})

// =============================================================================
// LE LUNGHEZZE SI DECIDONO QUI, NON NEL `.slice()` DEL GENERATORE.
//
// `LIMITI.numeroCivico` è 8 (`NumeroCivicoType` dello XSD) e `normalizza()`
// chiude con `.slice(0, max)`. Il pannello invitava a scriverne DIECI: il civico
// `27/B int.3` finiva nell'XML come `27/B int` — nessun errore, nessun log,
// nessun controllo — e la fattura partiva verso una porta che non esiste. Lo
// stesso valeva, in scala maggiore, per denominazione (80), indirizzo (60) e
// comune (60).
// =============================================================================
describe('lunghezze del cedente: si segnalano, non si tagliano di nascosto', () => {
  it('LUNGHEZZE_CEDENTE non è una seconda copia: sono i numeri dello XSD', () => {
    // Due copie dello stesso limite divergono, e quando divergono vince quella
    // che tronca. Questo caso è il lucchetto.
    expect(LUNGHEZZE_CEDENTE).toEqual({
      denominazione: LIMITI.denominazione,
      indirizzo: LIMITI.indirizzo,
      numero_civico: LIMITI.numeroCivico,
      comune: LIMITI.comune,
      // `EmailContattiType`: 256. Il campo è nato il 2026-08-10 insieme a
      // `<Contatti><Email>`, che sulle fatture vere c'è sempre e da noi non
      // usciva mai.
      email: LIMITI.email,
    })
    expect(LIMITI.numeroCivico).toBe(8)
    expect(LIMITI.email).toBe(256)
  })

  it('il civico di 10 caratteri che il pannello accettava ora è un errore, non un taglio', () => {
    const civico = '27/B int.3'
    expect(civico).toHaveLength(10)
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, numero_civico: civico }).numero_civico).toBe('lungo')

    const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, numero_civico: civico })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.mancanti).toContain('numero_civico')
    expect(esito.messaggio).toContain('numero civico (troppo lungo)')
  })

  it('il civico entro gli 8 caratteri resta buono (non si è chiuso un caso legittimo)', () => {
    const esito = cedenteDaConfig({ ...CEDENTE_COOPERATIVA, numero_civico: '27/B int' })
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.cedente.sede.numeroCivico).toBe('27/B int')
  })

  it('denominazione, indirizzo e comune oltre il limite: nessuna fattura invece di una fattura tagliata', () => {
    const casi: { campo: 'denominazione' | 'indirizzo' | 'comune'; max: number }[] = [
      { campo: 'denominazione', max: LIMITI.denominazione },
      { campo: 'indirizzo', max: LIMITI.indirizzo },
      { campo: 'comune', max: LIMITI.comune },
    ]
    for (const { campo, max } of casi) {
      const dentro = 'A'.repeat(max)
      const fuori = 'A'.repeat(max + 1)
      expect(validaCedente({ ...CEDENTE_COOPERATIVA, [campo]: dentro })[campo], `${campo} a ${max}`).toBeUndefined()
      expect(validaCedente({ ...CEDENTE_COOPERATIVA, [campo]: fuori })[campo], `${campo} a ${max + 1}`).toBe('lungo')
      expect(cedenteDaConfig({ ...CEDENTE_COOPERATIVA, [campo]: fuori }).ok).toBe(false)
    }
  })

  it('un campo che manca non è anche «troppo lungo»: un difetto, un motivo', () => {
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, comune: '' }).comune).toBe('mancante')
  })
})

// =============================================================================
// LA P.IVA HA UN CARATTERE DI CONTROLLO, E LO SDI LO VERIFICA (scarto 00305).
//
// «Undici cifre» non è la regola: `03394870615` — la P.IVA vera con l'ultima
// cifra sbagliata — ha undici cifre, passa lo XSD, fa ALLOCARE un numero sul
// sezionale (che non si restituisce) e torna indietro come scarto giorni dopo,
// per PEC. Il controllo costa dieci moltiplicazioni e si fa prima di tutto.
// =============================================================================
describe('la P.IVA del cedente si verifica col carattere di controllo', () => {
  it('la P.IVA vera della cooperativa passa, quella con l\'ultima cifra storta no', () => {
    expect(partitaIvaValida(CEDENTE_COOPERATIVA.piva)).toBe(true)
    expect(partitaIvaValida('03394870615')).toBe(false)
    expect(validaCedente({ ...CEDENTE_COOPERATIVA, piva: '03394870615' }).piva).toBe('formato')
    expect(cedenteDaConfig({ ...CEDENTE_COOPERATIVA, piva: '03394870615' }).ok).toBe(false)
  })

  it('undici cifre qualsiasi non bastano più', () => {
    for (const piva of ['11111111111', '00000000001', '12345678901']) {
      expect(partitaIvaValida(piva), `piva «${piva}»`).toBe(false)
    }
    // E ciò che non ha undici cifre resta fuori come prima.
    expect(partitaIvaValida('0339487061')).toBe(false)
    expect(partitaIvaValida('0339487061X')).toBe(false)
    expect(partitaIvaValida(undefined)).toBe(false)
  })

  it('le P.IVA vere che questo codice usa davvero sono valide', () => {
    // `ARUBA_PEC_PIVA` finisce nell'`IdTrasmittente` di OGNI fattura: se il
    // controllo bocciasse questa, sarebbe il controllo a essere sbagliato.
    expect(partitaIvaValida(ARUBA_PEC_PIVA)).toBe(true)
    expect(partitaIvaValida('  03394870616  ')).toBe(true)
  })
})
