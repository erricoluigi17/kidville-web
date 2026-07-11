import { describe, it, expect } from 'vitest'
import { calcolaGiacenze, disponibileDi } from '@/lib/merch/giacenze'

describe('calcolaGiacenze', () => {
  it('disponibile = carichi − righe evase da magazzino (arrivato/consegnato)', () => {
    const cells = calcolaGiacenze(
      [{ articolo_id: 'a', articolo_nome: 'Polo', taglia: 'M', quantita_delta: 10 }],
      [
        { articolo_id: 'a', taglia: 'M', quantita: 3, stato: 'arrivato', origine: 'magazzino' },
        { articolo_id: 'a', taglia: 'M', quantita: 2, stato: 'consegnato', origine: 'magazzino' },
      ],
    )
    const c = cells.find((x) => x.articolo_id === 'a' && x.taglia === 'M')!
    expect(c.caricato).toBe(10)
    expect(c.impegnato).toBe(5)
    expect(c.disponibile).toBe(5)
  })

  it('le righe dal FORNITORE non impegnano lo stock; ordinato→inArrivo, arrivato→daConsegnare', () => {
    const cells = calcolaGiacenze(
      [{ articolo_id: 'a', taglia: 'M', quantita_delta: 4 }],
      [
        { articolo_id: 'a', taglia: 'M', quantita: 7, stato: 'ordinato', origine: 'fornitore' },
        { articolo_id: 'a', taglia: 'M', quantita: 2, stato: 'arrivato', origine: 'fornitore' },
      ],
    )
    const c = cells[0]
    expect(c.impegnato).toBe(0) // fornitore non impegna il magazzino
    expect(c.disponibile).toBe(4)
    expect(c.inArrivo).toBe(7)
    expect(c.daConsegnare).toBe(2)
  })

  it("l'annullo di una riga magazzino rilascia lo stock (non più arrivato/consegnato)", () => {
    const cells = calcolaGiacenze(
      [{ articolo_id: 'a', taglia: 'M', quantita_delta: 10 }],
      [{ articolo_id: 'a', taglia: 'M', quantita: 3, stato: 'annullato', origine: 'magazzino' }],
    )
    expect(cells[0].impegnato).toBe(0)
    expect(cells[0].disponibile).toBe(10)
  })

  it('scarichi/resi come delta negativi/positivi', () => {
    const cells = calcolaGiacenze(
      [
        { articolo_id: 'a', taglia: '', quantita_delta: 10 },
        { articolo_id: 'a', taglia: '', quantita_delta: -4 }, // scarico
        { articolo_id: 'a', taglia: '', quantita_delta: 1 }, // reso a stock
      ],
      [],
    )
    expect(cells[0].caricato).toBe(7)
    expect(cells[0].disponibile).toBe(7)
  })

  it('disponibileDi trova la cella per articolo/taglia (0 se assente)', () => {
    const cells = calcolaGiacenze([{ articolo_id: 'a', taglia: 'L', quantita_delta: 6 }], [])
    expect(disponibileDi(cells, 'a', 'L')).toBe(6)
    expect(disponibileDi(cells, 'a', 'M')).toBe(0)
    expect(disponibileDi(cells, 'z', 'L')).toBe(0)
  })
})
