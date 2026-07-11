import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuickAcquistoModal } from '@/components/features/admin/pagamenti/QuickAcquistoModal';

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const oggi = new Date().toISOString().slice(0, 10);
const alunno = { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' };
const categoria = { id: 'c1', nome: 'Gita', slug: 'gita' };

function mockFetch(posted: unknown[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && u === '/api/pagamenti') {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ success: true, data: { id: 'nuovo', fattura_stato: 'non_richiesta' } }) };
    }
    if (init?.method === 'POST' && u === '/api/pagamenti/incassi') {
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (u.startsWith('/api/pagamenti?')) {
      // esiste già un pagamento identico per importo con scadenza vicina
      return { ok: true, json: async () => ({ success: true, data: [{ id: 'vecchio', importo: 25, scadenza: oggi, descrizione: 'Gita Zoo', stato: 'da_pagare' }] }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

describe('QuickAcquistoModal — anti-duplicato', () => {
  const posted: unknown[] = [];
  beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal('fetch', mockFetch(posted));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('al primo submit con possibile duplicato NON crea e chiede conferma esplicita', async () => {
    render(<QuickAcquistoModal alunno={alunno} categoria={categoria} userId="u1" onClose={() => {}} onDone={() => {}} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /Registra acquisto/ }));
    await waitFor(() => expect(screen.getByText(/possibile duplicato/i)).toBeInTheDocument());
    expect(posted).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Conferma comunque/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
  });

  it('warning contanti presente quando "già pagato" è attivo col metodo di default', () => {
    render(<QuickAcquistoModal alunno={alunno} categoria={categoria} userId="u1" onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/non sarà detraibile/i)).toBeInTheDocument();
  });
});
