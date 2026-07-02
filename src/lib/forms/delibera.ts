/**
 * Delibera ammissioni (DL-025) — funzione PURA.
 *
 * Dato l'elenco dei candidati con punteggio, assegna l'esito in base a:
 *  - soglia di superamento (sotto soglia → non ammesso),
 *  - posti disponibili (i top entro i posti e sopra soglia → ammessi; gli altri
 *    sopra soglia → lista d'attesa).
 * L'ordinamento per punteggio (desc) è applicato internamente (stabile).
 */
export type EsitoAmmissione = 'ammesso' | 'lista_attesa' | 'non_ammesso'

export interface CandidatoDelibera {
  id: string
  score: number
}

export interface OpzioniDelibera {
  soglia: number
  posti: number
}

export function calcolaDelibera(
  candidati: CandidatoDelibera[],
  opts: OpzioniDelibera
): { id: string; esito: EsitoAmmissione }[] {
  // sort stabile per score desc (preserva l'ordine d'ingresso a parità)
  const ordinati = candidati
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map((x) => x.c)

  let ammessi = 0
  return ordinati.map((c) => {
    let esito: EsitoAmmissione
    if (c.score < opts.soglia) {
      esito = 'non_ammesso'
    } else if (ammessi < opts.posti) {
      esito = 'ammesso'
      ammessi++
    } else {
      esito = 'lista_attesa'
    }
    return { id: c.id, esito }
  })
}
