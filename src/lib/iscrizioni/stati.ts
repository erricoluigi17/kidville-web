/**
 * GLI STATI DI UNA DOMANDA D'ISCRIZIONE — `enrollment_submissions.status`.
 *
 * Erano una costante privata di `src/app/api/admin/iscrizioni/route.ts`. Un file di route di
 * Next può esportare solo i nomi che Next conosce (`GET`, `POST`, `maxDuration`…), quindi
 * nessun test e nessun lock poteva leggerla. Dalla sessione 1 della seconda serie di
 * robustezza la stessa lista è anche un CHECK in SQL (`enrollment_submissions_status_ammesso`):
 * `__tests__/architecture/stati-vincolati-in-sql.test.ts` tiene uguali le due copie.
 */
export const STATI_DOMANDA = ['pending', 'approved', 'rejected'] as const

export type StatoDellaDomanda = (typeof STATI_DOMANDA)[number]

/**
 * L'unico stato da cui una domanda si può ancora respingere. Una domanda approvata è già
 * un'anagrafica, con il documento copiato in `alunni`/`parents`. Respingerla la rimetterebbe
 * nel giro di conservazione, che la cancellerebbe con i suoi allegati (D9 del rapporto del
 * 2026-10-20).
 */
export const STATO_DOMANDA_IN_ATTESA: StatoDellaDomanda = 'pending'
