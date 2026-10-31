// =============================================================================
// MODULO CASSA · movimenti «assorbiti» da un incasso.
//
// La cassa somma due cose: i movimenti veri (`cassa_movimenti`) e, come entrate
// virtuali, gli incassi in contanti delle voci di contabilità (`incassi`). Quando
// la quota d'iscrizione passa dal CRM in contabilità nasce un incasso in contanti
// con lo stesso importo, metodo e data dell'entrata che il CRM aveva già messo in
// cassa: contati tutti e due, quei soldi varrebbero il doppio.
//
// Regola (spec 2026-10-31, §5.3): un movimento con `incasso_id` valorizzato è
// RAPPRESENTATO da quell'incasso, e non si conta né si elenca. Il totale del giorno
// resta identico, anche per un giorno già chiuso.
//
// Una sola funzione, usata da OGNI punto TypeScript che somma o elenca
// `cassa_movimenti` (saldo, lista dei movimenti). Le tre funzioni SQL dei report
// applicano la stessa regola con `m.incasso_id IS NULL`: se cambia qui, cambia lì.
// =============================================================================

/** Un movimento con `incasso_id` è rappresentato da quell'incasso: non si conta e non si elenca. */
export function movimentoAssorbito(m: { incasso_id?: string | null }): boolean {
  return typeof m.incasso_id === 'string' && m.incasso_id !== ''
}

/** I movimenti che la cassa conta davvero: tutti tranne quelli assorbiti da un incasso. */
export function soloMovimentiContati<T extends { incasso_id?: string | null }>(movimenti: T[]): T[] {
  return movimenti.filter((m) => !movimentoAssorbito(m))
}
