import { describe, it, expect } from 'vitest'
import {
  EMAIL_RIPETUTA_FRA_GENITORI,
  indiciEmailRipetute,
  normalizzaEmailModulo,
} from '@/lib/iscrizioni/email-genitori'
import { ADULT_FIELDS } from '@/lib/forms/enrollment-template'

// ─────────────────────────────────────────────────────────────────────────────
// UN GENITORE, UNA CASELLA — il modulo puro che dice se due adulti della stessa
// domanda hanno indicato lo stesso indirizzo.
//
// ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
// La regola vive in un posto solo ma viene chiesta da DUE parti: dal wizard
// (`EnrollmentWizard.tsx:352,366`), perché il genitore se ne accorga mentre
// scrive, e dalla route (`api/iscrizione/route.ts:258`), perché il modulo è
// pubblico e ANONIMO e chiunque può spedirle un corpo a mano. Nessuno dei due
// chiamanti ripete il confronto: se questa funzione sbaglia, sbagliano
// entrambi insieme e nella stessa direzione — che è il guasto peggiore, perché
// non c'è la seconda opinione che lo smaschera.
//
// ─── LE DUE DIREZIONI DELL'ERRORE, E PERCHÉ NON SI EQUIVALGONO ──────────────
// Un FALSO NEGATIVO (due caselle uguali che passano) rimette in produzione il
// caso che si voleva togliere: `utenti.email` è UNIQUE, GoTrue rifiuta un
// indirizzo già registrato, e uno dei due genitori resta fuori dall'app.
// Un FALSO POSITIVO (due caselle diverse rifiutate, o un campo vuoto scambiato
// per una ripetizione) è peggio ancora nella pratica: il modulo è l'unica porta
// d'ingresso pubblica, non ha assistenza, e chi non riesce a passare non
// telefona — chiude la pagina. L'email è un campo FACOLTATIVO (misurato qui
// sotto sul template), quindi «due adulti senza casella» è un caso NORMALE, non
// un caso limite: è la strada di tutti i giorni per le famiglie che l'email non
// la lasciano.
// ─────────────────────────────────────────────────────────────────────────────

describe('il fatto che regge la regola sui campi vuoti', () => {
  it("l'email del genitore è FACOLTATIVA nel modulo: «vuoto» non è un errore da segnalare", () => {
    // Non è un dettaglio del template: è la premessa di metà dei casi qui sotto.
    // Se un giorno l'email diventasse obbligatoria, la scelta di ignorare le
    // caselle vuote andrebbe ridiscussa, e questo test diventa rosso al momento
    // giusto — invece che restare un commento che nessuno rilegge.
    const email = ADULT_FIELDS.find((f) => f.id === 'email')
    expect(email).toBeDefined()
    expect(email?.required).toBe(false)
  })
})

describe('normalizzaEmailModulo — la stessa casella scritta in modi diversi', () => {
  it('lascia intatto un indirizzo già in minuscolo e senza spazi', () => {
    expect(normalizzaEmailModulo('mario.rossi@example.test')).toBe('mario.rossi@example.test')
  })

  it('abbassa le maiuscole: la casella è la stessa, il confronto alla lettera direbbe di no', () => {
    expect(normalizzaEmailModulo('Mario.Rossi@Example.TEST')).toBe('mario.rossi@example.test')
  })

  it('toglie gli spazi in testa e in coda — quelli che incolla il telefono, non il genitore', () => {
    expect(normalizzaEmailModulo('   mario.rossi@example.test   ')).toBe('mario.rossi@example.test')
  })

  it('maiuscole E spazi insieme: è la combinazione che arriva davvero da un incolla', () => {
    expect(normalizzaEmailModulo('  MARIO.ROSSI@EXAMPLE.TEST ')).toBe('mario.rossi@example.test')
  })

  it('è la stessa normalizzazione di `lower(btrim(...))` a database, non una parente stretta', () => {
    // La colonna generata `iscrizioni_inviti_credenziali.email_norm` è
    // `lower(btrim(email))` (migrazione 20260816201223, riga 147) ed è ciò su cui
    // gira l'indice che impedisce il doppio invito. Se qui si normalizzasse
    // diversamente, il modulo accetterebbe due caselle che il database poi
    // considera una sola — cioè rifiuterebbe l'invito al secondo genitore DOPO
    // avergli promesso un accesso.
    const comeIlDatabase = (v: string) => v.replace(/^ +| +$/g, '').toLowerCase()
    for (const grezzo of [
      ' Mario@Example.TEST ',
      'ANNA.VERDI@example.test',
      '  segreteria@scuola.test',
      'x@y.test  ',
    ]) {
      expect(normalizzaEmailModulo(grezzo)).toBe(comeIlDatabase(grezzo))
    }
  })

  it('non inventa niente: non tocca il punto, il più e il maiuscolo DENTRO la parte locale', () => {
    // `mario+padre@…` e `mario@…` sono caselle diverse per questa funzione, ed è
    // giusto così: qui si normalizza, non si indovina chi c'è dietro.
    expect(normalizzaEmailModulo('mario+padre@example.test')).toBe('mario+padre@example.test')
    expect(normalizzaEmailModulo('mario.rossi@example.test')).not.toBe('mariorossi@example.test')
  })

  it.each([
    ['stringa vuota', ''],
    ['solo spazi', '     '],
    ['null', null],
    ['undefined', undefined],
    ['numero', 42],
    ['oggetto', { email: 'mario@example.test' }],
    ['array', ['mario@example.test']],
    ['booleano', true],
  ])('%s → stringa vuota, senza lanciare: il corpo arriva da fuori e può essere qualunque cosa', (_, valore) => {
    expect(() => normalizzaEmailModulo(valore)).not.toThrow()
    expect(normalizzaEmailModulo(valore)).toBe('')
  })
})

describe('indiciEmailRipetute — quando NON si segnala niente', () => {
  it('due indirizzi diversi: nessuna ripetizione', () => {
    expect(indiciEmailRipetute(['mario.rossi@example.test', 'anna.verdi@example.test'])).toEqual([])
  })

  it('un solo adulto non può ripetere niente', () => {
    expect(indiciEmailRipetute(['mario.rossi@example.test'])).toEqual([])
  })

  it('nessun adulto: nessun indice', () => {
    expect(indiciEmailRipetute([])).toEqual([])
  })

  it('quattro adulti (il massimo del modulo) tutti diversi: nessuna ripetizione', () => {
    expect(
      indiciEmailRipetute([
        'padre@example.test',
        'madre@example.test',
        'nonna@example.test',
        'zio@example.test',
      ]),
    ).toEqual([])
  })

  it('caselle simili ma non uguali non si confondono', () => {
    expect(indiciEmailRipetute(['mario@example.test', 'mario@examples.test'])).toEqual([])
    expect(indiciEmailRipetute(['mario@example.test', 'maria@example.test'])).toEqual([])
  })
})

describe('indiciEmailRipetute — la stessa casella scritta in modo diverso è la stessa casella', () => {
  it('maiuscole diverse: è una ripetizione', () => {
    expect(indiciEmailRipetute(['Mario.Rossi@Example.test', 'mario.rossi@example.test'])).toEqual([1])
  })

  it('spazi in testa e in coda: è una ripetizione', () => {
    expect(indiciEmailRipetute(['mario.rossi@example.test', '  mario.rossi@example.test  '])).toEqual([1])
  })

  it('maiuscole E spazi insieme: è una ripetizione', () => {
    // È il caso vero: il secondo genitore copia l'indirizzo dal primo campo,
    // il telefono ci mette uno spazio in coda e la maiuscola iniziale. Senza
    // normalizzazione questa domanda passerebbe, e uno dei due resterebbe
    // senza accesso all'app.
    expect(indiciEmailRipetute(['  MARIO.ROSSI@EXAMPLE.TEST ', 'mario.rossi@example.test'])).toEqual([1])
  })
})

describe('indiciEmailRipetute — si segnala il SECONDO, mai il primo', () => {
  it('due uguali: l’indice segnalato è 1, non 0', () => {
    // Il messaggio va sul campo che l'utente deve CAMBIARE. Segnalare il primo
    // vorrebbe dire chiedergli di correggere la casella che ha compilato bene —
    // e chi la corregge davvero perde l'indirizzo giusto.
    const ripetuti = indiciEmailRipetute(['mario.rossi@example.test', 'mario.rossi@example.test'])
    expect(ripetuti).toEqual([1])
    expect(ripetuti).not.toContain(0)
  })

  it('la ripetizione è fra il TERZO e il PRIMO: si segnala il terzo', () => {
    const ripetuti = indiciEmailRipetute([
      'mario.rossi@example.test',
      'anna.verdi@example.test',
      'mario.rossi@example.test',
    ])
    expect(ripetuti).toEqual([2])
  })

  it('due coppie distinte: si segnala il secondo di ciascuna', () => {
    expect(
      indiciEmailRipetute([
        'padre@example.test',
        'madre@example.test',
        'padre@example.test',
        'madre@example.test',
      ]),
    ).toEqual([2, 3])
  })

  it('tre adulti con la stessa casella: gli indici sono 1 e 2', () => {
    // Il primo è la casella «buona»: tutti gli altri sono da cambiare, non solo
    // il secondo. Fermarsi al primo doppione lascerebbe passare il terzo.
    expect(
      indiciEmailRipetute([
        'famiglia@example.test',
        'famiglia@example.test',
        'famiglia@example.test',
      ]),
    ).toEqual([1, 2])
  })

  it('gli indici escono in ordine crescente: il wizard manda il genitore al PRIMO da correggere', () => {
    // `EnrollmentWizard.tsx:368` prende `ripetute[0]` e ci riporta il genitore.
    // Se l'ordine non fosse crescente lo manderebbe a un passo più avanti, e il
    // doppione precedente resterebbe lì senza che nessuno lo indichi.
    const ripetuti = indiciEmailRipetute([
      'famiglia@example.test',
      'famiglia@example.test',
      'altra@example.test',
      'famiglia@example.test',
    ])
    expect(ripetuti).toEqual([1, 3])
    expect([...ripetuti].sort((a, b) => a - b)).toEqual(ripetuti)
  })
})

describe('indiciEmailRipetute — le caselle vuote non ripetono niente', () => {
  it.each([
    ['stringa vuota', '' as unknown],
    ['solo spazi', '   ' as unknown],
    ['null', null as unknown],
    ['undefined', undefined as unknown],
  ])('due adulti senza email (%s) non stanno ripetendo niente', (_, vuoto) => {
    expect(indiciEmailRipetute([vuoto, vuoto])).toEqual([])
  })

  it('quattro adulti tutti senza email: nessuna segnalazione', () => {
    // Il caso normale della famiglia che l'email non la lascia. Se «vuoto»
    // contasse come valore, il modulo pubblico rifiuterebbe la domanda di chi
    // non ha sbagliato niente — e chi non passa non telefona: chiude la pagina.
    expect(indiciEmailRipetute(['', '   ', null, undefined])).toEqual([])
  })

  it('vuoti misti in mezzo a caselle vere: si segnala solo la ripetizione vera', () => {
    expect(
      indiciEmailRipetute([
        'mario.rossi@example.test',
        '',
        null,
        '   ',
        'mario.rossi@example.test',
        undefined,
      ]),
    ).toEqual([4])
  })

  it("i vuoti non spostano gli indici: l'indice segnalato è quello del campo nel modulo", () => {
    // L'indice torna al chiamante e diventa `adults.<i>.email`: se fosse un
    // conteggio dei soli campi compilati, l'errore si attaccherebbe al genitore
    // sbagliato.
    expect(indiciEmailRipetute([null, 'mario.rossi@example.test', '', 'mario.rossi@example.test'])).toEqual([3])
  })
})

describe('indiciEmailRipetute — non lancia su ciò che arriva da fuori', () => {
  it.each([
    ['numeri', [42, 42]],
    ['oggetti', [{}, {}]],
    ['array annidati', [['mario@example.test'], ['mario@example.test']]],
    ['booleani', [true, false]],
    ['misto di tutto', [0, {}, [], true, null, undefined, NaN]],
  ])('%s: non lancia e non segnala nessuna ripetizione', (_, valori) => {
    // La route è pubblica e anonima: il corpo può contenere qualunque cosa.
    // Questi valori non sono caselle, quindi non sono ripetizioni — e soprattutto
    // non devono far cadere la validazione prima che gli altri controlli parlino.
    expect(() => indiciEmailRipetute(valori)).not.toThrow()
    expect(indiciEmailRipetute(valori)).toEqual([])
  })

  it('un numero e la sua rappresentazione testuale non sono la stessa casella', () => {
    // Perché nessuno dei due è una casella: entrambi normalizzano a vuoto, e
    // «vuoto» non ripete.
    expect(indiciEmailRipetute([42, '42'])).toEqual([])
  })

  it('una casella vera in mezzo a valori non-stringa resta riconoscibile', () => {
    expect(indiciEmailRipetute([{}, 'mario.rossi@example.test', 7, ' MARIO.ROSSI@example.test '])).toEqual([3])
  })

  it("l'array non viene modificato: il chiamante ci ripassa sopra per costruire i messaggi", () => {
    const originale: unknown[] = [' Mario@Example.test ', 'mario@example.test']
    const copia = [...originale]
    indiciEmailRipetute(originale)
    expect(originale).toEqual(copia)
  })
})

describe('EMAIL_RIPETUTA_FRA_GENITORI — la frase che legge il genitore', () => {
  it('spiega il PERCHÉ, non solo il divieto', () => {
    // Senza il motivo la richiesta sembra un capriccio del modulo, e la reazione
    // naturale è inventare un indirizzo pur di andare avanti: a quel punto la
    // password del secondo genitore parte verso una casella che non esiste.
    expect(EMAIL_RIPETUTA_FRA_GENITORI).toMatch(/access/i)
    expect(EMAIL_RIPETUTA_FRA_GENITORI).toMatch(/divers/i)
  })

  it('è una frase per una persona, non un codice d’errore', () => {
    expect(EMAIL_RIPETUTA_FRA_GENITORI.length).toBeGreaterThan(30)
    expect(EMAIL_RIPETUTA_FRA_GENITORI).not.toMatch(/^[A-Z0-9_]+$/)
  })

  it('non suggerisce l’alias `+`: sarebbe due account e zero beneficio', () => {
    // Le due password finirebbero comunque nella stessa casella — esattamente il
    // problema che la regola voleva togliere.
    expect(EMAIL_RIPETUTA_FRA_GENITORI).not.toMatch(/\+/)
  })
})
