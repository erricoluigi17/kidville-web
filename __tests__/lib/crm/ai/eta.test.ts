import { describe, expect, it } from 'vitest'
import { gradiPerNascita, meseDiNascita } from '@/lib/crm/ai/eta'

describe('gradiPerNascita', () => {
  it.each([
    ['2026-08', ['nido']], // 3 mesi per mese di calendario: il nido comincia qui
    ['2026-07', ['nido']],
    ['2026-09', []], // 2 mesi: sotto i 3 mesi il nido non c'è
    ['2026-10', []],
    ['2026-11', []], // 0 mesi
    ['2025-04', ['nido', 'infanzia']], // anticipo infanzia nell'anno prossimo
    ['2025-05', ['nido']],
    ['2024-06', ['nido', 'infanzia']],
    ['2023-04', ['infanzia']],
    ['2022-09', ['infanzia']],
    ['2022-04', ['infanzia', 'primaria']], // anticipo primaria nell'anno prossimo
    ['2022-05', ['infanzia']],
    ['2021-02', ['infanzia', 'primaria']],
    ['2016-05', ['primaria']],
    ['2015-05', []],
    ['2026-12', []],
    ['2027-01', []],
    ['marzo 2023', []],
    ['2023-3', []],
    ['2023-00', []],
    ['2023-13', []],
    ['2023-03\n', []],
  ])('%s → %j', (nascita, attesi) => {
    expect(gradiPerNascita(nascita, '2026-11-10')).toEqual(attesi)
  })

  it('cambia anno scolastico il 1° settembre', () => {
    expect(gradiPerNascita('2023-06', '2026-08-31')).toEqual(['nido', 'infanzia'])
    expect(gradiPerNascita('2023-06', '2026-09-01')).toEqual(['infanzia'])
  })

  it('accetta il 29 febbraio di un anno bisestile', () => {
    expect(gradiPerNascita('2023-11', '2024-02-29')).toEqual(['nido'])
    expect(gradiPerNascita('2023-12', '2024-02-29')).toEqual([])
  })

  it.each(['2023-02-29', '2026-04-31', '2026-01-00', '2026-13-01', '2026-9-01', '2026-09-01\n'])(
    'rifiuta il giorno invalido %s',
    (oggi) => expect(gradiPerNascita('2023-01', oggi)).toEqual([]),
  )
})

describe('meseDiNascita', () => {
  it('toglie il giorno da una data valida', () => {
    expect(meseDiNascita('2023-03-15')).toBe('2023-03')
    expect(meseDiNascita('2024-02-29')).toBe('2024-02')
    expect(meseDiNascita('2000-02-29')).toBe('2000-02')
  })

  it.each([null, undefined, '15/03/2023', '2023-03', '2023-03-15\n', '1900-02-29', '2024-04-31'])(
    'rifiuta la data mancante o invalida: %s',
    (nascita) => expect(meseDiNascita(nascita)).toBeNull(),
  )
})
