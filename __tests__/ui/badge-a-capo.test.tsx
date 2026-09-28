import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, classiBadge } from '@/components/ui/Badge';

/**
 * `aCapo` (revisione 2026-09-28, C1) — il Badge che PUÒ andare a capo.
 *
 * Il Badge è `whitespace-nowrap`: giusto per «Pagato», sbagliato per «Paga il fratello Mario
 * Rossi (Sez. C) · Non generata», che col font vero misura 355 px contro i ~251 px che la card
 * mobile ha a 360 px di schermo. Passare `whitespace-normal` da `className` NON basta: `cx`
 * concatena, e fra due utility di pari specificità decide l'ordine nel FOGLIO di stile, non
 * quello nell'attributo (vedi `inCorso` in Badge.tsx). Quindi la prop SOSTITUISCE la classe,
 * e questo test guarda che nell'elemento ci sia UNA sola regola di `white-space`.
 */
const regoleWhitespace = (el: Element) =>
    [...el.classList].filter((c) => /^!?whitespace-/.test(c) || /^whitespace-.*!$/.test(c));

describe('Badge — aCapo', () => {
    it('predefinito INVARIATO: una riga, pillola', () => {
        render(<Badge tone="neutral">Da pagare</Badge>);
        const b = screen.getByText('Da pagare');
        expect(regoleWhitespace(b)).toEqual(['whitespace-nowrap']);
        expect(b).toHaveClass('rounded-pill');
    });

    it('aCapo: la sola regola è whitespace-normal, allineato a sinistra, largo al più il contenitore', () => {
        render(<Badge tone="neutral" aCapo>Paga il fratello Mario Rossi (Sez. C) · Non generata</Badge>);
        const b = screen.getByText(/Paga il fratello/);
        expect(regoleWhitespace(b)).toEqual(['whitespace-normal']);
        expect(b).toHaveClass('text-left', 'max-w-full');
        // Su due righe una pillola da 9999px mangia gli angoli del testo: raggio fisso.
        expect(b).not.toHaveClass('rounded-pill');
        // Il tono resta quello di sempre.
        expect(b).toHaveClass('bg-kidville-neutral-soft');
    });

    // K3 (seconda revisione 2026-09-28): `break-words` è `overflow-wrap: break-word`, che NON
    // riduce la larghezza minima del contenuto: dove la decide il contenuto una parola
    // lunghissima allargava tutto (misurato: un cognome di 80 caratteri portava la colonna
    // «Stato» della tabella Rette a 552 px a 1024 px di schermo). `anywhere` sì. E una sola
    // regola di `overflow-wrap`: con due, deciderebbe l'ordine nel foglio di stile.
    const regoleOverflowWrap = (el: Element) =>
        [...el.classList].filter((c) => /^!?(break-words|break-normal|wrap-)|overflow-wrap/.test(c));
    it('aCapo: una parola lunghissima va a capo anche a metà — `[overflow-wrap:anywhere]` come UNICA regola', () => {
        render(<Badge tone="neutral" aCapo>{`Paga il fratello ${'X'.repeat(80)}`}</Badge>);
        expect(regoleOverflowWrap(screen.getByText(/Paga il fratello/))).toEqual(['[overflow-wrap:anywhere]']);
    });
    it('predefinito: nessuna regola di overflow-wrap (la pillola non va a capo)', () => {
        render(<Badge tone="neutral">Pagato</Badge>);
        expect(regoleOverflowWrap(screen.getByText('Pagato'))).toEqual([]);
    });

    it('la prop non finisce nel DOM come attributo', () => {
        render(<Badge aCapo>x</Badge>);
        expect(screen.getByText('x')).not.toHaveAttribute('acapo');
        expect(screen.getByText('x')).not.toHaveAttribute('aCapo');
    });

    it('classiBadge: stesso contratto per chi non è uno span', () => {
        expect(classiBadge('warn').split(' ')).toContain('whitespace-nowrap');
        const aCapo = classiBadge('warn', undefined, { aCapo: true }).split(' ');
        expect(aCapo).toContain('whitespace-normal');
        expect(aCapo).not.toContain('whitespace-nowrap');
    });
});
