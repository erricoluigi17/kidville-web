import { describe, it, expect } from 'vitest'
import { studentiSenzaConsenso } from '@/lib/gallery/privacy'

// P4/DL-041 — Privacy Lock "foto privata": un solo bambino taggato è sempre
// consentito (foto visibile solo ai suoi genitori); il consenso privacy
// (liberatoria foto) serve solo nelle foto di gruppo (≥2 taggati distinti).
//
// Il canale di pubblicazione NON entra più nel calcolo: fino al 2026-07-31 il
// broadcast lo spegneva (`isBroadcast || …`) e il parametro che lo faceva non
// esiste più nella firma — collaudo privacy F5. Il caso broadcast sta tutto in
// `gallery-privacy-broadcast.test.ts`.

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

  it('la firma non ha più un argomento che spegne il controllo (era `isBroadcast`)', () => {
    // Il difetto F5 in una riga: la stessa chiamata che prima tornava `[]` con
    // un `true` in coda oggi non si scrive nemmeno — e senza quell'argomento
    // segnala i due bambini scoperti, come deve.
    expect(studentiSenzaConsenso.length).toBe(2)
    expect(studentiSenzaConsenso(['a', 'b', 'z'], consent)).toEqual(['b', 'z'])
  })

  it('deduplica (["b","b"] = un solo taggato → foto privata) e gestisce input vuoto', () => {
    expect(studentiSenzaConsenso(['b', 'b'], consent)).toEqual([])
    expect(studentiSenzaConsenso([], consent)).toEqual([])
  })
})
