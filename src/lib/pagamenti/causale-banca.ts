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

/** I segni diacritici che `NFKD` stacca dalla lettera: «ò» → «o» + U+0300. */
const DIACRITICI = /[̀-ͯ]/g

/**
 * Le lettere che nessuna normalizzazione Unicode scompone, e che buttate come simboli
 * storpierebbero un nome («Weiß» → «Wei»): si traslitterano come le scrive l'anagrafe.
 */
const TRASLITTERAZIONI: Record<string, string> = {
    ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O',
    ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', þ: 'th', Þ: 'TH', ð: 'd', Ð: 'D',
}
const DA_TRASLITTERARE = new RegExp(`[${Object.keys(TRASLITTERAZIONI).join('')}]`, 'g')

/** Tutto ciò che non è una lettera semplice o una cifra, a gruppi: ogni gruppo diventa UNO spazio. */
const FUORI_SET = /[^A-Za-z0-9]+/g

/**
 * Il testo ripulito per la banca, SENZA taglio: lettere `A-Z a-z`, cifre e spazi singoli.
 *
 * È la trasformazione che serve due volte, e deve essere la stessa tutte e due: in USCITA, per
 * la causale che il genitore ricopia (`causalePerBanca`, qui sotto), e in ENTRATA, quando la
 * riconciliazione confronta il nome e la descrizione di una voce con la causale tornata dalla
 * banca (`@/lib/pagamenti/riconciliazione`). Due pulizie diverse ai due capi sono due stringhe
 * che non si riconoscono più.
 *
 * Le sostituzioni che conservano il SENSO vengono prima della pulizia: «€» diventa «EUR» e «×»
 * (il «2× Felpa» del merchandise) diventa « x » — buttati come simboli qualunque, «€ 150» e «2×»
 * perderebbero l'unica parte che dice qualcosa. La « x » va fra SPAZI: incollata, «245×367»
 * diventerebbe «245x367», sette simboli dell'alfabeto del codice della voce con dentro cifre e
 * lettere — cioè un codice finto, che l'abbinamento automatico tratterebbe da sconosciuto.
 * `NFKD` (e non `NFD`) riporta all'ASCII anche le legature e le cifre e lettere «larghe» o in
 * apice; quello che nessuna normalizzazione scompone passa da `TRASLITTERAZIONI`. Tutto il resto
 * (`#` `*` `/` `'` `’` `-` `—` `[ ]` `:` `,` `.`, emoji, tab, a capo) diventa uno spazio.
 *
 * Idempotente. Un valore che non è una stringa dà `''`, mai un'eccezione: la stessa difesa di
 * `renderCausale`, perché un 500 qui spegnerebbe l'intera lista pagamenti del genitore.
 */
export function testoPerBanca(testo: string): string {
    if (typeof testo !== 'string') return ''
    return testo
        .replace(/€/g, ' EUR ')
        .replace(/×/g, ' x ')
        .replace(DA_TRASLITTERARE, (c) => TRASLITTERAZIONI[c] ?? ' ')
        .normalize('NFKD')
        .replace(DIACRITICI, '')
        .replace(FUORI_SET, ' ')
        .trim()
}

/**
 * La causale del bonifico ripulita per la banca (`testoPerBanca`) e tagliata a `limite`
 * caratteri — di norma `LIMITE_CAUSALE_BANCA`, il campo SEPA.
 *
 * Il taglio cade sull'ultimo spazio entro il limite, così nessuna parola esce mozzata; una parola
 * sola più lunga del limite si taglia al limite invece di sparire. Si conta DOPO la pulizia, cioè
 * sui caratteri che la banca vede davvero.
 */
export function causalePerBanca(testo: string, limite: number = LIMITE_CAUSALE_BANCA): string {
    const pulita = testoPerBanca(testo)
    if (pulita.length <= limite) return pulita
    const spazio = pulita.lastIndexOf(' ', limite)
    return (spazio > 0 ? pulita.slice(0, spazio) : pulita.slice(0, limite)).trim()
}
