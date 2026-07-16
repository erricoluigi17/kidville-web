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

/**
 * Valutazione minimale ai fini del calcolo della media: interessa solo la
 * modalità e l'etichetta del giudizio sintetico. Strutturale, così accetta anche
 * le righe più ricche restituite dalle query (id, tipo, obiettivi, ecc.).
 */
export interface ValutazioneGiudizio {
  modalita?: string | null
  giudizio_sintetico?: string | null
}

/**
 * Estrae le etichette dei giudizi dalle sole valutazioni con modalità
 * 'sintetico' e giudizio_sintetico valorizzato. Rispecchia esattamente il filtro
 * applicato dalla panoramica lato query
 * (`.eq('modalita','sintetico').not('giudizio_sintetico','is',null)`): così la
 * media per singola materia e la media in panoramica insistono sullo stesso
 * insieme di dati e non divergono. Funzione pura, senza effetti collaterali.
 */
export function giudiziSintetici<T extends ValutazioneGiudizio>(valutazioni: readonly T[]): string[] {
  const out: string[] = []
  for (const v of valutazioni) {
    if (v.modalita === 'sintetico' && v.giudizio_sintetico != null && v.giudizio_sintetico !== '') {
      out.push(v.giudizio_sintetico)
    }
  }
  return out
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
