// Firma congiunta dei moduli (DL-031). Helper puri sopra gli slot FEA (DL-007).

export type SignatureMode = 'single' | 'joint'

/** Numero di firmatari richiesti dalla modalità del modello. */
export function firmatariRichiesti(mode: SignatureMode | string | null | undefined): number {
  return mode === 'joint' ? 2 : 1
}

/** True se le firme raccolte soddisfano la modalità (completamento). */
export function firmaCompleta(
  mode: SignatureMode | string | null | undefined,
  slotFirmati: number
): boolean {
  return slotFirmati >= firmatariRichiesti(mode)
}

/** Indice del prossimo slot da firmare = numero di slot già firmati. */
export function prossimoSlot(slotFirmati: number): number {
  return slotFirmati
}
