/**
 * I messaggi di Postgres e PostgREST possono riportare i dati della richiesta.
 * Per i percorsi che trattano dati riservati conserva soltanto un codice tecnico.
 */
export function erroreDbSoloCodice(errore: unknown): { code?: string } {
  if (typeof errore !== 'object' || errore === null || !('code' in errore)) return {}
  const { code } = errore
  if (typeof code !== 'string' || !/^(?:(?:[0-9]{2}|P0|XX|HV|F0)[0-9A-Z]{3}|PGRST[0-9]{3})$/.test(code)) return {}
  return { code }
}
