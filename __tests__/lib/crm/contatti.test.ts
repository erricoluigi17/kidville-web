import { describe, expect, it } from 'vitest'
import { contattiNormalizzati, normalizzaEmail, normalizzaTelefono } from '@/lib/crm/contatti'

/**
 * Il confronto fra due schede passa dai contatti NORMALIZZATI: lo stesso numero scritto in tre modi
 * (`+39 333 000 0001`, `0039 333-0000001`, `333 0000001`) deve diventare la stessa stringa, altrimenti
 * la stessa famiglia apre due schede. Solo numeri e indirizzi finti (`333 000 0001`, `prova@example.com`).
 */
describe('normalizzaTelefono', () => {
    it('toglie il prefisso internazionale, in tutte le grafie', () => {
        expect(normalizzaTelefono('+39 333 000 0001')).toBe('3330000001')
        expect(normalizzaTelefono('0039 333-0000001')).toBe('3330000001')
        expect(normalizzaTelefono('333 0000001')).toBe('3330000001')
        expect(normalizzaTelefono('+39333.000.0001')).toBe('3330000001')
        expect(normalizzaTelefono('(+39) 333/000-0001')).toBe('3330000001')
    })

    it('il fisso resta com’è', () => {
        expect(normalizzaTelefono('081 000 0001')).toBe('0810000001')
        expect(normalizzaTelefono('+39 081 000 0001')).toBe('0810000001')
    })

    it('troppo corto, vuoto o senza cifre: null', () => {
        expect(normalizzaTelefono('12345')).toBeNull()
        expect(normalizzaTelefono('12345678')).toBeNull()
        expect(normalizzaTelefono('')).toBeNull()
        expect(normalizzaTelefono('   ')).toBeNull()
        expect(normalizzaTelefono('abc')).toBeNull()
        expect(normalizzaTelefono(null)).toBeNull()
        expect(normalizzaTelefono(undefined)).toBeNull()
    })

    it('nove cifre (un fisso corto) tengono le cifre che ci sono', () => {
        expect(normalizzaTelefono('081 000 001')).toBe('081000001')
    })

    it('più di dieci cifre senza prefisso 39: le ultime dieci (regola del piano, anche per i numeri esteri)', () => {
        expect(normalizzaTelefono('00 44 333 000 0001')).toBe('3330000001')
    })

    it('un numero di dieci cifre che comincia per 39 non perde le prime due', () => {
        expect(normalizzaTelefono('393 000 0001')).toBe('3930000001')
    })
})

describe('normalizzaEmail', () => {
    it('minuscolo e senza spazi', () => {
        expect(normalizzaEmail('  Prova@Example.COM ')).toBe('prova@example.com')
    })

    it('senza chiocciola, vuota o assente: null', () => {
        expect(normalizzaEmail('senza-chiocciola')).toBeNull()
        expect(normalizzaEmail('')).toBeNull()
        expect(normalizzaEmail('   ')).toBeNull()
        expect(normalizzaEmail(null)).toBeNull()
        expect(normalizzaEmail(undefined)).toBeNull()
    })
})

describe('contattiNormalizzati', () => {
    it('toglie i doppioni e i null', () => {
        expect(contattiNormalizzati({ telefoni: ['+39 333 000 0001', '3330000001', null], email: [] })).toEqual({
            telefoni_norm: ['3330000001'],
            email_norm: [],
        })
    })

    it('tiene l’ordine di arrivo e scarta ciò che non è valido', () => {
        expect(
            contattiNormalizzati({
                telefoni: ['081 000 0001', '12345', '+39 333 000 0001', undefined],
                email: ['Prova@Example.com', 'prova@example.com', 'rotta', null],
            }),
        ).toEqual({ telefoni_norm: ['0810000001', '3330000001'], email_norm: ['prova@example.com'] })
    })

    it('tutto vuoto: due liste vuote', () => {
        expect(contattiNormalizzati({ telefoni: [], email: [] })).toEqual({ telefoni_norm: [], email_norm: [] })
    })
})
