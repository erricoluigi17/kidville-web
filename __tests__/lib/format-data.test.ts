import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { addGiorni, isoToIt, itToIso, maskItDate } from '@/lib/format/data'

/**
 * Rimette `TZ` com'era — e se non c'era, la TOGLIE.
 *
 * `process.env.TZ = undefined` non azzera la variabile: la scrive come la
 * **stringa** `"undefined"`, che non è un fuso, e il processo ripiega su UTC.
 * Oggi sarebbe inerte perché vitest isola `process.env` per file e qui sotto non
 * resta niente da eseguire, ma diventerebbe un verde falso al primo test
 * aggiunto in coda: girerebbe in UTC credendo di girare nel fuso di sistema.
 */
function ripristinaTZ(tz: string | undefined) {
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
}

describe('format/data — gg/mm/aaaa ↔ ISO', () => {
  it('isoToIt converte ISO in formato italiano', () => {
    expect(isoToIt('2020-03-07')).toBe('07/03/2020')
    expect(isoToIt('')).toBe('')
    expect(isoToIt('non-una-data')).toBe('')
  })

  it('itToIso converte e valida il calendario', () => {
    expect(itToIso('07/03/2020')).toBe('2020-03-07')
    expect(itToIso('31/12/1999')).toBe('1999-12-31')
    expect(itToIso('29/02/2020')).toBe('2020-02-29') // bisestile
    expect(itToIso('31/02/2021')).toBeNull() // febbraio non ha 31
    expect(itToIso('00/01/2020')).toBeNull()
    expect(itToIso('13/13/2020')).toBeNull()
    expect(itToIso('7/3/2020')).toBeNull() // formato incompleto
    expect(itToIso('')).toBeNull()
  })

  it('maskItDate applica la maschera mentre si digita', () => {
    expect(maskItDate('07032020')).toBe('07/03/2020')
    expect(maskItDate('0703')).toBe('07/03')
    expect(maskItDate('07')).toBe('07')
    expect(maskItDate('07/03/2020extra')).toBe('07/03/2020')
    expect(maskItDate('abc07def03')).toBe('07/03')
  })
})

describe('format/data — addGiorni', () => {
  it('somma e sottrae giorni, attraversando mese e anno', () => {
    expect(addGiorni('2026-09-14', 1)).toBe('2026-09-15')
    expect(addGiorni('2026-09-14', -1)).toBe('2026-09-13')
    expect(addGiorni('2026-09-30', 1)).toBe('2026-10-01')
    expect(addGiorni('2026-01-01', -1)).toBe('2025-12-31')
    expect(addGiorni('2024-02-28', 1)).toBe('2024-02-29') // bisestile
    expect(addGiorni('2026-09-14', 0)).toBe('2026-09-14')
  })

  /**
   * 🔑 L'ANNO ESCE SEMPRE A QUATTRO CIFRE — e `0202` non è un caso di laboratorio:
   * si raggiunge dalla TASTIERA del campo mascherato battendo `15060202`, che
   * `itToIso` accetta perché `15/06/0202` è un giorno vero del calendario. Prima
   * del riempimento `getFullYear()` stampava `202` e da `'0202-06-15'` usciva
   * `'202-06-16'`: forma non ISO, che il controllo di forma qui sopra avrebbe poi
   * rifiutato al giro dopo — un valore capace di entrare e non più di muoversi.
   */
  it('l\'anno esce sempre a quattro cifre, anche sotto il 1000', () => {
    expect(addGiorni('0202-06-15', 1)).toBe('0202-06-16')
    expect(addGiorni('0202-01-01', -1)).toBe('0201-12-31')
    expect(addGiorni('1000-01-01', -1)).toBe('0999-12-31')
  })

  /**
   * ONESTÀ SUL TETTO: il riempimento non è un tetto. Oltre il 31/12/9999 l'anno
   * ha cinque cifre e questa funzione lo restituisce così com'è, di proposito:
   * troncarlo direbbe `'0000-01-01'` (una data falsa) e restituire l'ingresso
   * invariato fingerebbe che il giorno non sia cambiato. Il tetto sta in chi
   * propaga il risultato — `NavigatoreData` controlla l'USCITA della freccia e a
   * 9999-12-31 non si muove (`__tests__/ui/navigatore-data.test.tsx`).
   */
  it('oltre il 9999 l\'anno resta a cinque cifre: il tetto non è qui (è nel chiamante)', () => {
    expect(addGiorni('9999-12-31', 1)).toBe('10000-01-01')
  })

  it('una data non valida torna indietro invariata (non si inventa un giorno)', () => {
    expect(addGiorni('', 1)).toBe('')
    expect(addGiorni('non-una-data', 1)).toBe('non-una-data')
    expect(addGiorni('14/09/2026', 1)).toBe('14/09/2026')
  })

  /**
   * ⚠️ IL CAMBIO DELL'ORA LEGALE — e che cosa misura davvero questo blocco.
   *
   * Nelle due notti del cambio un giorno locale dura 23 o 25 ore, ed è lì che una
   * navigazione a frecce ha sempre slittato di un giorno nei prodotti che la
   * sbagliano. Il fuso si FORZA a `Europe/Rome`: la CI gira in UTC, che l'ora
   * legale europea non ce l'ha, e un test del cambio d'ora eseguito in UTC sarebbe
   * verde qualunque cosa faccia il codice. Il controllo di sanità qui sotto
   * pretende che il fuso sia davvero cambiato e che abbia davvero due offset.
   *
   * ONESTÀ SU QUELLO CHE NON DISTINGUE. In `Europe/Rome` il cambio scatta alle
   * 03:00, quindi da solo questo blocco non separerebbe `T12:00:00` da
   * `T00:00:00`: `setDate` lavora sui campi LOCALI e la mezzanotte, qui, esiste
   * sempre. Rosso lo diventa contro la rottura vera e già vista nel repo — la
   * ricomposizione in UTC — che a `Europe/Rome` con la mezzanotte manda la data
   * al giorno prima. Il mezzogiorno resta la difesa in profondità (copre i fusi
   * in cui la mezzanotte NON esiste), e chi lo togliesse deve sapere che qui non
   * trova un rosso: lo trova in `src/lib/format/data.ts`, scritto.
   */
  describe('attraversa il cambio dell\'ora legale senza slittare (TZ forzato a Europe/Rome)', () => {
    const tzOriginale = process.env.TZ

    beforeAll(() => { process.env.TZ = 'Europe/Rome' })
    afterAll(() => { ripristinaTZ(tzOriginale) })

    it('il fuso di prova è davvero attivo e ha l\'ora legale (altrimenti non si misura nulla)', () => {
      expect(new Date('2026-10-24T12:00:00').getTimezoneOffset()).not.toBe(0)
      const estate = new Date('2026-10-24T12:00:00').getTimezoneOffset()
      const inverno = new Date('2026-10-26T12:00:00').getTimezoneOffset()
      expect(estate).not.toBe(inverno)
    })

    it('fine dell\'ora legale: 2026-10-24 → 2026-10-25 (la notte da 25 ore)', () => {
      expect(addGiorni('2026-10-24', 1)).toBe('2026-10-25')
      expect(addGiorni('2026-10-25', -1)).toBe('2026-10-24')
      expect(addGiorni('2026-10-25', 1)).toBe('2026-10-26')
    })

    it('inizio dell\'ora legale: 2026-03-28 → 2026-03-29 (la notte da 23 ore)', () => {
      expect(addGiorni('2026-03-28', 1)).toBe('2026-03-29')
      expect(addGiorni('2026-03-29', -1)).toBe('2026-03-28')
      expect(addGiorni('2026-03-29', 1)).toBe('2026-03-30')
    })
  })

  /**
   * IL CONTROLLO CHE DISCRIMINA LA RICOMPOSIZIONE. `Pacific/Kiritimati` è UTC+14:
   * lì il mezzogiorno locale è già le 22:00 UTC del giorno PRIMA, e un
   * `toISOString()` al posto di `getFullYear/getMonth/getDate` restituisce un
   * giorno sbagliato — misurato, non supposto. È la stessa famiglia di difetti che
   * questo repo ha già pagato quattro volte con «UTC contro Europe/Rome», portata
   * al fuso in cui si vede anche partendo da mezzogiorno.
   */
  describe('la data si ricompone in ora LOCALE, non in UTC (TZ forzato a UTC+14)', () => {
    const tzOriginale = process.env.TZ

    beforeAll(() => { process.env.TZ = 'Pacific/Kiritimati' })
    afterAll(() => { ripristinaTZ(tzOriginale) })

    it('il fuso di prova è davvero a +14 (senza, il controllo non misura niente)', () => {
      // getTimezoneOffset() è MINUTI DIETRO UTC: +14 ore sono -840.
      expect(new Date('2026-09-14T12:00:00').getTimezoneOffset()).toBe(-840)
    })

    it('un giorno avanti resta un giorno avanti', () => {
      expect(addGiorni('2026-09-14', 1)).toBe('2026-09-15')
      expect(addGiorni('2026-09-14', -1)).toBe('2026-09-13')
      expect(addGiorni('2026-12-31', 1)).toBe('2027-01-01')
    })
  })
})
