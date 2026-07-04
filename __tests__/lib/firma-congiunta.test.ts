import { describe, it, expect } from 'vitest'
import { firmatariRichiesti, firmaCompleta, prossimoSlot } from '@/lib/fea/firma-congiunta'

describe('firmatariRichiesti', () => {
  it('single → 1, joint → 2', () => {
    expect(firmatariRichiesti('single')).toBe(1)
    expect(firmatariRichiesti('joint')).toBe(2)
    expect(firmatariRichiesti(undefined)).toBe(1)
  })
})

describe('firmaCompleta', () => {
  it('single completa dopo 1 firma', () => {
    expect(firmaCompleta('single', 0)).toBe(false)
    expect(firmaCompleta('single', 1)).toBe(true)
  })
  it('joint completa solo dopo 2 firme', () => {
    expect(firmaCompleta('joint', 1)).toBe(false)
    expect(firmaCompleta('joint', 2)).toBe(true)
  })
})

describe('prossimoSlot', () => {
  it('indice del prossimo slot = numero di slot già firmati', () => {
    expect(prossimoSlot(0)).toBe(0)
    expect(prossimoSlot(1)).toBe(1)
  })
})
