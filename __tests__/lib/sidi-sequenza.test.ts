import { describe, it, expect } from 'vitest'
import { puoInviareFrequentanti, puoInviarePiattaformaUnica, prossimaFase } from '@/lib/sidi/sequenza'
import { serializeFaseA, serializeFrequentanti, serializeGenitoriAlunni } from '@/lib/sidi/serializer'

describe('sequenza SIDI (Fase A → frequentanti → Piattaforma Unica)', () => {
  it('frequentanti solo dopo Fase A inviata', () => {
    expect(puoInviareFrequentanti('inviato')).toBe(true)
    expect(puoInviareFrequentanti('non_inviato')).toBe(false)
    expect(puoInviareFrequentanti('errore')).toBe(false)
  })

  it('Piattaforma Unica solo dopo frequentanti inviati', () => {
    expect(puoInviarePiattaformaUnica('inviato')).toBe(true)
    expect(puoInviarePiattaformaUnica('in_corso')).toBe(false)
  })

  it('prossimaFase segue l’ordine', () => {
    expect(prossimaFase({ fase_a_stato: 'non_inviato', frequentanti_stato: 'non_inviato' })).toBe('fase_a')
    expect(prossimaFase({ fase_a_stato: 'inviato', frequentanti_stato: 'non_inviato' })).toBe('frequentanti')
    expect(prossimaFase({ fase_a_stato: 'inviato', frequentanti_stato: 'inviato' })).toBe('piattaforma_unica')
  })
})

describe('serializer SIDI (adapter sostituibile)', () => {
  it('producono stringhe non vuote per i tre flussi', () => {
    expect(serializeFaseA({ sedi: [], sezioni: [] }).length).toBeGreaterThan(0)
    expect(serializeFrequentanti({ perClasse: [] }).length).toBeGreaterThan(0)
    expect(serializeGenitoriAlunni({ associazioni: [] }).length).toBeGreaterThan(0)
  })
})
