import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TransazioniPanel } from '@/components/features/admin/pagamenti/TransazioniPanel';

// FatturaButton fa fetch proprie: stub per isolare il pannello.
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const famiglia = {
  parent: { id: 'genitore-1', nome: 'Genitore Uno' },
  figli: [
    { id: 'al-1', nome: 'Uno', cognome: 'Rossi', saldo_ticket: 0 },
    { id: 'al-2', nome: 'Due', cognome: 'Rossi', saldo_ticket: 0 },
    { id: 'al-3', nome: 'Tre', cognome: 'Rossi', saldo_ticket: 0 },
  ],
  voci: [
    { id: 'v1', alunno_id: 'al-1', descrizione: 'Retta Uno', importo: 100, importo_pagato: 0, residuo: 100, scadenza: null, stato_effettivo: 'aperto' },
    { id: 'v2', alunno_id: 'al-2', descrizione: 'Retta Due', importo: 100, importo_pagato: 0, residuo: 100, scadenza: null, stato_effettivo: 'aperto' },
    { id: 'v3', alunno_id: 'al-3', descrizione: 'Retta Tre', importo: 100, importo_pagato: 0, residuo: 100, scadenza: null, stato_effettivo: 'aperto' },
  ],
  credito: 0,
};

const parents = [{ id: 'genitore-1', first_name: 'Genitore', last_name: 'Uno' }];

function stubFetch() {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/api/pagamenti/famiglia')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: famiglia }) };
    }
    if (String(url).includes('/api/admin/parents')) {
      return { ok: true, status: 200, json: async () => parents };
    }
    if (String(url).includes('/api/pagamenti/transazioni')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: [], disponibile: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

describe('TransazioniPanel — precompilazione da bonifico multi-CF', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('con pagante risolto: carica la famiglia, precompila totale/riferimento e pre-spunta SOLO le voci degli alunni riconosciuti', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(
      <TransazioniPanel
        userId="u1" scuolaId="s1"
        precompila={{ parent: 'genitore-1', rif: 'BONIFICO FAMIGLIA', tot: 200, alunni: ['al-1', 'al-2'] }}
      />,
    );

    // Arriva allo step «importi» (compare la testata «Voci da saldare»)
    await waitFor(() => expect(screen.getByText(/Voci da saldare/)).toBeInTheDocument());

    expect((screen.getByLabelText('Totale versato (€)') as HTMLInputElement).value).toBe('200');
    expect((screen.getByLabelText('Riferimento / CRO') as HTMLInputElement).value).toBe('BONIFICO FAMIGLIA');

    // Voci degli alunni riconosciuti pre-spuntate; quella dell'altro figlio no.
    expect((screen.getByLabelText('Includi Retta Uno') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Includi Retta Due') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Includi Retta Tre') as HTMLInputElement).checked).toBe(false);
  });

  it('pagante NON risolto (parent null): resta su «scegli pagante», e totale/riferimento sopravvivono alla scelta manuale del pagante', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(
      <TransazioniPanel
        userId="u1" scuolaId="s1"
        precompila={{ parent: null, rif: 'CAUSALE X', tot: 150, alunni: [] }}
      />,
    );

    // Step «scegli pagante»: compare la lista dei tutori
    const paganteBtn = await screen.findByRole('button', { name: /Genitore Uno/ });
    // Non è ancora comparsa la testata «Voci da saldare»
    expect(screen.queryByText(/Voci da saldare/)).toBeNull();

    // Sceglie manualmente il pagante → step importi con totale/riferimento già precompilati
    fireEvent.click(paganteBtn);
    await waitFor(() => expect(screen.getByText(/Voci da saldare/)).toBeInTheDocument());
    expect((screen.getByLabelText('Totale versato (€)') as HTMLInputElement).value).toBe('150');
    expect((screen.getByLabelText('Riferimento / CRO') as HTMLInputElement).value).toBe('CAUSALE X');
  });

  it('senza precompila: parte allo step «scegli pagante» come sempre', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<TransazioniPanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByLabelText('Cerca pagante')).toBeInTheDocument());
    expect(screen.queryByText(/Voci da saldare/)).toBeNull();
  });
});
