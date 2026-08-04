/**
 * TOLLERANZA D'AMBIENTE — «questa TABELLA non c'è», e nient'altro.
 *
 * ─── Il difetto che questo modulo chiude ────────────────────────────────────
 * La stessa funzione `tabellaMancante` era scritta TRE volte, identica, in tre
 * route diverse (`notifiche/promemoria`, `mensa/alternative`, `locker/requests`).
 * Tutte e tre decidevano così:
 *
 *     error.code === '42P01' || /does not exist|schema cache|could not find/i.test(message)
 *
 * Quel regex non guarda il codice: guarda la PROSA. E dentro «does not exist» ci
 * cade anche `42703 "column … does not exist"`, che non è affatto un ambiente non
 * migrato — è una TABELLA CHE C'È a cui manca una colonna, cioè una migrazione
 * applicata a metà su un database vivo. Un guasto vero, assorbito in silenzio
 * perché due errori diversi condividono tre parole di messaggio.
 *
 * In `locker/requests` la conseguenza era la più diretta di tutte: la tolleranza
 * lì fa ritornare un ELENCO VUOTO. Una colonna mancante diventava «nessuna
 * richiesta armadietto», un genitore vedeva zero righe e nessuno — né lui né la
 * segreteria né i log — poteva sapere perché.
 *
 * ─── La regola ──────────────────────────────────────────────────────────────
 * La discriminante è il CODICE, non il messaggio. Due soli, per nome:
 *
 *   · `42P01`     — Postgres: «relation does not exist».
 *   · `PGRST205`  — PostgREST: «Could not find the table … in the schema cache».
 *
 * Tutto il resto — `42703` (colonna assente in SELECT), `PGRST204` (colonna
 * assente in INSERT/UPDATE), `PGRST200` (relazione fra tabelle non riconosciuta),
 * `PGRST202` (RPC non trovata) — NON è tolleranza d'ambiente: è schema a metà, e
 * deve arrivare al chiamante e ai log come il guasto che è.
 *
 * ─── Perché vive in un posto solo ───────────────────────────────────────────
 * È la lezione già pagata da questo repo, e con queste parole: «una regola valida
 * per due strade deve vivere in un posto solo». La correzione del 2026-08-03 su
 * `notifiche/promemoria` lasciò indietro le altre due copie proprio perché erano
 * copie. Il lock `__tests__/architecture/tolleranza-schema-un-posto-solo.test.ts`
 * impedisce alla quarta di nascere.
 *
 * ⚠️ NON è un giudizio sull'ambiente. «Tabella assente» significa «ambiente non
 * migrato» solo sul DB E2E della CI (progetto separato, mai migrato). In
 * PRODUZIONE la stessa condizione significa FUNZIONALITÀ MORTA — ed è misurato:
 * `locker_requests` e `daily_routines` non esistono nel database di produzione e
 * nessuna migrazione le crea. Chi tollera qui deve comunque DIRLO (un log, un
 * campo nella risposta), mai limitarsi a restituire una lista vuota: «zero righe»
 * e «non ho guardato» si leggono uguali e significano l'opposto.
 */

/** I due soli codici che dicono «la TABELLA non esiste». */
export const CODICI_TABELLA_ASSENTE: ReadonlySet<string> = new Set(['42P01', 'PGRST205'])

/**
 * `true` solo se l'errore dice che la TABELLA non esiste.
 *
 * Il messaggio non viene guardato: è testo umano di due prodotti diversi, cambia
 * fra versioni, e leggerlo è esattamente ciò che faceva inghiottire il `42703`.
 */
export function tabellaMancante(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  return CODICI_TABELLA_ASSENTE.has(error.code ?? '')
}
