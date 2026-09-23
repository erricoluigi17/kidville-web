// @vitest-environment node
/**
 * `quandoRelativo` — un istante detto come lo legge la segreteria: «alle 14:30»,
 * «domani alle 00:03», «ven 25/09 alle 08:00» (coda fatture, consegna 2a, rilievo c).
 *
 * Il difetto che chiude: la pagina «Coda fatture» diceva solo l'ora. Una pausa 429 di
 * 60 minuti partita alle 23:30 diceva «In pausa fino alle 00:30.», e 300 fatture a 50
 * l'ora accodate alle 18:03 dicevano «Fine stimata alle 00:03.»: in tutti e due i casi
 * è il giorno DOPO, e la frase non lo diceva.
 *
 * Perché i quattro fusi del PROCESSO: il portatile gira in Europe/Rome, e lì anche un
 * confronto sbagliato (`toDateString()`, che usa il fuso del processo) darebbe verde.
 * Il browser della segreteria può stare in qualunque fuso; il giorno si decide SEMPRE
 * in Europe/Rome. Ogni fuso ha la sua prova di sanità dell'offset: senza, un fuso non
 * applicato renderebbe il blocco un doppione silenzioso di quello di Roma.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { IntlMessageFormat } from 'intl-messageformat'
import { quandoRelativo, type QuandoRelativo } from '@/lib/i18n/quando-relativo'
import catalogoIt from '../../messages/it/adminContabilita.json'
import catalogoEn from '../../messages/en/adminContabilita.json'

/** Copiata da `__tests__/lib/format-data.test.ts`: `process.env.TZ = undefined` scriverebbe la stringa «undefined». */
function ripristinaTZ(tz: string | undefined) {
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
}

/**
 * Rende un testo ICU con i valori di `quandoRelativo`. Il `null` si restringe PRIMA:
 * `format` vuole `Record<string, …> | undefined`, e passargli `QuandoRelativo | null`
 * sarebbe verde in vitest ma rosso in `tsc --noEmit` (TS2345).
 */
function rendi(testo: string, locale: string, q: QuandoRelativo | null): string {
  if (!q) throw new Error('quandoRelativo ha risposto null su un istante valido')
  return String(new IntlMessageFormat(testo, locale).format(q))
}

const FUSI: Array<[string, number]> = [
  ['Europe/Rome', -120],
  ['UTC', 0],
  ['Pacific/Kiritimati', -840],
  ['America/Los_Angeles', 420],
]

describe.each(FUSI)('quandoRelativo con il processo nel fuso %s', (fuso, offsetAtteso) => {
  const tzOriginale = process.env.TZ

  beforeAll(() => { process.env.TZ = fuso })
  afterAll(() => { ripristinaTZ(tzOriginale) })

  it(`il fuso di prova è davvero applicato (offset di settembre ${offsetAtteso})`, () => {
    // getTimezoneOffset() è MINUTI DIETRO UTC: Roma d'estate (+2) è -120.
    expect(new Date('2026-09-14T12:00:00').getTimezoneOffset()).toBe(offsetAtteso)
  })

  it('1 · stesso giorno civile a Roma → oggi', () => {
    const q = quandoRelativo('2026-09-23T21:59:00Z', new Date('2026-09-23T21:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('oggi')
    expect(q?.ora).toBe('23:59')
  })

  it('2 · la mezzanotte di Roma è già domani, e si scrive 00:00 (mai 24:00)', () => {
    const q = quandoRelativo('2026-09-23T22:00:00Z', new Date('2026-09-23T21:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('domani')
    expect(q?.ora).toBe('00:00')
  })

  it('3 · 300 fatture a 50 l’ora dalle 18:03 finiscono domani alle 00:03', () => {
    const q = quandoRelativo('2026-09-23T22:03:00Z', new Date('2026-09-23T16:03:00Z'), 'it-IT')
    expect(q?.giorno).toBe('domani')
    expect(q?.ora).toBe('00:03')
  })

  it('4 · due giorni dopo → altro, con la data breve in italiano e in inglese', () => {
    const adesso = new Date('2026-09-23T16:03:00Z')
    const q = quandoRelativo('2026-09-25T06:00:00Z', adesso, 'it-IT')
    expect(q?.giorno).toBe('altro')
    expect(q?.ora).toBe('08:00')
    expect(q?.data).toBe('ven 25/09')
    expect(quandoRelativo('2026-09-25T06:00:00Z', adesso, 'en-GB')?.data).toBe('Fri 25/09')
  })

  it('5 · la notte del ritorno all’ora solare: dopo la mezzanotte è domani', () => {
    const q = quandoRelativo('2026-10-24T23:30:00Z', new Date('2026-10-24T21:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('domani')
    expect(q?.ora).toBe('01:30')
  })

  it('6 · l’ora che a Roma c’è due volte resta oggi', () => {
    const q = quandoRelativo('2026-10-25T01:30:00Z', new Date('2026-10-25T00:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('oggi')
    expect(q?.ora).toBe('02:30')
  })

  it('7 · 24 ore dopo, ma il 25/10 dura 25 ore: è ancora lo STESSO giorno', () => {
    const q = quandoRelativo('2026-10-25T22:30:00Z', new Date('2026-10-24T22:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('oggi')
    expect(q?.ora).toBe('23:30')
  })

  it('8 · 24 ore e mezza dopo, il 26/10 a mezzanotte: domani', () => {
    const q = quandoRelativo('2026-10-25T23:00:00Z', new Date('2026-10-24T22:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('domani')
    expect(q?.ora).toBe('00:00')
    expect(q?.data).toBe('lun 26/10')
  })

  it('9 · 23 ore dopo, ma il 29/03 dura 23 ore: è già il giorno DOPO', () => {
    const q = quandoRelativo('2026-03-29T22:30:00Z', new Date('2026-03-28T23:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('domani')
    expect(q?.ora).toBe('00:30')
  })

  it('10 · il cambio d’anno è un giorno come gli altri', () => {
    const q = quandoRelativo('2027-01-01T00:30:00Z', new Date('2026-12-31T22:30:00Z'), 'it-IT')
    expect(q?.giorno).toBe('domani')
    expect(q?.ora).toBe('01:30')
  })

  it('11 · un istante passato non è mai «oggi» né «domani» (e «ieri» non esiste)', () => {
    const q = quandoRelativo('2026-09-23T10:00:00Z', new Date('2026-09-24T10:00:00Z'), 'it-IT')
    expect(q?.giorno).toBe('altro')
  })

  it('12 · istante illeggibile o adesso invalido → null, mai un’eccezione', () => {
    const adesso = new Date('2026-09-23T10:00:00Z')
    expect(quandoRelativo(null, adesso, 'it-IT')).toBeNull()
    expect(quandoRelativo(undefined, adesso, 'it-IT')).toBeNull()
    expect(quandoRelativo('', adesso, 'it-IT')).toBeNull()
    expect(quandoRelativo('non-una-data', adesso, 'it-IT')).toBeNull()
    expect(quandoRelativo('2026-09-23T11:00:00Z', new Date(NaN), 'it-IT')).toBeNull()
  })
})

describe('quandoRelativo + i due cataloghi veri (codaFatture.stato.pausa / stimaFine)', () => {
  const pausaIt = catalogoIt.codaFatture.stato.pausa
  const stimaIt = catalogoIt.codaFatture.stato.stimaFine
  const pausaEn = catalogoEn.codaFatture.stato.pausa
  const stimaEn = catalogoEn.codaFatture.stato.stimaFine

  const OGGI = { istante: '2026-09-23T17:03:00Z', adesso: new Date('2026-09-23T16:03:00Z') }
  const DOMANI_PAUSA = { istante: '2026-09-23T22:30:00Z', adesso: new Date('2026-09-23T21:30:00Z') }
  const DOMANI_STIMA = { istante: '2026-09-23T22:03:00Z', adesso: new Date('2026-09-23T16:03:00Z') }
  const ALTRO = { istante: '2026-09-25T06:00:00Z', adesso: new Date('2026-09-23T16:03:00Z') }

  it('italiano: oggi, domani, altro', () => {
    expect(rendi(pausaIt, 'it-IT', quandoRelativo(OGGI.istante, OGGI.adesso, 'it-IT'))).toBe('In pausa fino alle 19:03.')
    expect(rendi(pausaIt, 'it-IT', quandoRelativo(DOMANI_PAUSA.istante, DOMANI_PAUSA.adesso, 'it-IT'))).toBe('In pausa fino a domani alle 00:30.')
    expect(rendi(pausaIt, 'it-IT', quandoRelativo(ALTRO.istante, ALTRO.adesso, 'it-IT'))).toBe('In pausa fino a ven 25/09 alle 08:00.')
    expect(rendi(stimaIt, 'it-IT', quandoRelativo(OGGI.istante, OGGI.adesso, 'it-IT'))).toBe('Fine stimata alle 19:03.')
    expect(rendi(stimaIt, 'it-IT', quandoRelativo(DOMANI_STIMA.istante, DOMANI_STIMA.adesso, 'it-IT'))).toBe('Fine stimata domani alle 00:03.')
    expect(rendi(stimaIt, 'it-IT', quandoRelativo(ALTRO.istante, ALTRO.adesso, 'it-IT'))).toBe('Fine stimata ven 25/09 alle 08:00.')
  })

  it('inglese: oggi, domani, altro', () => {
    expect(rendi(pausaEn, 'en-GB', quandoRelativo(OGGI.istante, OGGI.adesso, 'en-GB'))).toBe('Paused until 19:03.')
    expect(rendi(pausaEn, 'en-GB', quandoRelativo(DOMANI_PAUSA.istante, DOMANI_PAUSA.adesso, 'en-GB'))).toBe('Paused until tomorrow at 00:30.')
    expect(rendi(pausaEn, 'en-GB', quandoRelativo(ALTRO.istante, ALTRO.adesso, 'en-GB'))).toBe('Paused until Fri 25/09 at 08:00.')
    expect(rendi(stimaEn, 'en-GB', quandoRelativo(OGGI.istante, OGGI.adesso, 'en-GB'))).toBe('Estimated finish at 19:03.')
    expect(rendi(stimaEn, 'en-GB', quandoRelativo(DOMANI_STIMA.istante, DOMANI_STIMA.adesso, 'en-GB'))).toBe('Estimated finish tomorrow at 00:03.')
    expect(rendi(stimaEn, 'en-GB', quandoRelativo(ALTRO.istante, ALTRO.adesso, 'en-GB'))).toBe('Estimated finish on Fri 25/09 at 08:00.')
  })

  it('senza `giorno` la resa lancia: il pannello deve passarlo sempre', () => {
    expect(() => new IntlMessageFormat(pausaIt, 'it-IT').format({ ora: '00:30' })).toThrow()
  })
})
