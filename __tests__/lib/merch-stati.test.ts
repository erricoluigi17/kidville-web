import { describe, it, expect } from 'vitest'
import { derivaStatoTestata, puoTransire, poCompleto, type StatoRiga } from '@/lib/merch/stati'

describe('derivaStatoTestata', () => {
  it('tutte da_ordinare → inviato', () => {
    expect(derivaStatoTestata(['da_ordinare', 'da_ordinare'])).toBe('inviato')
  })
  it('almeno una in lavorazione → confermato', () => {
    expect(derivaStatoTestata(['da_ordinare', 'ordinato'])).toBe('confermato')
    expect(derivaStatoTestata(['arrivato', 'da_ordinare'])).toBe('confermato')
    expect(derivaStatoTestata(['consegnato', 'da_ordinare'])).toBe('confermato')
  })
  it('tutte le attive consegnate → consegnato (ignora annullate)', () => {
    expect(derivaStatoTestata(['consegnato', 'consegnato'])).toBe('consegnato')
    expect(derivaStatoTestata(['consegnato', 'annullato'])).toBe('consegnato')
  })
  it('nessuna riga attiva → annullato', () => {
    expect(derivaStatoTestata(['annullato', 'annullato'])).toBe('annullato')
    expect(derivaStatoTestata([])).toBe('annullato')
  })
})

describe('puoTransire', () => {
  const legali: [StatoRiga, StatoRiga][] = [
    ['da_ordinare', 'ordinato'],
    ['da_ordinare', 'arrivato'], // evasione da magazzino
    ['da_ordinare', 'annullato'],
    ['ordinato', 'arrivato'], // check-in PO
    ['ordinato', 'da_ordinare'], // annullo PO
    ['ordinato', 'annullato'],
    ['arrivato', 'consegnato'],
    ['arrivato', 'annullato'],
  ]
  const illegali: [StatoRiga, StatoRiga][] = [
    ['da_ordinare', 'consegnato'],
    ['consegnato', 'annullato'], // terminale
    ['annullato', 'da_ordinare'], // terminale
    ['consegnato', 'consegnato'], // stesso stato
    ['arrivato', 'ordinato'], // all'indietro non consentito
  ]
  it.each(legali)('consente %s → %s', (da, a) => {
    expect(puoTransire(da, a)).toBe(true)
  })
  it.each(illegali)('blocca %s → %s', (da, a) => {
    expect(puoTransire(da, a)).toBe(false)
  })
})

describe('poCompleto', () => {
  it('true se tutte le attive sono arrivate/consegnate', () => {
    expect(poCompleto(['arrivato', 'arrivato'])).toBe(true)
    expect(poCompleto(['arrivato', 'consegnato'])).toBe(true)
    expect(poCompleto(['arrivato', 'annullato'])).toBe(true) // ignora annullate
  })
  it('false se resta almeno una riga ordinato/da_ordinare', () => {
    expect(poCompleto(['arrivato', 'ordinato'])).toBe(false)
    expect(poCompleto(['da_ordinare'])).toBe(false)
  })
  it('false se nessuna riga attiva', () => {
    expect(poCompleto(['annullato', 'annullato'])).toBe(false)
    expect(poCompleto([])).toBe(false)
  })
})
