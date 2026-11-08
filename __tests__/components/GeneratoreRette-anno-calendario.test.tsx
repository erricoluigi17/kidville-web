import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';
import { CalendarioProvider } from '@/lib/context/calendario-context';

// =============================================================================
// PR 4.1 · compito 4.1.S4a · «Genera rette»: l'anno proposto lo decide il CALENDARIO della sede.
//
// Prima il componente aveva una SUA annoScolasticoCorrente() (`getMonth() + 1 >= 9` nel fuso del
// browser): il 10 settembre proponeva sempre 2026/2027, anche per una sede il cui 2026/27 comincia
// il 15 settembre. Si aspetta la PRESENZA dell'anno proposto (mai un'assenza: la fetch è in volo).
// =============================================================================

const riga = (annoInizio: number, inizio: string, fine: string) => ({
  annoId: `a${annoInizio}`, annoSedeId: `r${annoInizio}`, annoInizio, inizio, fine,
  ultimoGiornoAperto: fine, preparaSuccessivoDal: inizio, stato: 'corrente', domandeAperte: false,
});
const CAL_SEDE = [riga(2025, '2025-09-01', '2026-09-14'), riga(2026, '2026-09-15', '2027-08-31')];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T10:00:00Z')); // a Roma: 10 settembre 2026
  vi.stubGlobal('fetch', vi.fn(async () => (
    new Response(JSON.stringify({ success: true, data: [{ scuola_id: 'sede-1', righe: CAL_SEDE }] }), { status: 200 })
  )));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GeneratoreRette — l\'anno proposto segue il calendario della sede', () => {
  it('sede il cui 2026/27 comincia il 15 settembre, oggi 10 settembre: si propone il 2025/2026', async () => {
    render(
      <CalendarioProvider>
        <GeneratoreRette userId="u1" scuolaId="sede-1" />
      </CalendarioProvider>,
    );
    expect(await screen.findByDisplayValue('2025/2026')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('2026/2027')).toBeNull();
  });

  it('senza provider vale il predefinito (1° settembre): il 10 settembre si propone il 2026/2027', async () => {
    render(<GeneratoreRette userId="u1" scuolaId="sede-1" />);
    expect(await screen.findByDisplayValue('2026/2027')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('2025/2026')).toBeNull();
  });
});
