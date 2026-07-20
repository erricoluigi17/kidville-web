import { describe, it, expect } from 'vitest'
import { zDataYMD } from '@/lib/validation/common'

// =============================================================================
// E1.2 — RC4: zDataYMD deve validare il CALENDARIO, non solo il formato.
//
// Prima del fix, una data sintatticamente valida ma inesistente (es. 2026-02-30)
// superava la regex e arrivava a Postgres (`.gte('data', ...)`), che lanciava
// il codice 22008 → la route rispondeva 500 invece di 400. Il validatore è
// CONDIVISO con attendance/mensa: il fix chiude la falla ovunque.
// =============================================================================

describe('zDataYMD — validità di calendario', () => {
  it('accetta una data reale', () => {
    expect(zDataYMD.safeParse('2026-07-20').success).toBe(true)
  })

  it('accetta il 29 febbraio di un anno bisestile', () => {
    expect(zDataYMD.safeParse('2024-02-29').success).toBe(true)
  })

  it('accetta il primo e l\'ultimo giorno del mese', () => {
    expect(zDataYMD.safeParse('2026-01-01').success).toBe(true)
    expect(zDataYMD.safeParse('2026-12-31').success).toBe(true)
  })

  it('rifiuta il 30 febbraio (giorno inesistente)', () => {
    expect(zDataYMD.safeParse('2026-02-30').success).toBe(false)
  })

  it('rifiuta il 29 febbraio di un anno NON bisestile', () => {
    expect(zDataYMD.safeParse('2026-02-29').success).toBe(false)
  })

  it('rifiuta il mese 13 e il giorno 99', () => {
    expect(zDataYMD.safeParse('2026-13-99').success).toBe(false)
  })

  it('rifiuta il mese 00', () => {
    expect(zDataYMD.safeParse('2026-00-10').success).toBe(false)
  })

  it('rifiuta il giorno 00', () => {
    expect(zDataYMD.safeParse('2026-07-00').success).toBe(false)
  })

  it('rifiuta il 31 aprile (aprile ha 30 giorni)', () => {
    expect(zDataYMD.safeParse('2026-04-31').success).toBe(false)
  })

  it('rifiuta comunque un formato errato (regola preesistente conservata)', () => {
    expect(zDataYMD.safeParse('20-07-2026').success).toBe(false)
    expect(zDataYMD.safeParse('2026/07/20').success).toBe(false)
    expect(zDataYMD.safeParse('').success).toBe(false)
  })
})
