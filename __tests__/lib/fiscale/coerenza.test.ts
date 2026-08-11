import { describe, it, expect } from 'vitest'
import { verificaCoerenza } from '@/lib/fiscale/coerenza'
import type { DatiPerCoerenza } from '@/lib/fiscale/coerenza'

/**
 * ⚠️ CONVENZIONE DEI DATI DI PROVA (la stessa di `calcolo.test.ts` e `validazione.test.ts`).
 *
 * Repository PUBBLICO, dominio: minori. Qui le checksum devono tornare — è l'oggetto del
 * collaudo — quindi l'impossibilità dei codici è garantita dal CODICE CATASTALE `Z999` /
 * `Z998`, serie `Z9xx` non assegnata ad alcuno stato, e da terzine (`XQQ`, `YKV`) che
 * vengono da un cognome e un nome inventati e impronunciabili.
 */

/** «XQQWZ YJKVB», maschio, 7 marzo 2019, catastale Z999. */
const CF_MASCHIO = 'XQQYKV19C07Z999T'
/** Gli stessi dati al femminile: cambia il giorno (+40) e cambia il controllo. */
const CF_FEMMINA = 'XQQYKV19C47Z999X'
/** Omocodia PIENA sullo stesso codice: sedici caratteri, zero cifre. */
const CF_OMOCODICO = 'XQQYKVMVCLTZVVVV'

const DATI: DatiPerCoerenza = {
  cognome: 'XQQWZ',
  nome: 'YJKVB',
  sesso: 'M',
  dataNascita: '2019-03-07',
  codiceBelfiore: 'Z999',
}

const TUTTI_I_CAMPI = ['cognome', 'nome', 'data-nascita', 'sesso', 'luogo-nascita']

describe('verificaCoerenza — tutto torna', () => {
  it('anagrafica completa e codice giusto', () => {
    expect(verificaCoerenza(CF_MASCHIO, DATI)).toEqual({
      coerente: true,
      motivi: [],
      nonVerificabili: [],
      codiceAtteso: CF_MASCHIO,
      codiceEsaminato: CF_MASCHIO,
    })
  })

  it('minuscole, spazi e catastale in minuscolo non spostano niente', () => {
    const esito = verificaCoerenza(' xqq ykv 19c07 z999t ', {
      cognome: ' xqq wz ', nome: 'yjkvb', sesso: 'm', dataNascita: ' 2019-03-07 ', codiceBelfiore: 'z999',
    })
    expect(esito.coerente).toBe(true)
    expect(esito.motivi).toEqual([])
    expect(esito.codiceEsaminato).toBe(CF_MASCHIO)
  })

  /**
   * Un codice OMOCODICO è legittimo: l'ha assegnato l'Agenzia. Si confronta la sua BASE
   * (le lettere riportate a cifra) col codice calcolato, non il codice così com'è —
   * altrimenti ogni omocodia risulterebbe incoerente, e a torto.
   */
  it('codice omocodico legittimo: COERENTE, e il codice atteso resta quello senza omocodia', () => {
    const esito = verificaCoerenza(CF_OMOCODICO, DATI)
    expect(esito.coerente).toBe(true)
    expect(esito.motivi).toEqual([])
    expect(esito.codiceEsaminato).toBe(CF_OMOCODICO)
    expect(esito.codiceAtteso).toBe(CF_MASCHIO)
  })

  it('femmina: il +40 sul giorno non è una discordanza', () => {
    const esito = verificaCoerenza(CF_FEMMINA, { ...DATI, sesso: 'F' })
    expect(esito.coerente).toBe(true)
    expect(esito.motivi).toEqual([])
  })
})

describe('verificaCoerenza — discordanze vere, campo per campo', () => {
  const casi: Array<[string, Partial<DatiPerCoerenza>, string]> = [
    ['cognome', { cognome: 'ZZWQP' }, 'cognome'],
    ['nome', { nome: 'BCDFG' }, 'nome'],
    ['data di nascita', { dataNascita: '2019-03-08' }, 'data-nascita'],
    ['mese di nascita', { dataNascita: '2019-04-07' }, 'data-nascita'],
    ['anno di nascita', { dataNascita: '2018-03-07' }, 'data-nascita'],
    ['sesso', { sesso: 'F' }, 'sesso'],
    ['luogo di nascita', { codiceBelfiore: 'Z998' }, 'luogo-nascita'],
  ]

  for (const [nome, modifica, motivo] of casi) {
    it(`${nome} diverso → motivo «${motivo}», e nient'altro`, () => {
      const esito = verificaCoerenza(CF_MASCHIO, { ...DATI, ...modifica })
      expect(esito.motivi).toEqual([motivo])
      expect(esito.coerente).toBe(false)
      expect(esito.nonVerificabili).toEqual([])
    })
  }

  it('più campi discordi: tutti i motivi, in ordine stabile', () => {
    const esito = verificaCoerenza(CF_MASCHIO, {
      cognome: 'ZZWQP', nome: 'BCDFG', sesso: 'F', dataNascita: '2018-04-08', codiceBelfiore: 'Z998',
    })
    expect(esito.motivi).toEqual(['cognome', 'nome', 'data-nascita', 'sesso', 'luogo-nascita'])
    expect(esito.coerente).toBe(false)
  })

  it('la discordanza sul CODICE non nasconde quella sull’anagrafica: si guarda la base', () => {
    // stesso codice omocodico di prima, ma con un cognome che non c'entra
    const esito = verificaCoerenza(CF_OMOCODICO, { ...DATI, cognome: 'ZZWQP' })
    expect(esito.motivi).toEqual(['cognome'])
  })

  /**
   * La data si verifica INDIPENDENTEMENTE dal sesso e viceversa: il giorno del codice si
   * riporta sotto i 40 prima del confronto. Senza questa separazione, un'anagrafica senza
   * sesso renderebbe non verificabile anche la data — che invece nel codice c'è.
   */
  it('la data si verifica anche su un codice FEMMINILE quando il sesso in anagrafica manca', () => {
    const esito = verificaCoerenza(CF_FEMMINA, { ...DATI, sesso: null })
    expect(esito.motivi).toEqual([])
    expect(esito.nonVerificabili).toEqual(['sesso'])
    expect(esito.coerente).toBe(true)
  })

  it('il sesso si verifica anche quando la data in anagrafica manca', () => {
    const esito = verificaCoerenza(CF_FEMMINA, { ...DATI, dataNascita: null, sesso: 'M' })
    expect(esito.motivi).toEqual(['sesso'])
    expect(esito.nonVerificabili).toEqual(['data-nascita'])
  })
})

/**
 * ⚠️⚠️ LA REGOLA PIÙ IMPORTANTE DI TUTTO IL MODULO.
 *
 * Un dato MANCANTE non produce mai un motivo di incoerenza: produce un `nonVerificabile`.
 *
 * Non è una raffinatezza, è una misura. Sul database di PRODUZIONE, il 2026-08-10:
 * su 33 alunni 18 non hanno codice fiscale, 18 non hanno il comune di nascita, 17 non
 * hanno nemmeno il sesso; su 50 genitori 27 non hanno codice fiscale. Senza questa regola
 * il pannello di verifica marcherebbe rosso 45 record su 83 per un dato che nessuno ha mai
 * inserito — e un pannello che segnala tutto non segnala niente.
 */
describe('verificaCoerenza — quello che MANCA non è quello che è SBAGLIATO', () => {
  it('campo per campo: assente, vuoto, di soli spazi, senza lettere latine → non verificabile', () => {
    const assenze: Array<[keyof DatiPerCoerenza, unknown, string]> = [
      ['cognome', null, 'cognome'],
      ['cognome', '', 'cognome'],
      ['cognome', '   ', 'cognome'],
      ['cognome', 'ИВАНОВ', 'cognome'],
      ['nome', null, 'nome'],
      ['nome', undefined, 'nome'],
      ['dataNascita', null, 'data-nascita'],
      ['dataNascita', '', 'data-nascita'],
      ['dataNascita', '07/03/2019', 'data-nascita'],
      ['dataNascita', '2019-02-30', 'data-nascita'],
      ['sesso', null, 'sesso'],
      ['sesso', '', 'sesso'],
      ['sesso', 'X', 'sesso'],
      ['codiceBelfiore', null, 'luogo-nascita'],
      ['codiceBelfiore', '', 'luogo-nascita'],
      ['codiceBelfiore', 'Giugliano in Campania', 'luogo-nascita'],
    ]
    for (const [campo, valore, atteso] of assenze) {
      const esito = verificaCoerenza(CF_MASCHIO, { ...DATI, [campo]: valore })
      expect(esito.motivi).toEqual([])
      expect(esito.nonVerificabili).toEqual([atteso])
      expect(esito.coerente).toBe(true)
    }
  })

  /** Lo stato «verificato per quel che si poteva, e torna» è LEGITTIMO, non un ripiego. */
  it('coerente = true con nonVerificabili NON vuoto è uno stato legittimo', () => {
    const esito = verificaCoerenza(CF_MASCHIO, { cognome: 'XQQWZ', nome: null, sesso: null, dataNascita: null, codiceBelfiore: null })
    expect(esito.coerente).toBe(true)
    expect(esito.motivi).toEqual([])
    expect(esito.nonVerificabili).toEqual(['nome', 'data-nascita', 'sesso', 'luogo-nascita'])
    expect(esito.codiceAtteso).toBeNull() // non si può calcolare: mancano quattro pezzi su cinque
  })

  it('anagrafica del tutto vuota e codice valido: niente di rosso, niente di verificato', () => {
    const esito = verificaCoerenza(CF_MASCHIO, {})
    expect(esito.coerente).toBe(true)
    expect(esito.motivi).toEqual([])
    expect(esito.nonVerificabili).toEqual(TUTTI_I_CAMPI)
    expect(esito.codiceAtteso).toBeNull()
    expect(esito.codiceEsaminato).toBe(CF_MASCHIO)
  })

  it('un campo mancante e un altro discorde convivono senza confondersi', () => {
    const esito = verificaCoerenza(CF_MASCHIO, { ...DATI, cognome: 'ZZWQP', sesso: null })
    expect(esito.motivi).toEqual(['cognome'])
    expect(esito.nonVerificabili).toEqual(['sesso'])
    expect(esito.coerente).toBe(false)
  })
})

describe('verificaCoerenza — il CODICE FISCALE assente', () => {
  /**
   * Il codice fiscale assente è l'assenza dell'OGGETTO della verifica, non una
   * contraddizione: sono i 45 record su 83 della misura qui sopra. Perciò `coerente`
   * resta `true` e `motivi` resta VUOTO — così anche il consumatore più ingenuo
   * (`coerente ? verde : rosso`) non dipinge di rosso mezzo istituto.
   *
   * Quello che il pannello ha, per distinguere «verificato» da «non c'era niente da
   * verificare», è `codiceEsaminato === ''` e i cinque campi in `nonVerificabili`.
   */
  it('assente in tutte le sue forme: nessun motivo, tutto non verificabile', () => {
    for (const valore of [null, undefined, '', '    ', 12345, {}]) {
      const esito = verificaCoerenza(valore, DATI)
      expect(esito.coerente).toBe(true)
      expect(esito.motivi).toEqual([])
      expect(esito.nonVerificabili).toEqual(TUTTI_I_CAMPI)
      expect(esito.codiceEsaminato).toBe('')
    }
  })

  it('senza codice, il codice ATTESO si calcola lo stesso: è il suggerimento da mostrare', () => {
    expect(verificaCoerenza(null, DATI).codiceAtteso).toBe(CF_MASCHIO)
  })

  it('senza codice E senza anagrafica non resta niente, e non è un errore', () => {
    const esito = verificaCoerenza(null, {})
    expect(esito).toEqual({
      coerente: true,
      motivi: [],
      nonVerificabili: TUTTI_I_CAMPI,
      codiceAtteso: null,
      codiceEsaminato: '',
    })
  })
})

describe('verificaCoerenza — il CODICE FISCALE c’è ma è rotto', () => {
  /**
   * Qui invece è rosso: qualcuno ha scritto qualcosa, e quel qualcosa non è un codice
   * fiscale. È il caso dei 30 codici da 14 caratteri contati in produzione il 2026-08-10.
   * Nessun campo si può verificare — la base non è affidabile — quindi tutti e cinque
   * restano fra i non verificabili ACCANTO al motivo, non al posto suo.
   */
  const rotti: Array<[string, string, string]> = [
    ['quattordici caratteri (il caso di produzione)', 'XQQYKV19C07Z99', 'cf-lunghezza'],
    ['sedici caratteri di cui due di impaginazione character(16)', 'XQQYKV19C07Z99  ', 'cf-lunghezza'],
    ['un carattere solo', 'X', 'cf-lunghezza'],
    ['forma sbagliata (mese inesistente)', 'XQQYKV19Z07Z999T', 'cf-forma'],
    ['forma sbagliata (cifra fra le prime sei lettere)', 'XQ1YKV19C07Z999T', 'cf-forma'],
    ['carattere di controllo sbagliato', 'XQQYKV19C07Z999A', 'cf-checksum'],
    // Il giorno impossibile: forma e checksum tornano, la scala 1–31 / 41–71 no.
    ['giorno inesistente (35)', 'XQQYKV19C35Z999S', 'cf-giorno'],
    ['giorno inesistente (00)', 'XQQYKV19C00Z999D', 'cf-giorno'],
    // La data impossibile: il giorno sta nella scala, ma quel mese non ce l'ha.
    ['data inesistente (31 febbraio)', 'XQQYKV19B31Z999A', 'cf-data-inesistente'],
    ['data inesistente (31 aprile al femminile)', 'XQQYKV19D71Z999L', 'cf-data-inesistente'],
    ['data inesistente (29 febbraio non bisestile)', 'XQQYKV19B29Z999U', 'cf-data-inesistente'],
  ]

  for (const [nome, valore, motivo] of rotti) {
    it(`${nome} → «${motivo}», e niente si può verificare`, () => {
      const esito = verificaCoerenza(valore, DATI)
      expect(esito.coerente).toBe(false)
      expect(esito.motivi).toEqual([motivo])
      expect(esito.nonVerificabili).toEqual(TUTTI_I_CAMPI)
      expect(esito.codiceAtteso).toBe(CF_MASCHIO) // il suggerimento resta
    })
  }
})

describe('verificaCoerenza — il ROSSO FALSO su un cognome non italiano', () => {
  /**
   * ⚠️ IL DANNO VERO DEL DIFETTO DELLE LETTERE NON DECOMPONIBILI, misurato dove si vede:
   * non un suggerimento brutto, ma un bambino il cui codice fiscale è GIUSTO marcato
   * `coerente: false` con motivo `cognome`.
   *
   * Prima della correzione `ŁUKASZ` dava terzina `KSZ` (la Ł buttata via) mentre il codice
   * vero comincia per `LKS`: le due stringhe non coincidevano e il pannello dipingeva di
   * rosso un'anagrafica sana. È esattamente il danno che il file dichiara di voler evitare.
   */
  const CF_LUKASZ = 'LKSYKV19C07Z999Y'

  it('un cognome con la L sbarrata NON produce un motivo «cognome»', () => {
    const esito = verificaCoerenza(CF_LUKASZ, { ...DATI, cognome: 'ŁUKASZ' })
    expect(esito.motivi).toEqual([])
    expect(esito.coerente).toBe(true)
    expect(esito.nonVerificabili).toEqual([])
    expect(esito.codiceAtteso).toBe(CF_LUKASZ)
  })

  /**
   * L'altra faccia: un cognome che contiene una lettera non traducibile non diventa un
   * rosso: diventa un GRIGIO. `nonVerificabili` contiene `cognome`, `motivi` resta vuoto,
   * e gli altri quattro campi si confrontano lo stesso. È la regola cardine del file.
   */
  it('un cognome che non si sa leggere finisce fra i NON VERIFICABILI, non fra i motivi', () => {
    const esito = verificaCoerenza(CF_MASCHIO, { ...DATI, cognome: 'ИВАНОВ' })
    expect(esito.motivi).toEqual([])
    expect(esito.coerente).toBe(true)
    expect(esito.nonVerificabili).toEqual(['cognome'])
    expect(esito.codiceAtteso).toBeNull() // senza cognome leggibile non si suggerisce nulla
  })
})
