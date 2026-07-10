import { describe, it, expect } from 'vitest'
import { normalizzaAnagraficaSede, parseAnagraficaSede } from '@/lib/scuole/anagrafica'

describe('normalizzaAnagraficaSede', () => {
  it('trim, vuoti → null, cod. mecc. e provincia maiuscoli', () => {
    const n = normalizzaAnagraficaSede({ codice_meccanografico: ' na1e123456 ', provincia: 'na', cap: '  ', telefono: '081 123' })
    expect(n.codice_meccanografico).toBe('NA1E123456')
    expect(n.provincia).toBe('NA')
    expect(n.cap).toBeNull()
    expect(n.telefono).toBe('081 123')
    expect(n.pec).toBeNull()
  })
})

describe('parseAnagraficaSede', () => {
  it('estrae da config JSONB', () => {
    const a = parseAnagraficaSede({ anagrafica: { codice_meccanografico: 'NA1E123456', provincia: 'NA' }, altro: 1 })
    expect(a.codice_meccanografico).toBe('NA1E123456')
    expect(a.provincia).toBe('NA')
  })
  it('config null/malformata → tutti null (mai throw)', () => {
    expect(parseAnagraficaSede(null).codice_meccanografico).toBeNull()
    expect(parseAnagraficaSede({ anagrafica: 'stringa-sbagliata' }).cap).toBeNull()
    expect(parseAnagraficaSede(undefined).pec).toBeNull()
  })
})
