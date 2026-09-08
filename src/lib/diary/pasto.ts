/**
 * ESTRATTORE CONDIVISO PER I PASTI — gemello di `nanna.ts` e `bagno.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO. Come per il bagno, «Salva pranzo per tutti» scriveva una riga per ogni
 * bambino presente, `buildInitialState` mette tutte le portate a `null`, e il
 * genitore di chi non era stato toccato leggeva la voce generica: «Ho mangiato con i
 * miei amici!». Misurato dal 1° settembre 2026: **40 pranzi su 443 e 26 merende su
 * 922 senza nessuna portata**. Un raggio più piccolo di quello del bagno, la stessa
 * frase falsa.
 *
 * ⚠️ LA DIFFERENZA COL BAGNO, ED È IL PUNTO DI QUESTO MODULO. Qui «non ha mangiato»
 * ESISTE come registrazione: `MEAL_QUANTITIES` (`eventConfig.ts`) si apre con
 * `{ value: 'niente' }`, la maestra lo sceglie con un tocco e il genitore legge «non
 * ne ho voluto assaggiare» (`messages/it/diario.json`). Il gesto è pure
 * bidirezionale: ritoccare la stessa quantità la riporta a `null`.
 *
 *      null      → non registrato   (lo scrive il codice, d'ufficio, per tutti)
 *      'niente'  → registrato: non ha mangiato   (lo sceglie una persona)
 *
 * Quindi il filtro guarda **se la portata ha un valore**, MAI se quel valore è
 * `'niente'`. Chi un domani "semplificasse" in `v && v !== 'niente'` cancellerebbe
 * dal diario proprio i bambini che non hanno mangiato — che è l'informazione che a
 * un genitore interessa di più. C'è un test che diventa rosso se succede.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const TIPI_PASTO: readonly string[] = ['pranzo', 'merenda'];

/** Questo tipo evento è un pasto? */
export function eEventoPasto(tipo: string): boolean {
    return TIPI_PASTO.includes(tipo);
}

/**
 * Le portate che hanno ricevuto una quantità.
 *
 * Si itera su TUTTE le chiavi di `dettagli.corsi`, non sulle quattro canoniche: le
 * righe vecchie possono avere un menu diverso, e continuano a raccontarsi — è la
 * stessa scelta che fa la narrativa del genitore.
 */
export function portateSegnate(dettagli: Record<string, unknown> | null | undefined): string[] {
    const corsi = dettagli?.corsi;
    if (!corsi || typeof corsi !== 'object' || Array.isArray(corsi)) return [];
    return Object.entries(corsi as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .map(([k]) => k);
}

/**
 * Questo pasto è stato COMPILATO davvero?
 *
 * Fail-closed fuori dai pasti, per la stessa ragione di `nannaCompilata`.
 */
export function pastoCompilato(
    tipo: string,
    dettagli: Record<string, unknown> | null | undefined,
): boolean {
    if (!eEventoPasto(tipo)) return false;
    return portateSegnate(dettagli).length > 0;
}
