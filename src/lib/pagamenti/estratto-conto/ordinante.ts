/**
 * L'ORDINANTE DEL BONIFICO, ESTRATTO DALLA CAUSALE.
 *
 * L'estratto conto della banca non ha una colonna «ordinante»: il nome di chi ha
 * pagato sta dentro la descrizione, in una forma che si ripete sempre uguale —
 *
 *     BONIFICO A VOSTRO FAVORE … DA  <nome> PER  <causale libera> TRN <numero>
 *
 * Senza questo pezzo la riconciliazione ha, di ogni accredito, solo data e importo:
 * il nome di chi ha pagato — l'aggancio più forte dopo il codice fiscale — resterebbe
 * sepolto in una frase di duecento caratteri.
 *
 * ─── OGNI SCELTA QUI SOTTO È MISURATA SU 9.000 RIGHE VERE (6.825 con «DA ») ───
 * `DA ` apre in 6.825 righe · `PER` chiude in 8.360 · `TRN` in 6.826 · `SPESE` in
 * 2.082 · `COMM` in 2.026. Estratto il 99,84% degli accrediti.
 *
 * · **niente flag `g`** — la regex vive a livello di modulo: con `g` porterebbe
 *   `lastIndex` da una chiamata all'altra e salterebbe una riga su due.
 * · **niente flag `i`** — case-sensitive e insensitive danno lo stesso risultato sulle
 *   righe vere, ma il testo dopo `PER` è prosa italiana minuscola: un `da` minuscolo
 *   che rubasse il match si porterebbe dietro mezza causale come nome di persona.
 * · **marcatore di chiusura obbligatorio**, nessun ramo «fino a fine stringa»: zero
 *   righe su 6.774 ne avrebbero avuto bisogno, e senza marcatore mezza causale
 *   diventerebbe un nome.
 * · **`\b` dopo il marcatore** — `PERLINI` non è `PER`: 16 righe.
 * · **la virgola resta dentro il nome** — 206 cointestati (`FABBRI GIULIA, BIANCHI LUCA`)
 *   sono UNA controparte, non due.
 * · **il doppio spazio interno si collassa, non separa** — su 113 casi a volte separa
 *   due persone, a volte è spurio: non si distinguono, e spezzare sbaglierebbe la metà.
 * · **non si tocca l'ordine cognome/nome, non si corregge il maiuscolo, non si ricuciono
 *   gli spazi dentro le parole**: riscrivere un nome è correggere in silenzio un dato
 *   che va mostrato all'operatore com'è.
 */

/** Apertura `DA` + nome pigro + uno dei marcatori che nella forma della banca lo chiudono. */
const ORDINANTE = /(?:^|\s)DA\s+(.+?)\s+(?:PER|COMM|SPESE|TRN)\b/

/**
 * Oltre questa lunghezza non è più un nome ma un pezzo di causale: si preferisce il
 * vuoto (che `senzaOrdinante` conta e rende visibile) a un falso che nessuno controlla.
 */
const MAX_ORDINANTE = 120

/** Il nome dell'ordinante, oppure `''` quando la causale non ne porta uno. */
export function estraiOrdinante(descrizione: string): string {
    if (!descrizione) return ''
    const m = ORDINANTE.exec(descrizione)
    if (!m) return ''
    const nome = m[1].replace(/\s+/g, ' ').trim()
    if (!nome || nome.length > MAX_ORDINANTE) return ''
    return nome
}
