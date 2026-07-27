import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SegnalazioniPanel } from '@/components/features/admin/moderazione/SegnalazioniPanel';

/**
 * Coda di moderazione (C5 §2 — pannello Direzione).
 *
 * La Direzione tria le segnalazioni ricevute: filtra per stato, apre il
 * dettaglio (il `motivo` in chiaro — è uno strumento interno, non un log) e
 * marca la segnalazione in_lavorazione/chiusa via PATCH.
 *
 * Fixture FINTE (mai PII di minori reali). Nessuna chiamata di rete vera:
 * `fetch` è stubbato e ogni chiamata è registrata per l'asserzione.
 */

const SEG_APERTA = {
  id: 'seg-1',
  scuola_id: 'sc-1',
  segnalante_id: 'p-1',
  segnalato_id: null,
  tipo_oggetto: 'messaggio_chat',
  oggetto_id: 'm-1',
  thread_id: 't-1',
  categoria: 'contenuto_inappropriato',
  motivo: 'Messaggio offensivo verso il personale',
  stato: 'aperta',
  creata_il: '2026-07-27T10:00:00Z',
  gestita_il: null,
  gestita_da: null,
  note_gestione: null,
};

let calls: { url: string; init?: RequestInit }[] = [];

function stubFetch() {
  return vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/api/admin/segnalazioni')) {
      if (init?.method === 'PATCH') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 'seg-1' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ segnalazioni: [SEG_APERTA], total: 1 }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  calls = [];
  global.fetch = stubFetch() as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SegnalazioniPanel — coda di moderazione', () => {
  it('carica la coda col filtro stato di default "aperta"', async () => {
    render(<SegnalazioniPanel userId="u1" />);
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/admin/segnalazioni') && c.url.includes('stato=aperta')),
      ).toBe(true),
    );
    // la riga della segnalazione è etichettata con la categoria (testo, non solo icona)
    expect(await screen.findByRole('button', { name: /Contenuto inappropriato/i })).toBeInTheDocument();
  });

  it('apre il dettaglio e mostra il motivo IN CHIARO', async () => {
    render(<SegnalazioniPanel userId="u1" />);
    const row = await screen.findByRole('button', { name: /Contenuto inappropriato/i });
    fireEvent.click(row);
    expect(await screen.findByText(/Messaggio offensivo verso il personale/)).toBeInTheDocument();
  });

  it('cambiando il filtro stato rifetcha con lo stato scelto', async () => {
    render(<SegnalazioniPanel userId="u1" />);
    await screen.findByRole('button', { name: /Contenuto inappropriato/i });
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'chiusa' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('stato=chiusa'))).toBe(true));
  });

  it('PATCH: "Prendi in carico" invia stato in_lavorazione con l’id della segnalazione', async () => {
    render(<SegnalazioniPanel userId="u1" />);
    const row = await screen.findByRole('button', { name: /Contenuto inappropriato/i });
    fireEvent.click(row);
    const btn = await screen.findByRole('button', { name: /Prendi in carico/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body).toMatchObject({ id: 'seg-1', stato: 'in_lavorazione' });
    });
  });
});
