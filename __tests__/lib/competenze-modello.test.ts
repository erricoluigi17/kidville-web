import { describe, it, expect } from 'vitest'
import {
  COMPETENZE_CHIAVE,
  LIVELLI,
  COMPETENZE_SIGNIFICATIVE_CODICE,
  livelloEtichetta,
  competenzaEtichetta,
} from '@/lib/competenze/modello'

// Modello statutario del Certificato delle Competenze (D.M. 14/2024, fine
// primaria): 8 competenze chiave europee + scala a 4 livelli A/B/C/D.

describe('COMPETENZE_CHIAVE', () => {
  it('elenca esattamente le 8 competenze chiave europee in ordine canonico', () => {
    expect(COMPETENZE_CHIAVE).toHaveLength(8)
    expect(COMPETENZE_CHIAVE[0].codice).toBe('comunicazione_alfabetica_funzionale')
    expect(COMPETENZE_CHIAVE[7].codice).toBe('consapevolezza_espressione_culturali')
    // ogni voce ha etichetta non vuota
    for (const c of COMPETENZE_CHIAVE) {
      expect(c.etichetta.length).toBeGreaterThan(0)
    }
  })

  it('la riga free-text non rientra fra le 8 competenze valutate', () => {
    expect(COMPETENZE_CHIAVE.some((c) => c.codice === COMPETENZE_SIGNIFICATIVE_CODICE)).toBe(false)
  })
})

describe('LIVELLI', () => {
  it('definisce i 4 livelli A/B/C/D con le etichette del certificato', () => {
    expect(LIVELLI.map((l) => l.codice)).toEqual(['A', 'B', 'C', 'D'])
    expect(livelloEtichetta('A')).toBe('Avanzato')
    expect(livelloEtichetta('B')).toBe('Intermedio')
    expect(livelloEtichetta('C')).toBe('Base')
    // il 4° livello del CERTIFICATO è "Iniziale" (≠ scala pagella "In via di prima acquisizione")
    expect(livelloEtichetta('D')).toBe('Iniziale')
  })

  it('ogni livello porta il descrittore canonico', () => {
    for (const l of LIVELLI) expect(l.descrittore.length).toBeGreaterThan(10)
  })
})

describe('lookup helpers', () => {
  it('livelloEtichetta su codice ignoto torna un fallback neutro', () => {
    expect(livelloEtichetta(null)).toBe('—')
    expect(livelloEtichetta('Z')).toBe('—')
  })

  it('competenzaEtichetta risolve un codice noto e fa fallback sul codice ignoto', () => {
    expect(competenzaEtichetta('competenza_digitale')).toMatch(/digitale/i)
    expect(competenzaEtichetta('xyz')).toBe('xyz')
  })
})
