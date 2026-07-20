import { describe, it, expect } from 'vitest'
import { postVisibileAiFigli, type PostTarget, type FiglioTarget } from '@/lib/news/target'

// =============================================================================
// Visibilità di un post ai figli di un genitore — funzione PURA. Deve essere
// FAIL-CLOSED: se nessun figlio ha una sede determinabile, il post non è
// visibile (un globale cross-sede non deve trapelare quando scuola_id manca).
// =============================================================================

const SEDE_A = '11111111-1111-1111-1111-111111111111'
const SEDE_B = '22222222-2222-2222-2222-222222222222'

function figlio(over: Partial<FiglioTarget> = {}): FiglioTarget {
  return { scuola_id: SEDE_A, classe_sezione: '1A', grado: 'infanzia', ...over }
}

describe('postVisibileAiFigli', () => {
  it('globale di sede: visibile solo ai figli di quella sede', () => {
    const post: PostTarget = { scuola_id: SEDE_A, target_scope: 'globale', target_gradi: null, target_classes: null }
    expect(postVisibileAiFigli(post, [figlio({ scuola_id: SEDE_A })])).toBe(true)
    expect(postVisibileAiFigli(post, [figlio({ scuola_id: SEDE_B })])).toBe(false)
  })

  it('scuola_id NULL (tutte le sedi): visibile a qualunque figlio con sede', () => {
    const post: PostTarget = { scuola_id: null, target_scope: 'globale', target_gradi: null, target_classes: null }
    expect(postVisibileAiFigli(post, [figlio({ scuola_id: SEDE_B })])).toBe(true)
  })

  it('grado: match sul grado del figlio', () => {
    const post: PostTarget = { scuola_id: SEDE_A, target_scope: 'grado', target_gradi: ['infanzia'], target_classes: null }
    expect(postVisibileAiFigli(post, [figlio({ grado: 'infanzia' })])).toBe(true)
    expect(postVisibileAiFigli(post, [figlio({ grado: 'primaria' })])).toBe(false)
  })

  it('classi: match sul nome sezione del figlio', () => {
    const post: PostTarget = { scuola_id: SEDE_A, target_scope: 'classi', target_gradi: null, target_classes: ['1A', '2B'] }
    expect(postVisibileAiFigli(post, [figlio({ classe_sezione: '1A' })])).toBe(true)
    expect(postVisibileAiFigli(post, [figlio({ classe_sezione: '3C' })])).toBe(false)
  })

  it('figli multi-sede: unione (basta un figlio che lo veda)', () => {
    const post: PostTarget = { scuola_id: SEDE_B, target_scope: 'globale', target_gradi: null, target_classes: null }
    const figli = [figlio({ scuola_id: SEDE_A }), figlio({ scuola_id: SEDE_B })]
    expect(postVisibileAiFigli(post, figli)).toBe(true)
  })

  it('fail-closed: nessun figlio con sede determinabile → false', () => {
    const post: PostTarget = { scuola_id: null, target_scope: 'globale', target_gradi: null, target_classes: null }
    expect(postVisibileAiFigli(post, [figlio({ scuola_id: null })])).toBe(false)
    expect(postVisibileAiFigli(post, [])).toBe(false)
  })

  it('classi con target vuoto → non visibile', () => {
    const post: PostTarget = { scuola_id: SEDE_A, target_scope: 'classi', target_gradi: null, target_classes: [] }
    expect(postVisibileAiFigli(post, [figlio({ classe_sezione: '1A' })])).toBe(false)
  })
})
