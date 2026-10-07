import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SEDE_B } from '../fixtures/sedi';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';

// =============================================================================
// «Genera rette» → l'esito dei SERVIZI MENSILI che la route genera insieme alle rette.
// Tre forme: { generati }, { errore, codice }, assente. Le rette restano generate in ogni caso.
// =============================================================================

type Servizi = unknown;

function fintoFetch(servizi: Servizi) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      return { ok: true, json: async () => ({ success: true, data: { periodo: '2026-09-01', generati: 3, ...(servizi === undefined ? {} : { servizi }) } }) };
    }
    if (u.includes('anno=')) {
      return { ok: true, json: async () => ({ success: true, data: {
        anno_inizio: 2026, mesi: [{ periodo: '2026-09-01', candidati: 3, gia_generati: 0, importo: 450 }],
        alunni_attivi: 3, retta_default: 150, totale_candidati: 3, totale_previsto: 450,
      } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: {
      periodo: '2026-09-01', gia_generati: 0, retta_default: 150, totale_previsto: 150,
      candidati: [{ id: 'al-1', nome: 'Anna', cognome: 'Prova', classe_sezione: '2 ANNI', importo_previsto: 150 }],
    } }) };
  });
}

async function generaMese() {
  render(<GeneratoreRette userId="u1" scuolaId={SEDE_B} />);
  fireEvent.click(screen.getByRole('button', { name: /Mese singolo/ }));
  fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Genera 1 rette/ }));
  await screen.findByText(/Generate 3 rette per/);
}

// Le aree live stanno sempre nel DOM: «nessun avviso» vuol dire area VUOTA, non area assente.
const testoAvvisi = () => screen.queryAllByRole('alert').map((a) => a.textContent ?? '').join('')

const AVVISO = 'Le rette sono state generate, ma le voci dei servizi mensili no: riprova da Servizi → «Genera le voci dei servizi».';

describe('GeneratoreRette — voci dei servizi mensili', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => vi.unstubAllGlobals());

  it('mese con servizi.generati 3: la riga sotto il messaggio delle rette', async () => {
    vi.stubGlobal('fetch', fintoFetch({ generati: 3 }));
    await generaMese();
    expect(screen.getByText('3 voci dei servizi mensili generate')).toBeInTheDocument();
  });

  it('una sola voce: plurale singolare', async () => {
    vi.stubGlobal('fetch', fintoFetch({ generati: 1 }));
    await generaMese();
    expect(screen.getByText('1 voce dei servizi mensili generata')).toBeInTheDocument();
  });

  it('generati 0: nessuna riga dei servizi (dopo aver visto il messaggio delle rette)', async () => {
    vi.stubGlobal('fetch', fintoFetch({ generati: 0 }));
    await generaMese();
    expect(screen.queryByText(/servizi mensili/)).toBeNull();
    expect(testoAvvisi()).toBe('');
  });

  it('servizi assenti dalla risposta: nessuna riga e nessun avviso', async () => {
    vi.stubGlobal('fetch', fintoFetch(undefined));
    await generaMese();
    expect(screen.queryByText(/servizi mensili/)).toBeNull();
    expect(testoAvvisi()).toBe('');
  });

  it('SERVIZI_NON_GENERATI: avviso in role="alert", le rette restano mostrate come generate', async () => {
    vi.stubGlobal('fetch', fintoFetch({ errore: true, codice: 'SERVIZI_NON_GENERATI' }));
    await generaMese();
    expect(testoAvvisi()).toBe(AVVISO);
    expect(screen.getByText(/Generate 3 rette per/)).toBeInTheDocument();
    expect(screen.queryByText(/voci dei servizi mensili generate/)).toBeNull();
  });

  it('SERVIZI_NON_DISPONIBILI: nessun avviso, lo schema non c\'è', async () => {
    vi.stubGlobal('fetch', fintoFetch({ errore: true, codice: 'SERVIZI_NON_DISPONIBILI' }));
    await generaMese();
    expect(testoAvvisi()).toBe('');
    expect(screen.queryByText(AVVISO)).toBeNull();
  });

  it('anno scolastico con servizi.generati 4: la riga compare', async () => {
    vi.stubGlobal('fetch', fintoFetch({ generati: 4 }));
    render(<GeneratoreRette userId="u1" scuolaId={SEDE_B} />);
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Genera 3 rette/ }));
    await screen.findByText(/Generate 3 rette per l’A\.S\./);
    expect(screen.getByText('4 voci dei servizi mensili generate')).toBeInTheDocument();
  });

  it('una nuova anteprima azzera l\'avviso dei servizi (l\'area live resta, vuota)', async () => {
    vi.stubGlobal('fetch', fintoFetch({ errore: true, codice: 'SERVIZI_NON_GENERATI' }));
    await generaMese();
    expect(testoAvvisi()).toBe(AVVISO);
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await screen.findByRole('button', { name: /Genera 1 rette/ });
    expect(testoAvvisi()).toBe('');
  });

  it('una nuova anteprima azzera anche la riga con il numero di voci', async () => {
    vi.stubGlobal('fetch', fintoFetch({ generati: 3 }));
    await generaMese();
    expect(screen.getByText('3 voci dei servizi mensili generate')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    await screen.findByRole('button', { name: /Genera 1 rette/ });
    expect(screen.queryByText(/servizi mensili/)).toBeNull();
  });
});
