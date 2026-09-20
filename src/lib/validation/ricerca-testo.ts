/**
 * IL TERMINE DI RICERCA PRIMA CHE DIVENTI UN FILTRO SQL — un posto solo.
 *
 * Queste funzioni non validano e non confrontano: preparano la stringa che
 * l'operatrice ha digitato perché possa finire dentro un `ilike` di PostgREST
 * senza cambiarne il significato.
 *
 * ⚠️ NON CONFONDERE CON `@/lib/ui/testo-ricerca`, che ha un nome quasi uguale e
 * un mestiere opposto: là si CONFRONTA in memoria (`normalizzaTesto`,
 * `testoCorrisponde`, `rangoDiMatch`) per filtrare un elenco già in mano; qui si
 * prepara il testo da mandare AL DATABASE. La differenza si vede sugli
 * apostrofi: `normalizzaTesto` li riduce a uno spazio — giusto per un confronto,
 * rovinoso per un `%pattern%`, perché «Dell'Aquila» non contiene «dell aquila»
 * e il filtro smetterebbe di trovare proprio le righe che doveva allargare.
 */

/** I segni diacritici che `NFD` stacca dalla lettera (à → a + U+0300). */
const SEGNI_DIACRITICI = /[\u0300-\u036f]/g;

/**
 * Neutralizza i metacaratteri di `ilike` (`%`, `_`) e quelli della sintassi
 * `or()` di PostgREST (virgole e parentesi), che altrimenti spezzerebbero il
 * filtro in termini che nessuno ha chiesto.
 *
 * Nata due volte, identica, in `admin/search` e in `admin/legami-familiari`: la
 * prima cosa che si aggiusta in una ricerca è proprio questa riga, e correggerla
 * in un posto su due lascia due campi che «cercano» in modo diverso nella stessa
 * applicazione.
 *
 * Non è una difesa dall'iniezione SQL — PostgREST parametrizza — ma dalla
 * SINTASSI: una virgola dentro `or(nome.ilike.%a,b%)` diventa un secondo
 * termine, e una `%` digitata per caso trasforma la ricerca in «qualunque cosa».
 *
 * ⚠️ `*` RESTA FUORI, e non per distrazione: dentro `like`/`ilike` PostgREST lo
 * traduce in `%`, quindi `q=**` ha lo stesso effetto di `q=%%` — un carattere
 * jolly che nessuno ha chiesto. La ragione per cui non lo si neutralizza QUI
 * **non** è «un asterisco si può voler cercare»: un asterisco LETTERALE, con i
 * filtri di questi chiamanti, non si trova comunque — finisce in un `ilike`,
 * dove vale `%`. Le ragioni vere sono due: questa funzione è condivisa da tre
 * rotte (`admin/search`, `admin/legami-familiari` e la ricerca alunni della
 * riconciliazione), quindi cambiarla sposterebbe il filtro di tutte e tre in una
 * volta, con un effetto da misurare sui test di tutte e tre; e la difesa giusta
 * non è mutilare il termine — che cambierebbe il significato di ciò che
 * l'operatrice ha digitato — ma rifiutare di partire quando, tolti i jolly, non
 * resta contenuto. È un debito noto e dichiarato, non un'omissione: la difesa
 * che regge intanto è a valle — la soglia minima del chiamante, misurata sul
 * CONTENUTO — e `formeDiRicerca` qui sotto si guarda dal produrre forme senza.
 */
export function ripulisciTermineRicerca(q: string): string {
    return q.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Lo stesso testo senza segni diacritici, e SENZA nient'altro: maiuscole,
 * apostrofi e spazi restano come sono.
 *
 * `ilike` in Postgres **non** è insensibile agli accenti (`ilike` abbassa le
 * maiuscole, non compone i caratteri): «niccolo» non trova «Niccolò». Il
 * richiamo pieno lo darebbe l'estensione `unaccent` sul database, cioè una
 * migrazione e un indice; finché non c'è, interrogare con DUE forme del termine
 * recupera il caso frequente — l'operatrice che digita senza accento un nome che
 * in anagrafe ce l'ha.
 *
 * ⚠️ Non fa il verso opposto: chi digita «Niccolò» non trova un «Niccolo»
 * scritto senza accento in anagrafica. Per quello servirebbe normalizzare anche
 * la COLONNA, che è esattamente ciò che `unaccent` fa e questa funzione no.
 */
export function senzaAccenti(testo: string): string {
    return testo.normalize('NFD').replace(SEGNI_DIACRITICI, '');
}

/**
 * Le forme con cui interrogare il database per uno stesso termine: come l'ha
 * scritto chi cerca, e la sua versione senza accenti quando è diversa.
 *
 * Restituisce SEMPRE almeno un elemento (il termine così com'è) e mai due
 * elementi uguali: un `or()` con due termini identici è solo un filtro pagato
 * due volte.
 *
 * 🔴 `minimo` non è una rifinitura: una forma PIÙ CORTA della soglia che il
 * chiamante ha già applicato al termine intero è una soglia aggirata. Il caso
 * che l'ha imposto è un termine di soli segni diacritici combinanti (due
 * `U+0300`/`U+0301` di fila: la guardia dei due caratteri non scatta):
 * `senzaAccenti` lo riduce a stringa vuota, e `nome.ilike.%%` significa «qualunque riga», cioè
 * nome, cognome e classe di tutti i bambini del perimetro fino al `limite`.
 * Scartando la forma si perde solo richiamo su un termine che di contenuto non
 * ne aveva.
 */
export function formeDiRicerca(termine: string, minimo = 1): string[] {
    const piatto = senzaAccenti(termine);
    if (piatto === termine || piatto.length < minimo) return [termine];
    return [termine, piatto];
}
