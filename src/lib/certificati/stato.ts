/**
 * Certificato medico (DL-027) — helper di validazione (puro).
 * Copertura modellata come periodo dal/al; nessun sollecito automatico.
 */
export type StatoCertificato = 'in_validazione' | 'validato' | 'rifiutato'

export interface PeriodoInput {
  data_inizio?: string | null
  data_fine?: string | null
}

/** Periodo valido: entrambe le date presenti e inizio <= fine (ISO yyyy-mm-dd). */
export function periodoValido(p: PeriodoInput): boolean {
  if (!p.data_inizio || !p.data_fine) return false
  return p.data_inizio <= p.data_fine
}

/** Esito ammesso in validazione staff. */
export function isEsitoValidazione(s: unknown): s is 'validato' | 'rifiutato' {
  return s === 'validato' || s === 'rifiutato'
}
