import { describe, it, expect } from 'vitest'
import {
  formeDiRicerca,
  ripulisciTermineRicerca,
  senzaAccenti,
} from '@/lib/validation/ricerca-testo'

/**
 * ─── IL TERMINE DI RICERCA PRIMA CHE DIVENTI UN FILTRO SQL ───────────────────
 *
 * `src/lib/validation/ricerca-testo.ts` è nato per estrazione: la ripulitura del
 * termine esisteva IDENTICA in `admin/search` e in `admin/legami-familiari`, e
 * la prima cosa che si aggiusta quando una ricerca non trova è proprio quella
 * riga — corretta in un posto su due, lascia due campi che «cercano» in modo
 * diverso nella stessa applicazione. Ora i chiamanti sono tre (c'è anche
 * `pagamenti/riconciliazione/alunni`), quindi qui si misura il posto UNICO.
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE, detto per intero: il modulo era coperto solo di
 * rimbalzo, dai test delle tre rotte. Bastava per due funzioni su tre, ma non
 * per la guardia del `minimo` di `formeDiRicerca`: togliendola, tutti e cinque i
 * file di test interessati restavano verdi, perché la rotta che la usa filtra
 * già le forme a valle per conto suo. Una difesa in profondità che nessun test
 * può vedere fallire non è una difesa: è un commento. Qui diventa falsificabile.
 */

describe('ripulisciTermineRicerca', () => {
  it('neutralizza i metacaratteri di `ilike` e la sintassi di `or()`', () => {
    // `%` e `_` sono i jolly di `like`; virgole e parentesi spezzano
    // `or(nome.ilike.%a,b%)` in termini che nessuno ha chiesto. Non è una
    // difesa dall'iniezione (PostgREST parametrizza): è una difesa dalla
    // SINTASSI, e da una `%` digitata per sbaglio che trasforma la ricerca in
    // «qualunque cosa».
    expect(ripulisciTermineRicerca('a%b,(c)_d')).toBe('a b c d')
  })

  it('non tocca gli apostrofi: «Dell’Aquila» deve restare cercabile', () => {
    // È la differenza dichiarata con `@/lib/ui/testo-ricerca`, che gli apostrofi
    // li riduce a spazio: giusto per CONFRONTARE in memoria, rovinoso per un
    // `%pattern%`, perché «Dell'Aquila» non contiene «dell aquila» e il filtro
    // smetterebbe di trovare proprio le righe che doveva allargare.
    expect(ripulisciTermineRicerca("Dell'Aquila")).toBe("Dell'Aquila")
  })

  it('lascia passare l’asterisco, ed è il debito DICHIARATO del modulo', () => {
    // Dentro `ilike` PostgREST traduce `*` in `%`. Non si neutralizza qui
    // perché la funzione è condivisa da tre chiamanti e il cambio andrebbe
    // misurato sui test di tutti; chi ha bisogno di chiudere quel buco lo fa a
    // valle, sulla soglia (lo fa `pagamenti/riconciliazione/alunni`). Questo
    // test non approva la scelta: la rende visibile, così che cambiarla sia una
    // decisione e non un effetto collaterale.
    expect(ripulisciTermineRicerca('ro*')).toBe('ro*')
  })

  it('comprime gli spazi e taglia quelli ai bordi', () => {
    expect(ripulisciTermineRicerca('  Rossi   Mario  ')).toBe('Rossi Mario')
  })
})

describe('senzaAccenti', () => {
  it('toglie i segni diacritici e NIENTE ALTRO', () => {
    // Maiuscole e apostrofi restano: `ilike` le maiuscole le abbassa da sé, e
    // gli apostrofi servono al pattern.
    expect(senzaAccenti('Niccolò')).toBe('Niccolo')
    expect(senzaAccenti("Dell'Aquilà")).toBe("Dell'Aquila")
  })

  it('su un testo senza accenti restituisce lo stesso testo', () => {
    // È il presupposto della forma unica di `formeDiRicerca`: quando non c'è
    // niente da togliere, non c'è una seconda forma da chiedere al database.
    expect(senzaAccenti('Rossi')).toBe('Rossi')
  })
})

describe('formeDiRicerca', () => {
  it('con un accento chiede DUE forme: come è stato scritto, e piatto', () => {
    // `ilike` in Postgres non è insensibile agli accenti (abbassa le maiuscole,
    // non compone i caratteri): «niccolo» non trova «Niccolò». Le due forme
    // recuperano il caso frequente senza `unaccent`, cioè senza migrazione.
    expect(formeDiRicerca('Niccolò')).toEqual(['Niccolò', 'Niccolo'])
  })

  it('senza accenti chiede UNA forma sola: un `or` con due termini uguali è pagato due volte', () => {
    expect(formeDiRicerca('Rossi')).toEqual(['Rossi'])
  })

  it('🔴 scarta la forma PIÙ CORTA del minimo: una soglia aggirata da dentro', () => {
    // Due segni diacritici combinanti (U+0300 e U+0301): due caratteri, quindi
    // la guardia del chiamante sul termine INTERO non scatta — e `senzaAccenti`
    // li riduce a stringa vuota. Senza questo scarto l'`or` conterrebbe
    // `nome.ilike.%%`, che in SQL è «qualunque riga»: nome, cognome e classe di
    // ogni bambino del perimetro, per un termine che di contenuto non ne ha.
    //
    // ⚠️ Questa riga è l'unico posto in cui quella guardia può diventare rossa:
    // il chiamante che oggi la userebbe filtra già le forme per conto suo, e
    // toglierla lasciava verdi tutti e cinque i file di test delle rotte.
    expect(formeDiRicerca('̀́', 2)).toEqual(['̀́'])
  })

  it('con il minimo di default (1) la forma piatta vuota cade comunque', () => {
    // Il controllo che dice perché il parametro ha un default e non è
    // obbligatorio: `''.length < 1` è già vero, quindi un chiamante che non ha
    // una soglia propria non resta scoperto.
    expect(formeDiRicerca('̀́')).toEqual(['̀́'])
  })

  it('una forma piatta lunga abbastanza passa anche con il minimo alto', () => {
    // Il controllo NEGATIVO del caso precedente: la guardia scarta le forme
    // senza contenuto, non le forme senza accenti. Senza questa riga si potrebbe
    // «superare» il test di sopra restituendo sempre una forma sola, cioè
    // buttando via il richiamo che il modulo esiste per dare.
    expect(formeDiRicerca('Niccolò', 2)).toEqual(['Niccolò', 'Niccolo'])
  })
})
