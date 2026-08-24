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
/**
 * La SECONDA sede finta del seed E2E.
 *
 * Non è un doppione per simmetria: dal 2026-07-31 il database della CI ne ha
 * DAVVERO due (`scripts/seed-e2e.mjs`), perché l'isolamento fra plessi non si
 * può provare con un plesso solo. Da quel giorno «l'elenco pubblico è vuoto e
 * ce n'è una sola, quindi il server la deduce» ha smesso di essere vero, e il
 * 2026-08-02 la suite E2E dell'iscrizione pubblica si è fermata su un 400
 * «Specificare la scuola». Un test che vuole riprodurre il database della CI
 * deve poter mettere DUE sedi di collaudo, non una.
 */
export const SEDE_E2E_DUE = 'e2e00000-0000-4000-8000-000000000002'
/**
 * La sede che in PRODUZIONE ospita tutti i dati di collaudo, dal 2026-08-24.
 *
 * Non è la sede della CI e non va confusa con lei: `SEDE_E2E` esiste per il seed
 * di `scripts/seed-e2e.mjs`, che la svuota e la ripopola a ogni giro. Questa
 * invece contiene gli account che Apple e Google usano per la revisione, i
 * bambini finti delle loro classi e il contenuto che il revisore deve vedere:
 * un seed che la resettasse spegnerebbe la review.
 *
 * PERCHÉ ESISTE. Fino al 2026-08-24 i dati di prova vivevano dentro le sedi
 * VERE, e il KPI «Studenti iscritti» che vede la segreteria contava 22 bambini
 * inesistenti a Giugliano, 2 ad Aversa, 1 a Cesa. Uno di loro sedeva nella
 * sezione reale «3 ANNI» di Aversa, cioè nel registro di una maestra vera.
 *
 * ⚠️ IL PREFISSO `e2e00000` NON È DECORATIVO, ed è l'unica ragione per cui
 * questa sede non compare nel selettore pubblico del modulo d'iscrizione:
 * `isScuolaE2E` la riconosce da lì. Con un uuid qualunque, una famiglia vera
 * potrebbe iscrivere il proprio figlio a una sede che non esiste.
 */
export const SEDE_DEMO = 'e2e00000-0000-4000-8000-00000000d000'

/** Nomi visualizzabili, in ordine alfabetico crescente A → B → C. */
export const NOME_SEDE_A = 'Kidville Alfa'
export const NOME_SEDE_B = 'Kidville Beta'
export const NOME_SEDE_C = 'Kidville Gamma'
/** Contiene «e2e»: è il secondo indizio con cui `isScuolaE2E` riconosce la sede di test. */
export const NOME_SEDE_E2E = 'Kidville E2E'
/** Come sopra, per la seconda sede di collaudo (lo stesso nome del seed). */
export const NOME_SEDE_E2E_DUE = 'Kidville E2E Due'
/**
 * Il nome della sede demo, che di proposito NON contiene «e2e»: lo legge il
 * revisore Apple e Google dentro l'app. L'esclusione dagli elenchi pubblici la
 * regge il prefisso dell'uuid, non il nome — ed è per questo che il prefisso non
 * si può cambiare.
 */
export const NOME_SEDE_DEMO = 'Kidville Demo'
