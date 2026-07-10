import { describe, it, expect } from 'vitest'
import { isoToIt, itToIso, maskItDate } from '@/lib/format/data'

describe('format/data — gg/mm/aaaa ↔ ISO', () => {
  it('isoToIt converte ISO in formato italiano', () => {
    expect(isoToIt('2020-03-07')).toBe('07/03/2020')
    expect(isoToIt('')).toBe('')
    expect(isoToIt('non-una-data')).toBe('')
  })

  it('itToIso converte e valida il calendario', () => {
    expect(itToIso('07/03/2020')).toBe('2020-03-07')
    expect(itToIso('31/12/1999')).toBe('1999-12-31')
    expect(itToIso('29/02/2020')).toBe('2020-02-29') // bisestile
    expect(itToIso('31/02/2021')).toBeNull() // febbraio non ha 31
    expect(itToIso('00/01/2020')).toBeNull()
    expect(itToIso('13/13/2020')).toBeNull()
    expect(itToIso('7/3/2020')).toBeNull() // formato incompleto
    expect(itToIso('')).toBeNull()
  })

  it('maskItDate applica la maschera mentre si digita', () => {
    expect(maskItDate('07032020')).toBe('07/03/2020')
    expect(maskItDate('0703')).toBe('07/03')
    expect(maskItDate('07')).toBe('07')
    expect(maskItDate('07/03/2020extra')).toBe('07/03/2020')
    expect(maskItDate('abc07def03')).toBe('07/03')
  })
})
