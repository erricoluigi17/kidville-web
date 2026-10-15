import { describe, it, expect } from 'vitest'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { oggiRoma, intervalloGiornoRoma, politicaNotificaOperazione, puoCorreggereStorico, deveNotificareGenitori, istanteNelGiornoRoma } from '@/lib/storici/retroattivita'

const ORA = new Date('2026-10-14T22:30:00Z') // 15 ottobre a Roma
const utente = (role: AppUser['role']): AppUser => ({ id: 'operatore-fittizio', role })

describe('rettifiche storiche e politica originale delle notifiche', () => {
  it('oggi segue Roma anche se UTC è ancora ieri', () => expect(oggiRoma(ORA)).toBe('2026-10-15'))
  it.each(['admin', 'coordinator', 'segreteria'] as const)('%s corregge senza limiti e sopprime solo il passato', role => {
    expect(puoCorreggereStorico(utente(role))).toBe(true)
    for (const giorno of ['2020-01-01', '2026-10-14']) expect(deveNotificareGenitori(politicaNotificaOperazione({ attore: utente(role), giornoCompetenza: giorno, ora: ORA }))).toBe(false)
    for (const giorno of ['2026-10-15', '2026-10-16']) expect(deveNotificareGenitori(politicaNotificaOperazione({ attore: utente(role), giornoCompetenza: giorno, ora: ORA }))).toBe(true)
  })
  it.each(['educator', 'genitore', 'cuoca'] as const)('%s non acquisisce permessi o silenzio', role => {
    expect(puoCorreggereStorico(utente(role))).toBe(false)
    expect(deveNotificareGenitori(politicaNotificaOperazione({ attore: utente(role), giornoCompetenza: '2026-10-14', ora: ORA }))).toBe(true)
  })
  it('i ruoli reali prevalgono sulla veste attiva', () => {
    expect(puoCorreggereStorico({ ...utente('genitore'), ruoli: ['genitore', 'segreteria'] })).toBe(true)
  })
  it('domani non ricalcola come silenzioso un avviso di oggi in buffer', () => {
    const originale = politicaNotificaOperazione({ attore: utente('segreteria'), giornoCompetenza: '2026-10-15', ora: ORA })
    const differita = JSON.parse(JSON.stringify(originale))
    expect(differita).toEqual({ giornoCompetenza: '2026-10-15', giornoOperazioneRoma: '2026-10-15', sopprimiGenitori: false })
    expect(deveNotificareGenitori(differita)).toBe(true)
  })
  it.each([
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T21:59:59.999Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T22:59:59.999Z', 25],
    ['2026-10-15', '2026-10-14T22:00:00.000Z', '2026-10-15T21:59:59.999Z', 24],
  ])('giornata %s include tutte e sole le sue ore anche al cambio DST', (giorno, inizio, fine, ore) => {
    const intervallo = intervalloGiornoRoma(String(giorno))
    expect(intervallo).toEqual({ startOfDay: inizio, endOfDay: fine })
    expect((Date.parse(intervallo.endOfDay) + 1 - Date.parse(intervallo.startOfDay)) / 3_600_000).toBe(ore)
    expect(oggiRoma(new Date(istanteNelGiornoRoma(String(giorno), ORA)))).toBe(giorno)
  })
  it('date impossibili non diventano giorni diversi', () => expect(() => intervalloGiornoRoma('2026-02-30')).toThrow())
})


it('spostare dal passato a oggi resta silenzioso perché conta anche la competenza originale', () => {
  expect(deveNotificareGenitori(politicaNotificaOperazione({ attore: utente('segreteria'), giornoCompetenza: '2026-10-15', giornoOriginale: '2020-04-02', ora: ORA }))).toBe(false)
})
