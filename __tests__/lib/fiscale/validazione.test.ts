import { describe, it, expect } from 'vitest'
import { normalizzaCodiceFiscale, validaCodiceFiscale } from '@/lib/fiscale/validazione'
import { carattereControllo } from '@/lib/fiscale/calcolo'
import { dataNascitaDaCodiceFiscale } from '@/lib/fiscale/codice-fiscale'

/**
 * ⚠️ CONVENZIONE DEI DATI DI PROVA (la stessa di `calcolo.test.ts`, e per la stessa ragione).
 *
 * Il repository è PUBBLICO e il dominio sono minori. Qui la checksum DEVE tornare — è
 * l'oggetto del collaudo — quindi la garanzia che nessuno di questi codici appartenga a una
 * persona vera è tutta nel CODICE CATASTALE: `Z999` e `Z998` sono nella serie `Z9xx`, che
 * non è assegnata a nessuno stato estero. Le terzine (`XQQ`, `YKV`) vengono da cognomi e
 * nomi inventati e impronunciabili.
 *
 * Il codice di riferimento, calcolato con `codice-fiscale-js` (implementazione
 * indipendente): `XQQYKV19C07Z999T` — «XQQWZ YJKVB», maschio, 7 marzo 2019, catastale Z999.
 */

const VALIDO = 'XQQYKV19C07Z999T'

describe('normalizzaCodiceFiscale', () => {
  it('toglie gli spazi (anche interni) e alza a maiuscolo', () => {
    expect(normalizzaCodiceFiscale('  xqqykv19c07z999t  ')).toBe(VALIDO)
    expect(normalizzaCodiceFiscale('XQQ YKV 19C07 Z999T')).toBe(VALIDO)
    // incollato da un PDF: spazio unificatore (U+00A0), tabulazioni, a capo
    expect(normalizzaCodiceFiscale('XQQYKV19C07 Z999T')).toBe(VALIDO)
    expect(normalizzaCodiceFiscale('XQQYKV19C07\tZ999T\n')).toBe(VALIDO)
  })

  it('quello che non è una stringa diventa stringa vuota, non «undefined»', () => {
    expect(normalizzaCodiceFiscale(null)).toBe('')
    expect(normalizzaCodiceFiscale(undefined)).toBe('')
    expect(normalizzaCodiceFiscale(12345)).toBe('')
    expect(normalizzaCodiceFiscale({})).toBe('')
    expect(normalizzaCodiceFiscale(['XQQYKV19C07Z999T'])).toBe('')
  })
})

describe('validaCodiceFiscale — il codice giusto', () => {
  it('valido, senza motivi, senza omocodia, base uguale a sé stesso', () => {
    expect(validaCodiceFiscale(VALIDO)).toEqual({
      valido: true,
      normalizzato: VALIDO,
      motivi: [],
      omocodia: false,
      baseSenzaOmocodia: VALIDO,
    })
  })

  it('minuscole e spazi non lo rendono meno valido', () => {
    expect(validaCodiceFiscale(' xqq ykv 19c07 z999t ').valido).toBe(true)
    expect(validaCodiceFiscale(' xqq ykv 19c07 z999t ').normalizzato).toBe(VALIDO)
  })
})

describe('validaCodiceFiscale — assente', () => {
  it('vuoto, spazi soltanto, null, non-stringa → motivo «vuoto»', () => {
    for (const valore of ['', '   ', '\n\t', null, undefined, 12345, {}]) {
      const esito = validaCodiceFiscale(valore)
      expect(esito).toEqual({
        valido: false,
        normalizzato: '',
        motivi: ['vuoto'],
        omocodia: false,
        baseSenzaOmocodia: null,
      })
    }
  })
})

describe('validaCodiceFiscale — LUNGHEZZA', () => {
  /**
   * ⚠️ IL CASO CHE VIENE DALLA PRODUZIONE, non dalla fantasia.
   *
   * Misurato il 2026-08-10 sul database di produzione: dei codici fiscali presenti,
   * **30 su 36 sono lunghi 14 caratteri** (10 su 15 fra gli alunni, 20 su 22 fra i
   * genitori). Non sono omocodie né refusi isolati: è la forma con cui sono stati
   * importati. Un pannello che li desse per buoni sbaglierebbe su quasi tutti.
   */
  it('quattordici caratteri: il caso di gran lunga più frequente in produzione', () => {
    const esito = validaCodiceFiscale('XQQYKV19C07Z99')
    expect(esito.valido).toBe(false)
    expect(esito.motivi).toEqual(['lunghezza'])
    expect(esito.baseSenzaOmocodia).toBeNull()
  })

  /**
   * ⚠️ `alunni.codice_fiscale` è `character(16)`: Postgres IMPAGINA CON SPAZI a destra.
   * Un valore di 14 caratteri torna da PostgREST come 14 caratteri + 2 spazi, cioè con
   * `length` 16. Ogni controllo scritto come `valore.length === 16` su quella colonna
   * MENTE. Qui la normalizzazione toglie gli spazi PRIMA di misurare, ed è tutta la
   * differenza fra «sedici caratteri» e «sedici caratteri veri».
   */
  it('sedici caratteri di cui due sono l’impaginazione di character(16) → resta lungo 14', () => {
    const dalDatabase = 'XQQYKV19C07Z99  '
    expect(dalDatabase).toHaveLength(16) // ecco la bugia
    expect(validaCodiceFiscale(dalDatabase).motivi).toEqual(['lunghezza'])
    expect(validaCodiceFiscale(dalDatabase).normalizzato).toHaveLength(14)
  })

  it('un codice vero dentro character(16) non viene rovinato dalla normalizzazione', () => {
    expect(validaCodiceFiscale(`${VALIDO}`).valido).toBe(true)
    expect(validaCodiceFiscale(` ${VALIDO} `).valido).toBe(true)
  })

  it('altre lunghezze sbagliate, comprese quelle da uno e due caratteri viste in produzione', () => {
    for (const valore of ['X', 'XQ', 'XQQYKV19C07Z999', 'XQQYKV19C07Z999TT']) {
      expect(validaCodiceFiscale(valore).motivi).toEqual(['lunghezza'])
    }
  })
})

describe('validaCodiceFiscale — FORMA', () => {
  const malformati: Array<[string, string]> = [
    ['cifra dentro le prime sei lettere', 'XQ1YKV19C07Z999T'],
    ['lettera fuori omocodia al posto di una cifra dell’anno', 'XQQYKV1KC07Z999T'],
    ['lettera del mese inesistente (Z)', 'XQQYKV19Z07Z999T'],
    ['lettera del mese inesistente (F)', 'XQQYKV19F07Z999T'],
    ['lettera fuori omocodia nel giorno', 'XQQYKV19C0AZ999T'],
    ['cifra al posto della lettera del catastale', 'XQQYKV19C079999T'],
    ['cifra al posto del carattere di controllo', 'XQQYKV19C07Z9991'],
    ['punteggiatura', 'XQQYKV19C07Z99-T'],
  ]

  for (const [nome, valore] of malformati) {
    it(`${nome} → motivo «forma»`, () => {
      const esito = validaCodiceFiscale(valore)
      expect(esito.valido).toBe(false)
      expect(esito.motivi).toEqual(['forma'])
      expect(esito.baseSenzaOmocodia).toBeNull()
    })
  }
})

describe('validaCodiceFiscale — GIORNO', () => {
  /**
   * ⚠️ IL CASO SU CUI DUE MODULI DELLA STESSA CARTELLA DAVANO VERDETTI OPPOSTI.
   *
   * Fino al 2026-08-10 `validaCodiceFiscale` dichiarava `valido: true` su un codice con un
   * giorno che non esiste — `00`, `32`, `40`, `99` — purché la checksum tornasse, mentre
   * `codice-fiscale.ts` lo rifiutava già («0 e 32–40 non esistono né al maschile né al
   * femminile: il codice è rotto»). Non era una riga sbagliata: era la divergenza che
   * `tabelle.ts` esiste per abolire, e nessun test se ne accorgeva perché ogni modulo
   * aveva i suoi.
   *
   * La scala vera è **1–31 al maschile e 41–71 al femminile** (giorno + 40): fra 32 e 40,
   * e sopra 71, non c'è nessuno.
   */
  const impossibili: Array<[string, string]> = [
    ['00 — non esiste né al maschile né al femminile', 'XQQYKV19C00Z999D'],
    ['32 — il primo giorno che il maschile non ha', 'XQQYKV19C32Z999K'],
    ['35 — in mezzo alla terra di nessuno', 'XQQYKV19C35Z999S'],
    ['40 — l’ultimo prima che cominci il femminile', 'XQQYKV19C40Z999H'],
    ['72 — sarebbe il 32 al femminile', 'XQQYKV19C72Z999O'],
    ['99 — sarebbe il 59 al femminile', 'XQQYKV19C99Z999G'],
  ]

  const ammessi: Array<[string, string]> = [
    ['01 — il primo del maschile', 'XQQYKV19C01Z999C'],
    ['31 — l’ultimo del maschile', 'XQQYKV19C31Z999F'],
    ['41 — il primo del femminile (1 + 40)', 'XQQYKV19C41Z999G'],
    ['71 — l’ultimo del femminile (31 + 40)', 'XQQYKV19C71Z999J'],
  ]

  /**
   * ⚠️ SENZA QUESTO, IL BLOCCO NON PROVEREBBE NIENTE: dimostra che questi codici vengono
   * rifiutati PER IL GIORNO e non perché ci si è sbagliati a scegliere il sedicesimo
   * carattere. Se la checksum fosse falsa, il motivo sarebbe `checksum` e il collaudo
   * passerebbe verde misurando la cosa sbagliata.
   */
  it('tutti i codici di questo blocco hanno la checksum GIUSTA', () => {
    for (const [, cf] of [...impossibili, ...ammessi]) {
      expect(carattereControllo(cf.slice(0, 15))).toBe(cf[15])
    }
  })

  for (const [nome, cf] of impossibili) {
    it(`giorno ${nome} → motivo «giorno», nonostante la checksum torni`, () => {
      const esito = validaCodiceFiscale(cf)
      expect(esito.valido).toBe(false)
      expect(esito.motivi).toEqual(['giorno'])
      expect(esito.baseSenzaOmocodia).toBeNull()
    })
  }

  for (const [nome, cf] of ammessi) {
    it(`giorno ${nome} → valido`, () => {
      const esito = validaCodiceFiscale(cf)
      expect(esito.valido).toBe(true)
      expect(esito.motivi).toEqual([])
    })
  }

  /**
   * L'omocodia sostituisce le cifre con lettere anche nelle due posizioni del giorno: il
   * giorno va giudicato DOPO averla sciolta, altrimenti `Number('LT')` è `NaN` e ogni
   * codice omocodico diventerebbe «giorno impossibile».
   */
  it('il giorno si giudica dopo aver sciolto l’omocodia, non prima', () => {
    // 'LT' → 0,7: il 7 marzo. Valido, e lo era già.
    expect(validaCodiceFiscale('XQQYKV19CLTZ999B').valido).toBe(true)
    // 'QM' → 4,1: il 41, cioè il 1º al femminile. Valido.
    expect(validaCodiceFiscale('XQQYKV19CQMZ999K').valido).toBe(true)
    // '3R' → 3,5: il 35. Impossibile anche se scritto in omocodia.
    expect(validaCodiceFiscale('XQQYKV19C3RZ999N').motivi).toEqual(['giorno'])
  })

  /**
   * ⚠️ IL MOTIVO È «giorno», NON «data-inesistente», e la differenza non è formale: qui le
   * due cifre non sono un giorno del codice fiscale in nessun mese dell'anno. Il 31
   * febbraio è un'altra cosa — è un giorno della scala che quel mese non ha — e ha il suo
   * motivo e il suo blocco qui sotto.
   */
  it('la scala e il calendario sono due domande diverse, e due motivi diversi', () => {
    expect(validaCodiceFiscale('XQQYKV19C35Z999S').motivi).toEqual(['giorno'])
    expect(validaCodiceFiscale('XQQYKV19B31Z999A').motivi).toEqual(['data-inesistente'])
  })
})

describe('validaCodiceFiscale — DATA CHE NON ESISTE SUL CALENDARIO', () => {
  /**
   * ⚠️ LA SECONDA METÀ DELLA STESSA DIVERGENZA, e per due settimane è rimasta aperta con
   * il test della prima metà verde accanto.
   *
   * La scala 1–31 / 41–71 dice che `31` è un giorno; non dice che il 31 FEBBRAIO esista.
   * Misurato il 2026-08-10, con la checksum ricalcolata da `codice-fiscale-js`:
   * `XQQYKV19B31Z999A` (31 febbraio), `…B30…` (30 febbraio), `…B29…` (29 febbraio 2019,
   * che non è bisestile), `XQQYKV19D31Z999H` (31 aprile) e i quattro femminili
   * corrispondenti uscivano da `validaCodiceFiscale` come `{valido: true, motivi: []}`,
   * mentre `dataNascitaDaCodiceFiscale`, sulla stessa identica stringa, rispondeva `null`.
   *
   * La regola «questa data esiste?» era già scritta DUE volte nella cartella — in
   * `calcolo.ts` (`giorniDelMese`, aritmetica) e in `codice-fiscale.ts` (`dataReale`, via
   * `new Date`, cioè proprio la costruzione dipendente dal fuso che `calcolo.ts` addita
   * come rischio già pagato in questo repo). Ora è UNA, in `tabelle.ts`, e la usano tutti
   * e tre i moduli.
   */
  const inesistenti: Array<[string, string]> = [
    ['31 febbraio', 'XQQYKV19B31Z999A'],
    ['30 febbraio', 'XQQYKV19B30Z999B'],
    ['29 febbraio di un anno che non è bisestile (19)', 'XQQYKV19B29Z999U'],
    ['31 aprile', 'XQQYKV19D31Z999H'],
    ['31 giugno', 'XQQYKV19H31Z999R'],
    ['31 settembre', 'XQQYKV19P31Z999D'],
    ['31 novembre', 'XQQYKV19S31Z999M'],
    ['71 = 31 febbraio al femminile', 'XQQYKV19B71Z999E'],
    ['70 = 30 febbraio al femminile', 'XQQYKV19B70Z999F'],
    ['69 = 29 febbraio al femminile, anno non bisestile', 'XQQYKV19B69Z999Y'],
    ['71 = 31 aprile al femminile', 'XQQYKV19D71Z999L'],
  ]

  const esistenti: Array<[string, string]> = [
    ['28 febbraio, che c’è sempre', 'XQQYKV19B28Z999S'],
    ['68 = 28 febbraio al femminile', 'XQQYKV19B68Z999W'],
    ['30 aprile', 'XQQYKV19D30Z999I'],
    ['29 febbraio 2020, bisestile', 'XQQYKV20B29Z999Q'],
    ['69 = 29 febbraio 2020 al femminile', 'XQQYKV20B69Z999U'],
    ['29 febbraio dell’anno «00», che il 2000 rende possibile', 'XQQYKV00B29Z999M'],
  ]

  /**
   * ⚠️ SENZA QUESTO IL BLOCCO NON PROVEREBBE NIENTE: dimostra che questi codici vengono
   * rifiutati PER LA DATA e non perché ci si è sbagliati a scegliere il sedicesimo
   * carattere. Con una checksum falsa il motivo sarebbe `checksum` e il collaudo passerebbe
   * verde misurando la cosa sbagliata.
   */
  it('tutti i codici di questo blocco hanno la checksum GIUSTA', () => {
    for (const [, cf] of [...inesistenti, ...esistenti]) {
      expect(carattereControllo(cf.slice(0, 15))).toBe(cf[15])
    }
  })

  for (const [nome, cf] of inesistenti) {
    it(`${nome} → motivo «data-inesistente», nonostante la checksum torni`, () => {
      const esito = validaCodiceFiscale(cf)
      expect(esito.valido).toBe(false)
      expect(esito.motivi).toEqual(['data-inesistente'])
      expect(esito.baseSenzaOmocodia).toBeNull()
    })
  }

  for (const [nome, cf] of esistenti) {
    it(`${nome} → valido`, () => {
      const esito = validaCodiceFiscale(cf)
      expect(esito.valido).toBe(true)
      expect(esito.motivi).toEqual([])
    })
  }

  /**
   * Come per la scala, anche il calendario si giudica DOPO aver sciolto l'omocodia: nel
   * codice così com'è le due posizioni del giorno possono portare lettere, e `Number('PM')`
   * sarebbe `NaN` — cioè ogni codice omocodico diventerebbe una data impossibile.
   */
  it('anche il calendario si giudica dopo aver sciolto l’omocodia', () => {
    // 'PM' → 3,1: il 31 febbraio, che non esiste nemmeno scritto in omocodia.
    expect(validaCodiceFiscale('XQQYKV19BPMZ999E').motivi).toEqual(['data-inesistente'])
    // 'NV' → 2,9: il 29 febbraio di un anno che finisce per 19, mai bisestile.
    expect(validaCodiceFiscale('XQQYKV19BNVZ999U').motivi).toEqual(['data-inesistente'])
    // 'NU' → 2,8: il 28 febbraio. Valido, e la bandiera dell'omocodia si alza.
    const esito = validaCodiceFiscale('XQQYKV19BNUZ999A')
    expect(esito.valido).toBe(true)
    expect(esito.omocodia).toBe(true)
  })

  /**
   * ⚠️ IL SECOLO NON C'È NEL CODICE, e la validazione non ha un orologio con cui
   * indovinarlo: `19B29` può essere solo 1919 o 2019 o 2119 — nessuno dei quali è
   * bisestile — mentre `00B29` può essere il 2000, che lo è. Perciò la domanda giusta,
   * qui, è «esiste in QUALCHE secolo?», e la risposta si dimostra con l'aritmetica invece
   * che con un elenco di secoli: un anno che finisce per `aa` è bisestile in qualche
   * secolo **se e solo se `aa` è multiplo di 4** (`00` compreso: il 2000 lo è).
   */
  it('il 29 febbraio dipende dalle due cifre dell’anno, non da un secolo scelto a caso', () => {
    const feb29 = (aa: string) => {
      const primi15 = `XQQYKV${aa}B29Z999`
      return validaCodiceFiscale(primi15 + carattereControllo(primi15)).valido
    }
    // multipli di 4: bisestili in ogni secolo (e `00` nel 2000)
    for (const aa of ['00', '04', '20', '24', '96']) expect(feb29(aa)).toBe(true)
    // non multipli di 4: nessun secolo li rende bisestili
    for (const aa of ['01', '19', '25', '99']) expect(feb29(aa)).toBe(false)
  })
})

describe('validaCodiceFiscale e `codice-fiscale.ts` — lo STESSO verdetto', () => {
  // Riferimento fisso: il secolo non si sceglie con l'orologio del banco di prova.
  const RIFERIMENTO = new Date(2026, 7, 10)

  /**
   * ⚠️ QUESTO TEST, FINO AL 2026-08-10, AFFERMAVA UN INVARIANTE GENERALE CON UNA PROVA PER
   * CAMPIONE: si chiamava «lo stesso verdetto sulla stessa stringa» ed esercitava le dieci
   * stringhe su cui la proprietà valeva già, mentre sui giorni impossibili DI CALENDARIO i
   * due moduli si contraddicevano. Un nome così è peggio di nessun test: un lettore futuro
   * ci si fida.
   *
   * Adesso l'invariante si verifica dove è definito, cioè su TUTTI i codici che si possono
   * costruire variando le due cifre del giorno e la lettera del mese: 4 anni × 12 mesi ×
   * 100 giorni = **4800 codici**, ciascuno con la checksum calcolata, così che il verdetto
   * non possa mai essere `checksum` e la sola variabile resti la data.
   *
   * Gli anni sono scelti per coprire i tre casi del 29 febbraio: `19` (mai bisestile),
   * `20` e `24` (bisestili in ogni secolo), `00` (bisestile solo grazie al 2000).
   */
  it('4800 codici costruiti a tavolino, e nemmeno uno con due verdetti diversi', () => {
    const divergenti: string[] = []
    for (const aa of ['19', '20', '24', '00']) {
      for (const mese of 'ABCDEHLMPRST') {
        for (let gg = 0; gg < 100; gg++) {
          const primi15 = `XQQYKV${aa}${mese}${String(gg).padStart(2, '0')}Z999`
          const cf = primi15 + carattereControllo(primi15)
          const valido = validaCodiceFiscale(cf).valido
          const leggibile = dataNascitaDaCodiceFiscale(cf, RIFERIMENTO) !== null
          if (valido !== leggibile) divergenti.push(`${cf} valido=${valido} data=${leggibile}`)
        }
      }
    }
    expect(divergenti).toEqual([])
  })

  /**
   * ⚠️ L'UNICA DIVERGENZA CHE RESTA, ED È SCRITTA QUI PERCHÉ SIA UNA SCELTA E NON UNA
   * SVISTA. `validaCodiceFiscale` non ha un orologio: dice se il codice è scritto bene, e
   * `00B29` lo è perché il 2000 è bisestile. `dataNascitaDaCodiceFiscale` deve invece
   * SCEGLIERE un secolo, e prova solo i due che il riferimento gli mette a disposizione:
   * con un riferimento nel 1999 quei due sono 1900 e 1800, e nessuno dei due è bisestile.
   *
   * Non è la divergenza riparata sopra — quella era sulla stessa domanda; questa è su due
   * domande diverse, e la leva è il riferimento, non il calendario. Col riferimento di
   * oggi (questo secolo) i due moduli tornano a coincidere, come dimostra il test qui
   * sopra.
   */
  it('l’unica divergenza superstite è il SECOLO, e la decide il riferimento', () => {
    const feb29 = 'XQQYKV00B29Z999M'
    expect(validaCodiceFiscale(feb29).valido).toBe(true)
    expect(dataNascitaDaCodiceFiscale(feb29, RIFERIMENTO)).not.toBeNull()
    // Riferimento nel 1999: restano il 1900 e il 1800, e il 1900 non è bisestile.
    expect(dataNascitaDaCodiceFiscale(feb29, new Date(1999, 7, 10))).toBeNull()
  })
})

describe('validaCodiceFiscale — CHECKSUM', () => {
  it('carattere di controllo sbagliato: forma giusta, codice falso', () => {
    const esito = validaCodiceFiscale('XQQYKV19C07Z999A')
    expect(esito.valido).toBe(false)
    expect(esito.motivi).toEqual(['checksum'])
    expect(esito.normalizzato).toBe('XQQYKV19C07Z999A')
  })

  it('tutte le venticinque lettere sbagliate sono sbagliate, e solo la giusta è giusta', () => {
    let valide = 0
    for (const lettera of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (validaCodiceFiscale(`XQQYKV19C07Z999${lettera}`).valido) valide += 1
    }
    expect(valide).toBe(1)
  })

  /**
   * Su un codice con la forma giusta ma la checksum sbagliata la base si calcola lo stesso:
   * è una trasformazione meccanica, e dice «ecco che cosa avrebbe dovuto esserci».
   */
  it('la base si ricava anche da un codice con la checksum sbagliata', () => {
    expect(validaCodiceFiscale('XQQYKV19C07Z999A').baseSenzaOmocodia).toBe(VALIDO)
  })
})

describe('validaCodiceFiscale — OMOCODIA', () => {
  /**
   * L'Agenzia sostituisce le cifre con lettere partendo da destra: `L=0 M=1 N=2 P=3 Q=4
   * R=5 S=6 T=7 U=8 V=9`. Il codice risultante è VALIDO e ha un carattere di controllo
   * RICALCOLATO sui caratteri sostituiti.
   */
  it('omocodia parziale (ultima cifra del giorno): valida, e la base torna quella originaria', () => {
    const esito = validaCodiceFiscale('XQQYKV19C0TZ999Q')
    expect(esito.valido).toBe(true)
    expect(esito.motivi).toEqual([])
    expect(esito.omocodia).toBe(true)
    expect(esito.baseSenzaOmocodia).toBe(VALIDO)
  })

  it('omocodia PIENA: sedici caratteri e zero cifre, e la base è sempre la stessa', () => {
    const pieno = 'XQQYKVMVCLTZVVVV'
    expect(pieno).not.toMatch(/\d/) // senza questo, il caso non proverebbe niente
    const esito = validaCodiceFiscale(pieno)
    expect(esito.valido).toBe(true)
    expect(esito.omocodia).toBe(true)
    expect(esito.baseSenzaOmocodia).toBe(VALIDO)
  })

  /**
   * ⚠️ LA REGOLA CHE È FACILE SBAGLIARE: la checksum si verifica sui primi quindici
   * caratteri COSÌ COME SONO, lettere dell'omocodia comprese. Chi de-omocodifica PRIMA e
   * verifica DOPO accetta un codice che non esiste — questo:
   */
  it('de-omocodificare prima di verificare accetterebbe un codice inesistente', () => {
    // primi quindici del codice omocodico, ma con il carattere di controllo della BASE
    const falso = 'XQQYKVMVCLTZVVVT'
    expect(falso.slice(0, 15)).toBe('XQQYKVMVCLTZVVV') // gli stessi 15 del codice valido
    expect(falso[15]).toBe(VALIDO[15]) // ma il controllo è quello della base
    expect(validaCodiceFiscale(falso).valido).toBe(false)
    expect(validaCodiceFiscale(falso).motivi).toEqual(['checksum'])
  })

  it('la bandiera `omocodia` è falsa quando tutte le posizioni numeriche sono cifre', () => {
    expect(validaCodiceFiscale(VALIDO).omocodia).toBe(false)
    // una lettera in una posizione NON numerica (il mese) non è omocodia
    expect(validaCodiceFiscale('XQQYKV19C47Z999X').omocodia).toBe(false)
  })
})
