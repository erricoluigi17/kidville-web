import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UscitePanel } from '@/components/features/admin/pagamenti/UscitePanel';

vi.mock('@/lib/context/sede-context', () => ({ useSediAttive: () => ({ sedi: [{ id: 'sc-a', nome: 'Alfa' }, { id: 'sc-b', nome: 'Beta' }], effettive: ['sc-a', 'sc-b'] }) }));
afterEach(() => vi.unstubAllGlobals());

describe('Pagina delle uscite', () => {
  it('aggiorna sede, mensilità e categoria insieme e azzera la categoria cambiando sede', async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => {
      const q = new URL(String(url), 'http://localhost').searchParams;
      const corrisponde = q.get('scuola_id') === 'sc-b' && q.get('da') === '2028-02-01' && q.get('a') === '2028-02-29' && q.get('categoria_id') === 'cat-b';
      const righe = corrisponde ? [{ id: 'spesa-b', origine: 'cassa', scuola_id: 'sc-b', scuola_nome: 'Beta', data: '2028-02-12', importo: 23, metodo: 'bonifico', descrizione: 'Spesa di Beta a febbraio', categoria_id: 'cat-b', categoria_nome: 'Spese Beta' }] : [];
      return { ok: true, status: 200, json: async () => String(url).includes('/cassa/categorie')
        ? { disponibile: true, categorie: [{ id: q.get('scuola_id') === 'sc-b' ? 'cat-b' : 'cat-a', nome: q.get('scuola_id') === 'sc-b' ? 'Spese Beta' : 'Spese Alfa' }] }
        : { disponibile: true, conteggio: righe.length, pagina: 1, limite: 50, righe, totali: { totale: corrisponde ? 23 : 0, contanti: 0, altri: corrisponde ? 23 : 0 } } } as Response;
    });
    vi.stubGlobal('fetch', fn);
    render(<UscitePanel userId="u" scuolaId={null} />);
    await screen.findByRole('option', { name: 'Spese Alfa' });
    fireEvent.change(screen.getByLabelText('Mensilità', { exact: true }), { target: { value: '2028-02' } });
    fireEvent.change(screen.getByLabelText('Sede', { exact: true }), { target: { value: 'sc-b' } });
    await screen.findByRole('option', { name: 'Spese Beta' });
    expect(screen.queryByRole('option', { name: 'Spese Alfa' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Categoria', { exact: true }), { target: { value: 'cat-b' } });
    await screen.findByText('Spesa di Beta a febbraio');
    expect(screen.getByTestId('cassa-dettaglio-totali')).toHaveTextContent('23,00');
    await waitFor(() => {
      const q = new URL(String(fn.mock.calls.at(-1)![0]), 'http://localhost').searchParams;
      expect(Object.fromEntries(q)).toMatchObject({ scuola_id: 'sc-b', da: '2028-02-01', a: '2028-02-29', categoria_id: 'cat-b', pagina: '1' });
    });
    fireEvent.change(screen.getByLabelText('Sede', { exact: true }), { target: { value: '' } });
    await screen.findByRole('option', { name: 'Spese Alfa' });
    const q = new URL(String(fn.mock.calls.filter(([u]) => String(u).includes('/cassa/dettaglio')).at(-1)![0]), 'http://localhost').searchParams;
    expect(q.has('categoria_id')).toBe(false);
    expect(q.has('scuola_id')).toBe(false);
    expect(q.get('da')).toBe('2028-02-01');
    expect(screen.getByLabelText('Mensilità')).toHaveValue('2028-02');
    await screen.findByText('Nessun movimento corrisponde ai filtri.');
    expect(screen.queryByText('Spesa di Beta a febbraio')).toBeNull();
  });

  it('parte dal mese corrente di Roma e permette tutti i mesi o un intervallo personalizzato', async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => { void url; return ({ ok: true, status: 200, json: async () => ({ disponibile: true, categorie: [], righe: [], conteggio: 0, pagina: 1, limite: 50 }) }) as Response; });
    vi.stubGlobal('fetch', fn);
    render(<UscitePanel userId="u" scuolaId="sc-a" />);
    await screen.findByText('Nessun movimento corrisponde ai filtri.');
    const oggi = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
    expect(screen.getByLabelText('Mensilità')).toHaveValue(oggi.slice(0, 7));
    fireEvent.change(screen.getByLabelText('Mensilità'), { target: { value: '2100-02' } });
    expect(screen.getByLabelText('Al')).toHaveValue('2100-02-28');
    fireEvent.click(screen.getByRole('button', { name: 'Tutti i mesi' }));
    await waitFor(() => {
      const q = new URL(String(fn.mock.calls.at(-1)![0]), 'http://localhost').searchParams;
      expect(q.has('da')).toBe(false); expect(q.has('a')).toBe(false);
    });
    expect(screen.getByLabelText('Mensilità')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-09-10' } });
    expect(screen.getByLabelText('Mensilità')).toHaveValue('');
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).toContain('da=2026-09-10'));
  });

  it('filtra il dettaglio per categoria, metodo e periodo senza inventare una sede', async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => ({ ok: true, status: 200, json: async () => String(url).includes('/cassa/categorie')
      ? { disponibile: true, categorie: [{ id: 'cat-a', nome: 'Spese', scuola_id: 'sc-a' }, { id: 'cat-b', nome: 'Spese', scuola_id: 'sc-b' }] }
      : { disponibile: true, conteggio: 0, pagina: 1, limite: 50, righe: [], totali: { totale: 0, contanti: 0, altri: 0 } } }) as Response);
    vi.stubGlobal('fetch', fn);
    render(<UscitePanel userId="u" scuolaId={null} />);
    await screen.findByRole('option', { name: 'Spese — Beta' });
    const controlloCategoria = screen.getByLabelText('Categoria', { exact: true }) as HTMLSelectElement;
    expect(Array.from(controlloCategoria.labels ?? []).map((l) => l.textContent)).toEqual(['Categoria']);
    fireEvent.change(screen.getByLabelText('Categoria', { exact: true }), { target: { value: 'cat-b' } });
    fireEvent.change(screen.getByLabelText('Metodo', { exact: true }), { target: { value: 'bonifico' } });
    fireEvent.change(screen.getByLabelText('Dal', { exact: true }), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(fn.mock.calls.some(([u]) => String(u).includes('da=2026-10-01'))).toBe(true));
    const url = new URL(String(fn.mock.calls.at(-1)![0]), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ tipo: 'uscita', categoria_id: 'cat-b', metodo: 'bonifico', da: '2026-10-01', pagina: '1' });
    expect(url.searchParams.has('scuola_id')).toBe(false);
    fireEvent.change(screen.getByLabelText('Categoria', { exact: true }), { target: { value: 'senza' } });
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).toContain('categoria_id=senza'));
  });

  it('rifiuta un periodo invertito senza inviare quel filtro al server', async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => { void url; return ({ ok: true, status: 200, json: async () => ({ disponibile: true, categorie: [], righe: [], conteggio: 0, pagina: 1, limite: 50 }) }) as Response; });
    vi.stubGlobal('fetch', fn);
    render(<UscitePanel userId="u" scuolaId="sc-a" />);
    await screen.findByText('Nessun movimento corrisponde ai filtri.');
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('Al'), { target: { value: '2026-10-01' } });
    expect(screen.getByRole('alert').textContent).toContain('La data iniziale');
    expect(fn.mock.calls.some(([url]) => {
      const q = new URL(String(url), 'http://localhost').searchParams;
      return q.get('da') === '2026-10-20' && q.get('a') === '2026-10-01';
    })).toBe(false);
  });
});
