import { describe, it, expect } from 'vitest'
import { calcolaAttestazione } from '@/lib/pagamenti/attestazione'
import { metodoTracciabile } from '@/lib/pagamenti/fiscale'

describe('metodoTracciabile', () => {
  it('bonifico/pos/assegno sì; contanti/altro/assente no', () => {
    expect(metodoTracciabile('bonifico')).toBe(true)
    expect(metodoTracciabile('pos')).toBe(true)
    expect(metodoTracciabile('contanti')).toBe(false)
    expect(metodoTracciabile('altro')).toBe(false)
    expect(metodoTracciabile(null)).toBe(false)
  })
})

describe('calcolaAttestazione', () => {
  const voci = [
    { importo: 150, metodo: 'bonifico', categoria_slug: 'retta', descrizione: 'Retta Gennaio' },
    { importo: 150, metodo: 'bonifico', categoria_slug: 'retta', descrizione: 'Retta Febbraio' },
    { importo: 50, metodo: 'contanti', categoria_slug: 'gita', descrizione: 'Gita zoo' },
    { importo: 30, metodo: 'pos', categoria_slug: 'divisa', descrizione: 'Divise: polo' },
    { importo: -150, metodo: 'bonifico', categoria_slug: 'retta', descrizione: 'Retta Febbraio' }, // storno
  ]

  it('somma versato, detraibile (tracciabile+categoria ammessa), non tracciabile ed escluso', () => {
    const r = calcolaAttestazione(voci)
    expect(r.versato).toBe(230) // 150+150+50+30-150
    expect(r.detraibile).toBe(150) // rette nette (300-150), gita contanti fuori, divisa esclusa
    expect(r.nonTracciabile).toBe(50)
    expect(r.escluso).toBe(30)
  })

  it('raggruppa le righe per descrizione con totale netto', () => {
    const r = calcolaAttestazione(voci)
    const feb = r.righe.find((x) => x.descrizione === 'Retta Febbraio')
    expect(feb?.importo).toBe(0)
    expect(r.righe.find((x) => x.descrizione === 'Retta Gennaio')?.importo).toBe(150)
  })

  it('vuoto → tutto a zero', () => {
    const r = calcolaAttestazione([])
    expect(r.versato).toBe(0)
    expect(r.detraibile).toBe(0)
    expect(r.righe).toHaveLength(0)
  })
})
