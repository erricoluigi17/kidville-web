import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }))

import { esitoLotto, leggiEsitoLotto } from '@/lib/ui/esito-lotto'

const SEL = new Set(['a', 'b', 'c'])

describe('esitoLotto — «N su M» invece di «tutti assegnati»', () => {
  it('tutti scritti: non è parziale e non resta niente selezionato', () => {
    const e = esitoLotto({ success: true, updated: 3, data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, SEL)
    expect(e).toMatchObject({ riusciti: 3, totale: 3, parziale: false })
    expect(e.rimasti.size).toBe(0)
  })

  it('una riga in errori: 2 su 3, e resta selezionata solo quella', () => {
    const e = esitoLotto({ updated: 2, data: [{ id: 'a' }, { id: 'c' }], errori: [{ id: 'b', codice: 'SCRITTURA_INCOMPLETA' }] }, SEL)
    expect(e).toMatchObject({ riusciti: 2, totale: 3, parziale: true })
    expect([...e.rimasti]).toEqual(['b'])
  })

  it('senza errori ma con meno righe di quante selezionate: parziale, restano quelle assenti da data', () => {
    const e = esitoLotto({ updated: 1, data: [{ id: 'a' }] }, SEL)
    expect(e.parziale).toBe(true)
    expect([...e.rimasti].sort()).toEqual(['b', 'c'])
  })

  it('un id in errori che non era selezionato non entra', () => {
    expect(esitoLotto({ updated: 3, errori: [{ id: 'x' }] }, SEL).rimasti.size).toBe(0)
  })

  it('corpo illeggibile o vuoto: si ricade sul numero dei selezionati, come prima', () => {
    expect(esitoLotto(null, SEL)).toMatchObject({ riusciti: 3, totale: 3, parziale: false })
    expect(esitoLotto('boh', SEL)).toMatchObject({ riusciti: 3, parziale: false })
  })

  it('leggiEsitoLotto: un json che lancia non rompe, ricade sul totale', async () => {
    const res = { json: async () => { throw new Error('non json') } } as unknown as Response
    expect(await leggiEsitoLotto(res, SEL)).toMatchObject({ riusciti: 3, parziale: false })
  })
})
