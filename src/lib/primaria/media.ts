// =============================================================================
// Media matematica delle valutazioni in itinere (primaria)
// =============================================================================
// Le valutazioni in itinere memorizzano il giudizio sintetico come etichetta
// (es. "Buono"). Per calcolare una media matematica mappiamo l'etichetta sul
// valore_numerico configurato in giudizi_sintetici_scala.
// =============================================================================

export interface ScalaVoce {
  etichetta: string
  valore_numerico: number | null
}

/** Costruisce la mappa etichetta → valore numerico dalla scala configurata. */
export function mappaValori(scala: ScalaVoce[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const v of scala) {
    if (v.valore_numerico !== null && v.valore_numerico !== undefined) {
      m.set(v.etichetta, Number(v.valore_numerico))
    }
  }
  return m
}

/**
 * Calcola la media dei giudizi sintetici dati (etichette), arrotondata a 2
 * decimali. Ignora i giudizi senza valore numerico configurato. Ritorna null se
 * nessun giudizio è mappabile.
 */
export function mediaGiudizi(scala: ScalaVoce[], giudizi: (string | null | undefined)[]): number | null {
  const mappa = mappaValori(scala)
  const valori: number[] = []
  for (const g of giudizi) {
    if (!g) continue
    const v = mappa.get(g)
    if (v !== undefined) valori.push(v)
  }
  if (valori.length === 0) return null
  const media = valori.reduce((a, b) => a + b, 0) / valori.length
  return Math.round(media * 100) / 100
}
