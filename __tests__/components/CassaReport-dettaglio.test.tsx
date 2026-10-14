import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CassaReport } from '@/components/features/admin/pagamenti/CassaReport';

const cat = '11111111-1111-4111-8111-111111111111';
const report = {
  disponibile: true,
  entrate_per_categoria: [{ categoria_id: cat, categoria_nome: 'Retta', totale: 140, per_metodo: { contanti: 40, bonifico: 100 } }],
  uscite_per_categoria: [{ categoria_id: null, categoria_nome: null, totale: 35, contanti: 15, altri: 20 }],
  mensile: [], per_sede: [],
};
const dettaglio = {
  disponibile: true, conteggio: 1, pagina: 1, limite: 50, totali: { totale: 140, contanti: 40, altri: 100 },
  righe: [{ id: 'i1', origine: 'incasso', scuola_id: 'sc-a', scuola_nome: 'Alfa', data: '2026-10-14', categoria_id: cat, categoria_nome: 'Retta', metodo: 'bonifico', importo: 100, descrizione: 'Retta ottobre', note: null, allegato_path: null, storno_di: null, stornato_il: null, pagamento_id: 'p1' }],
};
const res = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
function prepara() {
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/cassa/dettaglio')) return res(dettaglio);
    if (u.includes('/cassa/report')) return res(report);
    return res({ success: true, data: [{ id: cat, nome: 'Retta' }] });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe('Riepilogo: somme e movimenti delle categorie', () => {
  it('mostra le somme complete e la differenza, con il contante distinto', async () => {
    prepara(); render(<CassaReport userId="u1" scuolaId="sc-a" />);
    const totali = await screen.findByTestId('cassa-report-totali');
    expect(totali.textContent).toContain('€ 140,00');
    expect(totali.textContent).toContain('€ 35,00');
    expect(totali.textContent).toContain('€ 105,00');
    expect(screen.getAllByRole('columnheader', { name: 'Contante incassato' })).toHaveLength(1);
  });

  it('apre gli incassi della categoria usando lo stesso periodo e la sede', async () => {
    const fn = prepara(); render(<CassaReport userId="u1" scuolaId="sc-a" />);
    await screen.findByRole('button', { name: 'Vedi entrate di Retta' });
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Al'), { target: { value: '2026-10-31' } });
    const bottone = await screen.findByRole('button', { name: 'Vedi entrate di Retta' });
    fireEvent.click(bottone);
    const dialogo = await screen.findByRole('dialog');
    await within(dialogo).findByText('Retta ottobre');
    const url = new URL(fn.mock.calls.find(([u]) => String(u).includes('/cassa/dettaglio'))![0].toString(), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ tipo: 'entrata', categoria_id: cat, scuola_id: 'sc-a', da: '2026-10-01', a: '2026-10-31' });
  });

  it('la categoria nulla apre soltanto le uscite senza categoria', async () => {
    const fn = prepara(); render(<CassaReport userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vedi uscite di Senza categoria' }));
    await waitFor(() => expect(fn.mock.calls.some(([u]) => String(u).includes('/cassa/dettaglio'))).toBe(true));
    const url = new URL(String(fn.mock.calls.find(([u]) => String(u).includes('/cassa/dettaglio'))![0]), 'http://localhost');
    expect(url.searchParams.get('categoria_id')).toBe('senza');
    expect(url.searchParams.get('tipo')).toBe('uscita');
    expect(url.searchParams.has('scuola_id')).toBe(false);
  });

  it('non lascia i totali precedenti sotto un nuovo periodo ancora in caricamento', async () => {
    const fn = prepara(); render(<CassaReport userId="u1" scuolaId="sc-a" />);
    await screen.findByTestId('cassa-report-totali');
    fn.mockImplementation(async (url) => String(url).includes('/cassa/report') ? new Promise<Response>(() => {}) : res({ success: true, data: [] }));
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-09-01' } });
    expect(screen.queryByTestId('cassa-report-totali')).toBeNull();
    expect(screen.getByText('Caricamento…')).toBeTruthy();
  });

  it('il vecchio totale non ricompare tornando al filtro iniziale durante una nuova lettura', async () => {
    const fn = prepara(); render(<CassaReport userId="u1" scuolaId="sc-a" />);
    await screen.findByTestId('cassa-report-totali');
    const risposte: ((r: Response) => void)[] = [];
    fn.mockImplementation(() => new Promise<Response>((resolve) => risposte.push(resolve)));
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(risposte.length).toBe(1));
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '' } });
    expect(screen.queryByTestId('cassa-report-totali')).toBeNull();
    await waitFor(() => expect(risposte.length).toBe(2));
    await act(async () => risposte[1](res({ ...report, entrate_per_categoria: [] })));
    expect(screen.getByTestId('cassa-report-totali').textContent).not.toContain('€ 140,00');
    await act(async () => risposte[0](res(report)));
    expect(screen.getByTestId('cassa-report-totali').textContent).not.toContain('€ 140,00');
  });

  it('tornando a Tutte ripristina il periodo dopo Intero importo', async () => {
    const fn = prepara(); render(<CassaReport userId="u1" scuolaId="sc-a" />);
    await screen.findByRole('option', { name: 'Retta' });
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Categoria di pagamento'), { target: { value: cat } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByLabelText('Dal')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Categoria di pagamento'), { target: { value: '' } });
    expect(screen.getByLabelText('Dal')).not.toBeDisabled();
    await waitFor(() => expect(String(fn.mock.calls.at(-1)![0])).toContain('da=2026-10-01'));
    expect(String(fn.mock.calls.at(-1)![0])).not.toContain('categoria_pagamento_id');
  });
});
