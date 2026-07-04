import { describe, it, expect } from 'vitest'
import { COMPETENZA_MATERIE, suggerisciLivello } from '@/lib/competenze/livello-mapping'

// Precompilazione euristica del livello di competenza dai giudizi sintetici di
// scrutinio (scala pagella O.M.172/2020 → scala certificato A/B/C/D).
// È un SUGGERIMENTO sovrascrivibile dallo staff, non un automatismo legale.

describe('COMPETENZA_MATERIE', () => {
  it('mappa la comunicazione alfabetica funzionale su italiano', () => {
    expect(COMPETENZA_MATERIE['comunicazione_alfabetica_funzionale']).toContain('italiano')
  })
})

describe('suggerisciLivello', () => {
  it('converte un singolo giudizio "Avanzato" su materia mappata in livello A', () => {
    const out = suggerisciLivello('comunicazione_alfabetica_funzionale', [
      { materia_codice: 'italiano', giudizio_sintetico: 'Avanzato' },
    ])
    expect(out).toBe('A')
  })

  it('mappa "In via di prima acquisizione" sul livello D (Iniziale)', () => {
    const out = suggerisciLivello('comunicazione_multilinguistica', [
      { materia_codice: 'inglese', giudizio_sintetico: 'In via di prima acquisizione' },
    ])
    expect(out).toBe('D')
  })

  it('su più materie media i livelli (Avanzato+Base → Intermedio)', () => {
    const out = suggerisciLivello('competenza_matematica_scienze_tecnologia', [
      { materia_codice: 'matematica', giudizio_sintetico: 'Avanzato' },
      { materia_codice: 'scienze', giudizio_sintetico: 'Base' },
    ])
    expect(out).toBe('B')
  })

  it('ignora i giudizi su materie non pertinenti alla competenza', () => {
    const out = suggerisciLivello('comunicazione_alfabetica_funzionale', [
      { materia_codice: 'matematica', giudizio_sintetico: 'Avanzato' },
    ])
    expect(out).toBeNull()
  })

  it('torna null senza giudizi riconoscibili', () => {
    expect(suggerisciLivello('comunicazione_alfabetica_funzionale', [])).toBeNull()
    expect(
      suggerisciLivello('comunicazione_alfabetica_funzionale', [
        { materia_codice: 'italiano', giudizio_sintetico: 'boh' },
      ])
    ).toBeNull()
  })
})
