import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CassaChiusuraModal } from '@/components/features/admin/pagamenti/CassaChiusuraModal';

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const SALDO = {
  disponibile: true,
  fondo: 100,
  saldo_atteso: 130,
  entrate_contanti: 50,
  uscite_contanti: 20,
  prelievi: 0,
  rettifiche: 0,
  entrato_oggi: [],
};

function mockFetch(opts: { chiusuraStatus?: number; saldo?: unknown } = {}) {
  const { chiusuraStatus = 201, saldo = SALDO } = opts;
  const calls = { chiusura: [] as Record<string, unknown>[] };
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/cassa/saldo')) return jsonRes(saldo);
    if (u.includes('/cassa/chiusura')) {
      calls.chiusura.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonRes({ chiusura_id: 'ch1', saldo_atteso: 130, contato: 128, differenza: -2, prelevato: 28, fondo_lasciato: 100 }, chiusuraStatus);
    }
    return jsonRes({});
  });
  return { fn, calls };
}

describe('CassaChiusuraModal — svuotamento con differenza a parole', () => {
  let calls: ReturnType<typeof mockFetch>['calls'];
  beforeEach(() => {
    const m = mockFetch();
    calls = m.calls;
    vi.stubGlobal('fetch', m.fn);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('con contato 128 su atteso 130 e fondo 100 mostra un «Ammanco» e un prelievo di 28 €', async () => {
    render(<CassaChiusuraModal userId="u1" scuolaId="sc-1" onClose={() => {}} onDone={() => {}} />);
    // Attende il caricamento del saldo (mostra l'atteso).
    await screen.findByText(/€ 130,00/);
    fireEvent.change(screen.getByLabelText(/Totale contato/), { target: { value: '128' } });
    // Differenza comunicata A PAROLE, non solo col colore.
    expect(screen.getByText(/Ammanco/i)).toBeInTheDocument();
    // Prelievo previsto = contato − fondo = 28 €.
    expect(screen.getByText(/€ 28,00/)).toBeInTheDocument();
  });

  it('la conferma invia SOLO { scuola_id, contato, note } (mai il saldo calcolato dal client)', async () => {
    render(<CassaChiusuraModal userId="u1" scuolaId="sc-1" onClose={() => {}} onDone={() => {}} />);
    await screen.findByText(/€ 130,00/);
    fireEvent.change(screen.getByLabelText(/Totale contato/), { target: { value: '128' } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'chiusura serale' } });
    fireEvent.click(screen.getByRole('button', { name: /Conferma/ }));

    await waitFor(() => expect(calls.chiusura).toHaveLength(1));
    const body = calls.chiusura[0];
    expect(Object.keys(body).sort()).toEqual(['contato', 'note', 'scuola_id']);
    expect(body).toMatchObject({ scuola_id: 'sc-1', contato: 128, note: 'chiusura serale' });
    // Il client NON deve mai inviare il saldo che ha calcolato: lo ricalcola il server.
    expect(body).not.toHaveProperty('saldo_atteso');
    expect(body).not.toHaveProperty('differenza');
  });
});
