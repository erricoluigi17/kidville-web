import { describe, it, expect } from 'vitest'
import { dataNascitaDaCodiceFiscale, sessoDaCodiceFiscale } from '@/lib/fiscale/codice-fiscale'

/**
 * ⚠️ TUTTI i codici fiscali di questo file sono SINTETICI e IMPOSSIBILI: la terna
 * cognome/nome è `XXXYYY`, il codice catastale è `Z999` (i codici `Z…` sono gli stati
 * esteri, e il 999 non è assegnato) e il carattere di controllo è una `X` qualsiasi,
 * quindi la checksum NON torna. Nessuno di questi codici può appartenere a una persona
 * vera — che è il requisito, visto che il repository è pubblico e il dominio sono minori.
 *
 * Mappa dei mesi usata qui: A=gen B=feb C=mar D=apr E=mag H=giu L=lug M=ago P=set
 * R=ott S=nov T=dic.
 */

/** Riferimento fisso per la scelta del secolo: senza, un test su `99` cambierebbe esito nel 2100. */
const OGGI = new Date(2026, 7, 9) // 9 agosto 2026

/** Confronta un `Date` con una terna di calendario, senza dipendere dal fuso. */
function eGiorno(d: Date | null, anno: number, mese: number, giorno: number) {
  expect(d).not.toBeNull()
  expect([d!.getFullYear(), d!.getMonth() + 1, d!.getDate()]).toEqual([anno, mese, giorno])
}

describe('dataNascitaDaCodiceFiscale — casi ordinari', () => {
  it('maschio: giorno letto tale e quale', () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY20A15Z999X', OGGI), 2020, 1, 15)
  })

  it('femmina: al giorno sono stati sommati 40 e vanno tolti', () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY20A55Z999X', OGGI), 2020, 1, 15)
  })

  it('tutti i dodici mesi hanno la loro lettera', () => {
    const attesi: Array<[string, number]> = [
      ['A', 1], ['B', 2], ['C', 3], ['D', 4], ['E', 5], ['H', 6],
      ['L', 7], ['M', 8], ['P', 9], ['R', 10], ['S', 11], ['T', 12],
    ]
    for (const [lettera, mese] of attesi) {
      eGiorno(dataNascitaDaCodiceFiscale(`XXXYYY20${lettera}15Z999X`, OGGI), 2020, mese, 15)
    }
  })

  it('accetta minuscole e spazi (capita incollando da un PDF)', () => {
    eGiorno(dataNascitaDaCodiceFiscale('xxxyyy20a15z999x', OGGI), 2020, 1, 15)
    eGiorno(dataNascitaDaCodiceFiscale('XXX YYY 20A15 Z999X', OGGI), 2020, 1, 15)
  })

  it('il Date che esce è la mezzanotte LOCALE, non un istante qualsiasi', () => {
    const d = dataNascitaDaCodiceFiscale('XXXYYY20A15Z999X', OGGI)!
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0])
  })
})

describe('dataNascitaDaCodiceFiscale — OMOCODIA', () => {
  /**
   * Il parser ingenuo è quello che casca qui: legge `1R` come «uno-erre», non trova una
   * cifra e o esplode o inventa. `R` vale 5, quindi il giorno è 15.
   */
  it('parziale: sostituite solo le cifre più a destra (catastale + ultima del giorno)', () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY20A1RZVVVX', OGGI), 2020, 1, 15)
  })

  it('parziale che tocca solo il codice catastale: la data non cambia', () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY20A15Z99VX', OGGI), 2020, 1, 15)
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY20A15Z9VVX', OGGI), 2020, 1, 15)
  })

  it('piena: sedici caratteri e ZERO cifre — stessa data del codice originario', () => {
    const pieno = 'XXXYYYNLAMRZVVVX'
    expect(pieno).toHaveLength(16)
    expect(pieno).not.toMatch(/\d/) // se qui comparisse una cifra, il caso non starebbe provando nulla
    eGiorno(dataNascitaDaCodiceFiscale(pieno, OGGI), 2020, 1, 15)
    // stessa data del codice senza omocodia: è il punto della sostituzione
    expect(dataNascitaDaCodiceFiscale(pieno, OGGI)!.getTime())
      .toBe(dataNascitaDaCodiceFiscale('XXXYYY20A15Z999X', OGGI)!.getTime())
  })

  it('piena al femminile: il +40 sopravvive alla sostituzione', () => {
    // giorno 55 → 'RR' (R=5); resta femmina, giorno vero 15
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYYNLARRZVVVX', OGGI), 2020, 1, 15)
    expect(sessoDaCodiceFiscale('XXXYYYNLARRZVVVX')).toBe('F')
  })

  it('tutte e dieci le lettere valgono la cifra giusta, provate sul giorno', () => {
    const cifre: Array<[string, number]> = [
      ['L', 0], ['M', 1], ['N', 2], ['P', 3], ['Q', 4],
      ['R', 5], ['S', 6], ['T', 7], ['U', 8], ['V', 9],
    ]
    for (const [lettera, valore] of cifre) {
      // decina fissa a 1 → giorni da 10 a 19
      eGiorno(dataNascitaDaCodiceFiscale(`XXXYYY20A1${lettera}Z999X`, OGGI), 2020, 1, 10 + valore)
    }
  })
})

describe('dataNascitaDaCodiceFiscale — scelta del SECOLO', () => {
  it("'99' letto nel 2026 è il 1999: il 2099 non è ancora arrivato", () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY99A15Z999X', OGGI), 1999, 1, 15)
  })

  it("'26' con mese già passato è 2026", () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY26A15Z999X', OGGI), 2026, 1, 15)
  })

  it("'26' con mese ANCORA DA VENIRE scivola al 1926 — è la regola, per quanto assurda per un bimbo", () => {
    // 15 dicembre 2026, letto il 9 agosto 2026: nel futuro. Resta solo il 1926.
    // La plausibilità non la stabilisce il parser: la stabilisce il confronto con l'anagrafica.
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY26T15Z999X', OGGI), 1926, 12, 15)
  })

  it('nato OGGI non è futuro', () => {
    // M = agosto, giorno 09 → 9 agosto 2026, cioè `OGGI`
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY26M09Z999X', OGGI), 2026, 8, 9)
  })

  it('nato DOMANI scivola indietro di un secolo', () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY26M10Z999X', OGGI), 1926, 8, 10)
  })

  it('29 febbraio: sceglie il secolo in cui la data ESISTE (2000 sì, 1900 no)', () => {
    eGiorno(dataNascitaDaCodiceFiscale('XXXYYY00B29Z999X', OGGI), 2000, 2, 29)
  })

  it('29 febbraio inesistente in entrambi i secoli → null', () => {
    // 1999 e 2099 non sono bisestili (e il 2099 sarebbe comunque futuro)
    expect(dataNascitaDaCodiceFiscale('XXXYYY99B29Z999X', OGGI)).toBeNull()
  })

  it("senza 'oggi' esplicito usa la data corrente e resta coerente", () => {
    const d = dataNascitaDaCodiceFiscale('XXXYYY20A15Z999X')
    eGiorno(d, 2020, 1, 15)
    expect(d!.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

describe('dataNascitaDaCodiceFiscale — codici MALFORMATI', () => {
  const rotti: Array<[string, unknown]> = [
    ['stringa vuota', ''],
    ['prosa qualsiasi', 'NON VALIDO'],
    ['troppo corto (15)', 'XXXYYY20A15Z999'],
    ['troppo lungo (17)', 'XXXYYY20A15Z999XX'],
    ['cifra dentro le prime sei lettere', 'XXXYY120A15Z999X'],
    ['lettera fuori omocodia al posto di una cifra (K)', 'XXXYYY2KA15Z999X'],
    ['lettera del mese inesistente (Z)', 'XXXYYY20Z15Z999X'],
    ['lettera del mese inesistente (F)', 'XXXYYY20F15Z999X'],
    ['giorno 00', 'XXXYYY20A00Z999X'],
    ['giorno 32 (non è femmina, è rotto)', 'XXXYYY20A32Z999X'],
    ['giorno 40 (il +40 parte da 41)', 'XXXYYY20A40Z999X'],
    ['giorno 72 → 32 dopo il -40', 'XXXYYY20A72Z999X'],
    ['31 aprile: la data non esiste', 'XXXYYY20D31Z999X'],
    ['30 febbraio: la data non esiste', 'XXXYYY20B30Z999X'],
    ['cifra al posto del codice catastale', 'XXXYYY20A159999X'],
    ['non è una stringa (null)', null],
    ['non è una stringa (numero)', 12345],
  ]

  for (const [nome, valore] of rotti) {
    it(`${nome} → null`, () => {
      expect(dataNascitaDaCodiceFiscale(valore as string, OGGI)).toBeNull()
    })
  }

  it("un 'oggi' non valido non produce una data inventata", () => {
    expect(dataNascitaDaCodiceFiscale('XXXYYY20A15Z999X', new Date('non-una-data'))).toBeNull()
  })
})

describe('sessoDaCodiceFiscale', () => {
  it('giorno ≤ 31 → maschio', () => {
    expect(sessoDaCodiceFiscale('XXXYYY20A15Z999X')).toBe('M')
    expect(sessoDaCodiceFiscale('XXXYYY20A01Z999X')).toBe('M')
    expect(sessoDaCodiceFiscale('XXXYYY20A31Z999X')).toBe('M')
  })

  it('giorno > 40 → femmina', () => {
    expect(sessoDaCodiceFiscale('XXXYYY20A55Z999X')).toBe('F')
    expect(sessoDaCodiceFiscale('XXXYYY20A41Z999X')).toBe('F') // primo giorno del mese
    expect(sessoDaCodiceFiscale('XXXYYY20A71Z999X')).toBe('F') // trentunesimo
  })

  it('legge il sesso anche sotto omocodia piena', () => {
    expect(sessoDaCodiceFiscale('XXXYYYNLAMRZVVVX')).toBe('M') // giorno 15
    expect(sessoDaCodiceFiscale('XXXYYYNLARRZVVVX')).toBe('F') // giorno 55
    // 'QM' = 41 → femmina, primo giorno del mese
    expect(sessoDaCodiceFiscale('XXXYYYNLAQMZVVVX')).toBe('F')
  })

  it('malformato → null', () => {
    expect(sessoDaCodiceFiscale('')).toBeNull()
    expect(sessoDaCodiceFiscale('NON VALIDO')).toBeNull()
    expect(sessoDaCodiceFiscale('XXXYYY20A00Z999X')).toBeNull()
    expect(sessoDaCodiceFiscale('XXXYYY20A72Z999X')).toBeNull()
    expect(sessoDaCodiceFiscale(null as unknown as string)).toBeNull()
  })

  /**
   * Divergenza voluta dalle due funzioni: il 30 febbraio non è una data, ma il sesso
   * nel codice c'è lo stesso. Rispondere `null` butterebbe via un'informazione presente.
   */
  it('data impossibile ma sesso leggibile: la data dà null, il sesso no', () => {
    expect(dataNascitaDaCodiceFiscale('XXXYYY24B70Z999X', OGGI)).toBeNull()
    expect(sessoDaCodiceFiscale('XXXYYY24B70Z999X')).toBe('F')
    expect(dataNascitaDaCodiceFiscale('XXXYYY20D31Z999X', OGGI)).toBeNull()
    expect(sessoDaCodiceFiscale('XXXYYY20D31Z999X')).toBe('M')
  })
})
