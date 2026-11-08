import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GeneratoreCategoria } from '@/components/features/admin/pagamenti/GeneratoreCategoria';
import { CalendarioProvider } from '@/lib/context/calendario-context';

/**
 * PR 4.1 · 4.1.P — la chiave anti-doppione proposta porta l'anno SCOLASTICO di oggi della sede
 * (`slug-<annoInizio>`), non l'anno solare. Solo `Date` è finto: i timer restano veri, perché i
 * `waitFor` hanno bisogno dei loro.
 */

const riga = (annoInizio: number, inizio: string, fine: string) => ({
  annoId: `a${annoInizio}`,
  annoSedeId: `r${annoInizio}`,
  annoInizio,
  inizio,
  fine,
  ultimoGiornoAperto: fine,
  preparaSuccessivoDal: inizio,
  stato: 'corrente',
  domandeAperte: false,
});

let calendario: unknown[] = [];

function finto() {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith('/api/anno/calendario')) {
      return new Response(JSON.stringify({ success: true, data: calendario, fonte: 'database' }), { status: 200 });
    }
    if (u.startsWith('/api/admin/settings/categorie')) {
      return { ok: true, json: async () => ({ success: true, data: [{ id: 'c1', nome: 'Gita', slug: 'gita' }] }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

function monta() {
  render(
    <CalendarioProvider>
      <GeneratoreCategoria userId="u1" scuolaId="sc-1" />
    </CalendarioProvider>,
  );
}

const campoGruppo = () => screen.getByDisplayValue(/^gita-\d{4}$/) as HTMLInputElement;

describe('GeneratoreCategoria — chiave anti-doppione con l\'anno scolastico', () => {
  beforeEach(() => {
    calendario = [];
    vi.stubGlobal('fetch', finto());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('il 2026-08-20 è gita-2025 (con l\'anno solare sarebbe stato gita-2026)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-20T10:00:00Z') });
    monta();
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2025'));
  });

  it('il 2026-09-01 è gita-2026', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-01T10:00:00Z') });
    monta();
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2026'));
  });

  it('con un calendario in cui il 2026/27 comincia il 14 settembre, il 2026-09-10 è ancora gita-2025', async () => {
    calendario = [
      {
        scuola_id: 'sc-1',
        righe: [riga(2025, '2025-09-01', '2026-09-13'), riga(2026, '2026-09-14', '2027-08-31')],
      },
    ];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-10T10:00:00Z') });
    monta();
    // Senza il calendario la soglia predefinita darebbe gita-2026 (1° settembre): il valore giusto
    // compare solo DOPO l'arrivo del calendario, e il campo lo segue perché non è mai stato toccato.
    await waitFor(() => expect(campoGruppo().value).toBe('gita-2025'));
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).startsWith('/api/anno/calendario'))).toBe(true);
  });
});
