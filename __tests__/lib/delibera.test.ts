import { describe, it, expect } from 'vitest'
import { calcolaDelibera } from '@/lib/forms/delibera'

describe('calcolaDelibera', () => {
  it('soglia + posti: ammessi i top entro i posti e sopra soglia, poi lista, poi non ammessi', () => {
    const out = calcolaDelibera(
      [
        { id: 'a', score: 10 },
        { id: 'b', score: 8 },
        { id: 'c', score: 6 },
        { id: 'd', score: 4 },
      ],
      { soglia: 5, posti: 2 }
    )
    expect(out).toEqual([
      { id: 'a', esito: 'ammesso' },
      { id: 'b', esito: 'ammesso' },
      { id: 'c', esito: 'lista_attesa' },
      { id: 'd', esito: 'non_ammesso' },
    ])
  })

  it('sotto soglia → non ammesso anche se ci sono posti liberi', () => {
    const out = calcolaDelibera([{ id: 'x', score: 3 }], { soglia: 5, posti: 10 })
    expect(out).toEqual([{ id: 'x', esito: 'non_ammesso' }])
  })

  it('posti=0 → tutti i sopra-soglia in lista d’attesa', () => {
    const out = calcolaDelibera(
      [{ id: 'a', score: 9 }, { id: 'b', score: 2 }],
      { soglia: 5, posti: 0 }
    )
    expect(out).toEqual([{ id: 'a', esito: 'lista_attesa' }, { id: 'b', esito: 'non_ammesso' }])
  })

  it('ordina internamente per score desc (input non ordinato)', () => {
    const out = calcolaDelibera(
      [{ id: 'low', score: 2 }, { id: 'high', score: 9 }],
      { soglia: 1, posti: 1 }
    )
    expect(out.find((r) => r.id === 'high')!.esito).toBe('ammesso')
    expect(out.find((r) => r.id === 'low')!.esito).toBe('lista_attesa')
  })

  it('lista vuota → nessun esito', () => {
    expect(calcolaDelibera([], { soglia: 5, posti: 3 })).toEqual([])
  })
})
