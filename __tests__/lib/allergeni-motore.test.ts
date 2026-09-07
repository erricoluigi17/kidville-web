// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  ALLERGENI,
  inferisciAllergeniDaTesto,
  isNegazione,
  haAllergiaConteggiabile,
  haAllergiaOperativa,
  allergeniAlunno,
  chiaviAllergeni,
  etichetteAllergie,
} from '@/lib/mensa/allergeni'

/**
 * IL MOTORE DELLE ALLERGIE — due domande diverse, due predicati diversi.
 *
 * Fino al 2026-09-07 sotto la parola «Allergie» l'app contava `alunni.note_mediche`,
 * che il modulo d'iscrizione etichetta «Note Mediche (BES, DSA, patologie)». Misurato
 * in produzione su 646 iscritti: 41 con nota medica, 60 con testo `allergies`, 23
 * bambini con una nota medica e NESSUNA allergia — i falsi positivi del contatore —
 * e ZERO delle 41 note mediche nomina un allergene.
 *
 * Da qui in avanti:
 *  (A) i CONTATORI e i badge guardano gli allergeni (spuntati o inferiti dai 14 UE);
 *  (B) gli ELENCHI OPERATIVI della cucina tengono anche il testo non riconosciuto,
 *      perché lì non si conta: si decide cosa finisce nel piatto.
 */

describe('isNegazione — vocabolario INTERO, mai sottostringa', () => {
  it('riconosce le negazioni scritte per esteso', () => {
    for (const testo of [
      'Nessuna allergia nota',
      'nessuna',
      'NESSUNA ALLERGIA',
      'Nessun allergene conosciuta', // concordanza sbagliata: resta una negazione
      'niente',
      'nulla',
      'no',
      'none',
      'N/A',
      'n/a',
      'na',
      'assenti',
      'Nessuna intolleranza segnalata',
      'nessuna patologia nota',
      '-',
      '//',
      '',
      '   ',
    ]) {
      expect(isNegazione(testo), `«${testo}» doveva essere una negazione`).toBe(true)
    }
  })

  it('null e undefined valgono «niente da elencare»', () => {
    expect(isNegazione(null)).toBe(true)
    expect(isNegazione(undefined)).toBe(true)
  })

  it('una sola parola sconosciuta e NON è più una negazione', () => {
    for (const testo of [
      'lattosio',
      'fragole',
      'nessuna allergia al latte',
      'nessun formaggio',
      'nichel',
    ]) {
      expect(isNegazione(testo), `«${testo}» non è una negazione`).toBe(false)
    }
  })

  it('UNA FRASE AFFERMATIVA FATTA DI SOLE PAROLE DEL VOCABOLARIO NON È UNA NEGAZIONE', () => {
    // Il vocabolario contiene `presente/presenti`, `segnalata/e`, `rilevata/e`,
    // `allergia/e`, `intolleranza/e`, `patologia/e`: da soli non negano NIENTE,
    // sono i sostantivi e i participi che stanno accanto al negatore. Con la sola
    // regola «ogni parola sta nel vocabolario», «allergia presente» diventava una
    // negazione e il bambino spariva dall'elenco della cucina, dall'alert del
    // pranzo e dalla home del docente — cioè meno di quanto mostrasse il criterio
    // vecchio («testo non vuoto»), che è la direzione d'errore che il docblock del
    // motore vieta per iscritto.
    //
    // Serve quindi almeno un NEGATORE: `nessun*`, `no`, `none`, `n/a`, `niente`,
    // `nulla`, `assente/i`. Il resto del vocabolario è il contorno, non la negazione.
    for (const testo of [
      'allergia presente',
      'allergie presenti',
      'intolleranze presenti',
      'allergeni presenti',
      'allergia segnalata',
      'intolleranza rilevata',
      'patologie presenti',
      'allergia nota',
      'note particolari',
    ]) {
      expect(isNegazione(testo), `«${testo}» è un'AFFERMAZIONE, non una negazione`).toBe(false)
      expect(haAllergiaOperativa({ allergeni: [], allergies: testo }), testo).toBe(true)
    }
  })

  it('IL CASO REALE: «di nessun tipo» dentro una frase non cancella il bambino', () => {
    // Riscrittura sintetica del testo che sta in produzione: parla di un fastidio
    // al lattosio e di cibi che il bambino non mangia, e contiene «nessun» in
    // mezzo. Col criterio a sottostringa (`/\bnessun/`) sarebbe una NEGAZIONE, e
    // sparirebbe sia dai contatori sia dal foglio della cucina.
    const reale = 'non mangia crudi di nessun tipo, fastidio al lattosio'
    expect(isNegazione(reale)).toBe(false)
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: reale })).toBe(true)
    expect(haAllergiaOperativa({ allergeni: [], allergies: reale })).toBe(true)
  })
})

describe('haAllergiaConteggiabile (A) — i 14 allergeni UE, e basta', () => {
  it('conta chi ha gli allergeni spuntati', () => {
    expect(haAllergiaConteggiabile({ allergeni: ['glutine'], allergies: null })).toBe(true)
  })

  it('conta chi ha un testo che nomina uno dei 14', () => {
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: 'arachidi' })).toBe(true)
    expect(haAllergiaConteggiabile({ allergeni: null, allergies: 'lattosio, fragole' })).toBe(true)
  })

  it('NON conta un testo fuori dai 14: è la scelta del titolare, non un difetto', () => {
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: 'fragole' })).toBe(false)
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: 'kiwi' })).toBe(false)
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: 'nichel' })).toBe(false)
  })

  it('NON conta le negazioni né il vuoto', () => {
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: 'nessuna' })).toBe(false)
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: '' })).toBe(false)
    expect(haAllergiaConteggiabile({ allergeni: null, allergies: null })).toBe(false)
  })

  it('una nota medica non entra: il predicato non conosce `note_mediche`', () => {
    // La firma stessa è il presidio: le uniche due chiavi che legge sono
    // `allergeni` e `allergies`.
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: null })).toBe(false)
  })
})

describe('haAllergiaOperativa (B) — il foglio della cucina non butta via niente', () => {
  it('un testo fuori dai 14 RESTA: «fragole» finisce comunque nel piatto sbagliato', () => {
    expect(haAllergiaOperativa({ allergeni: [], allergies: 'fragole' })).toBe(true)
    expect(haAllergiaOperativa({ allergeni: [], allergies: 'kiwi, nichel' })).toBe(true)
  })

  it('gli allergeni strutturati bastano da soli', () => {
    expect(haAllergiaOperativa({ allergeni: ['molluschi'], allergies: null })).toBe(true)
  })

  it('escono solo le negazioni e il vuoto', () => {
    expect(haAllergiaOperativa({ allergeni: [], allergies: 'nessuna' })).toBe(false)
    expect(haAllergiaOperativa({ allergeni: [], allergies: 'Nessuna allergia nota' })).toBe(false)
    expect(haAllergiaOperativa({ allergeni: [], allergies: '   ' })).toBe(false)
    expect(haAllergiaOperativa({ allergeni: null, allergies: null })).toBe(false)
  })

  it('(B) è più larga di (A): ogni conteggiabile è anche operativo, non viceversa', () => {
    const casi = ['arachidi', 'fragole', 'lattosio, fragole', 'nessuna', '', 'kiwi']
    for (const allergies of casi) {
      if (haAllergiaConteggiabile({ allergeni: [], allergies })) {
        expect(haAllergiaOperativa({ allergeni: [], allergies }), allergies).toBe(true)
      }
    }
    // E il caso che dimostra che non sono la stessa funzione.
    expect(haAllergiaConteggiabile({ allergeni: [], allergies: 'fragole' })).toBe(false)
    expect(haAllergiaOperativa({ allergeni: [], allergies: 'fragole' })).toBe(true)
  })
})

// =============================================================================
// LA GUARDIA DI NEGAZIONE DENTRO `allergeniAlunno` ERA UN NO-OP, E IL SUO TEST
// ERA VERDE ANCHE SENZA DI LEI.
//
// Fino al 2026-09-07 `allergeniAlunno` conteneva
//     if (isNegazione(opts.allergies)) return []
// con un commento che prometteva: «senza, "nessuna allergia al latte" inferirebbe
// latte da un testo che dice l'opposto». Due misure, entrambe contrarie:
//  · `isNegazione('nessuna allergia al latte')` è `false` — «al» e «latte» non
//    stanno nel vocabolario chiuso — quindi su QUELLA frase la guardia non
//    scattava mai;
//  · e quando scattava non cambiava niente: nessuna parola del vocabolario
//    contiene il nome di un allergene, quindi su una negazione vera
//    `inferisciAllergeniDaTesto` restituisce già `[]`. Provato togliendo la riga:
//    102 test su 102 restavano verdi. Provato sui dati veri (2026-09-07, 657
//    iscritti): il contatore vale 27 con la guardia e 27 senza.
//
// Il test che la sorvegliava usava `'nessuna allergia'`, che dà `[]` con e senza:
// era il «mock piatto» applicato a un file che si chiama «il motore».
//
// La riga è stata TOLTA. Al suo posto stanno i due test qui sotto:
//  · la scelta deliberata — «nessuna allergia al latte» infersce `latte`, perché
//    contare di più costa una verifica e contare di meno costa un piatto
//    sbagliato (blocco in testa al motore);
//  · l'INVARIANTE che rendeva inutile la guardia, che ora si può vedere fallire:
//    nessun testo riconosciuto come negazione nomina un allergene.
// =============================================================================
describe('allergeniAlunno — le chiavi vincono, e sul testo si conta di PIÙ, mai di meno', () => {
  it('le chiavi spuntate a mano restano: sono una dichiarazione, non una frase', () => {
    // Anche accanto a un testo di negazione (caso possibile in archivio): chi ha
    // spuntato «latte» lo ha fatto apposta, e il testo non lo smentisce.
    expect(allergeniAlunno({ allergeni: ['latte'], allergies: 'nessuna' })).toEqual(['latte'])
  })

  it('un testo interamente di negazione non ha allergeni da inferire', () => {
    // ⚠️ Verde NON per una guardia, ma perché in «nessuna allergia» non c'è il
    // nome di un cibo: è l'invariante misurata due test più in basso.
    expect(allergeniAlunno({ allergeni: [], allergies: 'nessuna allergia' })).toEqual([])
    expect(allergeniAlunno({ allergeni: [], allergies: 'n/a' })).toEqual([])
  })

  it('un testo che nomina un allergene continua a inferirlo', () => {
    expect(allergeniAlunno({ allergeni: [], allergies: 'lattosio, fragole' })).toEqual(['latte'])
  })

  it('🔴 «NESSUNA ALLERGIA AL LATTE» INFERISCE `latte`, ED È VOLUTO', () => {
    // Il testo dice che il latte NON dà problemi, e il motore lo conta lo stesso.
    // Non è una svista: è la direzione d'errore che il blocco in testa al motore
    // dichiara l'unica accettabile quando in mezzo c'è la sicurezza alimentare.
    // «Correggerlo» significherebbe togliere un bambino dall'elenco della cucina
    // sulla base di una frase capita a metà — e questo test diventa rosso.
    expect(allergeniAlunno({ allergeni: [], allergies: 'nessuna allergia al latte' })).toEqual(['latte'])
    expect(allergeniAlunno({ allergeni: [], allergies: 'nessun formaggio' })).toEqual(['latte'])
  })

  it("L'INVARIANTE: un testo riconosciuto come negazione non nomina MAI un allergene", () => {
    // È la proprietà per cui la guardia era inutile, e adesso è una misura invece
    // di una riga muta. Diventa ROSSA il giorno in cui qualcuno allarga
    // `PAROLE_NEGAZIONE` con una parola che contiene il nome di un cibo — «pane»,
    // «grana», «uova» — perché da quel momento «nessuna <cibo>» sarebbe una
    // negazione E infersce, cioè un bambino sparirebbe dall'elenco della cucina.
    const sinonimi = ALLERGENI.flatMap((a) => a.sinonimi)
    expect(sinonimi.length).toBeGreaterThan(80) // controllo positivo: la misura vede i dati
    const rotti: string[] = []
    for (const s of sinonimi) {
      for (const t of [s, `nessuna ${s}`, `nessuna allergia ${s}`, `no ${s}`, `${s} assente`]) {
        if (isNegazione(t) && inferisciAllergeniDaTesto(t).length > 0) rotti.push(t)
      }
    }
    expect(
      rotti,
      'Questi testi sono NEGAZIONI e nominano un allergene: il bambino sparisce dagli\n' +
        'elenchi della cucina, che è la direzione d\'errore che il motore vieta per iscritto.',
    ).toEqual([])
  })
})

// =============================================================================
// LE SUPERFICI OPERATIVE NON SCARTANO UNA CHIAVE SOLO PERCHÉ NON LA CONOSCONO.
//
// `normalizzaAllergeni` tiene le 14 chiavi UE e butta via il resto in silenzio: è
// giusto per confrontare un bambino col menu del giorno (le chiavi devono
// combaciare), ed è sbagliato su un elenco di cucina — se in archivio c'è
// `['nichel']`, il prestampato di banco la stampa e l'alert del pranzo la faceva
// sparire. Due superfici operative sullo stesso dato con due regole opposte.
//
// Qui vive la regola sola: `chiaviAllergeni` (l'archivio così com'è) ed
// `etichetteAllergie` (chiavi etichettate PIÙ il testo libero, come
// `colonnaAllergie` in `prestampati/banco.ts`).
// =============================================================================
describe('chiaviAllergeni / etichetteAllergie — l\'elenco della cucina non butta via niente', () => {
  it('le chiavi arrivano come stanno in archivio, canoniche o no', () => {
    expect(chiaviAllergeni({ allergeni: ['glutine', 'nichel'], allergies: null })).toEqual(['glutine', 'nichel'])
    expect(chiaviAllergeni({ allergeni: null, allergies: 'fragole' })).toEqual([])
    // Vuoti e spazi non sono chiavi: diventerebbero etichette vuote sul foglio.
    expect(chiaviAllergeni({ allergeni: ['', '  ', 'latte'], allergies: null })).toEqual(['latte'])
  })

  it('una chiave NON canonica basta a far entrare il bambino nell\'elenco operativo', () => {
    // Col filtro `normalizzaAllergeni` questo bambino usciva dall'elenco pur
    // avendo una restrizione dichiarata: `[]` allergeni «validi», nessun testo.
    expect(haAllergiaOperativa({ allergeni: ['nichel'], allergies: null })).toBe(true)
    // …e non entra invece nel CONTATORE, che sono i 14 UE e restano tali.
    expect(haAllergiaConteggiabile({ allergeni: ['nichel'], allergies: null })).toBe(false)
  })

  it('etichette delle chiavi PIÙ il testo libero: si sommano, nessuna copre l\'altra', () => {
    expect(etichetteAllergie({ allergeni: ['latte'], allergies: 'fragole' })).toEqual(['Latte / lattosio', 'fragole'])
    // Chiave ignota → la chiave così com'è (è ciò che fa già `allergeneLabel`).
    expect(etichetteAllergie({ allergeni: ['nichel'], allergies: null })).toEqual(['nichel'])
  })

  it('IL CASO CHE LA CUCINA LEGGEVA AL CONTRARIO: chiavi spuntate + testo «nessuna»', () => {
    // `allergeniAlunno` tiene le chiavi (una spunta è una dichiarazione), quindi il
    // bambino ENTRA in elenco — e accanto al suo nome si leggeva «nessuna», cioè il
    // testo che vinceva sempre sulle chiavi. È il foglio con cui si prepara il piatto.
    expect(etichetteAllergie({ allergeni: ['latte'], allergies: 'nessuna' })).toEqual(['Latte / lattosio'])
  })

  it('senza niente da dire l\'elenco è vuoto, non una stringa vuota', () => {
    expect(etichetteAllergie({ allergeni: [], allergies: '   ' })).toEqual([])
    expect(etichetteAllergie({ allergeni: null, allergies: null })).toEqual([])
  })

  it('l\'etichettatore si può sostituire (i componenti client traducono)', () => {
    expect(etichetteAllergie({ allergeni: ['latte'], allergies: 'fragole' }, (k) => `«${k}»`))
      .toEqual(['«latte»', 'fragole'])
  })
})
