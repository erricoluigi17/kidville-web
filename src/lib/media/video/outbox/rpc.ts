/**
 * I pezzi minimi che le RPC del gruppo video si scambiano con chi le chiama: il codice di
 * un errore PostgREST, il riconoscimento di «questo schema qui non c'è», la forma di una
 * risposta `{ ok, code, … }`.
 *
 * Stavano dentro la route della retention. Stanno qui perché li usano anche il consumo
 * dell'outbox e i suoi destinatari, e due copie dello stesso insieme di codici divergono il
 * giorno in cui qualcuno ne corregge una sola: la retention li importa da qui, invece di
 * tenersene una sua.
 */

/**
 * I codici PostgREST che dicono «questo schema qui non c'è».
 *
 * Il database E2E della CI è un progetto separato e **non migrato**, e le migrazioni video
 * sono dichiarate in `IN_CODA`: là dentro `video_jobs` non esiste e le RPC nemmeno. Un `500`
 * racconterebbe un guasto; un `200` racconterebbe «non c'era niente da fare», che è un altro
 * fatto. Si dichiara e si esce con un `503` (la retention) o con un esito `schema-assente`
 * (il consumo dell'outbox).
 */
export const CODICI_SCHEMA_ASSENTE = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])

export function codiceDi(errore: unknown): string {
  const c = (errore as { code?: unknown } | null)?.code
  return typeof c === 'string' && c.length > 0 ? c : 'sconosciuto'
}

export function schemaAssente(errore: unknown): boolean {
  return CODICI_SCHEMA_ASSENTE.has(codiceDi(errore))
}

/** Il risultato di una RPC del gruppo video: `{ ok }` più i suoi conteggi. */
export type EsitoRpc = { ok?: boolean; code?: string } & Record<string, unknown>
