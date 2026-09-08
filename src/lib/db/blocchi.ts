/**
 * DIVIDERE UN ELENCO DI ID IN BLOCCHI, PERCHÉ POSTGREST LI METTE IN QUERY STRING.
 *
 * `.in('colonna', ids)` non viaggia nel corpo: finisce nell'URL. Cento uuid sono
 * ~3.800 caratteri, che stanno comodi sotto il limite di riga di qualunque proxy;
 * mille arriverebbero a ~38 kB e la richiesta verrebbe rifiutata con un **414**.
 * Il tetto non è cosmetico: è ciò che impedisce a una correzione di rompersi da
 * sola il giorno in cui gli elenchi crescono.
 *
 * Il numero non è teorico. A Giugliano i genitori distinti sono 345 (misurato il
 * 2026-09-08): un debounce delle notifiche che li passasse tutti in un `.in()`
 * costruirebbe una riga di richiesta da ~13 kB al primo avviso di plesso.
 *
 * PERCHÉ STA QUI E NON IN `@/lib/avvisi`. La regola è una proprietà di PostgREST,
 * non degli avvisi: il primo che ne ha avuto bisogno l'ha scritta lì, e il secondo
 * (le notifiche) non può né duplicarla né importare `AVVISI_PER_QUERY` dentro un
 * modulo che di avvisi non parla. `@/lib/avvisi/statistiche` continua a esporre
 * gli stessi nomi ri-esportandoli, così chi già li usa non si accorge di niente.
 */

/** Quanti id entrano in un solo `.in(...)`. Vedi il 414 qui sopra. */
export const ID_PER_QUERY = 100;

/** Divide un elenco in blocchi di dimensione fissa (l'ultimo può essere più corto). */
export function aBlocchi<T>(elementi: readonly T[], dimensione: number): T[][] {
    if (dimensione < 1) return elementi.length > 0 ? [[...elementi]] : [];
    const blocchi: T[][] = [];
    for (let i = 0; i < elementi.length; i += dimensione) {
        blocchi.push(elementi.slice(i, i + dimensione));
    }
    return blocchi;
}
