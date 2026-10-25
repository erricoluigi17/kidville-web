/**
 * `leggiABlocchi` vive in `src/lib/db/leggi-a-blocchi.ts` dalla sessione 11 della seconda serie
 * di robustezza: è la paginazione di PostgREST, non una regola dei pagamenti.
 *
 * Questo modulo resta per chi lo importava già (sei route, `guasto-db.ts`,
 * `export-rette-a-carico.ts`, e i test che lo mockano per percorso) e riesporta GLI STESSI
 * oggetti: nessun comportamento cambia. Il codice nuovo importa da `@/lib/db/leggi-a-blocchi`.
 */
export {
  BLOCCO_LETTURA,
  MAX_BLOCCHI_LETTURA,
  descriviTetto,
  leggiABlocchi,
} from '@/lib/db/leggi-a-blocchi'
export type { EsitoABlocchi, OpzioniABlocchi, QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
