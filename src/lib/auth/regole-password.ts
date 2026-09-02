// =============================================================================
// LE REGOLE DELLA PASSWORD — e perché ce n’è UNA copia sola.
//
// Fino al 2026-09-01 la stessa domanda («questa password va bene?») aveva tre
// risposte diverse: la route di onboarding pretendeva 8 caratteri, la schermata
// che la chiama ne ripeteva 8 per conto suo, e `supabase/config.toml` ne
// dichiarava 6 al provider. Nessuna delle tre era sbagliata rispetto a sé stessa,
// ed è il motivo per cui nessun test poteva vedere la divergenza: ogni copia era
// coerente con la propria copia. Un utente sì — nel punto esatto in cui gli viene
// detto «almeno 8» e poi rifiutata una password di 9.
//
// Qui la regola sta scritta una volta. Chi la vuole cambiare la cambia qui.
//
// PERCHÉ QUESTO MODULO NON IMPORTA NIENTE. Deve poter essere importato sia da una
// route sia da un componente `'use client'`: la schermata in cui il genitore
// sceglie la password deve poter dire PRIMA, mentre digita, ciò che il server
// dirà DOPO. È lo stesso motivo per cui esiste `forma-password.ts` separato da
// `password-temporanea.ts` (che importa `randomInt` da `crypto`): un import di
// Node qui romperebbe il bundle che finisce sul telefono di una famiglia, e
// affidarsi al tree-shaking sarebbe una scommessa sul bundler, non una garanzia.
//
// Qui dentro non c’è nessun segreto e nessuna generazione: solo un giudizio su
// una stringa. Da queste funzioni non esce MAI la password — esce un codice a
// vocabolario chiuso, che è l’unica cosa che si può loggare o mandare al client.
// =============================================================================

/**
 * Il minimo, in caratteri.
 *
 * NON è il minimo del provider: `minimum_password_length = 6` in
 * `supabase/config.toml` è il pavimento di GoTrue, cioè il punto sotto il quale
 * la password verrebbe rifiutata comunque. Dieci è la POLITICA nostra, e sta
 * sopra il pavimento di proposito: se un domani il provider alzasse il suo
 * minimo sopra il nostro, il nostro «va bene» diventerebbe una bugia detta un
 * istante prima del rifiuto. `__tests__/lib/regole-password.test.ts` confronta i
 * due numeri, così quel giorno se ne accorge un test e non una famiglia.
 */
export const LUNGHEZZA_MINIMA_PASSWORD = 10

/** I motivi per cui una password può essere rifiutata. Vocabolario chiuso. */
export type CodiceRegolaPassword =
  | 'PASSWORD_TROPPO_CORTA'
  | 'PASSWORD_SENZA_CIFRA'
  | 'PASSWORD_CON_SPAZI_AI_BORDI'
  | 'PASSWORD_UGUALE_ALLA_PRECEDENTE'

/** L’esito: o va bene, o c’è esattamente un motivo — il PRIMO che si incontra. */
export type EsitoRegolaPassword = { ok: true } | { ok: false; codice: CodiceRegolaPassword }

/**
 * L’alfabeto di GoTrue, non il nostro: la policy `letters_digits` conta i
 * caratteri di `a-zA-Z` e `0-9`. Se qui accettassimo `à` come lettera, una
 * password di sole accentate passerebbe da noi e verrebbe respinta DOPO dal
 * provider — con un messaggio che chi la sta scegliendo non può interpretare.
 * Essere almeno tanto severi quanto chi decide davvero è ciò che rende utile
 * dare un giudizio in anticipo.
 */
const LETTERA = /[A-Za-z]/
const CIFRA = /[0-9]/

/**
 * Le quattro regole, nell’ordine in cui si verificano — e si restituisce solo la
 * prima che fallisce: due motivi insieme non aiutano nessuno a correggere.
 *
 *  1. Almeno {@link LUNGHEZZA_MINIMA_PASSWORD} caratteri.
 *  2. Almeno una lettera E almeno una cifra: è la policy `letters_digits` che il
 *     codice già assume in produzione (vedi `password-temporanea.ts`, che genera
 *     le temporanee proprio per soddisfarla). Se non la applichiamo noi, la
 *     applica GoTrue dopo, e l’utente riceve un rifiuto che non spiega niente.
 *  3. Nessuno spazio a inizio o fine. `src/app/auth/login/page.tsx` porta un
 *     intero SECONDO tentativo d’accesso che esiste solo per non chiudere fuori
 *     chi una password così ce l’ha già dentro l’hash (difetto del 2026-08-22).
 *     Quelle esistenti si rispettano; di nuove non se ne creano più.
 *  4. Diversa dall’attuale, quando l’attuale è nota. Il confronto è ESATTO: due
 *     password che differiscono per una maiuscola sono due password diverse, e
 *     normalizzare qui vorrebbe dire rifiutarne una che il provider accetterebbe.
 *
 * @param nuova   la password proposta, GREZZA: non si ripulisce, si giudica.
 * @param attuale la password in uso, se il chiamante la conosce. Se manca — ed è
 *                il caso dell’onboarding, dove non c’è nessuna precedente — la
 *                quarta regola semplicemente non si applica.
 */
export function valutaPasswordNuova(nuova: string, attuale?: string): EsitoRegolaPassword {
    if (nuova.length < LUNGHEZZA_MINIMA_PASSWORD) return { ok: false, codice: 'PASSWORD_TROPPO_CORTA' }
    if (!LETTERA.test(nuova) || !CIFRA.test(nuova)) return { ok: false, codice: 'PASSWORD_SENZA_CIFRA' }
    // `trim()` toglie ogni spazio bianco, tabulazioni e capi riga compresi: sono
    // tutti frutto di un incollaggio, e nessuno di essi si vede sullo schermo.
    if (nuova !== nuova.trim()) return { ok: false, codice: 'PASSWORD_CON_SPAZI_AI_BORDI' }
    if (attuale !== undefined && nuova === attuale) return { ok: false, codice: 'PASSWORD_UGUALE_ALLA_PRECEDENTE' }
    return { ok: true }
}

/**
 * Quanto è robusta, da 0 a 4 — il numero che riempie la barra sotto il campo.
 *
 * NON È IL GIUDIZIO DI AMMISSIBILITÀ, ed è deliberato che siano due funzioni.
 * `valutaPasswordNuova` dice se si può usare; questa dice quanto regge. Uno
 * spazio in coda non rende una password più debole: la rende inammissibile.
 * Tenerle separate è ciò che permette a questa di essere MONOTONA.
 *
 * MONOTONIA — la proprietà, e perché è quella che conta. Il punteggio si calcola
 * SOLO su predicati che, aggiungendo un carattere, non possono che restare veri o
 * diventarlo: la lunghezza cresce, e una classe di caratteri già presente non
 * sparisce. Quindi aggiungendo caratteri il punteggio non scende MAI. Senza
 * questa garanzia la barra tornerebbe indietro mentre qualcuno continua a
 * digitare, e la leggerebbe come «sto peggiorando» — un consiglio falso, dato nel
 * momento peggiore. È l’unica ragione per cui qui non c’è nessuna penalità per le
 * ripetizioni o per le parole comuni: una penalità è per costruzione non monotona.
 *
 * Deterministica e senza dipendenze: stessa password, stesso numero, ovunque
 * giri — server o telefono.
 */
export function forzaPassword(p: string): 0 | 1 | 2 | 3 | 4 {
    // Lunghezza: tre soglie, perché è il fattore che pesa di più davvero.
    let punti = 0
    if (p.length >= 8) punti++
    if (p.length >= 12) punti++
    if (p.length >= 16) punti++

    // Varietà: quante delle quattro famiglie compaiono. «Altro» raccoglie
    // simboli, spazi e lettere accentate — che per GoTrue non sono lettere
    // (vedi LETTERA) ma per la robustezza contano eccome.
    const classi =
        Number(/[a-z]/.test(p)) +
        Number(/[A-Z]/.test(p)) +
        Number(/[0-9]/.test(p)) +
        Number(/[^a-zA-Z0-9]/.test(p))
    if (classi >= 2) punti++
    if (classi >= 3) punti++
    if (classi >= 4) punti++

    // Il tetto è 4 perché la barra ha quattro tacche. `Math.min` di una funzione
    // monotona resta monotono: il tetto non introduce discese.
    return Math.min(punti, 4) as 0 | 1 | 2 | 3 | 4
}
