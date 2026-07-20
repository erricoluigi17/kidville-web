// =============================================================================
// Rilevamento «schema news assente» (DB E2E della CI NON migrato). Copia locale
// del pattern di src/app/api/pagamenti/cassa/categorie/route.ts:16-20: le route
// news degradano a {disponibile:false}/liste vuote invece di rispondere 500
// quando le tabelle/colonne nuove non esistono.
//
//   42P01   → relazione (tabella) inesistente (SELECT)
//   42703   → colonna inesistente (SELECT)
//   PGRST202→ funzione RPC non trovata nello schema cache
//   PGRST204→ colonna non trovata (INSERT/UPDATE)
//   PGRST205→ tabella non trovata nello schema cache
// =============================================================================

export const NEWS_SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])

export function schemaAssente(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code
  return !!code && NEWS_SCHEMA_ASSENTE.has(code)
}
