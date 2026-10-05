import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BadgeMetodoPagamento } from '@/components/features/pagamenti/BadgeMetodoPagamento';

/**
 * Il badge «Solo contanti» / «Solo bonifico» (2026-10-05).
 *
 * Con entrambi i metodi — il caso normale, e quello del DB della CI senza la colonna — il
 * badge NON c'è: un'etichetta che dice «tutto come sempre» su ogni riga sarebbe rumore.
 * I testi li passa il chiamante (segreteria e genitore leggono da cataloghi diversi): qui
 * sono stringhe sintetiche, così il test non dipende da un catalogo.
 */
const TESTI = { testoSoloContanti: 'Solo contanti', testoSoloBonifico: 'Solo bonifico' };

describe('BadgeMetodoPagamento', () => {
  it('solo contanti → «Solo contanti», col tono di avviso del design system', () => {
    render(<BadgeMetodoPagamento metodi={['contanti']} {...TESTI} />);
    const badge = screen.getByTestId('badge-metodo-pagamento');
    expect(badge).toHaveTextContent('Solo contanti');
    expect(badge).toHaveClass('bg-kidville-warn-soft', 'text-kidville-warn-strong');
  });

  it('solo bonifico → «Solo bonifico»', () => {
    render(<BadgeMetodoPagamento metodi={['bonifico']} {...TESTI} />);
    expect(screen.getByTestId('badge-metodo-pagamento')).toHaveTextContent('Solo bonifico');
  });

  it('il className del chiamante arriva al badge', () => {
    render(<BadgeMetodoPagamento metodi={['contanti']} {...TESTI} className="ml-2 align-middle" />);
    expect(screen.getByTestId('badge-metodo-pagamento')).toHaveClass('ml-2', 'align-middle');
  });

  it.each([
    ['assente (DB della CI senza colonna)', undefined],
    ['null', null],
    ['entrambi', ['contanti', 'bonifico']],
    ['vuoto', []],
    ['solo valori ignoti', ['assegno']],
  ])('%s → nessun badge, e niente al suo posto', (_caso, metodi) => {
    // Un contenitore con una presenza accanto: l'assenza si legge su un render avvenuto.
    render(
      <p data-testid="riga">
        Gita allo zoo
        <BadgeMetodoPagamento metodi={metodi} {...TESTI} />
      </p>,
    );
    expect(screen.getByTestId('riga')).toHaveTextContent('Gita allo zoo');
    expect(screen.queryByTestId('badge-metodo-pagamento')).toBeNull();
    expect(screen.getByTestId('riga').innerHTML).toBe('Gita allo zoo');
  });
});
