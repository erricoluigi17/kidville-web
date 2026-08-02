import { describe, it, expect } from 'vitest'
import { formattaIstante, intlDateTime } from '@/i18n/config'

/**
 * `formattaIstante` — fuso, regione, e soprattutto NIENTE ECCEZIONI.
 *
 * ─── DA DOVE VIENE ──────────────────────────────────────────────────────────
 *
 * Sostituendo le 71 `toLocale*String` senza fuso è venuta a galla una
 * differenza che non si vede leggendo il codice, perché le due forme sembrano
 * la stessa cosa e si comportano in modo OPPOSTO sull'unico caso che conta:
 *
 *   new Date(undefined).toLocaleDateString('it-IT')  → "Invalid Date"
 *   new Intl.DateTimeFormat('it-IT').format(quella)  → RangeError: Invalid time value
 *
 * Il vecchio codice, davanti a una colonna nulla, stampava una stringa brutta e
 * tirava dritto. La conversione «corretta» l'ha trasformata in un'eccezione —
 * cioè, dentro una route, in un **500**. Misurato il 2026-08-01 su
 * `GET /api/pagamenti/ricevuta`: una ricevuta senza `creato_il` faceva fallire
 * il download del PDF a una famiglia. Il test della route è diventato rosso, ed
 * è così che si è visto.
 *
 * Questo file è la rete che impedisce di rimetterlo: se qualcuno «semplifica»
 * `formattaIstante` in un `intlDateTime(...).format(...)` diretto, qui diventa
 * rosso prima che lo diventi una ricevuta.
 */

describe('formattaIstante — non lancia mai', () => {
    it('una data non valida diventa stringa vuota, non un\'eccezione', () => {
        // Il controllo che tiene: `Intl` LANCIA sulla stessa data.
        expect(() => intlDateTime('it').format(new Date('non-una-data'))).toThrow(RangeError)
        expect(formattaIstante('non-una-data', 'it')).toBe('')
    })

    it('null, undefined e stringa vuota danno stringa vuota', () => {
        expect(formattaIstante(null, 'it')).toBe('')
        expect(formattaIstante(undefined, 'it')).toBe('')
        expect(formattaIstante('', 'it')).toBe('')
        expect(formattaIstante(new Date(Number.NaN), 'it')).toBe('')
    })

    it('e su una data VERA formatta davvero (controllo positivo)', () => {
        // Senza questo, una funzione che ritornasse sempre '' passerebbe tutto
        // quanto sopra.
        expect(formattaIstante('2026-11-05T09:30:00Z', 'it')).toBe('05/11/2026')
        expect(formattaIstante(new Date('2026-11-05T09:30:00Z'), 'it')).toBe('05/11/2026')
        expect(formattaIstante(Date.parse('2026-11-05T09:30:00Z'), 'it')).toBe('05/11/2026')
    })

    it('dichiara il fuso della scuola: mezzanotte e mezza a Roma è il 31, non il 30', () => {
        // 2026-07-30 22:30 UTC = 2026-07-31 00:30 a Roma. È il caso in cui il
        // giorno del server e quello della famiglia non coincidono.
        expect(formattaIstante('2026-07-30T22:30:00Z', 'it')).toBe('31/07/2026')
        expect(formattaIstante('2026-07-30T22:30:00Z', 'it', { hour: '2-digit', minute: '2-digit' })).toBe('00:30')
        // …e resta sovrascrivibile per i valori già ancorati a UTC.
        expect(formattaIstante('2026-07-30T22:30:00Z', 'it', { timeZone: 'UTC' })).toBe('30/07/2026')
    })

    it('dichiara la regione: «en» è en-GB, non en-US', () => {
        expect(formattaIstante('2026-11-05T09:30:00Z', 'en')).toBe('05/11/2026')
        expect(formattaIstante('2026-11-05T09:30:00Z', 'en')).not.toBe('11/5/2026')
        expect(formattaIstante('2026-11-05T09:30:00Z', 'en', { hour: '2-digit', minute: '2-digit' })).toBe('10:30')
    })
})
