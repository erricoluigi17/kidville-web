import { describe, it, expect } from 'vitest'
import { inizioGiornoCivile, fineGiornoCivile } from '@/lib/format/confini-giorno'

/**
 * ─── I DUE ESTREMI DI UN GIORNO ITALIANO, IN ISTANTI ─────────────────────────
 *
 * Una barra filtri manda `?creataDa=2026-09-01`. La colonna che riceve quel
 * filtro è una `timestamptz`, cioè un ISTANTE: `gte('creata_il', '2026-09-01')`
 * lo fa leggere a Postgres come `2026-09-01 00:00:00` **nel fuso della
 * sessione**, che su Supabase è UTC. A Roma quell'istante è l'01:00 o le 02:00
 * del mattino: tutto ciò che è arrivato fra mezzanotte e le due del 1° settembre
 * finisce nel 31 agosto, e la segreteria che filtra «oggi» non lo vede.
 *
 * Non è teoria: è lo stesso difetto misurato il 2026-08-01 alle 01:08 che ha
 * fatto sparire un incasso vero da un KPI, e per cui esiste `dataCivile()`.
 * Qui serve la strada inversa — da un giorno civile ai due istanti che lo
 * delimitano — e i casi che contano sono i due giorni in cui l'ora cambia.
 *
 * I valori attesi non sono dedotti a mente: sono stati calcolati con `Intl` e
 * `timeZone: 'Europe/Rome'` prima di scrivere il test.
 */
describe('confini di un giorno civile italiano', () => {
  it('estate (UTC+2): il 1° settembre comincia il 31 agosto alle 22:00Z', () => {
    expect(inizioGiornoCivile('2026-09-01')).toBe('2026-08-31T22:00:00.000Z')
    expect(fineGiornoCivile('2026-09-01')).toBe('2026-09-01T21:59:59.999Z')
  })

  it('inverno (UTC+1): il 15 gennaio comincia il 14 alle 23:00Z', () => {
    expect(inizioGiornoCivile('2026-01-15')).toBe('2026-01-14T23:00:00.000Z')
    expect(fineGiornoCivile('2026-01-15')).toBe('2026-01-15T22:59:59.999Z')
  })

  it('il giorno in cui l\'ora VA AVANTI (29/03/2026) ha due offset diversi ai due estremi', () => {
    // 00:00 locali sono ancora +01:00 — l'ora cambia alle 02:00.
    expect(inizioGiornoCivile('2026-03-29')).toBe('2026-03-28T23:00:00.000Z')
    // …e le 23:59 sono già +02:00. Un solo offset per tutto il giorno
    // sbaglierebbe uno dei due estremi di un'ora piena.
    expect(fineGiornoCivile('2026-03-29')).toBe('2026-03-29T21:59:59.999Z')
  })

  it('il giorno in cui l\'ora TORNA INDIETRO (25/10/2026) è lungo 25 ore', () => {
    expect(inizioGiornoCivile('2026-10-25')).toBe('2026-10-24T22:00:00.000Z')
    expect(fineGiornoCivile('2026-10-25')).toBe('2026-10-25T22:59:59.999Z')
    const durata =
      Date.parse(fineGiornoCivile('2026-10-25') as string) -
      Date.parse(inizioGiornoCivile('2026-10-25') as string)
    expect(Math.round(durata / 3_600_000)).toBe(25)
  })

  it('una data che sul calendario non esiste non produce un estremo: `null`', () => {
    // `new Date('2026-02-30')` scivolerebbe al 2 marzo in silenzio. Un estremo
    // sbagliato di due giorni è peggio di nessun estremo: chi filtra vedrebbe
    // righe che non ha chiesto e non saprebbe perché.
    for (const brutta of ['2026-02-30', '2026-13-01', '1-1-2026', '', 'oggi']) {
      expect(inizioGiornoCivile(brutta)).toBeNull()
      expect(fineGiornoCivile(brutta)).toBeNull()
    }
  })

  it('l\'estremo finale è INCLUSIVO: l\'ultimo millisecondo del giorno c\'è', () => {
    // «Dal 1° al 31» comprende il 31 — è il contratto del motore dei filtri
    // (`motore.ts`), e l'ultimo giorno che sparisce è il difetto più comune di
    // tutti: si nota solo quando manca la registrazione di fine mese.
    const fine = fineGiornoCivile('2026-09-30') as string
    const inizioDopo = inizioGiornoCivile('2026-10-01') as string
    expect(Date.parse(inizioDopo) - Date.parse(fine)).toBe(1)
  })
})
