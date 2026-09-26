import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

/**
 * P2b (26/09) — con più sedi accorpate l'agenda dice DI QUALE SEDE sono le scadenze di
 * ogni bucket. I bucket sono aggregati, quindi la sede compare come ripartizione dei
 * conteggi («Aversa 1 · Giugliano 2»), non come badge per riga.
 */
describe('AgendaScadenze — sede (P2b)', () => {
  const rowsSede = [
    { importo: 100, importo_pagato: 0, scadenza: '2026-05-01', stato: 'scaduto', tipo: 'singolo', scuola_nome: 'Kidville Giugliano' },
    { importo: 60, importo_pagato: 0, scadenza: '2026-05-03', stato: 'scaduto', tipo: 'singolo', scuola_nome: 'Kidville Giugliano' },
    { importo: 40, importo_pagato: 0, scadenza: '2026-05-04', stato: 'scaduto', tipo: 'singolo', scuola_nome: 'Kidville Aversa' },
    { importo: 80, importo_pagato: 0, scadenza: '2026-07-12', stato: 'da_pagare', tipo: 'singolo', scuola_nome: 'Kidville Cesa' },
    { importo: 30, importo_pagato: 0, scadenza: '2026-07-13', stato: 'da_pagare', tipo: 'singolo', scuola_nome: null },
  ];

  it('mostraSede: ogni bucket ripartisce il conteggio per sede, in ordine alfabetico', () => {
    render(<AgendaScadenze pagamenti={rowsSede} oggi="2026-07-10" attivo={null} onSelect={() => {}} mostraSede />);
    const oltre = screen.getByRole('button', { name: /Scaduti oltre 30gg/ });
    const rip = within(oltre).getByTestId('agenda-sedi');
    expect(rip).toHaveTextContent('Kidville Aversa 1');
    expect(rip).toHaveTextContent('Kidville Giugliano 2');
    expect(rip.textContent!.indexOf('Aversa')).toBeLessThan(rip.textContent!.indexOf('Giugliano'));
    expect(rip).not.toHaveTextContent('Cesa');
  });

  it('mostraSede: lo screen reader sente una pausa fra una sede e l\'altra, non «Aversa 1 Giugliano 2»', () => {
    render(<AgendaScadenze pagamenti={rowsSede} oggi="2026-07-10" attivo={null} onSelect={() => {}} mostraSede />);
    const rip = within(screen.getByRole('button', { name: /Scaduti oltre 30gg/ })).getByTestId('agenda-sedi');
    // Quel che resta togliendo ciò che è `aria-hidden` (la riga visiva col «·») è ciò che viene letto:
    // UNA frase, la cornice dal catalogo e la congiunzione italiana di Intl.ListFormat.
    const letto = rip.cloneNode(true) as HTMLElement;
    letto.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    expect(letto.textContent).toBe('Ripartizione per sede: Kidville Aversa 1 e Kidville Giugliano 2');
    // Il «·» si vede ma non si legge.
    const visivo = rip.querySelector('[aria-hidden="true"]');
    expect(visivo?.textContent).toBe('Kidville Aversa 1·Kidville Giugliano 2');
  });

  it('mostraSede: con tre voci l\'elenco letto usa la forma della lingua («A, B e C»)', () => {
    const tre = [...rowsSede, { importo: 10, importo_pagato: 0, scadenza: '2026-05-05', stato: 'scaduto', tipo: 'singolo', scuola_nome: 'Kidville Cesa' }];
    render(<AgendaScadenze pagamenti={tre} oggi="2026-07-10" attivo={null} onSelect={() => {}} mostraSede />);
    const rip = within(screen.getByRole('button', { name: /Scaduti oltre 30gg/ })).getByTestId('agenda-sedi');
    expect(rip.querySelector('.sr-only')?.textContent).toBe(
      'Ripartizione per sede: Kidville Aversa 1, Kidville Cesa 1 e Kidville Giugliano 2',
    );
  });

  it('mostraSede: una riga senza sede è contata come «Sede non indicata», non sparisce', () => {
    render(<AgendaScadenze pagamenti={rowsSede} oggi="2026-07-10" attivo={null} onSelect={() => {}} mostraSede />);
    const sett = within(screen.getByRole('button', { name: /Questa settimana/ })).getByTestId('agenda-sedi');
    expect(sett).toHaveTextContent('Kidville Cesa 1');
    expect(sett).toHaveTextContent('Sede non indicata 1');
    // Contratto P2b.md: nell'agenda «Sede non indicata» è TESTO della ripartizione, in fondo,
    // senza Badge e senza tono `warn` (diverso da card e drawer).
    expect(sett.textContent?.trim()).toMatch(/Sede non indicata 1$/);
    expect(sett.querySelector('[data-testid="sede-badge"]')).toBeNull();
    expect(sett.querySelector('.bg-kidville-warn-soft, .text-kidville-warn-strong')).toBeNull();
    expect(sett).not.toHaveClass('bg-kidville-warn-soft');
  });

  it('mostraSede: un bucket vuoto non mostra la ripartizione', () => {
    render(<AgendaScadenze pagamenti={rowsSede} oggi="2026-07-10" attivo={null} onSelect={() => {}} mostraSede />);
    expect(within(screen.getByRole('button', { name: /Scaduti fino a 30gg/ })).queryByTestId('agenda-sedi')).toBeNull();
  });

  it('senza mostraSede il rendering è IDENTICO a quello senza sede nei dati', () => {
    const senzaSedeNeiDati = rowsSede.map((r) => { const c: Record<string, unknown> = { ...r }; delete c.scuola_nome; return c as unknown as (typeof rows)[number]; });
    const oggiHtml = render(<AgendaScadenze pagamenti={senzaSedeNeiDati} oggi="2026-07-10" attivo={null} onSelect={() => {}} />).container.innerHTML;
    const { container: c1 } = render(<AgendaScadenze pagamenti={rowsSede} oggi="2026-07-10" attivo={null} onSelect={() => {}} />);
    const { container: c2 } = render(<AgendaScadenze pagamenti={rowsSede} oggi="2026-07-10" attivo={null} onSelect={() => {}} mostraSede={false} />);
    expect(c1.innerHTML).toBe(oggiHtml);
    expect(c2.innerHTML).toBe(oggiHtml);
    expect(c1.textContent).not.toMatch(/Giugliano|Aversa|Cesa|Sede/);
    expect(c1.querySelector('[data-testid="agenda-sedi"]')).toBeNull();
  });
});
