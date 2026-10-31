import { describe, it, expect } from 'vitest'
import { movimentoAssorbito, soloMovimentiContati } from '@/lib/cassa/assorbiti'

// =============================================================================
// Un movimento di cassa con `incasso_id` è rappresentato da quell'incasso (che la
// cassa conta già come entrata virtuale in contanti): non si somma e non si elenca.
// Funzione pura condivisa da saldo.ts e dalla GET dei movimenti.
// =============================================================================

describe('movimentoAssorbito', () => {
  it('con incasso_id valorizzato → assorbito', () => {
    expect(movimentoAssorbito({ incasso_id: 'inc-1' })).toBe(true)
  })

  it('con incasso_id nullo → non assorbito', () => {
    expect(movimentoAssorbito({ incasso_id: null })).toBe(false)
  })

  it('senza la chiave incasso_id → non assorbito', () => {
    expect(movimentoAssorbito({})).toBe(false)
  })

  it('con incasso_id stringa vuota → non assorbito (non è un riferimento)', () => {
    expect(movimentoAssorbito({ incasso_id: '' })).toBe(false)
  })
})

describe('soloMovimentiContati', () => {
  it('toglie i movimenti assorbiti e tiene gli altri nell\'ordine', () => {
    const contati = soloMovimentiContati([
      { id: 'a', incasso_id: null },
      { id: 'b', incasso_id: 'inc-1' },
      { id: 'c' },
    ])
    expect(contati.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('non muta l\'array di partenza', () => {
    const partenza = [{ id: 'a', incasso_id: 'inc-1' }]
    const contati = soloMovimentiContati(partenza)
    expect(contati).toEqual([])
    expect(partenza).toHaveLength(1)
  })

  it('lista vuota → lista vuota', () => {
    expect(soloMovimentiContati([])).toEqual([])
  })
})
