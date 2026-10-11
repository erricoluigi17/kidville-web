/**
 * UNA COLONNA NUOVA CHE QUESTO DATABASE NON HA ANCORA.
 *
 * Il DB E2E della CI non è migrato: le colonne aggiunte da una migrazione recente lì non
 * esistono, e il codice deve degradare invece di fermarsi. PostgREST lo dice con due codici:
 *  · `42703` — colonna inesistente in una SELECT o in un filtro (`.lt('col', …)`);
 *  · `PGRST204` — colonna sconosciuta allo schema cache in un INSERT o in un UPDATE.
 *
 * Si guarda il CODICE, mai il messaggio: il testo cambia fra lettura e scrittura e fra versioni
 * di PostgREST. In produzione la colonna c'è: chi degrada su questo riconoscitore lo DICE con una
 * riga di log, perché una degradazione muta nasconderebbe una migrazione mai applicata.
 */
export function colonnaNuovaAssente(error: { code?: string } | null | undefined): boolean {
  const codice = error?.code
  return codice === '42703' || codice === 'PGRST204'
}
