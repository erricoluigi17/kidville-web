import { describe, it, expect } from 'vitest'
import {
  isTracciabile,
  bolloDovuto,
  datiStruttura,
  CATEGORIE_ESCLUSE_ADE,
  BOLLO_SOGLIA_DEFAULT,
} from '@/lib/pagamenti/fiscale'

describe('isTracciabile', () => {
  it('vero solo se tutti gli incassi sono con metodo tracciabile', () => {
    expect(isTracciabile(['bonifico', 'pos'])).toBe(true)
    expect(isTracciabile(['assegno'])).toBe(true)
    expect(isTracciabile(['bonifico', 'contanti'])).toBe(false)
    expect(isTracciabile(['contanti'])).toBe(false)
  })
  it('falso senza incassi o con metodo ignoto/mancante', () => {
    expect(isTracciabile([])).toBe(false)
    expect(isTracciabile([undefined])).toBe(false)
  })
})

describe('bolloDovuto', () => {
  it('€2 sopra la soglia 77,47 quando abilitato', () => {
    expect(bolloDovuto(100, { bollo_enabled: true })).toBe(2)
    expect(bolloDovuto(77.48, { bollo_enabled: true })).toBe(2)
  })
  it('0 sotto/alla soglia, se disabilitato o config assente', () => {
    expect(bolloDovuto(77.47, { bollo_enabled: true })).toBe(0)
    expect(bolloDovuto(50, { bollo_enabled: true })).toBe(0)
    expect(bolloDovuto(100, { bollo_enabled: false })).toBe(0)
    expect(bolloDovuto(100, null)).toBe(0)
  })
  it('soglia e importo personalizzabili', () => {
    expect(bolloDovuto(60, { bollo_enabled: true, bollo_soglia: 50, bollo_importo: 2.5 })).toBe(2.5)
    expect(BOLLO_SOGLIA_DEFAULT).toBe(77.47)
  })
})

describe('datiStruttura', () => {
  it('usa fiscale_config e ricade su aruba_config.fiscal per i campi mancanti', () => {
    const d = datiStruttura(
      { denominazione: 'Kidville Giugliano' },
      { fiscal: { piva: '01234567890', ragione_sociale: 'Kidville Srl' } }
    )
    expect(d.denominazione).toBe('Kidville Giugliano')
    expect(d.piva).toBe('01234567890')
  })
  it('senza nulla ritorna campi vuoti (mai undefined che rompe i PDF)', () => {
    const d = datiStruttura(null, null)
    expect(d.denominazione).toBe('')
    expect(d.piva).toBe('')
  })
})

describe('CATEGORIE_ESCLUSE_ADE', () => {
  it('esclude merchandise e materiale (non sono spese di istruzione)', () => {
    expect(CATEGORIE_ESCLUSE_ADE).toContain('divisa')
    expect(CATEGORIE_ESCLUSE_ADE).toContain('materiale')
  })
})
