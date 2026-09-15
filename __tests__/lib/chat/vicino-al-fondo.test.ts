import { describe, it, expect } from 'vitest';
import { vicinoAlFondo } from '@/lib/chat/stato-conversazione';

/**
 * CHI LEGGE È IN FONDO ALLA CONVERSAZIONE? (2026-09-14)
 *
 * Dal 2026-09-14 lo storico si chiede a mano («Carica messaggi precedenti»), e chi lo legge sta più
 * su dell'ultimo messaggio. Un messaggio in arrivo deve portare in fondo chi era già lì, e lasciare
 * dov'è chi sta leggendo lo storico. «In fondo» è una soglia, e una soglia si prova sui confini:
 * un pixel di qua, un pixel di là.
 *
 * `scrollHeight − scrollTop − clientHeight` è la distanza dal fondo, come la misura un browser.
 */

/** Il contenitore con la sua altezza visibile e il suo contenuto, scorso a `distanza` px dal fondo. */
function aDistanza(distanza: number, clientHeight: number, scrollHeight = 5000) {
    return { scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight - distanza };
}

describe('vicinoAlFondo', () => {
    it('esattamente in fondo: sì', () => {
        expect(vicinoAlFondo(aDistanza(0, 500))).toBe(true);
    });

    it('in cima a una conversazione lunga: no', () => {
        expect(vicinoAlFondo({ scrollHeight: 5000, clientHeight: 500, scrollTop: 0 })).toBe(false);
    });

    it('con un contenitore basso la soglia è 150 px: a 150 sì, a 151 no', () => {
        // Un terzo di 300 è 100: vale il minimo di 150, altrimenti su uno schermo basso anche una
        // bolla sola basterebbe a non essere più «in fondo».
        expect(vicinoAlFondo(aDistanza(150, 300))).toBe(true);
        expect(vicinoAlFondo(aDistanza(151, 300))).toBe(false);
    });

    it('con un contenitore alto la soglia è un terzo dell’altezza visibile: a 300 sì, a 301 no', () => {
        // Un terzo di 900 è 300: l'ultima bolla può essere un'immagine alta, e chi la guarda è in fondo.
        expect(vicinoAlFondo(aDistanza(300, 900))).toBe(true);
        expect(vicinoAlFondo(aDistanza(301, 900))).toBe(false);
    });

    it('un contenitore non impaginato (display:none, tutte le misure a zero) risulta in fondo', () => {
        // È l'istanza nascosta delle due che le pagine montano: lo scorrimento che le si chiede non fa niente.
        expect(vicinoAlFondo({ scrollHeight: 0, clientHeight: 0, scrollTop: 0 })).toBe(true);
    });

    it('il rimbalzo oltre il fondo (distanza negativa, iOS) resta in fondo', () => {
        expect(vicinoAlFondo(aDistanza(-40, 500))).toBe(true);
    });
});
