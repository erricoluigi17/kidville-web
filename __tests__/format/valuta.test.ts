import { describe, it, expect } from 'vitest';
import { formatEuro, euroFormatter } from '@/lib/format/valuta';

// Helper valuta condiviso it-IT: simbolo in testa, virgola decimale, punto
// separatore migliaia (spaziatura unica «€ …»). Fonte unica per l'intera app.
describe('formatEuro', () => {
    it('formatta un intero con due decimali e virgola', () => {
        expect(formatEuro(150)).toBe('€ 150,00');
    });

    it('usa il punto come separatore delle migliaia (anche per 4 cifre)', () => {
        // it-IT ha minimumGroupingDigits=2: senza useGrouping esplicito 1234 non
        // verrebbe raggruppato. Deve comunque risultare «€ 1.234,50».
        expect(formatEuro(1234.5)).toBe('€ 1.234,50');
        expect(formatEuro(12345.6)).toBe('€ 12.345,60');
        expect(formatEuro(1000000)).toBe('€ 1.000.000,00');
    });

    it('gestisce i negativi (segno prima del numero)', () => {
        expect(formatEuro(-150)).toBe('€ -150,00');
        expect(formatEuro(-1234.5)).toBe('€ -1.234,50');
    });

    it('accetta stringhe numeriche', () => {
        expect(formatEuro('150')).toBe('€ 150,00');
        expect(formatEuro('1234.5')).toBe('€ 1.234,50');
    });

    it('degrada a «€ 0,00» per null/undefined/NaN/stringa vuota', () => {
        expect(formatEuro(null)).toBe('€ 0,00');
        expect(formatEuro(undefined)).toBe('€ 0,00');
        expect(formatEuro(NaN)).toBe('€ 0,00');
        expect(formatEuro('')).toBe('€ 0,00');
        expect(formatEuro('abc')).toBe('€ 0,00');
    });

    it('arrotonda a due decimali', () => {
        expect(formatEuro(1.005)).toBe('€ 1,01');
        expect(formatEuro(0.1 + 0.2)).toBe('€ 0,30');
    });

    it('espone un formatter Intl memoizzato (stessa istanza)', () => {
        expect(euroFormatter).toBeInstanceOf(Intl.NumberFormat);
        expect(euroFormatter.resolvedOptions().currency).toBe('EUR');
    });
});
