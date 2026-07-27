import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ThreadSospensioneBanner } from '@/components/features/admin/messaggi/ThreadSospensioneBanner';

/**
 * Banner di sospensione nella supervisione chat (C5 §2).
 *
 * Il bottone «Riapri» compare SOLO quando la conversazione è sospesa E il
 * lettore è Direzione (`canReopen`): un membro dello staff non-Direzione vede
 * l'informazione ma non l'azione (il gate vero è comunque nella route /riapri).
 */

afterEach(() => cleanup());

describe('ThreadSospensioneBanner', () => {
  it('non mostra nulla quando la conversazione NON è sospesa', () => {
    const { container } = render(
      <ThreadSospensioneBanner sospensione={null} canReopen onRiapri={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /Riapri/i })).toBeNull();
  });

  it('sospesa + Direzione: mostra il banner e il bottone Riapri che chiama onRiapri', () => {
    const onRiapri = vi.fn();
    render(
      <ThreadSospensioneBanner
        sospensione={{ sospesaIl: '2026-07-27T10:00:00Z', motivo: 'toni aggressivi' }}
        canReopen
        onRiapri={onRiapri}
      />,
    );
    expect(screen.getByText(/sospesa/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Riapri/i });
    fireEvent.click(btn);
    expect(onRiapri).toHaveBeenCalledTimes(1);
  });

  it('sospesa ma NON Direzione: banner sì, bottone Riapri no', () => {
    render(
      <ThreadSospensioneBanner
        sospensione={{ sospesaIl: '2026-07-27T10:00:00Z', motivo: null }}
        canReopen={false}
        onRiapri={() => {}}
      />,
    );
    expect(screen.getByText(/sospesa/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Riapri/i })).toBeNull();
  });
});
