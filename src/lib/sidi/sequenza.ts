/**
 * Guardie di sequenza dei flussi SIDI (P5.3). Il PRD impone l'ordine
 * **Fase A → frequentanti → Piattaforma Unica**: i frequentanti si inviano solo
 * dopo l'allineamento strutturale, e le associazioni genitori-alunni solo dopo i
 * frequentanti. Funzioni pure, usate dagli endpoint per bloccare gli ordini fuori
 * sequenza (409) e dall'UI per abilitare i pulsanti in cascata.
 */

import type { SidiFlusso } from './client'

export type FaseStato = 'non_inviato' | 'in_corso' | 'inviato' | 'errore'

export function puoInviareFrequentanti(faseA: FaseStato): boolean {
  return faseA === 'inviato'
}

export function puoInviarePiattaformaUnica(frequentanti: FaseStato): boolean {
  return frequentanti === 'inviato'
}

/** Prossimo flusso inviabile data la situazione corrente, o null se completato. */
export function prossimaFase(state: { fase_a_stato: FaseStato; frequentanti_stato: FaseStato }): SidiFlusso | null {
  if (state.fase_a_stato !== 'inviato') return 'fase_a'
  if (state.frequentanti_stato !== 'inviato') return 'frequentanti'
  return 'piattaforma_unica'
}
