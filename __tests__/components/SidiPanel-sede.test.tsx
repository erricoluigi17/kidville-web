import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SEDE_B } from '../fixtures/sedi';
import { SidiPanel } from '@/components/features/admin/SidiPanel';

// =============================================================================
// X2 (lato cockpit) — il pannello SIDI dichiara la sede su cui sta lavorando.
//
// Dal 2026-07-31 le route SIDI rispondono 400 se chi ha più plessi non dice
// dove sta scrivendo. Il pannello non lo diceva in nessuna delle sue cinque
// chiamate: senza questo, per l'unica Direzione reale — che di sedi ne ha tre —
// l'intera sezione SIDI risponderebbe «Specificare la sede» e basta.
//
// Il test guarda la richiesta EFFETTIVAMENTE spedita: è l'unica cosa che il
// server riceve, e l'unico modo perché «manda la sede» sia una proprietà
// verificata invece di un'intenzione.
// =============================================================================

interface Chiamata { url: string; metodo: string; form: FormData | null }

function fintoFetch(chiamate: Chiamata[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body;
    chiamate.push({
      url: u,
      metodo: init?.method ?? 'GET',
      form: typeof FormData !== 'undefined' && body instanceof FormData ? body : null,
    });
    if (u.includes('/api/admin/settings/sidi')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { abilitato: true } }) };
    }
    if (u.includes('/api/admin/sidi/sync-state')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          success: true,
          data: { fase_a_stato: 'inviato', frequentanti_stato: 'non_inviato', piattaforma_unica_stato: 'non_inviato' },
        }),
      };
    }
    if (u.includes('/api/admin/sidi/import')) {
      return { ok: true, status: 200, json: async () => ({ success: true, batchId: 'b-1', totale: 2, warnings: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, stato: 'inviato' }) };
  });
}

const perUrl = (chiamate: Chiamata[], frammento: string) => chiamate.filter((c) => c.url.includes(frammento));

describe('SidiPanel — ogni chiamata dichiara la sede', () => {
  const chiamate: Chiamata[] = [];
  beforeEach(() => {
    chiamate.length = 0;
    vi.stubGlobal('fetch', fintoFetch(chiamate));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lo stato di sincronizzazione si legge sulla sede corrente', async () => {
    render(<SidiPanel userId="u1" scuolaId={SEDE_B} />);

    await waitFor(() => expect(perUrl(chiamate, '/api/admin/sidi/sync-state')).not.toHaveLength(0));
    for (const c of perUrl(chiamate, '/api/admin/sidi/sync-state')) {
      expect(c.url).toContain(`scuola_id=${SEDE_B}`);
    }
  });

  it('la trasmissione di Fase A parte con la sede nella query', async () => {
    render(<SidiPanel userId="u1" scuolaId={SEDE_B} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Invia al SIDI/ })).toHaveLength(3));

    fireEvent.click(screen.getAllByRole('button', { name: /Invia al SIDI/ })[0]);

    await waitFor(() => expect(perUrl(chiamate, '/api/admin/sidi/fase-a')).toHaveLength(1));
    const invio = perUrl(chiamate, '/api/admin/sidi/fase-a')[0];
    expect(invio.metodo).toBe('POST');
    expect(invio.url).toContain(`scuola_id=${SEDE_B}`);
  });

  it('i frequentanti (sbloccati da Fase A) partono con la sede nella query', async () => {
    render(<SidiPanel userId="u1" scuolaId={SEDE_B} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Invia al SIDI/ })).toHaveLength(3));

    fireEvent.click(screen.getAllByRole('button', { name: /Invia al SIDI/ })[1]);

    await waitFor(() => expect(perUrl(chiamate, '/api/admin/sidi/frequentanti')).toHaveLength(1));
    expect(perUrl(chiamate, '/api/admin/sidi/frequentanti')[0].url).toContain(`scuola_id=${SEDE_B}`);
  });

  it('lo ZIP ministeriale viaggia col campo `scuola_id` nel form', async () => {
    const { container } = render(<SidiPanel userId="u1" scuolaId={SEDE_B} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['zip finto'], 'domande_sidi.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.click(screen.getByRole('button', { name: /Carica e analizza/ }));

    await waitFor(() => expect(perUrl(chiamate, '/api/admin/sidi/import')).toHaveLength(1));
    const upload = perUrl(chiamate, '/api/admin/sidi/import')[0];
    expect(upload.metodo).toBe('POST');
    expect(upload.form?.get('scuola_id')).toBe(SEDE_B);
    expect((upload.form?.get('file') as File)?.name).toBe('domande_sidi.zip');
  });

  it('cambiando sede lo stato si ri-legge sulla nuova', async () => {
    const { rerender } = render(<SidiPanel userId="u1" scuolaId={SEDE_B} />);
    await waitFor(() => expect(perUrl(chiamate, '/api/admin/sidi/sync-state')).not.toHaveLength(0));

    const altra = 'aaaaaaaa-0000-4000-8000-00000000000a';
    rerender(<SidiPanel userId="u1" scuolaId={altra} />);

    await waitFor(() =>
      expect(perUrl(chiamate, '/api/admin/sidi/sync-state').some((c) => c.url.includes(`scuola_id=${altra}`))).toBe(true),
    );
  });
});
