import { describe, it, expect, vi, afterEach } from 'vitest'
import { inizioGiornoRomaISO } from '@/lib/format/fiscal-date'

/**
 * IL CONFINE DEL GIORNO ITALIANO — e il modo sbagliato di calcolarlo.
 *
 * Serve al tetto giornaliero delle email di credenziali: «quante ne sono già uscite
 * OGGI» ha senso solo se «oggi» è il giorno di chi le riceve, non quello di UTC.
 *
 * ⚠️ LA SCORCIATOIA CHE SEMBRA GIUSTA E NON LO È:
 *
 *     new Date(oggiFiscaleISO() + 'T00:00:00Z')       // ← SBAGLIATO
 *
 * `oggiFiscaleISO()` dà la data italiana, ma appiccicarle una `Z` la interpreta come
 * mezzanotte UTC — che in Italia è l'una o le due di notte. Il conteggio sbaglierebbe
 * di un'ora o due esatte, cioè includerebbe (o escluderebbe) le email spedite in
 * quella fascia. Questo progetto ha già pagato un difetto di fuso orario, e la
 * lezione era che i quattro punti caduti insieme erano tutti «UTC contro Europe/Rome».
 *
 * I due casi qui sotto sono scelti perché stanno **dalle parti opposte del confine**
 * e in stagioni opposte: l'ora legale (+02:00) e quella solare (+01:00). Un solo caso
 * passerebbe per coincidenza — è già successo.
 */

afterEach(() => {
    vi.useRealTimers()
})

describe('inizioGiornoRomaISO', () => {
    it('a mezzanotte e mezza italiana, il giorno è già quello NUOVO (ora legale)', () => {
        // 23:30 UTC del 22 agosto = 01:30 del 23 agosto a Roma (+02:00).
        // L'inizio del giorno italiano corrente è quindi le 22:00 UTC del 22.
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-22T23:30:00Z'))
        expect(inizioGiornoRomaISO()).toBe('2026-08-22T22:00:00.000Z')
    })

    it('lo stesso, in ora solare (+01:00)', () => {
        // 00:30 UTC del 15 gennaio = 01:30 del 15 a Roma (+01:00).
        // L'inizio del giorno italiano è le 23:00 UTC del 14.
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-15T00:30:00Z'))
        expect(inizioGiornoRomaISO()).toBe('2026-01-14T23:00:00.000Z')
    })

    it('in pieno giorno, l\'inizio è la mezzanotte italiana appena passata', () => {
        // L'ora a cui gira il cron delle iscrizioni: 08:10 UTC = 10:10 di Roma.
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-23T08:10:00Z'))
        expect(inizioGiornoRomaISO()).toBe('2026-08-22T22:00:00.000Z')
    })

    it('è sempre nel passato, e mai più di 25 ore fa', () => {
        // Prova di sanità che non dipende da una data cablata: qualunque sia
        // l'implementazione, il confine non può stare nel futuro né a due giorni fa.
        const adesso = Date.now()
        const inizio = new Date(inizioGiornoRomaISO()).getTime()
        expect(inizio).toBeLessThanOrEqual(adesso)
        expect(adesso - inizio).toBeLessThan(25 * 60 * 60 * 1000)
    })
})
