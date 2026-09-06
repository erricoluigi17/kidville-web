/**
 * `42P10` — la chiave di `ON CONFLICT` non corrisponde a nessun indice inferibile.
 *
 * Non è un errore sui DATI: è il database che dice «l'indice che questa route si aspetta qui non
 * c'è». Le due cause sono una migrazione non arrivata (il DB E2E della CI, non migrato) e un
 * indice PARZIALE, che `ON CONFLICT (colonne)` non sa inferire perché PostgREST non può mandare
 * il `WHERE`. La seconda ha tenuto fermo il menu della mensa fino al 2026-09-06.
 *
 * Sta qui, e non accanto a una delle chiavi, perché lo usano il registro (`chiave-orario`), la
 * mensa (`mensa/chiave-menu`) e i giudizi della Primaria.
 */
export function vincoloConflittoAssente(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P10'
}
