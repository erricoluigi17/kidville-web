import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgendaScadenze } from '@/components/features/admin/pagamenti/AgendaScadenze';

const rows = [
  { importo: 100, importo_pagato: 0, scadenza: '2026-05-01', stato: 'scaduto', tipo: 'singolo' },
  { importo: 80, importo_pagato: 0, scadenza: '2026-07-12', stato: 'da_pagare', tipo: 'singolo' },
];

describe('AgendaScadenze', () => {
  it('mostra i 4 bucket con conteggi', () => {
    render(<AgendaScadenze pagamenti={rows} oggi="2026-07-10" attivo={null} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /Scaduti oltre 30gg/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Questa settimana/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Scaduti fino a 30gg/ })).toHaveTextContent('0');
  });

  it('click su un bucket → onSelect(id); click sul bucket attivo → onSelect(null)', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<AgendaScadenze pagamenti={rows} oggi="2026-07-10" attivo={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Scaduti oltre 30gg/ }));
    expect(onSelect).toHaveBeenCalledWith('scaduti_oltre_30');
    rerender(<AgendaScadenze pagamenti={rows} oggi="2026-07-10" attivo="scaduti_oltre_30" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Scaduti oltre 30gg/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('il bucket attivo è marcato aria-pressed', () => {
    render(<AgendaScadenze pagamenti={rows} oggi="2026-07-10" attivo="settimana" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /Questa settimana/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Scaduti oltre 30gg/ })).toHaveAttribute('aria-pressed', 'false');
  });
});
