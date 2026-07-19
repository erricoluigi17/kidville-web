import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MovimentoDialog } from '@/components/features/admin/pagamenti/MovimentoDialog';
import type { MovimentoUi, PagamentoApertoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';

// FatturaButton fa fetch proprie: stub per isolare il dialog.
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

// Etichette dei pagamenti aperti volutamente DISTINTE da quelle dei suggerimenti,
// così un'asserzione sulla ricerca manuale non pesca anche la lista suggerimenti.
const aperti: PagamentoApertoUi[] = [
  { id: 'pa1', descrizione: 'Iscrizione', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Tina', cognome: 'Blu' } },
  { id: 'pa2', descrizione: 'Mensa Novembre', importo: 60, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Ugo', cognome: 'Verdi' } },
];

const movBase: MovimentoUi = {
  id: 'm1',
  data_operazione: '2026-10-05',
  importo: 150,
  causale: 'Bonifico retta RSSMRA85T10A562S',
  controparte: 'Mario Rossi',
  stato: 'suggerito',
  suggerimenti: [
    { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Aldo Neri · Retta Ottobre (residuo € 150,00)' },
    { pagamento_id: 'p2', score: 50, motivi: ['importo esatto'], alunno_id: 'a2', label: 'Bea Neri · Retta Ottobre (residuo € 150,00)' },
  ],
  pagamento_id: null,
};

const ref = () => createRef<HTMLButtonElement>();

describe('MovimentoDialog', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('mostra i suggerimenti ordinati, con badge «CF» sul primo', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/Aldo Neri · Retta Ottobre/)).toBeInTheDocument();
    expect(screen.getByText('CF')).toBeInTheDocument();
    // l'importo è nell'intestazione (heading del dialog)
    expect(screen.getByRole('heading', { name: /150,00/ })).toBeInTheDocument();
  });

  it('«Conferma questo» chiama la PATCH col pagamento_id del suggerimento e chiude', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Conferma questo/ })[0]);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'conferma', pagamento_id: 'p1' }) }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('409 «già saldato» → messaggio chiaro, niente chiusura né crash', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Pagamento già saldato: ignora la riga o scegli un'altra voce" }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Conferma questo/ })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/già saldato/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('409 corsa persa → messaggio + refetch (onDone)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Movimento già riconciliato da un altro operatore' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Conferma questo/ })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/altro operatore/i);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('la ricerca manuale filtra i pagamenti aperti e abbina quello scelto', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const search = screen.getByLabelText(/Cerca un pagamento aperto/);
    fireEvent.change(search, { target: { value: 'ugo' } });
    // solo Ugo Verdi resta fra i pagamenti aperti; Tina Blu sparisce
    expect(screen.getByText(/Ugo Verdi · Mensa Novembre/)).toBeInTheDocument();
    expect(screen.queryByText(/Tina Blu · Iscrizione/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Abbina/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'conferma', pagamento_id: 'pa2' }) }),
    );
  });

  it('«Apri Incasso unico» compare SOLO per i multi-CF e solo se il chiamante lo aggancia', () => {
    vi.stubGlobal('fetch', vi.fn());
    const multiCf: MovimentoUi = {
      ...movBase,
      suggerimenti: [
        { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Figlio 1 · Retta' },
        { pagamento_id: 'p2', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a2', label: 'Figlio 2 · Retta' },
      ],
    };
    const onIncassoUnico = vi.fn();

    // multi-CF con handler → bottone presente
    const { unmount } = render(<MovimentoDialog movimento={multiCf} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onIncassoUnico={onIncassoUnico} />);
    fireEvent.click(screen.getByRole('button', { name: /Apri Incasso unico/ }));
    expect(onIncassoUnico).toHaveBeenCalledWith(multiCf);
    unmount();

    // multi-CF SENZA handler → nessun bottone (solo predisposizione)
    render(<MovimentoDialog movimento={multiCf} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.queryByRole('button', { name: /Apri Incasso unico/ })).toBeNull();
  });

  it('A5: i CTA primari del popup sono bianco su verde (AA), mai giallo', () => {
    vi.stubGlobal('fetch', vi.fn());
    const multiCf: MovimentoUi = {
      ...movBase,
      suggerimenti: [
        { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Figlio 1 · Retta' },
        { pagamento_id: 'p2', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a2', label: 'Figlio 2 · Retta' },
      ],
    };
    const { container } = render(
      <MovimentoDialog movimento={multiCf} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onIncassoUnico={() => {}} />,
    );
    // Conferma questo + Apri Incasso unico + Abbina presenti nella stessa vista
    expect(screen.getAllByRole('button', { name: /Conferma questo/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Apri Incasso unico/ })).toBeInTheDocument();
    // nessun testo giallo-su-verde (~4:1, sotto AA), neppure negli stati :hover
    expect(container.innerHTML).not.toContain('text-kidville-yellow');
  });

  it('non multi-CF → nessun «Apri Incasso unico» anche col handler', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onIncassoUnico={() => {}} />);
    expect(screen.queryByRole('button', { name: /Apri Incasso unico/ })).toBeNull();
  });

  it('movimento confermato + pagamento pagato → Ricevuta + Fattura + Riapri', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const ricevuta = await screen.findByRole('link', { name: /Ricevuta/ });
    expect(ricevuta).toHaveAttribute('href', expect.stringContaining('/api/pagamenti/ricevuta?pagamento_id=pg1'));
    expect(screen.getByTestId('fattura-button')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Riapri/ })).toBeInTheDocument();
    // niente suggerimenti/ricerca sui confermati
    expect(screen.queryByText(/Cerca un altro pagamento/)).toBeNull();
  });

  it('movimento confermato ma non ancora pagato → nota «a saldo avvenuto», niente ricevuta', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'parziale' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await waitFor(() => expect(screen.getByText(/a saldo avvenuto/i)).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Ricevuta/ })).toBeNull();
  });
});
