import { describe, it, expect } from 'vitest'
import { annoScolasticoCorrente } from '@/lib/anno-scolastico'

describe('annoScolasticoCorrente — set→lug (ago = nuovo anno)', () => {
  it('luglio → anno in chiusura', () => {
    expect(annoScolasticoCorrente(new Date(2026, 6, 10))).toBe('2025/2026')
    expect(annoScolasticoCorrente(new Date(2026, 6, 31))).toBe('2025/2026')
  })
  it('agosto → nuovo anno', () => {
    expect(annoScolasticoCorrente(new Date(2026, 7, 1))).toBe('2026/2027')
  })
  it('set–dic → nuovo anno', () => {
    expect(annoScolasticoCorrente(new Date(2026, 8, 15))).toBe('2026/2027')
    expect(annoScolasticoCorrente(new Date(2026, 11, 31))).toBe('2026/2027')
  })
  it("gen–giu → anno iniziato l'autunno prima", () => {
    expect(annoScolasticoCorrente(new Date(2027, 0, 1))).toBe('2026/2027')
    expect(annoScolasticoCorrente(new Date(2027, 5, 30))).toBe('2026/2027')
  })
  it('senza argomento usa oggi', () => {
    expect(annoScolasticoCorrente()).toMatch(/^\d{4}\/\d{4}$/)
  })
})
