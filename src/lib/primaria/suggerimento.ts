// =============================================================================
// Suggerimento del giudizio sintetico dall'annotazione numerica privata
// =============================================================================
// Strumento di SUPPORTO al docente: dato l'appunto numerico (scala /10) di una
// verifica in itinere, propone il giudizio sintetico con il valore_numerico più
// vicino. È SOLO un suggerimento da confermare: non genera il giudizio ufficiale,
// non calcola medie e non scrive nulla in autonomia (PRD §4: «il sistema può al
// massimo SUGGERIRE un giudizio, ma il docente deve confermarlo»).
// =============================================================================
import { mappaValori, type ScalaVoce } from './media'

/**
 * Suggerisce l'etichetta del giudizio sintetico più vicino al numero dato.
 * In caso di pari distanza preferisce il giudizio con valore più ALTO (beneficio
 * del dubbio). Ritorna null se la scala non ha valori numerici o il numero non è
 * valido.
 */
export function suggerisciGiudizio(
  scala: ScalaVoce[],
  numero: number | null | undefined
): string | null {
  if (numero === null || numero === undefined || Number.isNaN(numero)) return null
  const mappa = mappaValori(scala) // etichetta -> valore_numerico
  if (mappa.size === 0) return null

  let best: string | null = null
  let bestDist = Infinity
  let bestValore = -Infinity
  for (const [etichetta, valore] of mappa) {
    const dist = Math.abs(valore - numero)
    if (dist < bestDist || (dist === bestDist && valore > bestValore)) {
      best = etichetta
      bestDist = dist
      bestValore = valore
    }
  }
  return best
}
