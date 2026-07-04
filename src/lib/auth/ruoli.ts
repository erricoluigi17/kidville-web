/**
 * Ruoli staff assegnabili dalla Direzione (DL-028).
 * Il ruolo `genitore` NON è assegnabile dal pannello Staff (le famiglie sono
 * gestite a parte). Helper puri per validazione + label.
 */
import type { AppRole } from './require-staff'

export const RUOLI_ASSEGNABILI: { value: AppRole; label: string }[] = [
  { value: 'educator', label: 'Docente' },
  { value: 'segreteria', label: 'Segreteria' },
  { value: 'cuoca', label: 'Cuoca' },
  { value: 'coordinator', label: 'Direzione' },
  { value: 'admin', label: 'Amministratore' },
]

export const RUOLI_VALIDI: AppRole[] = RUOLI_ASSEGNABILI.map((r) => r.value)

export function isRuoloAssegnabile(r: unknown): r is AppRole {
  return typeof r === 'string' && (RUOLI_VALIDI as string[]).includes(r)
}

export function labelRuolo(r: string): string {
  return RUOLI_ASSEGNABILI.find((x) => x.value === r)?.label ?? r
}
