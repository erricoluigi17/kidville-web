/**
 * Il tetto della motivazione di uno sblocco della Direzione (`sblocchi_audit.motivazione`).
 *
 * Modulo PURO, senza import: lo leggono DUE lati che non devono divergere.
 *  · la route `/api/primaria/sblocca` lo mette nello schema zod (dopo `trim()`);
 *  · il `BottoneSblocca` lo mette come `maxLength` della textarea.
 *
 * Finché il numero stava solo nella route, chi scriveva più di mille caratteri
 * riceveva un 400 generico («Dati non validi», senza codice) che non diceva che il
 * problema era la LUNGHEZZA: il limite esisteva, ma l'interfaccia non lo mostrava.
 *
 * Mille caratteri bastano per un motivo e non per un verbale: la riga d'audit non
 * deve diventare un deposito di testo libero scritto su una classe di minori.
 */
export const MOTIVAZIONE_SBLOCCO_MAX = 1000
