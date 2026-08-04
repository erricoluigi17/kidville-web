/**
 * I tetti degli elenchi admin — in UN POSTO SOLO.
 *
 * «Una regola valida per due strade deve vivere in un posto solo»: è la lezione
 * che questo repo ha già pagato (POST/PUT avvisi, tasks/avvisi, 1 OTP su 4).
 * Qui la regola vale per DIECI strade: dieci pagine chiedevano
 * `/api/admin/students?limit=1000` scrivendo il numero a mano. Dieci copie di
 * un tetto sono dieci occasioni di cambiarne nove.
 *
 * Il tetto NON è una preferenza estetica: è il punto oltre il quale l'elenco
 * viene TRONCATO. Al 2026-08-04 in produzione ci sono ~32 alunni, quindi il
 * troncamento è LATENTE, non attivo — nessuna pagina perde righe oggi. Ma il
 * giorno in cui esistesse la 1001-esima riga, un elenco troncato non produce
 * nessun errore: produce una classe con dentro meno bambini, un conteggio più
 * basso e nessuno che se ne accorge. Per questo il tetto vive qui, e per questo
 * `GET /api/admin/students` restituisce `X-Total-Count` e logga a `warn` quando
 * le righe restituite sono esattamente il tetto e il totale è maggiore
 * (`src/app/api/admin/students/route.ts`).
 */

/**
 * Righe che le pagine admin chiedono a `GET /api/admin/students`.
 *
 * Deve restare ≤ al massimo accettato dal clamp `getQuerySchema.limit` della
 * route (1..1000): chiedere di più non allarga niente, dà solo l'illusione di
 * un tetto più alto. Il lock
 * `__tests__/architecture/limite-elenco-alunni.test.ts` lo verifica.
 */
export const LIMITE_ELENCO_ALUNNI = 1000

/**
 * Header con cui `GET /api/admin/students` dichiara il totale REALE (count
 * esatto), indipendente da quante righe stanno nella pagina. È l'unico modo per
 * cui un chiamante possa accorgersi di essere stato troncato.
 */
export const HEADER_TOTALE = 'X-Total-Count'

/**
 * `GET /api/admin/iscrizioni` — pagina di default.
 *
 * 50 e non 1000: la lista dei moduli ricevuti pesava 493 kB misurati su 299
 * domande vere, perché portava con sé il `data` INTERO di ogni domanda. Oggi
 * l'elenco non porta più il payload (vedi la route), ma il tetto resta: 299
 * righe sono già più di quante ne legga un operatore in una schermata.
 */
export const LIMITE_ISCRIZIONI_DEFAULT = 50

/** `GET /api/admin/iscrizioni` — massimo richiedibile con `?limit=`. */
export const LIMITE_ISCRIZIONI_MAX = 200
