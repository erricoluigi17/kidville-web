// =============================================================================
// L'IBAN: normalizzazione e controllo. Modulo PURO — nessun import.
//
// ─── PERCHÉ STA QUI E NON IN `fiscale.ts` ───────────────────────────────────
// Perché lo carica anche il BROWSER: il pannello delle impostazioni valida
// l'IBAN mentre l'operatore lo digita. `fiscale.ts` importa il logger, che
// trascina `node:crypto`, e un componente client che lo importasse porterebbe
// tutto quello nel bundle — un difetto che `vitest` non vede e che salta fuori
// solo a `next build`. È la stessa direzione già dichiarata nella testata di
// `fiscale.ts` per `@/lib/fatturazione/cedente`: i moduli puri stanno sotto, e
// chi importa il logger sta sopra.
//
// ─── PERCHÉ UN IBAN SI CONTROLLA, E NON SI PRENDE COM'È ─────────────────────
// Questo numero finisce nel riquadro «Dati per il bonifico» dei promemoria e dei
// solleciti di pagamento, ed è l'unica cosa di quelle email che chi legge copia
// e incolla nell'home banking. Un IBAN sbagliato di una cifra non dà nessun
// errore a chi lo scrive in Impostazioni: dà errore molto più tardi, a una
// famiglia che ha già mandato i soldi da qualche altra parte. Le due cifre di
// controllo esistono esattamente per questo, e verificarle costa otto righe.
// =============================================================================

/** Maiuscolo, senza spazi né punti. È la forma in cui l'IBAN si confronta e si copia. */
export function normalizzaIban(valore: string | null | undefined): string {
    return (valore ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Vero se l'IBAN è formalmente valido: forma giusta e cifre di controllo che
 * tornano (ISO 13616, resto 1 modulo 97).
 *
 * Una stringa vuota è «non valida» ma non è un errore: chi chiama distingue
 * «assente» — legittimo, e il riquadro bonifico omette la riga — da «sbagliato»,
 * che invece va corretto prima di salvare.
 */
export function ibanValido(valore: string | null | undefined): boolean {
    const iban = normalizzaIban(valore)
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false
    // Le prime quattro posizioni vanno in coda, poi ogni lettera diventa il suo
    // numero (A=10 … Z=35), e il tutto deve dare resto 1 modulo 97. Il resto si
    // accumula cifra per cifra perché il numero intero supera `Number.MAX_SAFE_INTEGER`.
    const riordinato = iban.slice(4) + iban.slice(0, 4)
    const numerico = riordinato.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
    let resto = 0
    for (const cifra of numerico) resto = (resto * 10 + Number(cifra)) % 97
    return resto === 1
}

/**
 * L'IBAN come si mostra a chi legge: a gruppi di quattro, che è il modo in cui
 * si rilegge senza perdere il segno. `null` se assente o se le cifre di
 * controllo non tornano — un IBAN sbagliato non si mostra affatto, perché
 * mostrarlo sarebbe peggio che ometterlo.
 */
export function ibanLeggibile(valore: string | null | undefined): string | null {
    const iban = normalizzaIban(valore)
    if (iban === '' || !ibanValido(iban)) return null
    return iban.replace(/(.{4})/g, '$1 ').trim()
}
