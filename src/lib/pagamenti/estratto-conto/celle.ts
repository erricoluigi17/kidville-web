import type { Cella } from './tipi'

/**
 * DA UNA CELLA A UN DATO — dove stanno quasi tutte le trappole di questo lotto.
 *
 * Una cella dell'estratto conto può arrivare in quattro forme diverse per dire la stessa
 * cosa: `"06/08/26"` dal CSV, `46240` dall'.xls, un `Date` da un foglio costruito altrove,
 * `"2026-08-06"` da un export ISO. Qui dentro diventano tutte la stessa stringa.
 *
 * ─── PERCHÉ NON SI USA MAI IL TESTO FORMATTATO ──────────────────────────────
 * La cella A5 del file vero della banca è `{ t:'n', v:46240, w:'8/6/26', z:'m/d/yy' }`.
 * Il `w` — il testo che Excel mostra — è in ordine **AMERICANO**: leggerlo significherebbe
 * prendere il 6 agosto per l'8 giugno, su ogni data con giorno ≤ 12. Cioè su circa il 40%
 * delle righe, in silenzio, con la data che entra nell'impronta anti-doppio-import.
 * Lo stesso vale per l'importo: `w = "80.00"` col punto decimale, e su un importo a
 * quattro cifre `w = "1,234.56"`.
 * **Il valore vero è `v`. Il testo formattato non si guarda.**
 */

/**
 * L'epoca dei seriali di Excel: il giorno 1 è il 1° gennaio 1900, ma il foglio crede che il
 * 1900 sia bisestile (non lo è), quindi il conto torna partendo dal **30 dicembre 1899**.
 * In UTC, perché tutta l'aritmetica qui sotto dev'essere indipendente dal fuso della macchina.
 */
const EPOCA_EXCEL = Date.UTC(1899, 11, 30)
const GIORNO_MS = 86_400_000

/**
 * La finestra di plausibilità del seriale: 20000 → 1954, 60000 → 2064.
 *
 * Serve perché in una colonna «Data» capita di tutto: un progressivo, un importo, un codice.
 * Senza la finestra, `1` diventerebbe il 31 dicembre 1899 e la riga entrerebbe come movimento
 * valido con una data assurda. Con la finestra diventa una riga scartata, che si conta e si vede.
 */
const SERIALE_MIN = 20000
const SERIALE_MAX = 60000

/** Lo scarto fra l'epoca 1900 e l'epoca 1904 di Excel per Mac. */
const GIORNI_1904 = 1462

/**
 * Il perno del secolo per l'anno a due cifre: `< 70` è il Duemila.
 *
 * L'estratto conto scrive l'anno a due cifre SEMPRE (`06/08/26`), e senza questo ramo il
 * file vero della banca dà zero movimenti su sessantacinque. Il perno a 70 copre 1970-2069:
 * un estratto conto bancario fuori da quella finestra non esiste.
 */
const PERNO_SECOLO = 70

const dueCifre = (n: number): string => String(n).padStart(2, '0')

/**
 * La data, **verificata sul calendario** e non solo sulla forma.
 *
 * `31/02/2026` ha una forma perfetta e non è un giorno. Fino a ieri passava, diventava
 * `"2026-02-31"`, arrivava a Postgres e faceva esplodere l'INSERT con `22008`: l'operatore
 * vedeva una **500** — un guasto del server — su un difetto che era del suo file. Ora è una
 * riga scartata, cioè un numero che l'operatore legge e capisce.
 */
function componi(anno: number, mese: number, giorno: number): string | null {
    if (!Number.isInteger(anno) || !Number.isInteger(mese) || !Number.isInteger(giorno)) return null
    if (mese < 1 || mese > 12 || giorno < 1 || giorno > 31) return null
    const d = new Date(Date.UTC(anno, mese - 1, giorno))
    if (d.getUTCFullYear() !== anno || d.getUTCMonth() !== mese - 1 || d.getUTCDate() !== giorno) return null
    return `${anno}-${dueCifre(mese)}-${dueCifre(giorno)}`
}

/** Una data scritta come testo → `YYYY-MM-DD`, oppure `null`. */
export function parseData(raw: string): string | null {
    if (!raw) return null
    // L'ora in coda si butta: `05/09/2026 12:30` e `2026-09-05T00:00:00.000Z` sono due date.
    const s = raw.trim().split(/[\sT]/)[0]
    if (!s) return null

    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
    if (iso) return componi(Number(iso[1]), Number(iso[2]), Number(iso[3]))

    const it = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s)
    if (it) {
        const grezzo = Number(it[3])
        const anno = it[3].length === 4 ? grezzo : grezzo < PERNO_SECOLO ? 2000 + grezzo : 1900 + grezzo
        return componi(anno, Number(it[2]), Number(it[1]))
    }
    return null
}

/**
 * Il seriale di Excel → `YYYY-MM-DD`.
 *
 * Aritmetica in **UTC** e getter **UTC**: `Date.UTC(1899,11,30) + n·86400000`. Con l'ora
 * locale il risultato dipenderebbe dal fuso della macchina che esegue l'import, e in
 * `Europe/Rome` sarebbe il giorno prima.
 */
export function serialeExcelAData(n: number, date1904 = false): string | null {
    if (!Number.isFinite(n)) return null
    const seriale = date1904 ? n + GIORNI_1904 : n
    if (seriale < SERIALE_MIN || seriale > SERIALE_MAX) return null
    // `floor` e non `round`: 46240,99 è il 6 agosto alle 23:45, non il 7 agosto.
    const d = new Date(EPOCA_EXCEL + Math.floor(seriale) * GIORNO_MS)
    return componi(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/**
 * La data di una cella, qualunque forma abbia.
 *
 * ⚠️ Il ramo `Date` usa i getter **LOCALI** (`getFullYear`/`getMonth`/`getDate`), mai
 * `toISOString()`. Una `Date` che rappresenta un giorno di calendario è costruita in ora
 * locale — `new Date(2026, 7, 6)` a Roma è `2026-08-05T22:00:00.000Z` — e il suo ISO dice
 * il giorno prima. È l'esatto opposto della regola del seriale, e le due convivono perché
 * i due dati non sono la stessa cosa: uno è un numero di giorni, l'altro è già un istante.
 */
export function dataDaCella(v: Cella, date1904 = false): string | null {
    if (v === null || v === undefined) return null
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return null
        return componi(v.getFullYear(), v.getMonth() + 1, v.getDate())
    }
    if (typeof v === 'number') return serialeExcelAData(v, date1904)
    if (typeof v === 'string') return parseData(v)
    return null
}

/**
 * Un importo scritto come testo → numero.
 *
 * Quando compaiono ENTRAMBI i separatori, decide **quello più a destra**: è il decimale, e
 * l'altro sono le migliaia. Senza questa riga `"1,234.56"` — cioè il testo formattato
 * dell'.xls — diventa `1,23456`: quattro ordini di grandezza sotto, e la riga si
 * riconcilierebbe con la quota di qualcun altro.
 */
export function parseImporto(raw: string): number | null {
    let s = raw.replace(/[€\s+]/g, '')
    if (!s) return null
    const virgola = s.lastIndexOf(',')
    const punto = s.lastIndexOf('.')
    if (virgola >= 0 && punto >= 0) {
        s = virgola > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
    } else if (virgola >= 0) {
        s = s.replace(',', '.')
    }
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/**
 * L'importo di una cella.
 *
 * Il numero vince sempre, perché è l'unico dato dell'.xls che non ha un'interpretazione:
 * `80` è ottanta in ogni lingua, `"80.00"` no.
 *
 * Lo **zero torna zero, non `null`**: una riga da 0,00 € è leggibile e va contata fra le
 * uscite, non fra gli scarti. Confondere «non ho capito la riga» con «la riga vale zero»
 * è il modo in cui un contatore comincia a mentire.
 */
export function importoDaCella(v: Cella): number | null {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
    if (typeof v === 'string') return parseImporto(v)
    return null
}
