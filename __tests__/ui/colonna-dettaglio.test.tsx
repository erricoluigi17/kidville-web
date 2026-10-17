import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColonnaDettaglio } from '@/components/ui/ColonnaDettaglio';
import { QUERY_SCHERMO_STRETTO } from '@/lib/ui/use-schermo-stretto';

/**
 * `ColonnaDettaglio` — il dettaglio di un elenco lungo (candidature, moduli ricevuti).
 *
 * Il difetto da cui nasce (2026-10-17): il pannello stava IN CIMA alla colonna destra di una
 * griglia, quindi dopo aver scorso cinquanta curriculum e averne aperto uno, il dettaglio
 * compariva lassù — fuori dallo schermo — e per leggerlo si doveva risalire, e poi ridiscendere
 * a cercare il punto della lista. Sul telefono finiva sotto TUTTO l'elenco.
 *
 * Computer: la colonna resta ferma accanto alla lista (`sticky`) e scorre per conto suo.
 * Telefono: il dettaglio si apre in un foglio sopra la lista, che sotto non si muove.
 */

function simulaSchermo(stretto: boolean) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: q === QUERY_SCHERMO_STRETTO ? stretto : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const originale = window.matchMedia;
afterEach(() => {
  window.matchMedia = originale;
});

const base = {
  titolo: 'Candidatura',
  onChiudi: vi.fn(),
  occupato: false,
  segnaposto: <p>Seleziona una candidatura</p>,
};

describe('ColonnaDettaglio — computer', () => {
  it('senza selezione mostra il segnaposto, nella colonna che resta ferma', () => {
    simulaSchermo(false);
    const { container } = render(
      <ColonnaDettaglio {...base} aperto={false} chiaveContenuto={null}>
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    expect(screen.getByText('Seleziona una candidatura')).toBeInTheDocument();
    expect(screen.queryByText('dettaglio')).toBeNull();
    const colonna = container.querySelector('[aria-busy]') as HTMLElement;
    expect(colonna).toBeTruthy();
    // Ferma accanto alla lista, sotto la barra in alto (`AdminTopBar`, h-16), e con uno
    // scorrimento suo quando il dettaglio è più alto dello schermo.
    expect(colonna.className).toContain('lg:sticky');
    expect(colonna.className).toContain('lg:top-20');
    expect(colonna.className).toContain('lg:overflow-y-auto');
  });

  it('con una selezione mostra il dettaglio nella colonna, non in un foglio', () => {
    simulaSchermo(false);
    render(
      <ColonnaDettaglio {...base} aperto chiaveContenuto="a">
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    expect(screen.getByText('dettaglio')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('`aria-busy` dice il vero: falso a riposo, vero mentre il dettaglio si apre', () => {
    simulaSchermo(false);
    const { container, rerender } = render(
      <ColonnaDettaglio {...base} aperto chiaveContenuto="a">
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    expect(container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    rerender(
      <ColonnaDettaglio {...base} occupato aperto chiaveContenuto="a">
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    expect(container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  });

  it('aprendo un altro dettaglio, la colonna riparte dalla cima', () => {
    // Senza, aprendo il secondo curriculum dopo aver letto il fondo del primo, si
    // atterrerebbe a metà del secondo.
    simulaSchermo(false);
    const { container, rerender } = render(
      <ColonnaDettaglio {...base} aperto chiaveContenuto="a">
        <p>primo</p>
      </ColonnaDettaglio>,
    );
    const colonna = container.querySelector('[aria-busy]') as HTMLElement;
    colonna.scrollTop = 400;
    rerender(
      <ColonnaDettaglio {...base} aperto chiaveContenuto="b">
        <p>secondo</p>
      </ColonnaDettaglio>,
    );
    expect(colonna.scrollTop).toBe(0);
  });
});

describe('ColonnaDettaglio — telefono', () => {
  it('senza selezione non disegna niente: il segnaposto sotto una lista lunga non serve', () => {
    simulaSchermo(true);
    render(
      <ColonnaDettaglio {...base} aperto={false} chiaveContenuto={null}>
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    expect(screen.queryByText('Seleziona una candidatura')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('con una selezione apre un foglio a tutta larghezza sopra la lista', () => {
    simulaSchermo(true);
    render(
      <ColonnaDettaglio {...base} aperto chiaveContenuto="a">
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    const foglio = screen.getByRole('dialog', { name: 'Candidatura' });
    expect(foglio).toHaveTextContent('dettaglio');
    // Il pannello del foglio: a tutta larghezza, non al 92% del cassetto laterale.
    const pannello = foglio.querySelector('.max-w-full');
    expect(pannello, 'il foglio non è a tutta larghezza').toBeTruthy();
  });

  it('Escape chiude il foglio', () => {
    simulaSchermo(true);
    const onChiudi = vi.fn();
    render(
      <ColonnaDettaglio {...base} onChiudi={onChiudi} aperto chiaveContenuto="a">
        <p>dettaglio</p>
      </ColonnaDettaglio>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onChiudi).toHaveBeenCalledTimes(1);
  });
});
