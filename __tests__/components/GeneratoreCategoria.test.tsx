import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GeneratoreCategoria } from '@/components/features/admin/pagamenti/GeneratoreCategoria';

function mockFetch(posted: unknown[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/admin/settings/categorie')) {
      return { ok: true, json: async () => ({ success: true, data: [{ id: 'c1', nome: 'Gita', slug: 'gita' }] }) };
    }
    if (u.startsWith('/api/admin/students')) {
      return { ok: true, json: async () => ({ success: true, data: [
        { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' },
        { id: 'a2', nome: 'Lia', cognome: 'Bianchi', classe_sezione: '1A' },
      ] }) };
    }
    if (init?.method === 'POST' && u === '/api/pagamenti/genera') {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ success: true, data: { generati: 1 } }) };
    }
    if (u.startsWith('/api/pagamenti/genera?')) {
      return { ok: true, json: async () => ({ success: true, data: {
        candidati: [{ id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' }],
        gia_generati: 1,
      } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

describe('GeneratoreCategoria — anteprima obbligatoria', () => {
  const posted: unknown[] = [];
  beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal('fetch', mockFetch(posted));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prima l\'anteprima (con saltati), poi la conferma esplicita', async () => {
    render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(screen.getByText(/Tutti \(2\)/)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });

    // il primo bottone è SOLO anteprima: nessun POST
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await waitFor(() => expect(screen.getByText(/Da generare: 1/i)).toBeInTheDocument());
    expect(screen.getByText(/già presenti.*1/i)).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    // conferma → POST con i soli candidati dell'anteprima
    fireEvent.click(screen.getByRole('button', { name: /Conferma generazione/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { alunno_ids: string[] }).alunno_ids).toEqual(['a1']);
  });

  it('modificare un campo invalida l\'anteprima', async () => {
    render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(screen.getByText(/Tutti \(2\)/)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await waitFor(() => expect(screen.getByText(/Da generare: 1/i)).toBeInTheDocument());

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '40' } });
    expect(screen.queryByText(/Da generare: 1/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Anteprima/ })).toBeInTheDocument();
  });
});
