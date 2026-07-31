import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';

/**
 * W3-E · R75 — `/admin/mensa/cucina` non diceva al server di quale sede parlava.
 *
 * La pagina sorella `/admin/mensa` sta dentro `SedeRequired` e passa `scuolaId`;
 * questa è stata clonata dalla versione mono-sede e non è mai stata allineata.
 * Risultato: sia il «Menu di oggi» sia il report — che è NOMINATIVO e porta i
 * CONFLITTI DI ALLERGENE bambino per bambino — partivano senza `scuola_id`, e il
 * server ripiegava sulla prima sede utile. Un elenco di una sola sede presentato
 * come «il» report della cucina.
 *
 * Dal 2026-07-31 `resolveScuolaScrittura` risponde 400 quando la sede è ambigua:
 * senza questo fix la pagina non ripiega più in silenzio — si rompe e basta.
 *
 * Qui si asserisce il GIRO COMPLETO: dal guard di sede fino alla query.
 */

const h = vi.hoisted(() => ({
  stato: {
    sedi: [] as { id: string; nome: string }[],
    sedeCorrente: null as string | null,
    loading: false,
  },
  fetchMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/admin/mensa/cucina',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'seg-1', role: 'segreteria', ready: true }),
}));

// Riproduzione fedele del guard vero (sede-context.tsx): senza UNA sede risolta
// non rende i figli — e quindi non parte nessuna fetch.
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: h.stato.sedi,
    selezionate: [],
    effettive: h.stato.sedi.map((s) => s.id),
    sedeCorrente: h.stato.sedeCorrente,
    reFetchKey: h.stato.sedi.map((s) => s.id).join(','),
    loading: h.stato.loading,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
  SedeNotice: ({ cosa }: { cosa?: string }) => <div data-testid="sede-notice">{cosa}</div>,
  SedeRequired: ({ cosa, children }: { cosa?: string; children: (id: string) => React.ReactNode }) =>
    h.stato.loading ? (
      <div>attendi</div>
    ) : h.stato.sedeCorrente ? (
      <>{children(h.stato.sedeCorrente)}</>
    ) : (
      <div data-testid="sede-notice">{cosa}</div>
    ),
}));

const menuDelGiorno = {
  data: new Date().toISOString().slice(0, 10),
  attivo: true,
  chiuso: false,
  portate: { primo: 'Pasta al pomodoro' },
  allergeni: null,
  note: null,
};

const report = {
  data: new Date().toISOString().slice(0, 10),
  totale: 1,
  perClasse: [{ classe: '2 ANNI', conteggio: 1, alunni: [{ id: 'a1', nome: 'Bimbo Uno', classe: '2 ANNI', allergeni: [], conflitti: [] }] }],
  allergie: [],
  alternative_automatiche: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.stato.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ];
  h.stato.sedeCorrente = SEDE_B;
  h.stato.loading = false;
  h.fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/api/mensa/menu')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [menuDelGiorno] }) });
    if (u.includes('/api/mensa/report')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: report }) });
    if (u.includes('/api/mensa/alternative')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { alternative: [] } }) });
    return Promise.resolve({ ok: true, json: async () => ({ success: false }) });
  });
  vi.stubGlobal('fetch', h.fetchMock);
});

import CucinaPage from '@/app/(dashboard)/admin/mensa/cucina/page';

const urlChiamate = () => h.fetchMock.mock.calls.map((c) => String(c[0]));

describe('/admin/mensa/cucina — la sede scelta arriva fino alla query', () => {
  it('il menu del giorno è chiesto PER la sede selezionata', async () => {
    render(<CucinaPage />);
    await waitFor(() => expect(urlChiamate().some((u) => u.includes('/api/mensa/menu'))).toBe(true));
    const menu = urlChiamate().filter((u) => u.includes('/api/mensa/menu'));
    expect(menu).toHaveLength(1);
    expect(menu[0]).toContain(`scuola_id=${SEDE_B}`);
    expect(menu[0]).not.toContain(SEDE_A);
  });

  it('il report nominativo con gli allergeni è chiesto PER la stessa sede', async () => {
    render(<CucinaPage />);
    await waitFor(() => expect(urlChiamate().some((u) => u.includes('/api/mensa/report'))).toBe(true));
    for (const u of urlChiamate().filter((x) => x.includes('/api/mensa/report') || x.includes('/api/mensa/alternative'))) {
      expect(u).toContain(`scuola_id=${SEDE_B}`);
    }
  });

  it('sede ambigua (due plessi attivi, nessuno scelto): lo dice e NON chiede nulla', async () => {
    h.stato.sedeCorrente = null;
    render(<CucinaPage />);
    await screen.findByTestId('sede-notice');
    // Niente ripiego silenzioso: nessuna riga di allergeni di una sede a caso.
    await waitFor(() => expect(screen.getByTestId('sede-notice')).toBeInTheDocument());
    expect(urlChiamate().filter((u) => u.includes('/api/mensa/'))).toEqual([]);
  });
});
