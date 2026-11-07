/**
 * `schemaAnnoIndietro` — «questo database non ha ancora lo schema dell'anno».
 *
 * Succede sul database della CI (le migrazioni dell'anno arrivano dopo il codice) e nella
 * finestra del deploy. I codici sono quelli di «oggetto assente» di PostgREST e Postgres:
 * tabella (`PGRST205`, `42P01`), colonna (`PGRST204`, `42703`), funzione (`PGRST202`, `42883`).
 * Un doppione (`23505`) o un'eccezione del trigger (`P0001`) NON sono schema indietro: il
 * database c'è, e ha detto di no.
 */
const SCHEMA_INDIETRO = new Set(['PGRST204', 'PGRST205', 'PGRST202', '42P01', '42703', '42883'])

export function schemaAnnoIndietro(
  error: { code?: string | null } | null | undefined,
): boolean {
  const code = error?.code
  return typeof code === 'string' && SCHEMA_INDIETRO.has(code)
}
