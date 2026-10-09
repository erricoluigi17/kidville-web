/**
 * LA CAUSALE COME LA ACCETTA LA BANCA PIÙ SEVERA — lettere, cifre e spazi, e niente altro.
 *
 * ─── PERCHÉ ESISTE (2026-10-09) ─────────────────────────────────────────────
 * Un genitore non riusciva a fare il bonifico da Poste: la causale copiata dall'app portava il
 * `#` del codice della voce, e BancoPosta lo rifiuta. Non era l'unico carattere a rischio. Lo
 * schema SEPA (EPC) ammette lettere, cifre, spazio e `/ - ? : ( ) . , ' +`, ma ogni banca può
 * restringere: BancoPosta rifiuta anche `/ : ? '`, Fineco elenca solo `/ ? '` oltre agli
 * alfanumerici. L'unico insieme che passa DOVUNQUE è l'intersezione: `A-Z a-z 0-9` e spazio.
 *
 * Misure su produzione del giorno, perché non sembri un eccesso di zelo: 1.434 voci su 2.205 si
 * chiamano «Retta MM/AAAA» (la `/`), 188 portano la lineetta `—` delle rate e dei ticket, e i nomi
 * dei bambini hanno apostrofi dritti e tipografici, trattini e lettere accentate. E sui 451
 * movimenti arrivati dalla banca dopo l'introduzione del codice, il `#` non c'era in NESSUNO: le
 * banche lo tolgono o costringono il genitore a toglierlo a mano.
 *
 * ─── PERCHÉ 140 ─────────────────────────────────────────────────────────────
 * È il campo «remittance information» non strutturato dello schema SEPA. Alcune banche tagliano
 * più corto (AgID, avviso SPID n. 32: «alcuni istituti bancari limitano la causale a 50
 * caratteri»): a quello non si rimedia qui ma nel MODELLO, che mette codice della voce e codice
 * fiscale in testa (v. `DEFAULT_CAUSALE_TEMPLATE` in `./causale`).
 *
 * ─── PERCHÉ ZERO IMPORT ─────────────────────────────────────────────────────
 * Lo consuma `./causale`, che è importato da un file `'use client'` (il pannello delle causali):
 * tutto ciò che entra qui entra nel bundle del browser. Stessa disciplina di `./codice-voce`.
 *
 * ─── PERCHÉ SOLO IL BONIFICO ────────────────────────────────────────────────
 * La causale della fattura elettronica NON passa di qui: il tracciato FatturaPA accetta accenti e
 * `/`, e ha già le sue regole (`causalePerTracciato` in `@/lib/aruba/fatturapa-xml`). Ripulire anche
 * quella toglierebbe a un documento fiscale caratteri che sono suoi.
 */

/** La lunghezza del campo causale nello schema SEPA. */
export const LIMITE_CAUSALE_BANCA = 140

/** I segni diacritici che `NFD` stacca dalla lettera: «ò» → «o» + U+0300. */
const DIACRITICI = /[̀-ͯ]/g

/** Tutto ciò che non è una lettera semplice o una cifra, a gruppi: ogni gruppo diventa UNO spazio. */
const FUORI_SET = /[^A-Za-z0-9]+/g

/**
 * La causale del bonifico ripulita per la banca: lettere `A-Z a-z`, cifre e spazi singoli, al
 * massimo `LIMITE_CAUSALE_BANCA` caratteri.
 *
 * Le sostituzioni che conservano il SENSO vengono prima della pulizia: «€» diventa «EUR» e «×»
 * (il «2× Felpa» del merchandise) diventa «x» — buttati come simboli qualunque, «€ 150» e «2×»
 * perderebbero l'unica parte che dice qualcosa. Tutto il resto (`#` `*` `/` `'` `’` `-` `—` `[ ]`
 * `:` `,` `.`, emoji, tab, a capo) diventa uno spazio, e gli spazi si comprimono.
 *
 * Il taglio cade sull'ultimo spazio entro il limite, così nessuna parola esce mozzata; una parola
 * sola più lunga del limite si taglia al limite invece di sparire. Si conta DOPO la pulizia, cioè
 * sui caratteri che la banca vede davvero.
 *
 * Idempotente. Un valore che non è una stringa dà `''`, mai un'eccezione: la stessa difesa di
 * `renderCausale`, perché un 500 qui spegnerebbe l'intera lista pagamenti del genitore.
 */
export function causalePerBanca(testo: string): string {
    if (typeof testo !== 'string') return ''
    const pulita = testo
        .normalize('NFD')
        .replace(DIACRITICI, '')
        .replace(/€/g, ' EUR ')
        .replace(/×/g, 'x')
        .replace(FUORI_SET, ' ')
        .trim()
    if (pulita.length <= LIMITE_CAUSALE_BANCA) return pulita
    const spazio = pulita.lastIndexOf(' ', LIMITE_CAUSALE_BANCA)
    return (spazio > 0 ? pulita.slice(0, spazio) : pulita.slice(0, LIMITE_CAUSALE_BANCA)).trim()
}
