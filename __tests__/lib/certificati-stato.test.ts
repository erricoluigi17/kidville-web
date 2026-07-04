import { describe, it, expect } from 'vitest'
import { periodoValido, isEsitoValidazione } from '@/lib/certificati/stato'

describe('periodoValido', () => {
  it('vero con inizio <= fine', () => {
    expect(periodoValido({ data_inizio: '2026-03-01', data_fine: '2026-03-05' })).toBe(true)
    expect(periodoValido({ data_inizio: '2026-03-05', data_fine: '2026-03-05' })).toBe(true)
  })
  it('falso se inizio > fine', () => {
    expect(periodoValido({ data_inizio: '2026-03-06', data_fine: '2026-03-05' })).toBe(false)
  })
  it('falso se manca una data', () => {
    expect(periodoValido({ data_inizio: '2026-03-01' })).toBe(false)
    expect(periodoValido({ data_fine: '2026-03-01' })).toBe(false)
    expect(periodoValido({})).toBe(false)
  })
})

describe('isEsitoValidazione', () => {
  it('accetta solo validato/rifiutato', () => {
    expect(isEsitoValidazione('validato')).toBe(true)
    expect(isEsitoValidazione('rifiutato')).toBe(true)
    expect(isEsitoValidazione('in_validazione')).toBe(false)
    expect(isEsitoValidazione('boh')).toBe(false)
  })
})
