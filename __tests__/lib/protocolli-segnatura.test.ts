import { describe, it, expect } from 'vitest'
import {
  formatNumeroProtocollo,
  dataOraItaliana,
  righeSegnatura,
  TIPO_LABEL,
} from '@/lib/protocolli/segnatura'

describe('formatNumeroProtocollo (art. 57: ≥7 cifre, per anno)', () => {
  it('padding a 7 cifre + anno', () => {
    expect(formatNumeroProtocollo(42, 2026)).toBe('0000042/2026')
  })
  it('primo numero del nuovo anno', () => {
    expect(formatNumeroProtocollo(1, 2027)).toBe('0000001/2027')
  })
  it('oltre le 7 cifre resta intero', () => {
    expect(formatNumeroProtocollo(12345678, 2026)).toBe('12345678/2026')
  })
})

describe('dataOraItaliana (fuso Europe/Rome su runtime UTC)', () => {
  it("estate: UTC+2 (l'istante UTC 07:41 è 09:41 italiane)", () => {
    expect(dataOraItaliana(new Date('2026-07-12T07:41:00Z'))).toEqual({
      data: '12/07/2026',
      ora: '09:41',
    })
  })
  it('inverno: UTC+1 con cambio di giorno', () => {
    expect(dataOraItaliana(new Date('2026-01-15T23:30:00Z'))).toEqual({
      data: '16/01/2026',
      ora: '00:30',
    })
  })
})

describe('righeSegnatura (contenuto minimo art. 55: ente, numero, data)', () => {
  it('tre righe: denominazione, numero+tipo, data e ora', () => {
    expect(
      righeSegnatura({
        denominazione: 'Kidville Giugliano',
        numero: 42,
        anno: 2026,
        tipo: 'ingresso',
        quando: new Date('2026-07-12T07:41:00Z'),
      })
    ).toEqual([
      'KIDVILLE GIUGLIANO',
      'Prot. n. 0000042/2026 · INGRESSO',
      'del 12/07/2026 ore 09:41',
    ])
  })
  it('etichette dei tipi', () => {
    expect(TIPO_LABEL.ingresso).toBe('INGRESSO')
    expect(TIPO_LABEL.uscita).toBe('USCITA')
    expect(TIPO_LABEL.interno).toBe('INTERNO')
  })
})
