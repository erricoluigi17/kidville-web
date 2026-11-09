import { describe, expect, it } from 'vitest'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import { corpoAnno, valoreAnnoIniziale, valoreNelCalendario } from '@/components/features/crm/schede/SelettoreAnnoScheda'

/** COMPITO 4.5.9 · il campo «anno» della scheda: le funzioni pure che decidono valore iniziale e corpo da mandare. */

const riga = (annoId: string, annoInizio: number, stato: RigaCalendario['stato']): RigaCalendario => ({
  annoId, annoSedeId: `sede-${annoInizio}`, annoInizio,
  inizio: `${annoInizio}-09-01`, fine: `${annoInizio + 1}-08-31`,
  ultimoGiornoAperto: `${annoInizio + 1}-07-31`, preparaSuccessivoDal: `${annoInizio}-09-01`,
  stato, domandeAperte: false,
})
const A25 = 'a1111111-1111-4111-8111-111111111111'
const A26 = 'a2222222-2222-4222-8222-222222222222'
const A27 = 'a3333333-3333-4333-8333-333333333333'
const CAL = [riga(A25, 2025, 'chiuso'), riga(A26, 2026, 'corrente'), riga(A27, 2027, 'in_preparazione')]

describe('corpoAnno', () => {
  it('un uuid va come annoId, un’etichetta come annoIngresso', () => {
    expect(corpoAnno(A27)).toEqual({ annoId: A27 })
    expect(corpoAnno('prossimo')).toEqual({ annoIngresso: 'prossimo' })
    expect(corpoAnno('non_indicato')).toEqual({ annoIngresso: 'non_indicato' })
  })
})

describe('valoreNelCalendario', () => {
  it('senza calendario non cambia niente', () => {
    expect(valoreNelCalendario('prossimo', null)).toBe('prossimo')
    expect(valoreNelCalendario('in_corso', [])).toBe('in_corso')
  })

  it('con il calendario, l’etichetta relativa diventa l’anno che oggi significa', () => {
    expect(valoreNelCalendario('prossimo', CAL)).toBe(A27)
    expect(valoreNelCalendario('in_corso', CAL)).toBe(A26)
    expect(valoreNelCalendario('non_indicato', CAL)).toBe('non_indicato')
  })

  it('un anno chiuso non è nell’elenco: ricade su «non indicato», salvo che sia quello già scelto', () => {
    expect(valoreNelCalendario(A25, CAL)).toBe(A25)
    expect(valoreNelCalendario(A26, CAL)).toBe(A26)
    expect(valoreNelCalendario('a9999999-9999-4999-8999-999999999999', CAL)).toBe('non_indicato')
  })
})

describe('valoreAnnoIniziale', () => {
  it('parte dall’anno della scheda se la sede lo conosce', () => {
    expect(valoreAnnoIniziale({ anno_id: A27.toUpperCase(), anno_ingresso: 'prossimo' }, CAL)).toBe(A27)
  })

  it('senza anno_id, o con un anno che la sede non ha, parte dall’etichetta', () => {
    expect(valoreAnnoIniziale({ anno_id: null, anno_ingresso: 'in_corso' }, CAL)).toBe('in_corso')
    expect(valoreAnnoIniziale({ anno_ingresso: 'prossimo' }, null)).toBe('prossimo')
    expect(valoreAnnoIniziale({ anno_id: 'a9999999-9999-4999-8999-999999999999', anno_ingresso: 'boh' }, CAL)).toBe('non_indicato')
  })
})
