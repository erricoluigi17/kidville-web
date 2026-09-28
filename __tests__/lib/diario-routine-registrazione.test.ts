import { describe, it, expect } from 'vitest';

import { voceDaMostrare, eventoSelettivo, eliminabile } from '@/lib/diary/registrazione';

/**
 * LE ROUTINE DELLA SCUOLA SEGUONO LE REGOLE DELLE ALTRE (2026-09-28).
 *
 * Senza una regola, `voceDaMostrare` è fail-open: una routine nuova si sarebbe salvata a TUTTI i
 * bambini, anche a chi la maestra non ha toccato, e il genitore avrebbe letto una riga vuota — il
 * difetto delle 323 righe di bagno vuote del 2026-09-08, rifatto per ogni routine aggiunta.
 */
describe('routine della scuola: selettive, con il cestino, vuote = non si salvano', () => {
    const tipo = 'routine:a1b2c3d4';

    it('si salvano solo a chi è stato segnato', () => {
        expect(eventoSelettivo(tipo)).toBe(true);
        expect(voceDaMostrare(tipo, { nome: 'Crema', emoji: '🧴', risposta: 'spunta', valore: true })).toBe(true);
        expect(voceDaMostrare(tipo, { nome: 'Crema', emoji: '🧴', risposta: 'spunta', valore: null })).toBe(false);
        expect(voceDaMostrare(tipo, {})).toBe(false);
    });

    it('una nota tiene in piedi la voce, come per le altre routine', () => {
        expect(voceDaMostrare(tipo, { risposta: 'spunta', valore: null }, { conNota: true })).toBe(true);
    });

    it('una registrazione sbagliata si cancella: il salvataggio selettivo senza cestino è una trappola', () => {
        expect(eliminabile(tipo)).toBe(true);
    });

    it('presidio — un tipo col prefisso ma senza un id valido non è una routine della scuola', () => {
        expect(eventoSelettivo('routine:')).toBe(false);
        expect(eliminabile('routine:../x')).toBe(false);
    });
});
