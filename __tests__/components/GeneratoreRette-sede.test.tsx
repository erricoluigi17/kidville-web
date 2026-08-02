import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SEDE_B } from '../fixtures/sedi';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';

// =============================================================================
// «Genera rette»: la CONFERMA dichiara la stessa sede dell'ANTEPRIMA.
//
// Il difetto è già costato una scrittura sbagliata in produzione: l'anteprima
// (GET) portava `scuola_id` e mostrava i candidati di UN plesso, la conferma
// (POST) mandava `{ periodo }` o `{ anno }` e basta. Le due metà dello stesso
// bottone guardavano insiemi diversi, e la RPC senza parametro di sede
// generava per tutti: `registro_modifiche` conserva una sola esecuzione, con
// `generati: 25`, e quelle 25 rette stanno su due sedi.
//
// Il test guarda il CORPO effettivamente spedito, che è l'unica cosa che il
// server riceve.
// =============================================================================

interface Chiamata { url: string; body: Record<string, unknown> | null }

function fintoFetch(chiamate: Chiamata[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    chiamate.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === 'POST') {
      return { ok: true, json: async () => ({ success: true, data: { periodo: '2026-09-01', generati: 3 } }) };
    }
    // anteprima: mensile o annuale a seconda della query
    if (u.includes('anno=')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            anno_inizio: 2026, mesi: [{ periodo: '2026-09-01', candidati: 3, gia_generati: 0, importo: 450 }],
            alunni_attivi: 3, retta_default: 150, totale_candidati: 3, totale_previsto: 450,
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          periodo: '2026-09-01', gia_generati: 0, retta_default: 150, totale_previsto: 150,
          candidati: [{ id: 'al-1', nome: 'Anna', cognome: 'Prova', classe_sezione: '2 ANNI', importo_previsto: 150 }],
        },
      }),
    };
  });
}

describe('GeneratoreRette — la conferma dichiara la sede', () => {
  const chiamate: Chiamata[] = [];
  beforeEach(() => {
    chiamate.length = 0;
    vi.stubGlobal('fetch', fintoFetch(chiamate));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('anno scolastico: il POST porta anno E scuola_id, la stessa dell\'anteprima', async () => {
    render(<GeneratoreRette userId="u1" scuolaId={SEDE_B} />);
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Genera 3 rette/ })).toBeInTheDocument());

    const anteprima = chiamate.find((c) => c.url.startsWith('/api/pagamenti/genera-rette?'));
    expect(anteprima?.url).toContain(`scuola_id=${SEDE_B}`);

    fireEvent.click(screen.getByRole('button', { name: /Genera 3 rette/ }));
    await waitFor(() => expect(chiamate.some((c) => c.body !== null)).toBe(true));
    const conferma = chiamate.find((c) => c.body !== null);
    // L'anno dipende dalla data odierna (set→giu): si asserisce la FORMA del
    // corpo — nient'altro oltre ad anno e sede — e che la sede sia quella.
    expect(Object.keys(conferma?.body ?? {}).sort()).toEqual(['anno', 'scuola_id']);
    expect((conferma?.body as { scuola_id: string }).scuola_id).toBe(SEDE_B);
    expect(typeof (conferma?.body as { anno: number }).anno).toBe('number');
  });

  it('mese singolo: il POST porta periodo E scuola_id', async () => {
    render(<GeneratoreRette userId="u1" scuolaId={SEDE_B} />);
    fireEvent.click(screen.getByRole('button', { name: /Mese singolo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Genera 1 rette/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Genera 1 rette/ }));
    await waitFor(() => expect(chiamate.some((c) => c.body !== null)).toBe(true));
    const conferma = chiamate.find((c) => c.body !== null);
    expect(conferma?.body).toMatchObject({ scuola_id: SEDE_B });
    expect(String((conferma?.body as { periodo: string }).periodo)).toMatch(/^\d{4}-\d{2}$/);
  });
});
