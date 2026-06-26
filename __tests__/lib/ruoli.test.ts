import { describe, it, expect } from 'vitest'
import { RUOLI_ASSEGNABILI, RUOLI_VALIDI, isRuoloAssegnabile, labelRuolo } from '@/lib/auth/ruoli'

describe('ruoli assegnabili (RBAC staff)', () => {
  it('include i ruoli staff e NON include il genitore', () => {
    expect(RUOLI_VALIDI).toContain('educator')
    expect(RUOLI_VALIDI).toContain('segreteria')
    expect(RUOLI_VALIDI).toContain('cuoca')
    expect(RUOLI_VALIDI).toContain('coordinator')
    expect(RUOLI_VALIDI).toContain('admin')
    expect(RUOLI_VALIDI).not.toContain('genitore')
  })

  it('isRuoloAssegnabile accetta solo i ruoli staff', () => {
    expect(isRuoloAssegnabile('educator')).toBe(true)
    expect(isRuoloAssegnabile('genitore')).toBe(false)
    expect(isRuoloAssegnabile('boh')).toBe(false)
    expect(isRuoloAssegnabile(null)).toBe(false)
  })

  it('ogni ruolo assegnabile ha una label leggibile', () => {
    expect(RUOLI_ASSEGNABILI.every((r) => r.label.length > 0)).toBe(true)
    expect(labelRuolo('educator')).toBe('Docente')
    expect(labelRuolo('genitore')).toBe('genitore') // fallback al valore grezzo
  })
})
