/**
 * Sedi FINTE per i test — l'unico posto da cui prendere l'uuid di una scuola.
 *
 * PERCHÉ ESISTE. Fino al 2026-07-31 l'uuid REALE di Kidville Giugliano (e in un
 * caso quello di Aversa) stava incollato dentro 24 file di test. Nei test un
 * uuid di produzione è innocuo ma NORMALIZZA l'errore: chi copia un test copia
 * l'uuid, e da lì finisce in uno script che scrive sul database vero o in una
 * migrazione che cabla la sede. Un test non deve conoscere la produzione: se
 * domani quell'uuid cambia, i test devono restare veri.
 *
 * COME SI USANO. `SEDE_A` è, per convenzione, «la sede dell'utente sotto test»;
 * `SEDE_B` e `SEDE_C` sono «un'altra sede», quella che l'isolamento deve tenere
 * fuori. La convenzione (e la forma degli uuid) è la stessa già adottata dai
 * test `*-scope-sede`, così un test nuovo si legge come i suoi vicini.
 *
 * LA SEDE E2E NON È UNA SEDE COME LE ALTRE. `SEDE_E2E` conserva di proposito il
 * prefisso `e2e00000`: è il segnale su cui `isScuolaE2E` (src/lib/scuole/reali.ts)
 * riconosce la scuola finta del seed della CI per escluderla dagli elenchi
 * pubblici. Cambiarne la forma non romperebbe la compilazione — spegnerebbe in
 * silenzio quel filtro nei test. Il contratto è verificato in `sedi.test.ts`.
 *
 * Nessun uuid qui dentro esiste in produzione, e nessuno di questi valori va
 * usato come default in codice applicativo o in uno script.
 */

/** La sede dell'utente sotto test. */
export const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
/** Un'altra sede: quella che l'isolamento deve tenere fuori. */
export const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
/** Una terza sede, per i casi in cui due non bastano a distinguere. */
export const SEDE_C = 'cccccccc-0000-4000-8000-00000000000c'
/** La sede finta del seed E2E: prefisso `e2e00000`, riconosciuto da `isScuolaE2E`. */
export const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000001'

/** Nomi visualizzabili, in ordine alfabetico crescente A → B → C. */
export const NOME_SEDE_A = 'Kidville Alfa'
export const NOME_SEDE_B = 'Kidville Beta'
export const NOME_SEDE_C = 'Kidville Gamma'
/** Contiene «e2e»: è il secondo indizio con cui `isScuolaE2E` riconosce la sede di test. */
export const NOME_SEDE_E2E = 'Kidville E2E'
