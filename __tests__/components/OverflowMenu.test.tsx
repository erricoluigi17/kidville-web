import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverflowMenu } from '@/components/ui/OverflowMenu';

// Menu generico a tre puntini (⋮): trigger accessibile, apertura/chiusura,
// click-fuori ed Escape. Riusabile ovunque serva un menu di azioni compatto.
describe('OverflowMenu', () => {
  it('il trigger espone aria-haspopup="menu" e parte chiuso', () => {
    render(
      <OverflowMenu label="Altre azioni">
        <button role="menuitem">Voce</button>
      </OverflowMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Altre azioni' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('click apre il menu e mostra le voci', () => {
    render(
      <OverflowMenu label="Altre azioni">
        <button role="menuitem">Segnala</button>
      </OverflowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Altre azioni' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Segnala' })).toBeInTheDocument();
  });

  it('Escape chiude il menu', () => {
    render(
      <OverflowMenu label="Altre azioni">
        <button role="menuitem">Segnala</button>
      </OverflowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Altre azioni' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('click fuori dal menu lo chiude', () => {
    render(
      <div>
        <OverflowMenu label="Altre azioni">
          <button role="menuitem">Segnala</button>
        </OverflowMenu>
        <button>fuori</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Altre azioni' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'fuori' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('cliccare una voce del menu lo chiude', () => {
    render(
      <OverflowMenu label="Altre azioni">
        <button role="menuitem">Segnala</button>
      </OverflowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Altre azioni' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Segnala' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
