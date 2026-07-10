import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PagamentoDrawer } from '@/components/features/admin/pagamenti/PagamentoDrawer';

// FatturaButton fa fetch proprie: lo stubbiamo per isolare il drawer.
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const dettaglio = {
  success: true,
  data: {
    id: 'p1',
    descrizione: 'Retta Settembre 2026',
    importo: 150,
    importo_pagato: 150,
    stato: 'pagato',
    tipo: 'singolo',
    fattura_stato: 'non_richiesta',
    scadenza: '2026-09-05',
    alunni: { nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli' },
    payment_categories: { nome: 'Retta', slug: 'retta' },
    incassi: [
      { id: 'i1', importo: 100, data_incasso: '2026-09-03', metodo: 'bonifico', note: null, creato_il: '2026-09-03T10:00:00Z' },
      { id: 'i2', importo: 50, data_incasso: '2026-09-04', metodo: 'contanti', note: 'saldo', creato_il: '2026-09-04T10:00:00Z' },
    ],
    quote: [],
    rate: [],
  },
};

const pagamentoRow = {
  id: 'p1',
  descrizione: 'Retta Settembre 2026',
  importo: 150,
  importo_pagato: 150,
  stato: 'pagato',
  tipo: 'singolo',
  fattura_stato: 'non_richiesta',
  scadenza: '2026-09-05',
  alunni: { nome: 'Mario', cognome: 'Rossi' },
};

describe('PagamentoDrawer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => dettaglio })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carica il dettaglio e mostra la timeline incassi con i metodi', async () => {
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    expect(screen.getByText('Retta Settembre 2026')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Bonifico')).toBeInTheDocument());
    expect(screen.getByText('Contanti')).toBeInTheDocument();
    expect(screen.getByText('saldo')).toBeInTheDocument();
  });

  it('pagato → link ricevuta attivo e niente bottone Incassa', async () => {
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    const ricevuta = await screen.findByRole('link', { name: /Ricevuta/ });
    expect(ricevuta).toHaveAttribute('href', expect.stringContaining('/api/pagamenti/ricevuta?pagamento_id=p1'));
    expect(screen.queryByRole('button', { name: 'Incassa' })).toBeNull();
    expect(screen.getByTestId('fattura-button')).toBeInTheDocument();
  });

  it('non saldato → Incassa presente (chiama onIncassa) e ricevuta disabilitata', async () => {
    const row = { ...pagamentoRow, stato: 'da_pagare', importo_pagato: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { ...dettaglio.data, stato: 'da_pagare', importo_pagato: 0, incassi: [] } }),
    })));
    const onIncassa = vi.fn();
    render(
      <PagamentoDrawer pagamento={row} userId="u1" onClose={() => {}}
        onIncassa={onIncassa} onModifica={() => {}} onRateizza={() => {}} />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Incassa' }));
    expect(onIncassa).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /Ricevuta/ })).toBeNull();
    // il bottone ricevuta esiste ma è disabilitato con spiegazione
    expect(screen.getByRole('button', { name: /Ricevuta/ })).toBeDisabled();
  });

  it('uno storno (importo negativo) è etichettato come tale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          ...dettaglio.data,
          incassi: [{ id: 'i3', importo: -50, data_incasso: '2026-09-05', metodo: 'contanti', note: null, creato_il: '2026-09-05T10:00:00Z' }],
        },
      }),
    })));
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    await waitFor(() => expect(screen.getByText('Storno')).toBeInTheDocument());
  });
});
