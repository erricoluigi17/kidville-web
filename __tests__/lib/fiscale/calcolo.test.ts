import { describe, it, expect } from 'vitest'
import {
  calcolaCodiceFiscale,
  carattereControllo,
  terzinaCognome,
  terzinaData,
  terzinaNome,
} from '@/lib/fiscale/calcolo'
import { PESI_DISPARI, PESI_PARI, ALFABETO_CONTROLLO, POSIZIONI_NUMERICHE } from '@/lib/fiscale/tabelle'

/**
 * ⚠️ CONVENZIONE DEI DATI DI PROVA — vale per tutto il file, e non è una formalità.
 *
 * Questo repository è PUBBLICO e il dominio sono minori. Un codice fiscale con la
 * checksum giusta può appartenere a una persona vera, quindi:
 *
 *  · il codice catastale è sempre `Z999` o `Z998`. I codici `Z…` sono gli stati esteri e
 *    la serie `Z9xx` NON è assegnata a nessuno: un codice che la contiene non può essere
 *    di nessuno, e questa è la garanzia forte;
 *  · le terzine sono `XQQ`/`YKV`, da cognomi e nomi inventati e impronunciabili
 *    (`XQQWZ`, `YJKVB`);
 *  · qui — a differenza di `codice-fiscale.test.ts` — la CHECKSUM DEVE TORNARE, perché è
 *    proprio quello che si sta collaudando. La seconda cintura (carattere di controllo
 *    volutamente sbagliato) qui non si può indossare: regge la prima, che è più forte.
 *
 * Le uniche eccezioni sono i cognomi/nomi comuni (`ROSSI`, `FRANCESCO`, `DE LUCA`…) usati
 * per fissare le REGOLE delle terzine: una terzina di tre lettere non è un dato personale
 * e non identifica nessuno — è la regola dell'Agenzia scritta come esempio.
 *
 * Le attese del carattere di controllo NON sono state prodotte da questo modulo: sono
 * state calcolate con `codice-fiscale-js` (già in `package.json`), cioè da
 * un'implementazione indipendente. Un test che si aspetta ciò che il codice produce non
 * misura niente.
 */

describe('terzinaCognome', () => {
  it('consonanti, poi vocali, poi X di riempimento — nell’ordine, prime tre', () => {
    expect(terzinaCognome('ROSSI')).toBe('RSS')
    expect(terzinaCognome('FOA')).toBe('FOA')
    expect(terzinaCognome('RE')).toBe('REX')
    expect(terzinaCognome('O')).toBe('OXX')
    expect(terzinaCognome('XQQWZ')).toBe('XQQ')
  })

  it('spazi e apostrofi si tolgono PRIMA di separare consonanti e vocali', () => {
    expect(terzinaCognome('DE LUCA')).toBe('DLC')
    expect(terzinaCognome("D'ANGELO")).toBe('DNG')
    expect(terzinaCognome('  de   luca  ')).toBe('DLC')
  })

  it('J K W X Y sono CONSONANTI', () => {
    expect(terzinaCognome('KWAKU')).toBe('KWK')
    expect(terzinaCognome('YJKVB')).toBe('YJK')
  })

  it('senza nemmeno una lettera latina → null, MAI un riempimento inventato di X', () => {
    // Se qui uscisse 'XXX' il codice sarebbe plausibile e sbagliato: il modo peggiore.
    expect(terzinaCognome('')).toBeNull()
    expect(terzinaCognome('   ')).toBeNull()
    expect(terzinaCognome('123')).toBeNull()
    expect(terzinaCognome("--'--")).toBeNull()
    expect(terzinaCognome('ИВАНОВ')).toBeNull() // cirillico
    expect(terzinaCognome('محمد')).toBeNull() // arabo
    expect(terzinaCognome('张伟')).toBeNull() // cinese
    expect(terzinaCognome(undefined as unknown as string)).toBeNull()
    expect(terzinaCognome(null as unknown as string)).toBeNull()
  })
})

describe('terzinaNome', () => {
  it('con QUATTRO o più consonanti si prendono la 1ª, la 3ª e la 4ª', () => {
    expect(terzinaNome('FRANCESCO')).toBe('FNC') // F R N C S C → F, N, C
    expect(terzinaNome('YJKVB')).toBe('YKV')
    expect(terzinaNome('XQQWZ')).toBe('XQW')
  })

  it('il confine è ESATTAMENTE quattro: con tre si torna alla regola del cognome', () => {
    expect(terzinaNome('BCDF')).toBe('BDF') // 4 consonanti → 1ª, 3ª, 4ª
    expect(terzinaNome('BCD')).toBe('BCD') // 3 consonanti → prime tre
    expect(terzinaNome('KWAKU')).toBe('KWK') // K W K = 3 → prime tre
  })

  it('con meno di quattro consonanti: consonanti + vocali + XXX', () => {
    expect(terzinaNome('EVA')).toBe('VEA')
    expect(terzinaNome('LI')).toBe('LIX')
    expect(terzinaNome('O')).toBe('OXX')
  })

  it('senza lettere latine → null', () => {
    expect(terzinaNome('')).toBeNull()
    expect(terzinaNome('Ярослав')).toBeNull()
    expect(terzinaNome('7')).toBeNull()
  })
})

describe('terzine — ACCENTI e diacritici', () => {
  /**
   * La normalizzazione NFD con rimozione dei segni deve avvenire PRIMA di separare
   * consonanti e vocali. Un `replace(/[^A-Z]/g, '')` ingenuo butta via la lettera
   * accentata invece di spogliarla.
   *
   * ⚠️ `NICCOLÒ` da solo NON dimostra il difetto: l'accento cade su una vocale e il nome
   * ha già quattro consonanti, quindi la regola «1ª, 3ª, 4ª» dà `NCL` in entrambi i modi.
   * Serve un caso in cui la lettera persa CAMBIA il risultato — ed è per quello che ci
   * sono le tre righe qui sotto.
   */
  it('NICCOLÒ: la Ò resta una O (caso richiesto, ma da solo non discrimina)', () => {
    expect(terzinaNome('NICCOLÒ')).toBe('NCL')
    expect(terzinaCognome('NICCOLÒ')).toBe('NCC')
  })

  it('la vocale accentata FINALE cambia il risultato: ingenuo `XXX`, corretto `XEX`', () => {
    expect(terzinaCognome('XÈ')).toBe('XEX') // ingenuo: 'X' → 'XXX'
    expect(terzinaNome('ZÙ')).toBe('ZUX') // ingenuo: 'Z' → 'ZXX'
  })

  it('la CEDIGLIA è una consonante spogliata, non un carattere da buttare', () => {
    // FRANÇOIS → FRANCOIS: consonanti F R N C S (5) → 1ª, 3ª, 4ª = F N C.
    // Ingenuo (Ç scartata): FRANOIS → consonanti F R N S → F N S. Lettera diversa.
    expect(terzinaNome('FRANÇOIS')).toBe('FNC')
  })

  it('altri diacritici: dieresi, tilde, circonflesso', () => {
    expect(terzinaCognome('MÜLLER')).toBe('MLL')
    expect(terzinaCognome('NÚÑEZ')).toBe('NNZ')
    expect(terzinaNome('RENÉ')).toBe('RNE')
  })
})

describe('terzine — LETTERE LATINE CHE NFD NON DECOMPONE', () => {
  /**
   * ⚠️ QUI IL COMMENTO DEL SORGENTE DICEVA IL FALSO, ED È IL DIFETTO PEGGIORE DEI DUE.
   *
   * Fino al 2026-08-10 `soloLettereLatine` sosteneva: «Resta fuori quello che NFD non
   * decompone (`Ø`, `Đ`) … in quel caso la stringa risultante è vuota, e chi chiama
   * restituisce `null`. È voluto». Misurato: era falso proprio per i due esempi citati.
   * `ĐORĐE` dava `ROE` e `ŁUKASZ` dava `KSZ` — non `null`, ma una terzina PLAUSIBILE E
   * SBAGLIATA, cioè alla lettera «il modo peggiore di sbagliare, perché non si vede».
   * La rete di sicurezza scattava solo se TUTTE le lettere erano non decomponibili.
   *
   * Non è un caso di scuola: in una scuola dell'infanzia i cognomi polacchi, croati e
   * scandinavi ci sono, e il danno non è un suggerimento brutto — è un motivo `cognome`
   * di incoerenza emesso a torto su un bambino il cui codice fiscale è GIUSTO.
   *
   * I casi qui sotto sono scelti perché DISCRIMINANO: con la lettera buttata via il
   * risultato è diverso, e sta scritto accanto a ognuno.
   */
  it('la lettera SBARRATA è una lettera spogliata, non un carattere da buttare', () => {
    // ĐORĐE → DORDE: consonanti D R D → 'DRD'. Ingenuo (Đ scartate): ORE → 'ROE'.
    expect(terzinaCognome('ĐORĐE')).toBe('DRD')
    expect(terzinaNome('ĐORĐE')).toBe('DRD')
    // ŁUKASZ → LUKASZ: consonanti L K S Z → cognome 'LKS'. Ingenuo: UKASZ → 'KSZ'.
    expect(terzinaCognome('ŁUKASZ')).toBe('LKS')
    // Quattro consonanti → 1ª, 3ª, 4ª = L, S, Z. Ingenuo: UKASZ → K S Z → 'KSZ'.
    expect(terzinaNome('ŁUKASZ')).toBe('LSZ')
  })

  it('la O sbarrata è una O: cambia l’ORDINE delle vocali, e quindi la terzina', () => {
    // ØYE → OYE: consonante Y, vocali O E → 'YOE'. Ingenuo: YE → 'YEX'.
    expect(terzinaCognome('ØYE')).toBe('YOE')
  })

  /**
   * I legamenti valgono per le due lettere che contengono. Non è una libertà: è la stessa
   * regola che questo modulo applica già a `ß` → `SS` (lo fa `toUpperCase`), e rifiutarla
   * agli altri sarebbe incoerente.
   */
  it('i LEGAMENTI valgono per le lettere che contengono (Æ, Œ, Þ)', () => {
    // ÆGIR → AEGIR: consonanti G R, vocali A E I → 'GRA'. Ingenuo: GIR → 'GRI'.
    expect(terzinaCognome('ÆGIR')).toBe('GRA')
    // ŒUVRE → OEUVRE: consonanti V R, vocali O E U E → 'VRO'. Ingenuo: UVRE → 'VRU'.
    expect(terzinaCognome('ŒUVRE')).toBe('VRO')
    // ÞORVALD → THORVALD: consonanti T H R V L D → 'THR'. Ingenuo: ORVALD → 'RVL'.
    expect(terzinaCognome('ÞORVALD')).toBe('THR')
    // La ß la scioglie già `toUpperCase`: qui si fissa che continui a farlo.
    expect(terzinaCognome('STRAßE')).toBe('STR')
  })

  /**
   * ⚠️ E QUI LA PROMESSA DIVENTA VERA ANCHE PER QUELLO CHE LA TABELLA NON CONOSCE.
   *
   * Una lettera che non si sa tradurre non si INDOVINA e non si BUTTA: fa restituire
   * `null`, cioè «non confrontabile». È la regola cardine di `coerenza.ts` — un dato che
   * non si può confrontare finisce fra i non verificabili (grigio), non fra le
   * contraddizioni (rosso).
   */
  it('una lettera non latina IN MEZZO a lettere latine non si butta in silenzio: null', () => {
    expect(terzinaCognome('ROSSИ')).toBeNull() // prima dava 'RSS', un rosso falso in attesa
    expect(terzinaNome('ROSSИ')).toBeNull()
    expect(terzinaCognome('张伟ROSSI')).toBeNull()
  })

  it('una lettera latina che la tabella non conosce non si indovina: null', () => {
    expect(terzinaCognome('ƏLIYEV')).toBeNull() // schwa azero: nessuna resa indiscutibile
  })

  it('punteggiatura, cifre e spazi restano scartati in silenzio: non sono lettere', () => {
    expect(terzinaCognome("D'ANGELO 3°")).toBe('DNG')
    expect(terzinaCognome('DE-LUCA')).toBe('DLC')
  })

  /**
   * ⚠️ IL CONFINE ESATTO FRA «scartato in silenzio» E «null», misurato invece che dedotto.
   *
   * La rete di sicurezza filtra su `\p{L}`, e Unicode chiama LETTERA anche roba che nessuno
   * scriverebbe in un cognome: l'indicatore ordinale `ª`/`º` (categoria Lo), il segno micro
   * `µ` (Ll) e le forme a larghezza piena. Per tutti questi la terzina esce `null`.
   *
   * Il confronto che vale la pena guardare è la coppia `3°` / `3ª`: il grado `°` è un
   * SIMBOLO, quindi cade fra la punteggiatura e sparisce; l'ordinale `ª` è una lettera,
   * quindi rende il campo non confrontabile. Sono due caratteri che a schermo si somigliano
   * e qui si comportano in modo opposto, ed è il motivo per cui questa riga è un test e non
   * una frase in un commento.
   *
   * Il fallimento è CONSERVATIVO — il campo finisce fra i `nonVerificabili` di
   * `coerenza.ts`, grigio, non rosso — quindi non produce mai un'incoerenza a torto. È una
   * perdita di verificabilità, non un errore: qui si fissa perché non sia più una sorpresa.
   */
  it('anche `ª`, `º`, `µ` e le forme a larghezza piena sono LETTERE per Unicode: null', () => {
    expect(terzinaCognome('ROSSIª')).toBeNull()
    expect(terzinaCognome('ROSSIº')).toBeNull()
    expect(terzinaCognome('ROSSIµ')).toBeNull()
    expect(terzinaCognome('ＲＯＳＳＩ')).toBeNull() // larghezza piena, U+FF32…
    expect(terzinaNome('MARIAª')).toBeNull()
    // La coppia che sembra la stessa cosa e non lo è: `°` è un simbolo, `ª` una lettera.
    expect(terzinaCognome("D'ANGELO 3°")).toBe('DNG')
    expect(terzinaCognome("D'ANGELO 3ª")).toBeNull()
  })

  /**
   * Il caso che la vecchia rete di sicurezza copriva davvero — tutte le lettere non
   * decomponibili — non è più `null`: adesso si traduce, che è la risposta giusta.
   * Sta scritto qui perché è l'unico comportamento che cambia in meglio senza essere un
   * difetto riparato.
   */
  it('quando TUTTE le lettere sono sbarrate non esce più `null`: esce la terzina vera', () => {
    expect(terzinaCognome('ĐĐĐ')).toBe('DDD')
    expect(terzinaCognome('ŁŁŁ')).toBe('LLL')
    expect(terzinaCognome('ИВАНОВ')).toBeNull() // il cirillico resta `null`, e deve
  })
})

describe('terzinaData', () => {
  it('anno a due cifre, lettera del mese, giorno — tutto zero-padded', () => {
    expect(terzinaData('2019-03-07', 'M')).toBe('19C07')
    expect(terzinaData('2005-12-15', 'M')).toBe('05T15')
    expect(terzinaData('2000-01-01', 'M')).toBe('00A01')
    expect(terzinaData('1999-11-30', 'M')).toBe('99S30')
  })

  it('alla FEMMINA si sommano 40 al giorno: 15 → 55, 1 → 41', () => {
    expect(terzinaData('2005-12-15', 'F')).toBe('05T55')
    expect(terzinaData('2000-01-01', 'F')).toBe('00A41')
    expect(terzinaData('2019-03-07', 'F')).toBe('19C47')
    expect(terzinaData('1999-10-31', 'F')).toBe('99R71')
  })

  it('le dodici lettere del mese, in ordine', () => {
    const attese: Array<[number, string]> = [
      [1, 'A'], [2, 'B'], [3, 'C'], [4, 'D'], [5, 'E'], [6, 'H'],
      [7, 'L'], [8, 'M'], [9, 'P'], [10, 'R'], [11, 'S'], [12, 'T'],
    ]
    for (const [mese, lettera] of attese) {
      const mm = String(mese).padStart(2, '0')
      expect(terzinaData(`2019-${mm}-07`, 'M')).toBe(`19${lettera}07`)
    }
  })

  it('date che sul calendario NON esistono → null', () => {
    expect(terzinaData('2019-02-30', 'M')).toBeNull()
    expect(terzinaData('2019-04-31', 'M')).toBeNull()
    expect(terzinaData('1900-02-29', 'M')).toBeNull() // 1900 non è bisestile
    expect(terzinaData('2019-13-01', 'M')).toBeNull()
    expect(terzinaData('2019-00-10', 'M')).toBeNull()
    expect(terzinaData('2019-03-00', 'M')).toBeNull()
    expect(terzinaData('2019-03-32', 'M')).toBeNull()
  })

  it('il 29 febbraio esiste negli anni bisestili, secolari compresi', () => {
    expect(terzinaData('2000-02-29', 'M')).toBe('00B29') // divisibile per 400
    expect(terzinaData('2020-02-29', 'F')).toBe('20B69')
    expect(terzinaData('2100-02-29', 'M')).toBeNull() // divisibile per 100 ma non per 400
  })

  it('accetta SOLO la forma AAAA-MM-GG (con spazi ai bordi tollerati)', () => {
    expect(terzinaData('  2019-03-07  ', 'M')).toBe('19C07')
    expect(terzinaData('07/03/2019', 'M')).toBeNull()
    expect(terzinaData('2019-3-7', 'M')).toBeNull()
    expect(terzinaData('2019-03-07T00:00:00Z', 'M')).toBeNull()
    expect(terzinaData('', 'M')).toBeNull()
    expect(terzinaData('boh', 'M')).toBeNull()
    expect(terzinaData(null as unknown as string, 'M')).toBeNull()
    expect(terzinaData(new Date() as unknown as string, 'M')).toBeNull()
  })

  it('senza un sesso valido non si può decidere il +40 → null', () => {
    expect(terzinaData('2019-03-07', 'X' as unknown as 'M')).toBeNull()
    expect(terzinaData('2019-03-07', '' as unknown as 'M')).toBeNull()
    expect(terzinaData('2019-03-07', null as unknown as 'M')).toBeNull()
  })
})

describe('carattereControllo', () => {
  /** Attese calcolate con `codice-fiscale-js`, non con questo modulo. */
  const attese: Array<[string, string]> = [
    ['XQQYKV19C07Z999', 'T'],
    ['XQQYKV19C47Z999', 'X'],
    ['XQQYKV19C0TZ999', 'Q'],
    ['XQQYKVMVCLTZVVV', 'V'],
    ['XQQYKV19C07Z998', 'R'],
    ['ZZZQQQ00A01Z999', 'F'],
  ]

  it('calcola la lettera attesa su tutti i casi noti', () => {
    for (const [primi15, lettera] of attese) {
      expect(carattereControllo(primi15)).toBe(lettera)
    }
  })

  it('è indifferente alle minuscole', () => {
    expect(carattereControllo('xqqykv19c07z999')).toBe('T')
  })

  /**
   * ⚠️ L'ERRORE PIÙ FACILE DEL MONDO: le posizioni «dispari» dell'Agenzia sono in
   * numerazione 1-BASED, cioè gli indici 0-based PARI. Chi scambia le due tabelle ottiene
   * comunque una lettera dell'alfabeto — plausibile, e sbagliata.
   *
   * Questo test ricostruisce la versione INVERTITA con le stesse tabelle e pretende che
   * dia una lettera DIVERSA: se un giorno qualcuno scambia i pesi in `tabelle.ts`, la
   * prima riga diventa rossa e la seconda smette di essere una tautologia.
   */
  it('le posizioni dispari sono gli INDICI PARI: invertire le tabelle dà un’altra lettera', () => {
    function invertito(primi15: string): string {
      let somma = 0
      for (let i = 0; i < primi15.length; i++) {
        const peso = i % 2 === 0 ? PESI_PARI[primi15[i]] : PESI_DISPARI[primi15[i]]
        somma += peso ?? 0
      }
      return ALFABETO_CONTROLLO[somma % 26]
    }
    for (const [primi15, lettera] of attese) {
      expect(carattereControllo(primi15)).toBe(lettera)
      expect(invertito(primi15)).not.toBe(lettera)
    }
    // e la lettera sbagliata è comunque una lettera: ecco perché l'errore passa inosservato
    expect(invertito('XQQYKV19C07Z999')).toBe('B')
  })

  it('un input che non è quindici caratteri ammessi non produce una lettera a caso', () => {
    expect(() => carattereControllo('XQQYKV19C07Z99')).toThrow(RangeError)
    expect(() => carattereControllo('XQQYKV19C07Z999T')).toThrow(RangeError)
    expect(() => carattereControllo('XQQYKV19C07Z9-9')).toThrow(RangeError)
    expect(() => carattereControllo(null as unknown as string)).toThrow(RangeError)
  })
})

describe('calcolaCodiceFiscale', () => {
  const BASE = {
    nome: 'YJKVB',
    cognome: 'XQQWZ',
    sesso: 'M' as const,
    dataNascita: '2019-03-07',
    codiceBelfiore: 'Z999',
  }

  it('caso completo, maschio', () => {
    expect(calcolaCodiceFiscale(BASE)).toEqual({ ok: true, codice: 'XQQYKV19C07Z999T' })
  })

  it('caso completo, femmina: cambia il giorno e cambia il controllo', () => {
    expect(calcolaCodiceFiscale({ ...BASE, sesso: 'F' }))
      .toEqual({ ok: true, codice: 'XQQYKV19C47Z999X' })
  })

  it('normalizza gli ingressi: minuscole, spazi, catastale in minuscolo', () => {
    expect(calcolaCodiceFiscale({
      nome: ' yjkvb ', cognome: ' xqq wz ', sesso: 'M', dataNascita: ' 2019-03-07 ', codiceBelfiore: ' z999 ',
    })).toEqual({ ok: true, codice: 'XQQYKV19C07Z999T' })
  })

  /**
   * L'omocodia la ASSEGNA l'Agenzia quando due persone collidono: non è una cosa che si
   * calcola. Un modulo che la producesse inventerebbe il codice di qualcun altro.
   */
  it('non produce MAI un codice omocodico: nelle posizioni numeriche ci sono cifre', () => {
    const esito = calcolaCodiceFiscale({ ...BASE, sesso: 'F' })
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    for (const posizione of POSIZIONI_NUMERICHE) {
      expect(esito.codice[posizione]).toMatch(/[0-9]/)
    }
  })

  it('cognome senza lettere → motivo, non un codice riempito di X', () => {
    expect(calcolaCodiceFiscale({ ...BASE, cognome: '' }))
      .toEqual({ ok: false, motivo: 'cognome-senza-lettere' })
    expect(calcolaCodiceFiscale({ ...BASE, cognome: 'ИВАНОВ' }))
      .toEqual({ ok: false, motivo: 'cognome-senza-lettere' })
  })

  it('nome senza lettere → motivo', () => {
    expect(calcolaCodiceFiscale({ ...BASE, nome: '  ' }))
      .toEqual({ ok: false, motivo: 'nome-senza-lettere' })
  })

  it('sesso non valido → motivo', () => {
    expect(calcolaCodiceFiscale({ ...BASE, sesso: 'X' as unknown as 'M' }))
      .toEqual({ ok: false, motivo: 'sesso-non-valido' })
    expect(calcolaCodiceFiscale({ ...BASE, sesso: '' as unknown as 'M' }))
      .toEqual({ ok: false, motivo: 'sesso-non-valido' })
    expect(calcolaCodiceFiscale({ ...BASE, sesso: 'maschio' as unknown as 'M' }))
      .toEqual({ ok: false, motivo: 'sesso-non-valido' })
  })

  /**
   * Il sesso lo normalizza l'ingresso, non la primitiva: `terzinaData` resta severa
   * (il suo tipo è `'M'|'F'` e basta), qui invece arriva quello che c'è in anagrafica.
   * In produzione la colonna `gender` contiene solo `M`, `F` o `null` — misurato il
   * 2026-08-10 su `alunni` e `parents` — ma il minuscolo costa una `toUpperCase()`.
   */
  it('il sesso tollera minuscole e spazi, come ogni altro ingresso', () => {
    expect(calcolaCodiceFiscale({ ...BASE, sesso: ' m ' as unknown as 'M' }))
      .toEqual({ ok: true, codice: 'XQQYKV19C07Z999T' })
    expect(calcolaCodiceFiscale({ ...BASE, sesso: 'f' as unknown as 'F' }))
      .toEqual({ ok: true, codice: 'XQQYKV19C47Z999X' })
  })

  it('data non valida → motivo', () => {
    expect(calcolaCodiceFiscale({ ...BASE, dataNascita: '2019-02-30' }))
      .toEqual({ ok: false, motivo: 'data-non-valida' })
    expect(calcolaCodiceFiscale({ ...BASE, dataNascita: '07/03/2019' }))
      .toEqual({ ok: false, motivo: 'data-non-valida' })
  })

  it('codice catastale non valido → motivo', () => {
    for (const belfiore of ['', 'ZZ99', 'Z9999', 'Z99', '9999', 'Z 9 9']) {
      expect(calcolaCodiceFiscale({ ...BASE, codiceBelfiore: belfiore }))
        .toEqual({ ok: false, motivo: 'belfiore-non-valido' })
    }
  })

  it('quando manca più di un dato, il motivo è il PRIMO in ordine di lettura', () => {
    expect(calcolaCodiceFiscale({ nome: '', cognome: '', sesso: 'Z' as unknown as 'M', dataNascita: '', codiceBelfiore: '' }))
      .toEqual({ ok: false, motivo: 'cognome-senza-lettere' })
    expect(calcolaCodiceFiscale({ ...BASE, nome: '', sesso: 'Z' as unknown as 'M', dataNascita: '' }))
      .toEqual({ ok: false, motivo: 'nome-senza-lettere' })
  })
})
