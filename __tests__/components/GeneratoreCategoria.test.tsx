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
    // il vecchio `<select>` di classe è diventato il selettore: «Tutti gli
    // iscritti» è la modalità di partenza, e la riga sotto dice per quanti
    await waitFor(() => expect(screen.getByText(/Si genera per 2 bambini/i)).toBeInTheDocument());
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
    // il vecchio `<select>` di classe è diventato il selettore: «Tutti gli
    // iscritti» è la modalità di partenza, e la riga sotto dice per quanti
    await waitFor(() => expect(screen.getByText(/Si genera per 2 bambini/i)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await waitFor(() => expect(screen.getByText(/Da generare: 1/i)).toBeInTheDocument());

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '40' } });
    expect(screen.queryByText(/Da generare: 1/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Anteprima/ })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LA SCELTA PER SINGOLO BAMBINO
//
// La rotta accettava `alunno_ids` da sempre; a schermo non c'era modo di
// comporli, e l'unico filtro era la classe. Ora c'è.
// ─────────────────────────────────────────────────────────────────────────────
describe('GeneratoreCategoria — scelta dei bambini', () => {
  const posted: unknown[] = [];
  beforeEach(() => { posted.length = 0; vi.stubGlobal('fetch', mockFetch(posted)); });
  afterEach(() => vi.unstubAllGlobals());

  it('scegliendo un bambino solo, il conto a schermo lo dice', async () => {
    render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await screen.findByText(/Si genera per 2 bambini/i);

    fireEvent.click(screen.getByRole('button', { name: /Bambini scelti/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Rossi Mario/i }));

    expect(await screen.findByText(/Si genera per un bambino/i)).toBeTruthy();
  });

  it('la ricerca restringe l’elenco, e «spunta quelli mostrati» agisce solo su quelli', async () => {
    render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await screen.findByText(/Si genera per 2 bambini/i);
    fireEvent.click(screen.getByRole('button', { name: /Bambini scelti/i }));

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bianchi' } });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Rossi Mario/i })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Spunta quelli mostrati/i }));
    // uno solo: quello che la ricerca mostrava
    expect(await screen.findByText(/Si genera per un bambino/i)).toBeTruthy();
  });

  it('cambiare la selezione invalida l’anteprima già fatta', async () => {
    render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await screen.findByText(/Si genera per 2 bambini/i);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await screen.findByText(/Da generare: 1/i);

    fireEvent.click(screen.getByRole('button', { name: /Bambini scelti/i }));
    // l'anteprima si riferiva a un altro insieme: non deve restare a schermo
    expect(screen.queryByText(/Da generare: 1/i)).toBeNull();
  });
});
