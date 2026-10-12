import { describe, it, expect } from 'vitest'
import { lunediDi, piuGiorni, giorniDellaSettimana } from '@/lib/mensa/settimana'

describe('settimana mensa — date AAAA-MM-GG senza fuso', () => {
  it('il lunedì di un lunedì è sé stesso', () => {
    expect(lunediDi('2026-10-12')).toBe('2026-10-12')
  })
  it('il lunedì di un mercoledì e di una domenica è il 12', () => {
    expect(lunediDi('2026-10-14')).toBe('2026-10-12')
    expect(lunediDi('2026-10-18')).toBe('2026-10-12')
  })
  it('regge la domenica del cambio d’ora (25/10/2026)', () => {
    expect(lunediDi('2026-10-25')).toBe('2026-10-19')
    expect(piuGiorni('2026-10-24', 2)).toBe('2026-10-26')
  })
  it('regge il cambio d’anno', () => {
    expect(lunediDi('2027-01-01')).toBe('2026-12-28')
    expect(giorniDellaSettimana('2026-12-28')).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
    ])
  })
  it('piuGiorni va anche indietro', () => {
    expect(piuGiorni('2026-10-12', -7)).toBe('2026-10-05')
  })
})
