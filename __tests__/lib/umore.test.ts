import { describe, it, expect } from 'vitest'
import {
  UMORE_VALUES,
  UMORE_CONFIG,
  isUmoreValue,
  umoreFromDettagli,
  umoreAttivo,
  umoreNarrative,
} from '@/lib/diary/umore'

// M5.4: mappa condivisa teacher/parent per l'evento diario 'umore'.

describe('umore — mappa condivisa', () => {
  it('espone esattamente 5 valori, ognuno con label ed emoji', () => {
    expect(UMORE_VALUES).toHaveLength(5)
    for (const v of UMORE_VALUES) {
      expect(UMORE_CONFIG[v].label.length).toBeGreaterThan(0)
      expect(UMORE_CONFIG[v].emoji.length).toBeGreaterThan(0)
    }
  })

  it('isUmoreValue accetta solo i 5 valori', () => {
    for (const v of UMORE_VALUES) expect(isUmoreValue(v)).toBe(true)
    expect(isUmoreValue('arrabbiato')).toBe(false)
    expect(isUmoreValue('')).toBe(false)
    expect(isUmoreValue(null)).toBe(false)
    expect(isUmoreValue(3)).toBe(false)
  })

  it('umoreFromDettagli estrae il valore da dettagli JSONB', () => {
    expect(umoreFromDettagli({ umore: 'felice' })).toBe('felice')
    expect(umoreFromDettagli({ umore: 'boh' })).toBeNull()
    expect(umoreFromDettagli({ umore: null })).toBeNull()
    expect(umoreFromDettagli({})).toBeNull()
    expect(umoreFromDettagli(null)).toBeNull()
    expect(umoreFromDettagli(undefined)).toBeNull()
  })

  it('umoreAttivo è fail-closed su input non validi', () => {
    expect(umoreAttivo(['pasto', 'umore'])).toBe(true)
    expect(umoreAttivo(['pasto', 'sonno'])).toBe(false)
    expect(umoreAttivo([])).toBe(false)
    expect(umoreAttivo(undefined)).toBe(false)
    expect(umoreAttivo(null)).toBe(false)
    expect(umoreAttivo('umore')).toBe(false)
  })

  it('umoreNarrative ha una frase per ogni valore', () => {
    for (const v of UMORE_VALUES) {
      expect(umoreNarrative(v).length).toBeGreaterThan(5)
    }
  })
})
