import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  annoScolasticoDiCompetenza,
  sezionalePerMinore,
  formattaNumeroFattura,
} from '@/lib/fatturazione/sezionale'

/**
 * ⚠️ Codici fiscali SINTETICI e impossibili: terna `XXXYYY`, catastale `Z999`,
 * carattere di controllo `X` (checksum volutamente sbagliata). Nessuno può appartenere
 * a una persona reale — il repository è pubblico e il dominio sono minori.
 *
 * Regola sotto esame: **compie 3 anni entro il 30 aprile dell'anno scolastico → FPR**,
 * dopo → Asilo. Per l'anno scolastico 2026 (cioè 2026/2027) il confine è il 30/04/2027,
 * quindi la data di nascita di confine è il **30/04/2024**.
 */

const ANNO = 2026

/**
 * L'esito ATTESO al completo: sette campi, sempre tutti e sette.
 *
 * Serve a tenere `toEqual` **esatto** invece di scivolare su `toMatchObject`: è
 * esattamente così che il difetto è passato inosservato — un codice fiscale illeggibile
 * dava un esito byte per byte identico a un codice fiscale assente, e nessun `toEqual`
 * poteva accorgersene perché il campo che li distingue non esisteva. Le bandiere si
 * dichiarano solo quando sono `true`, così ogni caso dice a voce alta quale segnale alza.
 *
 * Dal 2026-08-10 i campi sono sette e non più cinque: `…Implausibile` distingue il campo
 * che si legge benissimo ma descrive un'altra persona (il codice fiscale del genitore nel
 * campo del bambino) dal campo che non si legge affatto.
 */
function atteso(
  sezionale: 'Asilo' | 'FPR',
  fonte: 'cf' | 'data_nascita',
  bandiere: Partial<{
    discordanza: boolean
    codiceFiscaleIlleggibile: boolean
    dataNascitaIlleggibile: boolean
    codiceFiscaleImplausibile: boolean
    dataNascitaImplausibile: boolean
  }> = {},
) {
  return {
    sezionale,
    fonte,
    discordanza: false,
    codiceFiscaleIlleggibile: false,
    dataNascitaIlleggibile: false,
    codiceFiscaleImplausibile: false,
    dataNascitaImplausibile: false,
    ...bandiere,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('sezionalePerMinore — il confine del 30 aprile', () => {
  it('nato il 30 aprile ESATTO: compie 3 anni «entro» → FPR', () => {
    expect(sezionalePerMinore({ dataNascita: '2024-04-30', annoScolastico: ANNO }))
      .toEqual(atteso('FPR', 'data_nascita'))
  })

  it('nato il 1° maggio, un giorno dopo il confine → Asilo', () => {
    expect(sezionalePerMinore({ dataNascita: '2024-05-01', annoScolastico: ANNO }).sezionale)
      .toBe('Asilo')
  })

  it('il confine vale identico se la data arriva dal codice fiscale', () => {
    // D = aprile, giorno 30
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYY24D30Z999X', annoScolastico: ANNO }))
      .toEqual(atteso('FPR', 'cf'))
    // E = maggio, giorno 01
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYY24E01Z999X', annoScolastico: ANNO }).sezionale)
      .toBe('Asilo')
  })

  it('femmina al confine: il +40 non sposta il sezionale', () => {
    // giorno 70 = 30 + 40
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYY24D70Z999X', annoScolastico: ANNO }).sezionale)
      .toBe('FPR')
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYY24E41Z999X', annoScolastico: ANNO }).sezionale)
      .toBe('Asilo')
  })

  it('sotto omocodia piena il confine regge (nessuna cifra nel codice)', () => {
    // 30/04/2024 → anno 'NQ' (2,4), mese D, giorno 'PL' (3,0)
    const confine = 'XXXYYYNQDPLZVVVX'
    expect(confine).not.toMatch(/\d/)
    expect(sezionalePerMinore({ codiceFiscale: confine, annoScolastico: ANNO }))
      .toEqual(atteso('FPR', 'cf'))
    // 01/05/2024 → anno 'NQ', mese E, giorno 'LM' (0,1)
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYYNQELMZVVVX', annoScolastico: ANNO }).sezionale)
      .toBe('Asilo')
  })

  it('il 29 febbraio non ha un terzo compleanno, ma il sezionale è determinato lo stesso', () => {
    // 29/02/2024 è prima del 30/04/2024 → FPR, senza dover decidere fra 28/02 e 01/03
    expect(sezionalePerMinore({ dataNascita: '2024-02-29', annoScolastico: ANNO }).sezionale)
      .toBe('FPR')
  })

  it('il confine si sposta con l’anno scolastico', () => {
    // stesso bambino (30/04/2024), anno 2025: compirebbe 3 anni il 30/04/2027, oltre il 30/04/2026
    expect(sezionalePerMinore({ dataNascita: '2024-04-30', annoScolastico: 2025 }).sezionale)
      .toBe('Asilo')
    expect(sezionalePerMinore({ dataNascita: '2024-04-30', annoScolastico: 2027 }).sezionale)
      .toBe('FPR')
  })
})

describe('sezionalePerMinore — quale fonte vince', () => {
  it("CF e anagrafica d'accordo → fonte 'cf', nessuna discordanza", () => {
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY24D30Z999X',
      dataNascita: '2024-04-30',
      annoScolastico: ANNO,
    })).toEqual(atteso('FPR', 'cf'))
  })

  it('CF ASSENTE → si usa l’anagrafica', () => {
    for (const cf of [undefined, null, '']) {
      expect(sezionalePerMinore({ codiceFiscale: cf, dataNascita: '2024-04-30', annoScolastico: ANNO }))
        .toEqual(atteso('FPR', 'data_nascita'))
    }
  })

  /**
   * ⚠️ QUESTO TEST CEMENTAVA IL DIFETTO. Fino al 2026-08-10 diceva «senza gridare alla
   * discordanza» e si fermava lì: l'esito di un CF spazzatura era identico a quello di un
   * CF assente, e l'emissione — che logga solo `discordanza` — lasciava passare in
   * silenzio proprio il caso più frequente (in produzione, 11 codici su 14 non hanno
   * nemmeno la forma giusta). «Non è una discordanza» resta vero: due date non si
   * contraddicono se una delle due non c'è. Ma NON È NIENTE è falso, ed è quello che il
   * test affermava.
   */
  it('CF ILLEGGIBILE → si usa l’anagrafica, e la bandiera dell’illeggibilità si alza', () => {
    expect(sezionalePerMinore({
      codiceFiscale: 'NON VALIDO',
      dataNascita: '2024-05-01',
      annoScolastico: ANNO,
    })).toEqual(atteso('Asilo', 'data_nascita', { codiceFiscaleIlleggibile: true }))
  })

  it('un CF illeggibile NON è la stessa cosa di un CF assente', () => {
    const assente = sezionalePerMinore({ codiceFiscale: null, dataNascita: '2024-05-01', annoScolastico: ANNO })
    const illeggibile = sezionalePerMinore({ codiceFiscale: 'NON VALIDO', dataNascita: '2024-05-01', annoScolastico: ANNO })
    // stessa serie — e ci mancherebbe, la decide l'anagrafica in entrambi i casi…
    expect(illeggibile.sezionale).toBe(assente.sezionale)
    // …ma NON lo stesso esito: è la differenza che permette al chiamante di loggare.
    expect(illeggibile).not.toEqual(assente)
    expect(assente.codiceFiscaleIlleggibile).toBe(false)
    expect(illeggibile.codiceFiscaleIlleggibile).toBe(true)
  })

  /**
   * `alunni.codice_fiscale` è un `char(16)`: PostgREST consegna il valore riempito di
   * spazi a destra, quindi un campo mai compilato arriva come SEDICI SPAZI e non come
   * `''`. Contarlo come «illeggibile» farebbe scattare un `error` su ogni fattura di ogni
   * bambino senza codice fiscale — cioè un allarme che grida sempre e che nessuno guarda.
   */
  it('un campo di soli spazi vale ASSENTE, non illeggibile (la colonna è un char(16))', () => {
    for (const vuoto of ['                ', '   ', '\t\n']) {
      expect(sezionalePerMinore({ codiceFiscale: vuoto, dataNascita: '2024-05-01', annoScolastico: ANNO }))
        .toEqual(atteso('Asilo', 'data_nascita'))
    }
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYY24E01Z999X', dataNascita: '   ', annoScolastico: ANNO }))
      .toEqual(atteso('Asilo', 'cf'))
  })

  /**
   * I CODICI VERI CHE OGGI STANNO IN PRODUZIONE (forme, non valori: i valori sono di
   * minori e questo repo è pubblico). Il 2026-08-10 su 14 codici valorizzati solo 3
   * avevano la forma giusta: dieci erano lunghi 14 caratteri e uno ne aveva 1.
   */
  it('le forme sbagliate misurate in produzione alzano tutte la bandiera', () => {
    const forme = [
      'XXXYYY24D30Z99',   // 14 caratteri, come i dieci contati in tabella
      'X',                // 1 carattere, come l'undicesimo
      'XXXYYY24Z30Z999X', // mese inesistente
      'XXXYYY24D99Z999X', // giorno fuori scala
      'XXXYYY24D31Z999X', // 31 aprile: non sta sul calendario
    ]
    for (const forma of forme) {
      const esito = sezionalePerMinore({ codiceFiscale: forma, dataNascita: '2024-05-01', annoScolastico: ANNO })
      expect(esito, forma).toEqual(atteso('Asilo', 'data_nascita', { codiceFiscaleIlleggibile: true }))
    }
  })

  it('anagrafica assente → si usa il CF', () => {
    expect(sezionalePerMinore({ codiceFiscale: 'XXXYYY24E01Z999X', dataNascita: null, annoScolastico: ANNO }))
      .toEqual(atteso('Asilo', 'cf'))
  })

  it('CF che CONTRADDICE l’anagrafica: vince l’anagrafica e la bandiera si alza', () => {
    // CF: 15/01/2020 → FPR. Anagrafica: 15/06/2024 → Asilo. Il sezionale cambia davvero.
    const esito = sezionalePerMinore({
      codiceFiscale: 'XXXYYY20A15Z999X',
      dataNascita: '2024-06-15',
      annoScolastico: ANNO,
    })
    expect(esito).toEqual(atteso('Asilo', 'data_nascita', { discordanza: true }))
  })

  it('discordanza anche di un solo giorno', () => {
    const esito = sezionalePerMinore({
      codiceFiscale: 'XXXYYY24D30Z999X', // 30/04/2024
      dataNascita: '2024-05-01',
      annoScolastico: ANNO,
    })
    expect(esito).toEqual(atteso('Asilo', 'data_nascita', { discordanza: true }))
  })

  it('un CF che dice una data diversa dall’anagrafica non passa inosservato', () => {
    // 'XXXYYY26T15Z999X' = 15 dicembre '26, contro un'anagrafica che dice 01/09/2024.
    const esito = sezionalePerMinore({
      codiceFiscale: 'XXXYYY26T15Z999X',
      dataNascita: '2024-09-01',
      annoScolastico: ANNO,
    })
    expect(esito.discordanza).toBe(true)
    expect(esito.fonte).toBe('data_nascita')
    expect(esito.sezionale).toBe('Asilo')
  })
})

/**
 * D2 — IL SECOLO DEL CODICE FISCALE NON SI CHIEDE ALL'OROLOGIO.
 *
 * Il difetto, misurato prima di essere corretto: `sezionalePerMinore` chiamava
 * `dataNascitaDaCodiceFiscale(cf)` senza il parametro `oggi`, quindi il parser usava
 * `new Date()`. Stesso codice fiscale, stesso anno scolastico, esito diverso:
 *   emessa   il 10/08/2026 → 'FPR'   (il 15/12/2026 è futuro → 1926)
 *   riemessa il 20/12/2026 → 'Asilo' (il 15/12/2026 è passato → 2026)
 * Cioè una fattura scartata dallo SDI e rifatta due mesi dopo cambiava serie da sola, e
 * `discordanza`/`illeggibile` restavano `false` in entrambi i casi: nessuno se ne accorgeva.
 *
 * La cura non è iniettare «oggi»: è non averne bisogno. Il secolo si scioglie contro la
 * FINE DELL'ANNO SCOLASTICO CHE SI FATTURA (31 agosto dell'anno di chiusura) — un dato del
 * documento, che non cambia fra un'emissione e la successiva. Anche la data del documento
 * sarebbe cambiata alla riemissione: l'anno scolastico no.
 */
describe('sezionalePerMinore — è PURA: non legge l’orologio', () => {
  const CF_DICEMBRE = 'XXXYYY26T15Z999X' // 15 dicembre '26

  it('lo stesso ingresso dà lo stesso esito ad agosto e a dicembre', () => {
    const esiti = [new Date(2026, 7, 10, 9, 0, 0), new Date(2026, 11, 20, 9, 0, 0)].map((quando) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(quando)
      try {
        return sezionalePerMinore({ codiceFiscale: CF_DICEMBRE, annoScolastico: ANNO })
      } finally {
        vi.useRealTimers()
      }
    })
    expect(esiti[0]).toEqual(esiti[1])
    // e il secolo scelto è quello dell'anno scolastico che si fattura: 2026, non 1926
    expect(esiti[0]).toEqual(atteso('Asilo', 'cf'))
  })

  it('l’ancora è l’anno scolastico, non il giorno: cambiando anno cambia il secolo, e lo dice', () => {
    // Sull'anno scolastico 2025 (che si chiude il 31/08/2026) il 15/12/2026 non è ancora
    // arrivato: l'unica lettura possibile è il 1926 — e il 1926 non è la data di un alunno.
    expect(() => sezionalePerMinore({ codiceFiscale: CF_DICEMBRE, annoScolastico: 2025 }))
      .toThrow(/non determinabile/i)
  })
})

/**
 * D3 — «LA SANITÀ DEL DATO LA STABILISCE CHI CONFRONTA CON L'ANAGRAFICA»: era una promessa
 * che il confronto non poteva mantenere, perché avviene SOLO quando entrambe le fonti sono
 * leggibili. Col solo codice fiscale non c'era alcun controllo: un codice di forma perfetta
 * che dice 1985 — il caso vero del codice del GENITORE incollato nel campo del bambino —
 * produceva una serie fiscale con tutte le bandiere a `false`, e la fattura partiva muta.
 */
describe('sezionalePerMinore — una data che un alunno non può avere non è una fonte', () => {
  it('il codice fiscale di un adulto NON decide la serie: si blocca', () => {
    // 'XXXYYY85T10Z999X' = 10 dicembre 1985 (il 2085 sarebbe oltre la fine dell'anno scolastico)
    expect(() => sezionalePerMinore({ codiceFiscale: 'XXXYYY85T10Z999X', annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
    expect(() => sezionalePerMinore({ codiceFiscale: 'XXXYYY85T10Z999X', annoScolastico: ANNO }))
      .toThrow(/un alunno non può avere/i)
  })

  it('con l’anagrafica accanto la fattura parte, ma la bandiera si alza', () => {
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY85T10Z999X',
      dataNascita: '2024-05-01',
      annoScolastico: ANNO,
    })).toEqual(atteso('Asilo', 'data_nascita', { codiceFiscaleImplausibile: true }))
  })

  it('«impossibile» non è «illeggibile»: sono due riparazioni diverse, e due bandiere', () => {
    const illeggibile = sezionalePerMinore({
      codiceFiscale: 'NON VALIDO', dataNascita: '2024-05-01', annoScolastico: ANNO,
    })
    const implausibile = sezionalePerMinore({
      codiceFiscale: 'XXXYYY85T10Z999X', dataNascita: '2024-05-01', annoScolastico: ANNO,
    })
    expect(implausibile).not.toEqual(illeggibile)
    expect(implausibile.codiceFiscaleIlleggibile).toBe(false)
    expect(implausibile.codiceFiscaleImplausibile).toBe(true)
    expect(illeggibile.codiceFiscaleIlleggibile).toBe(true)
    expect(illeggibile.codiceFiscaleImplausibile).toBe(false)
  })

  it('vale anche per l’anagrafica: una data reale ma impossibile non decide niente', () => {
    // 1985 in `alunni.data_nascita`: si legge, è una data vera, non è di un alunno.
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY24D30Z999X',
      dataNascita: '1985-12-10',
      annoScolastico: ANNO,
    })).toEqual(atteso('FPR', 'cf', { dataNascitaImplausibile: true }))
    expect(() => sezionalePerMinore({ dataNascita: '1985-12-10', annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
  })

  it('il confine dei 18 anni è inclusivo e si muove con l’anno scolastico', () => {
    // anno scolastico 2026: può essere nato dal 01/09/2008 al 31/08/2027
    expect(sezionalePerMinore({ dataNascita: '2008-09-01', annoScolastico: ANNO }).sezionale).toBe('FPR')
    expect(() => sezionalePerMinore({ dataNascita: '2008-08-31', annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
    expect(sezionalePerMinore({ dataNascita: '2027-08-31', annoScolastico: ANNO }).sezionale).toBe('Asilo')
    expect(() => sezionalePerMinore({ dataNascita: '2027-09-01', annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
    // lo stesso 31/08/2008 è invece plausibile un anno prima
    expect(sezionalePerMinore({ dataNascita: '2008-08-31', annoScolastico: 2025 }).sezionale).toBe('FPR')
  })

  it('il messaggio dice che il campo si legge ma descrive un altro, senza riportarlo', () => {
    try {
      sezionalePerMinore({ codiceFiscale: 'XXXYYY85T10Z999X', annoScolastico: ANNO })
      expect.unreachable('doveva lanciare')
    } catch (e) {
      const messaggio = (e as Error).message
      expect(messaggio).toMatch(/si legge, ma indica una data di nascita che un alunno non può avere/i)
      expect(messaggio).not.toContain('XXXYYY85T10Z999X')
      expect(messaggio).not.toContain('1985')
    }
  })
})

describe('sezionalePerMinore — la data di nascita come Date o come stringa', () => {
  it('Date e stringa YYYY-MM-DD danno lo stesso esito', () => {
    const daStringa = sezionalePerMinore({ dataNascita: '2024-04-30', annoScolastico: ANNO })
    const daDate = sezionalePerMinore({ dataNascita: new Date(2024, 3, 30), annoScolastico: ANNO })
    expect(daDate).toEqual(daStringa)
  })

  it('una Date con ore diverse da mezzanotte resta lo stesso giorno', () => {
    expect(sezionalePerMinore({ dataNascita: new Date(2024, 3, 30, 23, 59, 59), annoScolastico: ANNO }).sezionale)
      .toBe('FPR')
    expect(sezionalePerMinore({ dataNascita: new Date(2024, 4, 1, 0, 0, 1), annoScolastico: ANNO }).sezionale)
      .toBe('Asilo')
  })

  it('accetta un timestamp ISO completo, leggendone solo il giorno', () => {
    expect(sezionalePerMinore({ dataNascita: '2024-04-30T00:00:00.000Z', annoScolastico: ANNO }).sezionale)
      .toBe('FPR')
  })

  /**
   * REGRESSIONE, misurata prima di essere corretta: `new Date('2024-05-01')` è la
   * mezzanotte UTC, e riletta con i getter locali a ovest di Greenwich diventa il
   * 30 aprile — cioè un bambino da «Asilo» finiva su «FPR». In Europe/Rome e in UTC
   * (macchina di sviluppo e Vercel) non si vedeva: il difetto era latente.
   *
   * `Date.UTC` costruisce lo stesso ISTANTE in qualunque fuso, quindi questo caso
   * interroga davvero il ramo della mezzanotte UTC ovunque giri la suite. Provato a
   * mano su Europe/Rome, UTC, America/New_York, America/Los_Angeles e Pacific/Kiritimati.
   */
  it('una Date a mezzanotte UTC non slitta al giorno prima, in nessun fuso', () => {
    // il giorno DOPO il confine: è qui che l'off-by-one cambia il sezionale
    expect(sezionalePerMinore({ dataNascita: new Date(Date.UTC(2024, 4, 1)), annoScolastico: ANNO }).sezionale)
      .toBe('Asilo')
    expect(sezionalePerMinore({ dataNascita: new Date(Date.UTC(2024, 3, 30)), annoScolastico: ANNO }).sezionale)
      .toBe('FPR')
    // e non introduce una discordanza fantasma contro lo stesso giorno letto dal CF
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY24E01Z999X', // 01/05/2024
      dataNascita: new Date(Date.UTC(2024, 4, 1)),
      annoScolastico: ANNO,
    })).toEqual(atteso('Asilo', 'cf'))
  })

  it('una data di nascita impossibile non decide niente — ma lo dice', () => {
    // 31 aprile: `new Date` la traslerebbe al 1° maggio in silenzio, cambiando il sezionale.
    // Si ripiega sul CF, e la bandiera dice che in anagrafica c'è un valore sbagliato.
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY24D30Z999X',
      dataNascita: '2024-04-31',
      annoScolastico: ANNO,
    })).toEqual(atteso('FPR', 'cf', { dataNascitaIlleggibile: true }))

    // stesso trattamento per il formato italiano e per una `Date` invalida
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY24D30Z999X',
      dataNascita: '30/04/2024',
      annoScolastico: ANNO,
    })).toEqual(atteso('FPR', 'cf', { dataNascitaIlleggibile: true }))
    expect(sezionalePerMinore({
      codiceFiscale: 'XXXYYY24D30Z999X',
      dataNascita: new Date('non-una-data'),
      annoScolastico: ANNO,
    })).toEqual(atteso('FPR', 'cf', { dataNascitaIlleggibile: true }))
  })
})

describe('sezionalePerMinore — quando NON si emette', () => {
  it('niente CF e niente data di nascita → lancia', () => {
    expect(() => sezionalePerMinore({ annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
    expect(() => sezionalePerMinore({ codiceFiscale: null, dataNascita: null, annoScolastico: ANNO }))
      .toThrow(/non si indovina/i)
  })

  it('CF illeggibile e nessuna anagrafica → lancia (non si ripiega su una serie a caso)', () => {
    expect(() => sezionalePerMinore({ codiceFiscale: 'XXXYYY20A99Z999X', annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
  })

  it('data di nascita illeggibile e nessun CF → lancia', () => {
    expect(() => sezionalePerMinore({ dataNascita: '30/04/2024', annoScolastico: ANNO }))
      .toThrow(/non determinabile/i)
  })

  it('anno scolastico non valido → lancia', () => {
    for (const anno of [0, -1, 2026.5, NaN, 26]) {
      expect(() => sezionalePerMinore({ dataNascita: '2024-04-30', annoScolastico: anno }))
        .toThrow(/anno scolastico non valido/i)
    }
  })

  it("il messaggio d'errore dice cosa fare, in italiano", () => {
    try {
      sezionalePerMinore({ annoScolastico: ANNO })
      expect.unreachable('doveva lanciare')
    } catch (e) {
      expect((e as Error).message).toMatch(/bloccare l'emissione/i)
      expect((e as Error).message).toMatch(/anagrafica/i)
    }
  })

  /**
   * «Manca» si completa, «c'è ma è sbagliato» si corregge: sono due riparazioni diverse e
   * il messaggio che finisce in `app_log` deve distinguerle, altrimenti la segreteria
   * cerca un campo vuoto che vuoto non è. Nessun VALORE nel testo: sono dati di un minore.
   */
  it("il messaggio distingue «manca» da «c'è ma non si legge»", () => {
    const messaggio = (ingresso: Parameters<typeof sezionalePerMinore>[0]) => {
      try {
        sezionalePerMinore(ingresso)
        return expect.unreachable('doveva lanciare') as never
      } catch (e) {
        return (e as Error).message
      }
    }

    expect(messaggio({ annoScolastico: ANNO }))
      .toMatch(/né il codice fiscale né la data di nascita sono utilizzabili/i)
    expect(messaggio({ codiceFiscale: 'NON VALIDO', annoScolastico: ANNO }))
      .toMatch(/il codice fiscale c.è ma NON è leggibile/i)
    expect(messaggio({ dataNascita: '30/04/2024', annoScolastico: ANNO }))
      .toMatch(/la data di nascita c.è ma NON è leggibile/i)
    expect(messaggio({ codiceFiscale: 'NON VALIDO', dataNascita: '30/04/2024', annoScolastico: ANNO }))
      .toMatch(/ENTRAMBI/)
    // e nessun messaggio riporta il valore che ha letto
    expect(messaggio({ codiceFiscale: 'XXXYYY20A99Z999X', annoScolastico: ANNO }))
      .not.toContain('XXXYYY20A99Z999X')
  })
})

/**
 * DIFETTO CON LA MICCIA ACCESA (corretto il 2026-08-10): l'anno scolastico veniva dalla
 * data di EMISSIONE. Una retta di maggio fatturata a settembre finiva sull'anno
 * scolastico nuovo, il confine dei tre anni si spostava di dodici mesi, e lo stesso
 * bambino usciva su una serie diversa — con un numero già bruciato.
 *
 * Dal 2026-11-08 (PR 4.1) la regola dell'anno è UNA sola in tutto il prodotto
 * (`annoDelGiorno`: il calendario della sede, o il predefinito 1° settembre) e il giorno
 * del documento arriva come stringa `AAAA-MM-GG` (il giorno fiscale di Roma).
 */
describe('annoScolasticoDiCompetenza — la serie la decide il periodo, non il calendario', () => {
  /** Il ripiego: 30 settembre 2026, cioè anno scolastico 2026 se si guardasse oggi. */
  const EMISSIONE_SETTEMBRE = '2026-09-30'

  it("il periodo di competenza vince sulla data d'emissione", () => {
    // retta di MAGGIO 2026 (anno scolastico 2025/2026) fatturata a SETTEMBRE 2026
    expect(annoScolasticoDiCompetenza('2026-05-01', EMISSIONE_SETTEMBRE))
      .toEqual({ anno: 2025, fonte: 'periodo_competenza' })
    // e senza il periodo si sarebbe letto 2026: è esattamente il salto d'anno del difetto
    expect(annoScolasticoDiCompetenza(null, EMISSIONE_SETTEMBRE))
      .toEqual({ anno: 2026, fonte: 'data_documento' })
  })

  it('i casi della PR 4.1: competenza ad agosto, ripiego ad agosto, ripiego a settembre', () => {
    expect(annoScolasticoDiCompetenza('2026-08-01', '2026-11-08'))
      .toEqual({ anno: 2025, fonte: 'periodo_competenza' })
    // era «ambiguo»: ora l'agosto è dell'anno che si chiude, come per tutto il prodotto
    expect(annoScolasticoDiCompetenza(null, '2026-08-20'))
      .toEqual({ anno: 2025, fonte: 'data_documento' })
    expect(annoScolasticoDiCompetenza(null, '2026-09-01').anno).toBe(2026)
  })

  it('con il calendario della sede vale quello: la sede che comincia il 14/09 ha il 10/09 nel 2025', () => {
    const cal = [{
      annoId: 'a-2026', annoSedeId: 's-2026', annoInizio: 2026,
      inizio: '2026-09-14', fine: '2027-08-31', ultimoGiornoAperto: '2027-07-31',
      preparaSuccessivoDal: '2027-05-01', stato: 'corrente' as const, domandeAperte: false,
    }, {
      annoId: 'a-2025', annoSedeId: 's-2025', annoInizio: 2025,
      inizio: '2025-09-01', fine: '2026-09-13', ultimoGiornoAperto: '2026-07-31',
      preparaSuccessivoDal: '2026-05-01', stato: 'chiuso' as const, domandeAperte: false,
    }]
    expect(annoScolasticoDiCompetenza(null, '2026-09-10', cal))
      .toEqual({ anno: 2025, fonte: 'data_documento' })
    // anche la competenza si legge col calendario: il 1° settembre è ancora il 2025
    expect(annoScolasticoDiCompetenza('2026-09-01', '2026-11-08', cal).anno).toBe(2025)
  })

  it('e cambia DAVVERO la serie, non solo un numero in un oggetto', () => {
    // nato il 30/04/2024: FPR sull'anno 2026, Asilo sull'anno 2025
    const nascita = '2024-04-30'
    const conCompetenza = annoScolasticoDiCompetenza('2026-05-01', EMISSIONE_SETTEMBRE)
    const senzaCompetenza = annoScolasticoDiCompetenza(null, EMISSIONE_SETTEMBRE)
    expect(sezionalePerMinore({ dataNascita: nascita, annoScolastico: conCompetenza.anno }).sezionale)
      .toBe('Asilo')
    expect(sezionalePerMinore({ dataNascita: nascita, annoScolastico: senzaCompetenza.anno }).sezionale)
      .toBe('FPR')
  })

  it('il confine di settembre vale anche sul periodo di competenza', () => {
    expect(annoScolasticoDiCompetenza('2026-08-31', EMISSIONE_SETTEMBRE).anno).toBe(2025)
    expect(annoScolasticoDiCompetenza('2026-09-01', EMISSIONE_SETTEMBRE).anno).toBe(2026)
  })

  it('accetta «YYYY-MM», la stringa completa e una Date', () => {
    expect(annoScolasticoDiCompetenza('2026-10', EMISSIONE_SETTEMBRE))
      .toEqual({ anno: 2026, fonte: 'periodo_competenza' })
    expect(annoScolasticoDiCompetenza('2026-10-15', EMISSIONE_SETTEMBRE))
      .toEqual({ anno: 2026, fonte: 'periodo_competenza' })
    expect(annoScolasticoDiCompetenza(new Date(2026, 9, 15), EMISSIONE_SETTEMBRE))
      .toEqual({ anno: 2026, fonte: 'periodo_competenza' })
  })

  /**
   * `new Date('2026-05-01')` è la mezzanotte UTC: riletta con i getter locali a ovest di
   * Greenwich diventa il 30 aprile — e qui non sposterebbe solo un giorno, sposterebbe
   * un MESE (aprile invece di maggio) e con esso l'anno scolastico a cavallo di settembre.
   * È lo stesso guasto latente già misurato su `aDataCalendario`, in un altro punto.
   */
  it('una Date a mezzanotte UTC non slitta al mese prima, in nessun fuso', () => {
    expect(annoScolasticoDiCompetenza(new Date(Date.UTC(2026, 8, 1)), EMISSIONE_SETTEMBRE).anno).toBe(2026)
    expect(annoScolasticoDiCompetenza(new Date(Date.UTC(2026, 7, 31)), EMISSIONE_SETTEMBRE).anno).toBe(2025)
  })

  it('un periodo illeggibile ripiega sulla data del documento, e lo DICE', () => {
    for (const rotto of [null, undefined, '', '   ', 'maggio 2026', '2026-13-01', new Date('non-una-data')]) {
      expect(annoScolasticoDiCompetenza(rotto, EMISSIONE_SETTEMBRE), String(rotto))
        .toEqual({ anno: 2026, fonte: 'data_documento' })
    }
  })

  it('senza periodo E con un giorno del documento non valido, non inventa un anno: lancia', () => {
    expect(() => annoScolasticoDiCompetenza(null, 'non-un-giorno')).toThrow(/giorno non valido/i)
  })
})

/**
 * AGOSTO NON È PIÙ AMBIGUO (PR 4.1, 2026-11-08).
 *
 * Fino alla PR 4.1 il resto del prodotto faceva partire l'anno da AGOSTO e la fatturazione
 * da SETTEMBRE: il ripiego sulla data del documento, ad agosto, era una monetina, e per la
 * coorte a cavallo del 30 aprile `sezionalePerMinore` lanciava `ErroreSerieAmbigua` (422).
 * Adesso la regola è una sola: l'agosto appartiene all'anno scolastico che si chiude, e la
 * serie si decide sempre.
 */
describe('agosto — non è più ambiguo: la serie si decide sempre', () => {
  /** Nato il 15/06/2023: `Asilo` sull'anno 2025, `FPR` sull'anno 2026. */
  const NASCITA_DELLA_COORTE = '2023-06-15'

  it("ad agosto, senza periodo di competenza, l'anno è quello che si chiude: 2025", () => {
    const { anno, fonte } = annoScolasticoDiCompetenza(null, '2026-08-10')
    expect(anno).toBe(2025)
    expect(fonte).toBe('data_documento')
  })

  it('la coorte a cavallo del 30 aprile ha la sua serie (Asilo), senza eccezioni', () => {
    const { anno } = annoScolasticoDiCompetenza(null, '2026-08-10')
    expect(sezionalePerMinore({ dataNascita: NASCITA_DELLA_COORTE, annoScolastico: anno }).sezionale)
      .toBe('Asilo')
    // il 31 agosto e il 1° settembre cambiano anno, come cambia tutto il prodotto
    expect(annoScolasticoDiCompetenza(null, '2026-08-31').anno).toBe(2025)
    expect(annoScolasticoDiCompetenza(null, '2026-09-01').anno).toBe(2026)
  })

  it("l'esito non ha più il campo «ambiguo»", () => {
    expect(Object.keys(annoScolasticoDiCompetenza(null, '2026-08-10')).sort())
      .toEqual(['anno', 'fonte'])
  })

  it('un’anagrafica assente resta il suo errore, ad agosto come sempre', () => {
    expect(() => sezionalePerMinore({ annoScolastico: 2025 })).toThrow(/non determinabile/i)
  })
})


describe('formattaNumeroFattura', () => {
  it("«Asilo» scrive l'anno a QUATTRO cifre", () => {
    expect(formattaNumeroFattura('Asilo', 2328, 2026)).toBe('Asilo 2328/2026')
  })

  it("«FPR» scrive l'anno a DUE cifre", () => {
    expect(formattaNumeroFattura('FPR', 1947, 2026)).toBe('FPR 1947/26')
  })

  it("l'anno a due cifre tiene lo zero iniziale", () => {
    expect(formattaNumeroFattura('FPR', 1, 2006)).toBe('FPR 1/06')
  })

  it('il numero non viene imbottito di zeri né raggruppato', () => {
    expect(formattaNumeroFattura('Asilo', 1, 2026)).toBe('Asilo 1/2026')
    expect(formattaNumeroFattura('Asilo', 12345, 2026)).toBe('Asilo 12345/2026')
  })

  it('rifiuta numeri e anni che una fattura non può avere', () => {
    expect(() => formattaNumeroFattura('Asilo', 0, 2026)).toThrow(/numero di fattura non valido/i)
    expect(() => formattaNumeroFattura('Asilo', -3, 2026)).toThrow(/numero di fattura non valido/i)
    expect(() => formattaNumeroFattura('Asilo', 1.5, 2026)).toThrow(/numero di fattura non valido/i)
    expect(() => formattaNumeroFattura('FPR', 10, 26)).toThrow(/anno di fattura non valido/i)
    expect(() => formattaNumeroFattura('FPR', 10, 2026.5)).toThrow(/anno di fattura non valido/i)
  })

  it('rifiuta un sezionale che non esiste', () => {
    expect(() => formattaNumeroFattura('Nido' as 'Asilo', 10, 2026)).toThrow(/sezionale sconosciuto/i)
  })

  it("si incastra con l'esito di `sezionalePerMinore`", () => {
    const { sezionale } = sezionalePerMinore({ dataNascita: '2024-04-30', annoScolastico: ANNO })
    expect(formattaNumeroFattura(sezionale, 1947, 2026)).toBe('FPR 1947/26')
  })
})
