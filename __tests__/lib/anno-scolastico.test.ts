import { describe, it, expect } from 'vitest'
import { annoScolasticoCorrente } from '@/lib/anno-scolastico'
import { dataCivile } from '@/i18n/config'

describe('annoScolasticoCorrente — il giorno si conta a Roma, non dove gira il processo', () => {
  // Misurato il 2026-08-16: `documentoDellAnnoScolastico` confrontava un anno
  // calcolato in Europe/Rome con uno calcolato nel fuso del PROCESSO — che su
  // Vercel è UTC. Fra le 00:00 e le 02:00 italiane del 1° agosto i due valori
  // divergono, e ogni «Scarica il certificato» in quella finestra non riusava il
  // documento: riemetteva, bruciando un numero del registro WORM e dichiarando
  // l'anno scolastico SBAGLIATO a un datore di lavoro o all'INPS.
  //
  // Il test gira anche in CI, dove il processo è in UTC: lì questa prova sarebbe
  // stata rossa prima della riparazione.
  it('la notte del passaggio: 31 luglio 22:30 UTC è già il 1° agosto a Roma', () => {
    const istante = new Date('2026-07-31T22:30:00.000Z')
    expect(dataCivile(istante)).toBe('2026-08-01')
    expect(annoScolasticoCorrente(istante)).toBe('2026/2027')
  })

  it('e il 31 luglio alle 21:00 UTC a Roma è ancora luglio', () => {
    const istante = new Date('2026-07-31T21:00:00.000Z')
    expect(dataCivile(istante)).toBe('2026-07-31')
    expect(annoScolasticoCorrente(istante)).toBe('2025/2026')
  })

  it("concorda SEMPRE col giorno civile italiano, qualunque sia il fuso del processo", () => {
    for (const iso of [
      '2026-07-31T22:00:00.000Z',
      '2026-07-31T23:59:59.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-12-31T23:30:00.000Z',
      '2027-01-01T00:30:00.000Z',
    ]) {
      const istante = new Date(iso)
      const [y, m] = dataCivile(istante).split('-').map(Number)
      const atteso = m >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`
      expect(annoScolasticoCorrente(istante), iso).toBe(atteso)
    }
  })
})

describe('annoScolasticoCorrente — set→lug (ago = nuovo anno)', () => {
  it('luglio → anno in chiusura', () => {
    expect(annoScolasticoCorrente(new Date(2026, 6, 10))).toBe('2025/2026')
    expect(annoScolasticoCorrente(new Date(2026, 6, 31))).toBe('2025/2026')
  })
  it('agosto → nuovo anno', () => {
    expect(annoScolasticoCorrente(new Date(2026, 7, 1))).toBe('2026/2027')
  })
  it('set–dic → nuovo anno', () => {
    expect(annoScolasticoCorrente(new Date(2026, 8, 15))).toBe('2026/2027')
    expect(annoScolasticoCorrente(new Date(2026, 11, 31))).toBe('2026/2027')
  })
  it("gen–giu → anno iniziato l'autunno prima", () => {
    expect(annoScolasticoCorrente(new Date(2027, 0, 1))).toBe('2026/2027')
    expect(annoScolasticoCorrente(new Date(2027, 5, 30))).toBe('2026/2027')
  })
  it('senza argomento usa oggi', () => {
    expect(annoScolasticoCorrente()).toMatch(/^\d{4}\/\d{4}$/)
  })
})
