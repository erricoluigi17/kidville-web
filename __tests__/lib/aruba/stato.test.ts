import { describe, it, expect } from 'vitest'
import { mapStatoAruba } from '@/lib/aruba/stato'

describe('mapStatoAruba', () => {
  it('stati in-flight (1 presa in carico, 3 inviata, 5 non consegnata) → in_attesa, non terminale', () => {
    for (const code of [1, 3, 5]) {
      const r = mapStatoAruba(code)
      expect(r.fatturaStato).toBe('in_attesa')
      expect(r.isTerminal).toBe(false)
      expect(r.isScarto).toBe(false)
    }
  })

  it('stati validi a SDI (6 recapito impossibile, 7 consegnata, 8 accettata, 10 decorrenza) → emessa, terminale', () => {
    for (const code of [6, 7, 8, 10]) {
      const r = mapStatoAruba(code)
      expect(r.fatturaStato).toBe('emessa')
      expect(r.isTerminal).toBe(true)
      expect(r.isScarto).toBe(false)
    }
  })

  it('scarti/rifiuti (2 errore elaborazione, 4 scartata SDI, 9 rifiutata) → scartata, terminale, isScarto', () => {
    for (const code of [2, 4, 9]) {
      const r = mapStatoAruba(code)
      expect(r.fatturaStato).toBe('scartata')
      expect(r.isTerminal).toBe(true)
      expect(r.isScarto).toBe(true)
    }
  })

  it('espone una label leggibile per ogni stato noto', () => {
    expect(mapStatoAruba(4).label).toMatch(/scart/i)
    expect(mapStatoAruba(7).label).toMatch(/consegn/i)
  })

  it('codice sconosciuto → in_attesa difensivo, non terminale, non scarto', () => {
    const r = mapStatoAruba(999)
    expect(r.fatturaStato).toBe('in_attesa')
    expect(r.isTerminal).toBe(false)
    expect(r.isScarto).toBe(false)
    expect(r.label).toMatch(/sconosciuto|ignoto/i)
  })
})
