import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UscitePanel } from '@/components/features/admin/pagamenti/UscitePanel';

vi.mock('@/lib/context/sede-context', () => ({ useSediAttive: () => ({ sedi: [{ id: 'sc-a', nome: 'Alfa' }, { id: 'sc-b', nome: 'Beta' }], effettive: ['sc-a', 'sc-b'] }) }));
afterEach(() => vi.unstubAllGlobals());

describe('Pagina delle uscite', () => {
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
    expect(fn.mock.calls.some(([url]) => String(url).includes('a=2026-10-01'))).toBe(false);
  });
});
