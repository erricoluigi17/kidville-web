import { describe, it, expect } from 'vitest'
import { TITOLO_MAX, titoloPredefinito } from '@/lib/votazioni/tipi'

/** PR 4.1 · 4.1.P — il titolo proposto prende l'anno dall'etichetta, non da una costante. */
describe('titoloPredefinito', () => {
  it('con «2026/27» è la stringa di sempre', () => {
    expect(titoloPredefinito('2026/27')).toBe('Elezione dei rappresentanti dei genitori a.s. 2026/27')
  })

  it('cambia con l’etichetta', () => {
    expect(titoloPredefinito('2025/26')).toBe('Elezione dei rappresentanti dei genitori a.s. 2025/26')
  })

  it('anche il più lungo possibile sta sotto il tetto del titolo', () => {
    expect(titoloPredefinito('2099/00').length).toBeLessThanOrEqual(TITOLO_MAX)
  })
})
