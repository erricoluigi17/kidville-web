import { describe, it, expect } from 'vitest'
import { studentiSenzaConsenso } from '@/lib/gallery/privacy'

// P4/DL-041 — Privacy Lock "foto privata": un solo bambino taggato è sempre
// consentito (foto visibile solo ai suoi genitori); il consenso privacy
// (liberatoria foto) serve solo nelle foto di gruppo (≥2 taggati distinti).
// Le foto broadcast (istituzionali) bypassano sempre.

describe('studentiSenzaConsenso', () => {
  const consent = { a: true, b: false, c: true }

  it('ritorna [] se tutti i taggati hanno consenso', () => {
    expect(studentiSenzaConsenso(['a', 'c'], consent)).toEqual([])
  })

  it('foto di gruppo: ritorna gli ID senza consenso', () => {
    expect(studentiSenzaConsenso(['a', 'b'], consent)).toEqual(['b'])
  })

  it('foto di gruppo: tratta gli ID assenti dalla mappa come SENZA consenso', () => {
    expect(studentiSenzaConsenso(['a', 'z'], consent)).toEqual(['z'])
  })

  it('foto privata: un singolo taggato SENZA consenso è consentito → []', () => {
    expect(studentiSenzaConsenso(['b'], consent)).toEqual([])
  })

  it('broadcast (istituzionale) bypassa il consenso → []', () => {
    expect(studentiSenzaConsenso(['a', 'b', 'z'], consent, true)).toEqual([])
  })

  it('deduplica (["b","b"] = un solo taggato → foto privata) e gestisce input vuoto', () => {
    expect(studentiSenzaConsenso(['b', 'b'], consent)).toEqual([])
    expect(studentiSenzaConsenso([], consent)).toEqual([])
  })
})
