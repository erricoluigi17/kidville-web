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

  /**
   * ─── GUARDIA DI REGRESSIONE: LA RICEVUTA NON SI SCARICA PIÙ DA QUI ──────────
   *
   * Questi due casi pretendevano il link «Ricevuta» — attivo a saldo avvenuto,
   * disabilitato prima — verso `GET /api/pagamenti/ricevuta`. Quella rotta è
   * stata CANCELLATA insieme alla ricevuta contabile per singolo pagamento: un
   * link rimasto lì darebbe 404 a chi lo preme, e nessun test se ne
   * accorgerebbe. Il ruolo dei due casi si ribalta: da «il link c'è» a «il link
   * non deve tornare», che è l'unica forma in cui una cancellazione resta
   * cancellata.
   *
   * ⚠️ NON SI ASSERISCE SU UN'ASSENZA E BASTA — un'assenza è verde anche se il
   * drawer non ha rinderizzato niente. Ogni caso pretende anche ciò che DEVE
   * esserci (il pulsante della fattura, il pulsante «Incassa»): senza quella
   * metà la prova passerebbe su una schermata vuota.
   *
   * ⚠️ E NON SI CERCA IL SOLO `link`: il ramo «non saldato» rendeva un `button`
   * disabilitato con la stessa parola. Si cerca il testo, qualunque forma abbia.
   */
  it('pagato → il pulsante della fattura, e NESSUN comando «Ricevuta»', async () => {
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    expect(await screen.findByTestId('fattura-button')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Incassa' })).toBeNull();
    // Né ancora, né bottone, né testo: la parola non compare più in questa schermata.
    expect(screen.queryByText(/Ricevuta/i)).toBeNull();
    // E soprattutto: nessun indirizzo verso la rotta che non esiste più.
    expect(document.body.innerHTML).not.toContain('/api/pagamenti/ricevuta');
  });

  it('non saldato → Incassa presente (chiama onIncassa) e nessun comando «Ricevuta»', async () => {
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
    // Il pulsante spento «Disponibile a saldo avvenuto» non c'è più: prometteva un
    // documento che, a saldo avvenuto, non sarebbe comunque arrivato.
    expect(screen.queryByText(/Ricevuta/i)).toBeNull();
    expect(document.body.innerHTML).not.toContain('/api/pagamenti/ricevuta');
    // Prima del saldo non c'è nemmeno la fattura: il ramo è `saldato && …`.
    expect(screen.queryByTestId('fattura-button')).toBeNull();
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
