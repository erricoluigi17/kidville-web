import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GeneratoreCategoria } from '@/components/features/admin/pagamenti/GeneratoreCategoria';
import { CalendarioProvider } from '@/lib/context/calendario-context';

// =============================================================================
// PR 4.1 · giro finale (M3, M4) · «Genera pagamento»: la chiave anti-doppione dell'anteprima e la scadenza.
//
// L'anteprima conta i «già generati» con una chiave (`gruppo`); se arriva il calendario e la chiave proposta
// cambia, la generazione non deve escludere con un'altra chiave: l'anteprima vecchia sparisce e va rifatta.
// =============================================================================

const riga = (annoInizio: number, inizio: string, fine: string) => ({
  annoId: `a${annoInizio}`, annoSedeId: `r${annoInizio}`, annoInizio, inizio, fine,
  ultimoGiornoAperto: fine, preparaSuccessivoDal: inizio, stato: 'corrente', domandeAperte: false,
});
const CAL_SEDE = [riga(2025, '2025-09-01', '2026-09-14'), riga(2026, '2026-09-15', '2027-08-31')];

let apriCalendario: () => void = () => {};
let posted: Array<Record<string, unknown>> = [];
let anteprime: string[] = [];

function finto() {
  const calendario = new Promise<Response>((ok) => {
    apriCalendario = () => ok(new Response(JSON.stringify({ success: true, data: [{ scuola_id: 'sc-1', righe: CAL_SEDE }] }), { status: 200 }));
  });
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/anno/calendario')) return calendario;
    if (u.startsWith('/api/admin/settings/categorie')) {
      return { ok: true, json: async () => ({ success: true, data: [{ id: 'c1', nome: 'Gita', slug: 'gita' }] }) };
    }
    if (u.startsWith('/api/admin/students')) {
      return { ok: true, json: async () => ({ success: true, data: [{ id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' }] }) };
    }
    if (init?.method === 'POST' && u === '/api/pagamenti/genera') {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ success: true, data: { generati: 1 } }) };
    }
    if (u.startsWith('/api/pagamenti/genera?')) {
      anteprime.push(u);
      return { ok: true, json: async () => ({ success: true, data: { candidati: [{ id: 'a1' }], gia_generati: 0 } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

const campoGruppo = () => screen.getByDisplayValue(/^gita-\d{4}$/) as HTMLInputElement;

describe('GeneratoreCategoria — l\'anteprima vale solo per la chiave che ha usato', () => {
  beforeEach(() => {
    posted = [];
    anteprime = [];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-10T10:00:00Z') });
    vi.stubGlobal('fetch', finto());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('anteprima con gita-2026, poi arriva il calendario (gita-2025): Conferma sparisce, nessun POST, poi rifatta porta gita-2025', async () => {
    render(
      <CalendarioProvider>
        <GeneratoreCategoria userId="u1" scuolaId="sc-1" />
      </CalendarioProvider>,
    );
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2026'));
    await waitFor(() => expect(screen.getByText(/Si genera per/i)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    expect(await screen.findByRole('button', { name: /Conferma generazione/ })).toBeInTheDocument();
    expect(anteprime[0]).toContain('gruppo=gita-2026');

    apriCalendario();
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2025'));
    expect(screen.queryByRole('button', { name: /Conferma generazione/ })).toBeNull();
    expect(posted).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Conferma generazione/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(anteprime[1]).toContain('gruppo=gita-2025');
    expect(posted[0].gruppo).toBe('gita-2025');
  });
  it('l\'anno della chiave è cambiato: al posto dell\'anteprima una riga con le due etichette; rifatta, sparisce', async () => {
    render(
      <CalendarioProvider>
        <GeneratoreCategoria userId="u1" scuolaId="sc-1" />
      </CalendarioProvider>,
    );
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2026'));
    await waitFor(() => expect(screen.getByText(/Si genera per/i)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    expect(await screen.findByRole('button', { name: /Conferma generazione/ })).toBeInTheDocument();
    expect(screen.queryByText(/L’anteprima era per il/)).toBeNull();

    apriCalendario();
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2025'));
    const riga = screen.getByText('L’anteprima era per il 2026/27: rifalla per il 2025/26');
    expect(riga).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/Anteprima generazione/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    expect(await screen.findByRole('button', { name: /Conferma generazione/ })).toBeInTheDocument();
    expect(screen.queryByText(/L’anteprima era per il/)).toBeNull();
  });

  it('la chiave cambiata a mano (stesso anno) non scrive la riga: l\'ha cambiata la segreteria', async () => {
    render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2026'));
    await waitFor(() => expect(screen.getByText(/Si genera per/i)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    expect(await screen.findByRole('button', { name: /Conferma generazione/ })).toBeInTheDocument();

    fireEvent.change(campoGruppo(), { target: { value: 'gita-primavera-2026' } });
    expect(screen.queryByRole('button', { name: /Conferma generazione/ })).toBeNull();
    expect(screen.queryByText(/L’anteprima era per il/)).toBeNull();
  });
});

describe('GeneratoreCategoria — la scadenza proposta è il giorno di Roma', () => {
  beforeEach(() => vi.stubGlobal('fetch', finto()));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('alle 22:30 UTC del 31 agosto (a Roma è il 1° settembre) la scadenza è 2026-09-01', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-31T22:30:00Z') });
    const { container } = render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(campoGruppo()).toBeInTheDocument());
    expect((container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-09-01');
  });
});
