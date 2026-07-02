import { describe, it, expect } from 'vitest'
import { validaNomeScuola, normalizzaScuola } from '@/lib/scuole/validate'

describe('validaNomeScuola', () => {
  it('rifiuta nome vuoto o solo spazi', () => {
    expect(validaNomeScuola('').ok).toBe(false)
    expect(validaNomeScuola('   ').ok).toBe(false)
  })
  it('rifiuta nome troppo lungo (>120)', () => {
    expect(validaNomeScuola('a'.repeat(121)).ok).toBe(false)
  })
  it('accetta un nome valido', () => {
    expect(validaNomeScuola('Kidville Centro').ok).toBe(true)
  })
})

describe('normalizzaScuola', () => {
  it('trimma nome/città/indirizzo', () => {
    expect(normalizzaScuola({ nome: '  Kidville  ', citta: ' Roma ', indirizzo: ' Via X 1 ' }))
      .toEqual({ nome: 'Kidville', citta: 'Roma', indirizzo: 'Via X 1' })
  })
  it('campi opzionali assenti → null', () => {
    expect(normalizzaScuola({ nome: 'Sede 2' })).toEqual({ nome: 'Sede 2', citta: null, indirizzo: null })
  })
})
