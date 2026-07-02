import { describe, it, expect } from 'vitest'
import { studentiSenzaConsenso } from '@/lib/gallery/privacy'

// P4/DL-041 — Privacy Lock: non si può taggare un alunno senza consenso privacy
// (liberatoria foto), tranne nelle foto broadcast (istituzionali).

describe('studentiSenzaConsenso', () => {
  const consent = { a: true, b: false, c: true }

  it('ritorna [] se tutti i taggati hanno consenso', () => {
    expect(studentiSenzaConsenso(['a', 'c'], consent)).toEqual([])
  })

  it('ritorna gli ID senza consenso', () => {
    expect(studentiSenzaConsenso(['a', 'b'], consent)).toEqual(['b'])
  })

  it('tratta gli ID assenti dalla mappa come SENZA consenso', () => {
    expect(studentiSenzaConsenso(['a', 'z'], consent)).toEqual(['z'])
  })

  it('broadcast (istituzionale) bypassa il consenso → []', () => {
    expect(studentiSenzaConsenso(['a', 'b', 'z'], consent, true)).toEqual([])
  })

  it('deduplica e gestisce input vuoto', () => {
    expect(studentiSenzaConsenso(['b', 'b'], consent)).toEqual(['b'])
    expect(studentiSenzaConsenso([], consent)).toEqual([])
  })
})
