import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';
import { CalendarioProvider } from '@/lib/context/calendario-context';

// =============================================================================
// PR 4.1 · giro finale (M3) · «Genera rette»: la CONFERMA non rilegge l'anno al clic.
//
// L'anteprima conta i candidati di un anno; se prima della conferma arriva il calendario della sede e
// l'anno proposto cambia, «Conferma» non deve generare le rette dell'anno nuovo con i candidati
// dell'anteprima vecchia. Scelta: l'anteprima di un altro anno SPARISCE e va rifatta (nessun POST possibile).
// =============================================================================

const riga = (annoInizio: number, inizio: string, fine: string) => ({
  annoId: `a${annoInizio}`, annoSedeId: `r${annoInizio}`, annoInizio, inizio, fine,
  ultimoGiornoAperto: fine, preparaSuccessivoDal: inizio, stato: 'corrente', domandeAperte: false,
});
// la sede il cui 2026/27 comincia il 15 settembre: il 10 settembre l'anno proposto è il 2025
const CAL_SEDE = [riga(2025, '2025-09-01', '2026-09-14'), riga(2026, '2026-09-15', '2027-08-31')];

let apriCalendario: () => void = () => {};
let posted: unknown[] = [];
let anteprime: string[] = [];

beforeEach(() => {
  posted = [];
  anteprime = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T10:00:00Z')); // a Roma: 10 settembre 2026
  const calendario = new Promise<Response>((ok) => {
    apriCalendario = () => ok(new Response(JSON.stringify({ success: true, data: [{ scuola_id: 'sede-1', righe: CAL_SEDE }] }), { status: 200 }));
  });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/anno/calendario')) return calendario;
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ success: true, data: { generati: 3 } }) };
    }
    anteprime.push(u);
    return { ok: true, json: async () => ({ success: true, data: {
      mesi: [{ periodo: '2026-09-01', candidati: 3, gia_generati: 0, importo: 450 }],
      alunni_attivi: 3, retta_default: 150, totale_candidati: 3, totale_previsto: 450,
    } }) };
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GeneratoreRette — l\'anteprima vale solo per l\'anno che ha contato', () => {
  it('anteprima col predefinito (2026), poi arriva il calendario (2025): Conferma sparisce e nessun POST parte', async () => {
    render(
      <CalendarioProvider>
        <GeneratoreRette userId="u1" scuolaId="sede-1" />
      </CalendarioProvider>,
    );
    expect(screen.getByDisplayValue('2026/2027')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    expect(await screen.findByRole('button', { name: /Genera 3 rette/ })).toBeInTheDocument();
    expect(anteprime[0]).toContain('anno=2026');

    apriCalendario();
    // si aspetta la PRESENZA del nuovo anno proposto, poi si guarda che la conferma non ci sia più
    expect(await screen.findByDisplayValue('2025/2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Genera 3 rette/ })).toBeNull();
    expect(posted).toHaveLength(0);

    // rifatta l'anteprima, la conferma porta l'anno NUOVO
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Genera 3 rette/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(anteprime[1]).toContain('anno=2025');
    expect((posted[0] as { anno: number }).anno).toBe(2025);
  });

  it('senza cambi, la conferma manda l\'anno dell\'anteprima', async () => {
    render(<GeneratoreRette userId="u1" scuolaId="sede-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Anteprima/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Genera 3 rette/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { anno: number }).anno).toBe(2026);
  });
});
