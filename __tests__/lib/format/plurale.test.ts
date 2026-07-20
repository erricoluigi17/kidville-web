import { describe, it, expect } from 'vitest'
import { plurale } from '@/lib/format/plurale'

describe('format/plurale — scelta singolare/plurale in italiano', () => {
  it('restituisce il singolare solo per esattamente 1', () => {
    expect(plurale(1, 'famiglia', 'famiglie')).toBe('famiglia')
    expect(plurale(1, 'lettura', 'letture')).toBe('lettura')
    expect(plurale(1, 'errore', 'errori')).toBe('errore')
  })

  it('restituisce il plurale per 0 (in italiano lo zero è plurale)', () => {
    expect(plurale(0, 'famiglia', 'famiglie')).toBe('famiglie')
    expect(plurale(0, 'errore', 'errori')).toBe('errori')
  })

  it('restituisce il plurale per conteggi maggiori di 1', () => {
    expect(plurale(2, 'famiglia', 'famiglie')).toBe('famiglie')
    expect(plurale(10, 'lettura', 'letture')).toBe('letture')
    expect(plurale(1234, 'famiglia', 'famiglie')).toBe('famiglie')
  })

  it('tratta il valore assoluto (magnitudine 1 → singolare)', () => {
    expect(plurale(-1, 'grado', 'gradi')).toBe('grado')
    expect(plurale(-2, 'grado', 'gradi')).toBe('gradi')
  })

  it('un valore non intero non è mai singolare', () => {
    expect(plurale(1.5, 'famiglia', 'famiglie')).toBe('famiglie')
  })

  it('degrada al plurale per input non numerici', () => {
    expect(plurale(Number.NaN, 'famiglia', 'famiglie')).toBe('famiglie')
  })
})
