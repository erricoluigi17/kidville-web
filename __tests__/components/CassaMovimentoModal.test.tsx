import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CassaMovimentoModal } from '@/components/features/admin/pagamenti/CassaMovimentoModal';

// Risposta JSON minimale nello stile fetch.
function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

interface MockOpts {
  uploadOk?: boolean;
  putOk?: boolean;
  movimentiStatus?: number;
}

function mockFetch(opts: MockOpts = {}) {
  const { uploadOk = true, putOk = true, movimentiStatus = 201 } = opts;
  const calls = { movimenti: [] as Record<string, unknown>[], uploadUrl: 0, put: 0 };
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/cassa/categorie')) {
      return jsonRes({
        disponibile: true,
        categorie: [
          { id: 'cat1', scuola_id: null, nome: 'Pulizie e igiene', slug: 'pulizie-igiene', colore: null, icona: null, ordine: 3, attivo: true, is_sistema: false },
          { id: 'cat2', scuola_id: null, nome: 'Cancelleria', slug: 'cancelleria', colore: null, icona: null, ordine: 5, attivo: true, is_sistema: false },
        ],
      });
    }
    if (u.includes('/cassa/allegato/upload-url')) {
      calls.uploadUrl++;
      if (!uploadOk) return jsonRes({ error: 'errore' }, 500);
      return jsonRes({ success: true, data: { path: 'sc/2026/x.jpg', token: 't', signedUrl: 'https://signed.example/put' } });
    }
    if (init?.method === 'PUT') {
      calls.put++;
      return jsonRes({}, putOk ? 200 : 500);
    }
    if (u.includes('/cassa/movimenti')) {
      calls.movimenti.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonRes({ movimento: { id: 'm1' } }, movimentiStatus);
    }
    return jsonRes({});
  });
  return { fn, calls };
}

describe('CassaMovimentoModal — uscita/entrata + foto facoltativa', () => {
  let calls: ReturnType<typeof mockFetch>['calls'];
  beforeEach(() => {
    const m = mockFetch();
    calls = m.calls;
    vi.stubGlobal('fetch', m.fn);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('un\'uscita senza categoria è bloccata lato client con un messaggio', async () => {
    render(<CassaMovimentoModal userId="u1" scuolaId="sc-1" tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/Importo/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/categoria/i);
    // Nessuna chiamata di salvataggio quando la validazione client fallisce.
    expect(calls.movimenti).toHaveLength(0);
  });

  it('un\'entrata manuale non richiede la categoria e salva', async () => {
    const onDone = vi.fn();
    render(<CassaMovimentoModal userId="u1" scuolaId="sc-1" tipoIniziale="entrata" onClose={() => {}} onDone={onDone} />);
    fireEvent.change(await screen.findByLabelText(/Importo/), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    await waitFor(() => expect(calls.movimenti).toHaveLength(1));
    expect(calls.movimenti[0]).toMatchObject({ scuola_id: 'sc-1', tipo: 'entrata', importo: 15 });
    expect(calls.movimenti[0]).not.toHaveProperty('categoria_id', expect.anything());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

describe('CassaMovimentoModal — un 400 con details nomina il campo in errore (RC1/E3.2)', () => {
  function mockFetch400(details: { path: string; message?: string }[]) {
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/cassa/categorie')) return jsonRes({ disponibile: true, categorie: [] });
      if (u.includes('/cassa/movimenti') && init?.method === 'POST') {
        return jsonRes({ error: 'Dati non validi', details }, 400);
      }
      return jsonRes({});
    });
    return fn;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('con details path=note il messaggio d\'errore contiene «Note» (non solo «Dati non validi»)', async () => {
    vi.stubGlobal('fetch', mockFetch400([{ path: 'note', message: 'Invalid input' }]));
    render(<CassaMovimentoModal userId="u1" scuolaId="sc-1" tipoIniziale="entrata" onClose={() => {}} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/Importo/), { target: { value: '9.99' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Note/);
    // Il campo Note è marcato come non valido e collegato al messaggio (P8).
    const note = screen.getByLabelText(/Note/);
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('con details su descrizione E importo il messaggio nomina entrambi i campi', async () => {
    vi.stubGlobal('fetch', mockFetch400([{ path: 'descrizione' }, { path: 'importo' }]));
    render(<CassaMovimentoModal userId="u1" scuolaId="sc-1" tipoIniziale="entrata" onClose={() => {}} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/Importo/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Descrizione/);
    expect(alert).toHaveTextContent(/Importo/);
  });
});

describe('CassaMovimentoModal — la foto facoltativa non blocca il salvataggio', () => {
  it('se l\'upload del giustificativo fallisce, il movimento viene comunque salvato senza allegato', async () => {
    const m = mockFetch({ uploadOk: false });
    vi.stubGlobal('fetch', m.fn);
    const onDone = vi.fn();
    render(<CassaMovimentoModal userId="u1" scuolaId="sc-1" tipoIniziale="entrata" onClose={() => {}} onDone={onDone} />);

    fireEvent.change(await screen.findByLabelText(/Importo/), { target: { value: '30' } });
    const file = new File(['x'], 'scontrino.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText(/Foto/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));

    // L'upload è stato tentato…
    await waitFor(() => expect(m.calls.uploadUrl).toBe(1));
    // …ma il salvataggio è comunque avvenuto, senza allegato_path.
    await waitFor(() => expect(m.calls.movimenti).toHaveLength(1));
    expect(m.calls.movimenti[0].allegato_path ?? null).toBeNull();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
