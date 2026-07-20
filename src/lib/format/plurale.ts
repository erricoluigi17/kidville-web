// Scelta singolare/plurale per le stringhe di conteggio (fonte unica app).
//
// In italiano solo la magnitudine 1 è singolare: «1 famiglia», ma «0 famiglie»,
// «2 famiglie», «1,5 famiglie». Restituisce SOLO il sostantivo nella forma
// corretta, così l'uso resta `{n} {plurale(n, 'famiglia', 'famiglie')}` e il
// numero è formattato a parte. Utile anche in ottica i18n (evita di concatenare
// il plurale a mano nei componenti).

/**
 * Sceglie la forma singolare o plurale in base al conteggio.
 * `n === ±1` → `sing`; qualunque altro valore (0, 2+, non intero, NaN) → `plur`.
 */
export function plurale(n: number, sing: string, plur: string): string {
  return Math.abs(n) === 1 ? sing : plur
}
