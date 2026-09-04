import type { MappingCsv, MovimentoCsv } from '../riconciliazione'
import { dataDaCella, importoDaCella } from './celle'
import { estraiOrdinante } from './ordinante'
import type { Cella, EsitoInterpretazione, FoglioGrezzo } from './tipi'

/**
 * DA UNA MATRICE DI CELLE AI MOVIMENTI — l'unico interprete, per CSV e per Excel.
 *
 * Qui non si sa da dove vengono le celle, ed è il punto: il preambolo, l'intestazione
 * spezzata su due righe, i sinonimi delle colonne, gli scarti e l'ordinante sono scritti
 * una volta sola. Due interpreti — uno per il CSV, uno per l'.xls — divergerebbero al
 * primo ritocco, e la banca cambia formato senza avvisare nessuno.
 */

/** Il campo di un movimento a cui una colonna del file può corrispondere. */
export type CampoColonna = keyof MappingCsv

/**
 * I NOMI CHE UNA COLONNA PUÒ AVERE, **IN ORDINE DI PREFERENZA**.
 *
 * L'ordine non è decorativo: è la correzione di un difetto misurato. La ricerca di ieri
 * faceva una passata di uguaglianze su TUTTI i sinonimi e poi una di `includes` su tutti;
 * la lista conteneva `data valuta` e `valuta` ma non `data operaz`, quindi sul file vero
 * vinceva l'uguaglianza su **`valuta`** e la colonna scelta era la DATA VALUTA.
 *
 * Le due date differiscono su **797 righe su 9.000**, e la data entra in `hashMovimento`:
 * l'impronta anti-doppio-import. Sbagliare colonna non è un fastidio da correggere dopo —
 * è un errore **permanente**, che si scopre solo quando lo stesso bonifico entra due volte.
 *
 * La correzione ha due metà, e **fanno cose diverse** — vale la pena non confonderle,
 * perché è facile credere che una delle due basti:
 *
 *  · **la LISTA** (con `data operaz` prima di `data valuta`) è quella che rimette a posto
 *    il file della banca. Lì l'ordine delle colonne aiuta — `Data Operaz.` è la colonna A
 *    e `Valuta` la B — quindi anche la ricerca di ieri, con questa lista, sceglierebbe
 *    giusto. Misurato: rimettendo la forma di ieri e tenendo la lista nuova, il file vero
 *    si legge ancora correttamente.
 *
 *  · **la FORMA ordinata** (sinonimo per sinonimo, e per ciascuno prima l'uguaglianza e
 *    poi il contenimento) è quella che rende il risultato indipendente dall'**ordine delle
 *    colonne nel file**. Basta un estratto che scriva la valuta PRIMA dell'operazione
 *    perché la ricerca di ieri torni a prendere la valuta: scandisce le intestazioni
 *    nell'ordine del file, e `data valuta` è un'uguaglianza esatta tanto quanto
 *    `data operazione`. Il caso è in `estratto-conto-tabella.test.ts`, «con la VALUTA
 *    PRIMA dell'operazione»: è rosso senza questa forma, e la lista da sola non lo salva.
 *
 * ⚠️ **`caus` NON è un sinonimo di causale**, e non è una dimenticanza: nel file vero la
 * colonna E si chiama `Caus.` e contiene il **codice ABI** (`048`), non la causale. Con
 * `caus` in lista ogni movimento avrebbe come descrizione la stringa «048» — e siccome la
 * causale è dentro l'impronta, tutti i movimenti dello stesso giorno e importo
 * collasserebbero sulla stessa.
 *
 * ⚠️ **`eur` invece SERVE**: è il nome vero della colonna dell'importo nell'estratto della
 * banca. Senza, l'indice resta -1 e il file dà zero movimenti anche dopo aver trovato
 * l'intestazione giusta.
 */
export const SINONIMI: Record<CampoColonna, string[]> = {
    data: ['data operazione', 'data operaz', 'data contabile', 'data', 'data valuta', 'valuta', 'date'],
    importo: ['importo eur', 'importo (eur)', 'importo', 'entrate', 'accrediti', 'avere', 'amount', 'eur'],
    causale: ['causale', 'descrizione', 'descrizione operazione', 'descrizione estesa', 'description', 'dettagli'],
    controparte: ['controparte', 'ordinante', 'beneficiario/ordinante', 'beneficiario', 'nome ordinante'],
}

/**
 * Il tetto delle righe, portato da 2.000 a 20.000.
 *
 * L'estratto annuale vero ne ha **9.004**: col tetto di ieri l'import ne avrebbe perse
 * 7.004 **senza dirlo a nessuno**. Il tetto resta — un file da un milione di righe non
 * deve poter fondere una funzione serverless — ma il troncamento adesso si dichiara
 * (`troncate`), e un numero che l'operatore legge è l'opposto di una perdita silenziosa.
 */
export const MAX_RIGHE = 20000

/** Quante righe in testa si guardano cercando l'intestazione (il preambolo è corto). */
const RIGHE_CANDIDATE = 25

/** Su quante righe si conta il separatore: abbastanza da non farsi ingannare dal preambolo. */
const RIGHE_PER_SEPARATORE = 20

/** I separatori che un export bancario usa davvero. */
const CANDIDATI_SEPARATORE = [';', ',', '\t', '|']

/** Il foglio che contiene i movimenti si chiama così in tutti i file della banca. */
const NOME_MOVIMENTI = /movimenti/i

const testoDaCella = (v: Cella): string =>
    v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)

const rigaVuota = (riga: Cella[] | undefined): boolean =>
    !riga || riga.every((c) => testoDaCella(c).trim() === '')

/** Conta un carattere solo dove separa davvero: dentro le virgolette non separa niente. */
function contaFuoriDaVirgolette(riga: string, sep: string): number {
    let n = 0
    let inQuote = false
    for (let i = 0; i < riga.length; i++) {
        const ch = riga[i]
        if (ch === '"') {
            if (inQuote && riga[i + 1] === '"') i++
            else inQuote = !inQuote
        } else if (ch === sep && !inQuote) n++
    }
    return n
}

/**
 * Il separatore del file, **contato** e non indovinato.
 *
 * La regola di ieri guardava solo la prima riga (`riga[0].includes(';') ? ';' : ','`). Ma la
 * prima riga di un estratto conto è il PREAMBOLO, e può non avere separatori affatto: in
 * quel caso la regola sceglieva la virgola su un file punto-e-virgola, e il file intero
 * diventava una colonna sola — cioè zero movimenti, con la stessa faccia di un file vuoto.
 *
 * Si conta su venti righe e si sceglie il carattere **più costante** (quante righe
 * condividono lo stesso conteggio), col totale come spareggio: le virgole dei decimali
 * italiani ci sono in quasi ogni riga, ma in numero variabile, mentre il vero separatore
 * ha sempre lo stesso conteggio.
 */
export function separatore(righe: string[]): string {
    const campione = righe.filter((r) => r.trim().length > 0).slice(0, RIGHE_PER_SEPARATORE)
    let migliore = CANDIDATI_SEPARATORE[0]
    let miglioreCostanza = 0
    let miglioreTotale = 0
    for (const sep of CANDIDATI_SEPARATORE) {
        const conteggi = campione.map((r) => contaFuoriDaVirgolette(r, sep)).filter((n) => n > 0)
        if (conteggi.length === 0) continue
        const frequenze = new Map<number, number>()
        for (const n of conteggi) frequenze.set(n, (frequenze.get(n) ?? 0) + 1)
        const costanza = Math.max(...frequenze.values())
        const totale = conteggi.reduce((a, b) => a + b, 0)
        if (costanza > miglioreCostanza || (costanza === miglioreCostanza && totale > miglioreTotale)) {
            migliore = sep
            miglioreCostanza = costanza
            miglioreTotale = totale
        }
    }
    return migliore
}

/** Split di una riga con supporto alle virgolette doppie, incluse quelle raddoppiate. */
export function splitRiga(riga: string, sep: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < riga.length; i++) {
        const ch = riga[i]
        if (ch === '"') {
            if (inQuote && riga[i + 1] === '"') {
                cur += '"'
                i++
            } else inQuote = !inQuote
        } else if (ch === sep && !inQuote) {
            out.push(cur)
            cur = ''
        } else {
            cur += ch
        }
    }
    out.push(cur)
    return out.map((c) => c.trim())
}

/**
 * Il testo di un CSV → la stessa matrice di celle che darebbe un foglio Excel.
 *
 * **Nessuna riga viene buttata via**, nemmeno quelle vuote: la `;;;;` del file vero è una
 * riga, e togliendola ogni riferimento «riga N» direbbe un numero diverso da quello che
 * l'operatore legge nel suo foglio. Le vuote non contano da nessuna parte, ma esistono.
 */
export function tabellaDaTesto(testo: string): Cella[][] {
    const righe = testo.split(/\r?\n/)
    const sep = separatore(righe)
    return righe.map((r) => splitRiga(r, sep))
}

/**
 * L'intestazione normalizzata per il confronto — funzione **separata** da `norm()` di
 * `riconciliazione.ts`, e non è un doppione da unificare: quella `norm()` è dentro
 * `hashMovimento`, cioè dentro l'impronta anti-doppio-import. Cambiarla per far combaciare
 * un'intestazione cambierebbe TUTTE le impronte già scritte, e ogni movimento già importato
 * tornerebbe importabile.
 *
 * Toglie il BOM (la prima cella di un CSV UTF-8 se lo porta dietro), gli accenti, la
 * punteggiatura in coda (`Caus.` → `caus`, `Importo (EUR):` → `importo (eur)`) e collassa
 * gli spazi.
 */
export function normIntestazione(s: string): string {
    // ⚠️ BOM e segni combinanti si scrivono con l'ESCAPE, mai col carattere letterale:
    // sono invisibili in un editor, e un salvataggio che li normalizza spegnerebbe la
    // protezione senza che nulla lo dica — insieme al test che la sorveglia, se anche lui
    // li scrive letterali. Un carattere che non si vede non si può nemmeno rileggere.
    return s
        .replace(/\uFEFF/g, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036F]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.,;:]+$/, '')
        .trim()
}

/** Dove sta ogni campo dentro le colonne: `-1` quando la colonna non c'è. */
export type Indici = Record<CampoColonna, number>

export interface Intestazione {
    /** L'indice della riga d'intestazione nella matrice (0-based). */
    riga: number
    /** L'indice della prima riga di dati: `riga+1`, oppure `riga+2` se l'intestazione era spezzata. */
    primaRigaDati: number
    /** Le intestazioni come sono state risolte: già unite, se erano su due righe. */
    intestazioni: string[]
    indici: Indici
}

function risolviIndici(intestazioni: string[], mapping?: MappingCsv): Indici {
    const norm = intestazioni.map(normIntestazione)
    const indice = (campo: CampoColonna): number => {
        const esplicito = mapping?.[campo]
        if (esplicito) return norm.indexOf(normIntestazione(esplicito))
        // Sinonimo per sinonimo, e per ciascuno prima l'uguaglianza e poi il contenimento.
        // Si scandiscono i SINONIMI in ordine di preferenza, non le INTESTAZIONI in ordine
        // di colonna: è ciò che rende la scelta indipendente da come la banca dispone le
        // colonne. Sul file di oggi basterebbe la lista; su un file che scriva la valuta
        // prima dell'operazione, no. Vedi il blocco su `SINONIMI` qui sopra.
        for (const s of SINONIMI[campo]) {
            const esatto = norm.indexOf(s)
            if (esatto !== -1) return esatto
            const parziale = norm.findIndex((h) => h.length > 0 && h.includes(s))
            if (parziale !== -1) return parziale
        }
        return -1
    }
    return {
        data: indice('data'),
        importo: indice('importo'),
        causale: indice('causale'),
        controparte: indice('controparte'),
    }
}

/**
 * La riga sotto l'intestazione è una CONTINUAZIONE, non un movimento?
 *
 * Lo è quando nessuna sua cella dà una data valida, nessuna dà un importo valido, e almeno
 * una porta testo. Nel file vero è `["Operaz.", "Valuta"]`, cioè la seconda metà di
 * `["Data", "", "Descrizione", "EUR", "Caus."]`.
 *
 * Il rischio speculare — mangiarsi una riga di dati scambiandola per un pezzo di
 * intestazione — è chiuso dalle prime due condizioni: un movimento ha sempre almeno una
 * data o un importo leggibile, altrimenti sarebbe una riga da scartare comunque.
 */
function continuazione(riga: Cella[] | undefined, date1904: boolean): boolean {
    if (!riga || rigaVuota(riga)) return false
    let testo = false
    for (const c of riga) {
        if (dataDaCella(c, date1904) !== null) return false
        if (importoDaCella(c) !== null) return false
        if (testoDaCella(c).trim() !== '') testo = true
    }
    return testo
}

/**
 * L'intestazione della tabella, cercata fra le prime righe **non vuote**.
 *
 * Una riga tutta vuota — come la `;;;;` del file vero, che al filtro `trim().length > 0`
 * di ieri sopravviveva perché i punti e virgola non sono spazi — non è mai un'intestazione.
 * Una riga è l'intestazione quando risolve **sia** la data **sia** l'importo: sono i due
 * campi senza i quali un movimento non esiste, e pretenderli entrambi è ciò che impedisce
 * al preambolo di spacciarsi per intestazione.
 */
export function trovaIntestazione(
    righe: Cella[][],
    mapping?: MappingCsv,
    date1904 = false,
): Intestazione | null {
    const candidate: number[] = []
    for (let i = 0; i < righe.length && candidate.length < RIGHE_CANDIDATE; i++) {
        if (!rigaVuota(righe[i])) candidate.push(i)
    }

    for (const i of candidate) {
        // ⚠️ Indice per indice, NON `.map`: `sheet_to_json` restituisce array **sparsi**
        // — la colonna B dell'intestazione del file vero è una cella che non esiste, non
        // una cella vuota — e `.map` sui buchi non chiama la funzione, li ricopia. Il
        // risultato era un `undefined` in mezzo alle intestazioni e un TypeError più giù.
        const riga = righe[i] ?? []
        const grezze: string[] = []
        for (let c = 0; c < riga.length; c++) grezze.push(testoDaCella(riga[c]))
        const indici = risolviIndici(grezze, mapping)
        if (indici.data === -1 || indici.importo === -1) continue

        const sotto = righe[i + 1]
        if (continuazione(sotto, date1904)) {
            const larghezza = Math.max(grezze.length, sotto?.length ?? 0)
            const unite: string[] = []
            for (let c = 0; c < larghezza; c++) {
                unite.push(`${grezze[c] ?? ''} ${testoDaCella(sotto?.[c])}`.trim())
            }
            // Gli indici si RICALCOLANO sulle intestazioni unite: è lì che «Data» + «Operaz.»
            // diventa `data operaz` e smette di perdere contro `valuta`.
            const indiciUniti = risolviIndici(unite, mapping)
            if (indiciUniti.data !== -1 && indiciUniti.importo !== -1) {
                return { riga: i, primaRigaDati: i + 2, intestazioni: unite, indici: indiciUniti }
            }
        }
        return { riga: i, primaRigaDati: i + 1, intestazioni: grezze, indici }
    }
    return null
}

export interface OpzioniInterpretazione {
    /** Le colonne indicate a mano dall'operatore: vincono sempre sui sinonimi. */
    mapping?: MappingCsv
    /** L'epoca del workbook, per i seriali delle date. */
    date1904?: boolean
}

const esitoVuoto = (foglio: string, intestazioni: string[] = []): EsitoInterpretazione => ({
    movimenti: [],
    scartate: 0,
    uscite: 0,
    troncate: 0,
    senzaOrdinante: 0,
    intestazioni,
    foglio,
})

/**
 * I movimenti, da tutti i fogli del file.
 *
 * ─── QUALE FOGLIO ───────────────────────────────────────────────────────────
 * Il primo che si chiama `Movimenti` **e** risolve un'intestazione; in mancanza, il primo
 * che ne risolve una; in mancanza ancora, il primo, così da poter almeno dire quali
 * colonne ha visto. Prendere `SheetNames[0]` non basta: `Conti-15.xls` porta anche un
 * foglio di riscontro del commercialista, e importarlo al posto dei movimenti darebbe un
 * esito plausibile e sbagliato.
 *
 * ─── I CONTATORI SONO ONESTI, E NON È UN DETTAGLIO ──────────────────────────
 * `scartate` sono le righe che non si sono capite; `uscite` quelle capite benissimo e non
 * importabili perché addebiti; `troncate` quelle oltre il tetto. Tenerle separate è ciò
 * che permette a un import riuscito di dichiarare **zero scarti** invece di 2.221.
 */
export function interpretaFogli(fogli: FoglioGrezzo[], opzioni?: OpzioniInterpretazione): EsitoInterpretazione {
    const date1904 = opzioni?.date1904 ?? false
    const risolti = fogli.map((foglio) => ({
        foglio,
        intestazione: trovaIntestazione(foglio.righe, opzioni?.mapping, date1904),
    }))

    const scelto =
        risolti.find((r) => r.intestazione && NOME_MOVIMENTI.test(r.foglio.nome)) ??
        risolti.find((r) => r.intestazione) ??
        risolti[0]

    if (!scelto) return esitoVuoto('')

    const righe = scelto.foglio.righe
    if (!scelto.intestazione) {
        // Nessuna intestazione da nessuna parte: si restituiscono le colonne VISTE — senza,
        // «non trovo le colonne» non dice all'operatore che cosa il lettore ha trovato al
        // loro posto — e si dichiarano illeggibili tutte le righe non vuote. «Zero movimenti»
        // da solo non distingue un file sbagliato da un file vuoto.
        const nonVuote = righe.filter((r) => !rigaVuota(r))
        return {
            ...esitoVuoto(scelto.foglio.nome, (nonVuote[0] ?? []).map(testoDaCella)),
            scartate: nonVuote.length,
        }
    }

    const { indici, primaRigaDati, intestazioni } = scelto.intestazione
    const movimenti: MovimentoCsv[] = []
    let scartate = 0
    let uscite = 0
    let troncate = 0
    let senzaOrdinante = 0
    let esaminate = 0

    for (let i = primaRigaDati; i < righe.length; i++) {
        const riga = righe[i]
        if (rigaVuota(riga)) continue
        if (esaminate >= MAX_RIGHE) {
            troncate++
            continue
        }
        esaminate++

        const data = dataDaCella(riga[indici.data], date1904)
        const importo = importoDaCella(riga[indici.importo])
        if (data === null || importo === null) {
            scartate++
            continue
        }
        if (importo <= 0) {
            uscite++
            continue
        }

        // ⚠️ La causale è la descrizione INTERA. È dentro `hashMovimento`: accorciarla,
        // ripulirla o togliere il nome dell'ordinante cambierebbe l'impronta di ogni
        // movimento già importato, e i doppioni tornerebbero a passare.
        const causale = indici.causale >= 0 ? testoDaCella(riga[indici.causale]) : ''
        // La colonna esplicita vince SEMPRE, anche quando è vuota: se la banca dichiara
        // l'ordinante in una colonna sua, dedurlo dalla descrizione significherebbe
        // sovrascrivere un dato dichiarato con una supposizione.
        const controparte =
            indici.controparte >= 0 ? testoDaCella(riga[indici.controparte]).trim() : estraiOrdinante(causale)
        if (!controparte) senzaOrdinante++

        movimenti.push({ data_operazione: data, importo, causale, controparte })
    }

    return { movimenti, scartate, uscite, troncate, senzaOrdinante, intestazioni, foglio: scelto.foglio.nome }
}
