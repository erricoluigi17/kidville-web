import { logEvento } from '@/lib/logging/logger'

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

/**
 * IL RIPIEGO A STADI, UNA REGOLA SOLA.
 *
 * Quando una colonna nuova manca (la CI E2E non è migrata) la scrittura si ripete SENZA, e lo si dice: stesso evento,
 * stessi campi, in ogni route. Lo `stadio` è il numero del ripiego e finisce nel log come `tentativo`:
 *  · 1 = senza `periodo_id` (la colonna più recente);
 *  · 2 = senza anche la colonna più vecchia (`tipo`, o `data_evento` per un voto di oggi).
 * La prossima colonna nuova si aggiunge qui come stadio, non in N route.
 */
export function logSchemaIndietro(operazione: string, error: unknown, stadio: number): void {
  logEvento('registro', 'info', { operazione, esito: 'colonne-nuove-non-disponibili-schema', tentativo: stadio }, error)
}

export interface RipiegoSchema<R> {
  /** Il numero del ripiego: è il `tentativo` del log, e ciò che `scriviConRipiegoSchema` restituisce se è l'ultimo tentato. */
  stadio: number
  /** La scrittura con i campi di questo stadio. Se non resta niente da scrivere restituisce `null` e la catena si ferma. */
  scrivi: () => PromiseLike<R>
}

/**
 * Prova la scrittura intera; se torna un errore di schema (`colonnaNuovaAssente`) passa al primo ripiego, e se anche quello
 * torna un errore di schema al successivo, in ordine. Ogni ripiego è loggato PRIMA di essere tentato. Un errore che NON è di
 * schema non ripiega: torna così com'è, e decide il chiamante.
 *
 * Restituisce l'esito dell'ULTIMA scrittura tentata e lo `stadio` in cui si è fermata: 0 = la scrittura intera, altrimenti lo
 * `stadio` del ripiego. Se `esito.error` è null, è lo stadio che è riuscito, e dice al chiamante quali colonne sono state
 * scritte davvero (con `stadio > 0` `periodo_id` NON c'è). Mai solleva per conto suo: le eccezioni sono quelle delle scritture.
 * `esito` è `null` solo se un ripiego dichiara di non avere più niente da scrivere.
 */
export async function scriviConRipiegoSchema<R extends { error: { code?: string } | null } | null>(
  operazione: string,
  prima: () => PromiseLike<R>,
  ripieghi: ReadonlyArray<RipiegoSchema<R>> = [],
): Promise<{ esito: R; stadio: number }> {
  let esito = await prima()
  let stadio = 0
  for (const ripiego of ripieghi) {
    if (!esito?.error || !colonnaNuovaAssente(esito.error)) break
    logSchemaIndietro(operazione, esito.error, ripiego.stadio)
    esito = await ripiego.scrivi()
    stadio = ripiego.stadio
  }
  return { esito, stadio }
}
