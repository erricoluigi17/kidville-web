// Formattazione valuta condivisa (fonte unica app). Localizzazione it-IT:
// virgola decimale, punto separatore delle migliaia, simbolo «€» in testa con
// una spaziatura unica e coerente ovunque («€ 1.234,50», «€ -150,00», «€ 0,00»).
//
// Perché `useGrouping: true` esplicito: l'it-IT ha `minimumGroupingDigits = 2`,
// quindi per default i numeri a 4 cifre (1234) NON verrebbero raggruppati
// («1234,50» invece di «1.234,50»). Forzando il raggruppamento la separazione è
// sempre presente. Il simbolo nativo cade in coda («150,00 €»): lo riportiamo in
// testa via `formatToParts`, restando basati sul formatter di valuta.

/** Formatter Intl memoizzato (una sola istanza per l'intera app). */
export const euroFormatter = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    useGrouping: true,
});

/**
 * Formatta un importo in euro come «€ 1.234,50».
 * Accetta number | string | null | undefined; input non finiti → 0.
 */
export function formatEuro(input: number | string | null | undefined): string {
    let n = typeof input === 'number' ? input : Number(input);
    if (!Number.isFinite(n)) n = 0;
    // -0 → 0 per non produrre mai «€ -0,00».
    if (n === 0) n = 0;

    const parts = euroFormatter.formatToParts(n);
    const symbol = parts.find((p) => p.type === 'currency')?.value ?? '€';
    // Tutto tranne il simbolo e lo spazio nativo (literal): «-1.234,50».
    const numero = parts
        .filter((p) => p.type !== 'currency' && p.type !== 'literal')
        .map((p) => p.value)
        .join('');
    return `${symbol} ${numero}`;
}
