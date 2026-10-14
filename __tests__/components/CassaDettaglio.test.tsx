import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CassaDettaglio } from '@/components/features/admin/pagamenti/CassaDettaglio';

const json = (d: unknown, status = 200) => ({ ok: status < 400, status, json: async () => d }) as Response;
const riga = (id: string) => ({ id, origine: 'cassa', scuola_id: 'sc-a', scuola_nome: 'Alfa', data: '2026-10-14', categoria_id: 'cat', categoria_nome: 'Pulizie', metodo: 'contanti', importo: 10, descrizione: id, note: null, allegato_path: null, storno_di: null, stornato_il: null, pagamento_id: null });
const dati = { disponibile: true, righe: [riga('uscita-prima')], conteggio: 1205, pagina: 1, limite: 50, totali: { totale: 12050, contanti: 12050, altri: 0 } };
afterEach(() => vi.unstubAllGlobals());

describe('Dettaglio cassa paginato', () => {
  it('mantiene il focus sul comando di pagina durante e dopo la lettura', async () => {
    let risolvi!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => String(url).includes('pagina=2') ? new Promise<Response>((resolve) => { risolvi = resolve; }) : Promise.resolve(json(dati))));
    render(<CassaDettaglio userId="u" scuolaId={null} tipo="uscita" />);
    await screen.findByText('uscita-prima');
    const avanti = screen.getByRole('button', { name: 'Successiva' });
    avanti.focus(); fireEvent.click(avanti);
    expect(avanti).toHaveFocus();
    await act(async () => risolvi(json({ ...dati, righe: [riga('uscita-seconda')] })));
    expect(screen.getByRole('button', { name: 'Successiva' })).toBe(avanti);
    expect(avanti).toHaveFocus();
  });
  it('mantiene la somma completa passando alla seconda pagina', async () => {
    const fn = vi.fn(async (url: RequestInfo | URL) => json({ ...dati, righe: [riga(String(url).includes('pagina=2') ? 'uscita-seconda' : 'uscita-prima')] }));
    vi.stubGlobal('fetch', fn);
    render(<CassaDettaglio userId="u" scuolaId={null} tipo="uscita" />);
    await screen.findByText('uscita-prima');
    expect(screen.getByTestId('cassa-dettaglio-totali').textContent).toContain('€ 12.050,00');
    fireEvent.click(screen.getByRole('button', { name: 'Successiva' }));
    await screen.findByText('uscita-seconda');
    expect(screen.getByTestId('cassa-dettaglio-totali').textContent).toContain('€ 12.050,00');
    expect(screen.getByText('Pagina 2 di 25 · 1205 movimenti')).toBeTruthy();
  });

  it('cambio filtro riparte dalla prima pagina e ignora la risposta del filtro precedente', async () => {
    let risolviVecchia!: (r: Response) => void;
    const fn = vi.fn((url: RequestInfo | URL) => String(url).includes('categoria_id=vecchia') ? new Promise<Response>((resolve) => { risolviVecchia = resolve; }) : Promise.resolve(json({ ...dati, righe: [riga('uscita-nuova')] })));
    vi.stubGlobal('fetch', fn);
    const { rerender } = render(<CassaDettaglio userId="u" scuolaId={null} tipo="uscita" categoriaId="vecchia" />);
    await waitFor(() => expect(risolviVecchia).toBeDefined());
    rerender(<CassaDettaglio userId="u" scuolaId={null} tipo="uscita" categoriaId="nuova" />);
    await screen.findByText('uscita-nuova');
    await act(async () => risolviVecchia(json(dati)));
    expect(screen.queryByText('uscita-prima')).toBeNull();
    expect(screen.getByText('uscita-nuova')).toBeTruthy();
    expect(String(fn.mock.calls.at(-1)![0])).toContain('pagina=1');
  });

  it('staff senza totali conserva la lista e distingue un guasto da un elenco vuoto', async () => {
    const { totali: _totali, ...staff } = dati;
    void _totali;
    const fn = vi.fn(async () => json(staff));
    vi.stubGlobal('fetch', fn);
    const { rerender } = render(<CassaDettaglio userId="u" scuolaId={null} tipo="uscita" />);
    await screen.findByText('uscita-prima');
    expect(screen.queryByTestId('cassa-dettaglio-totali')).toBeNull();
    fn.mockResolvedValue(json({ error: 'rifiutato' }, 403));
    rerender(<CassaDettaglio userId="u" scuolaId={null} tipo="uscita" refreshKey={1} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Nessun movimento corrisponde ai filtri.')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Paginazione dei movimenti' }).textContent).not.toContain('0 movimenti');
    fn.mockResolvedValue(json(staff));
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await screen.findByText('uscita-prima');
  });
});
