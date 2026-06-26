import { describe, it, expect } from 'vitest'
import { raggruppaPerCategoria } from '@/lib/pagamenti/categorie'

const p = (stato: string, cat?: { nome: string; icona?: string; colore?: string }) => ({
  stato,
  payment_categories: cat ?? null,
})

describe('raggruppaPerCategoria', () => {
  it('raggruppa per nome categoria e splitta da-pagare / pagati', () => {
    const gruppi = raggruppaPerCategoria([
      p('pagato', { nome: 'Rette' }),
      p('da_pagare', { nome: 'Rette' }),
      p('scaduto', { nome: 'Mensa' }),
    ])
    const rette = gruppi.find((g) => g.categoria === 'Rette')!
    expect(rette.pagati.length).toBe(1)
    expect(rette.daPagare.length).toBe(1)
    const mensa = gruppi.find((g) => g.categoria === 'Mensa')!
    expect(mensa.daPagare.length).toBe(1)
    expect(mensa.pagati.length).toBe(0)
  })

  it('i pagamenti senza categoria finiscono nel gruppo "Altro", in coda', () => {
    const gruppi = raggruppaPerCategoria([p('da_pagare'), p('pagato', { nome: 'Rette' })])
    expect(gruppi[gruppi.length - 1].categoria).toBe('Altro')
    expect(gruppi[gruppi.length - 1].daPagare.length).toBe(1)
  })

  it('preserva icona e colore della categoria', () => {
    const gruppi = raggruppaPerCategoria([p('da_pagare', { nome: 'Mensa', icona: '🍽️', colore: '#f90' })])
    expect(gruppi[0].icona).toBe('🍽️')
    expect(gruppi[0].colore).toBe('#f90')
  })

  it('lista vuota → nessun gruppo', () => {
    expect(raggruppaPerCategoria([])).toEqual([])
  })
})
