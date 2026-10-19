import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScrutinioPeriodiManager } from '@/components/features/admin/primaria/ScrutinioPeriodiManager';

// =============================================================================
// W2-G — «ogni scrittura dichiara la sua sede», anche dal cockpit.
//
// La route `admin/primaria/scrutinio-periodi` non scrive più su
// `auth.user.scuola_id` (la PRIMA sede assegnata all'account, che con tre plessi
// non è più «la scuola»): risolve la sede con `resolveScuolaScrittura`, che dal
// 2026-07-31 risponde davvero 400 quando è ambigua. Il pannello riceve già la
// sede scelta — `PagelleScrutinioPanel` è dentro `SedeRequired` — ma la buttava
// via: il tipo dichiarava `scuolaId` e la destrutturazione non lo prendeva.
// Restava in piedi solo grazie al cookie `sedi_attive`, cioè a un canale
// implicito. Qui si verifica che la sede viaggi ESPLICITAMENTE nel corpo del
// POST: è il canale che il server valida contro i plessi accessibili.
// =============================================================================

const SEDE_SCELTA = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';

type Chiamata = { url: string; metodo: string; body: Record<string, unknown> | null };

function mockFetch(chiamate: Chiamata[]) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    chiamate.push({
      url: String(url),
      metodo: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

describe('ScrutinioPeriodiManager — la sede si dichiara, non si deduce', () => {
  const chiamate: Chiamata[] = [];
  beforeEach(() => {
    chiamate.length = 0;
    vi.stubGlobal('fetch', mockFetch(chiamate));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('il POST di un nuovo periodo porta la sede scelta nel corpo', async () => {
    render(<ScrutinioPeriodiManager scuolaId={SEDE_SCELTA} userId="u-1" />);
    // attende la prima lettura, così il click non parte su un componente ancora vuoto
    await waitFor(() => expect(chiamate.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByPlaceholderText('Nome (es. Scrutinio finale)'), {
      target: { value: 'Scrutinio finale' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Aggiungi periodo/ }));

    await waitFor(() => expect(chiamate.some((c) => c.metodo === 'POST')).toBe(true));
    const post = chiamate.find((c) => c.metodo === 'POST')!;
    expect(post.body).toMatchObject({ scuolaId: SEDE_SCELTA, nome: 'Scrutinio finale' });
  });

  it('la lettura è ristretta alla sede scelta', async () => {
    render(<ScrutinioPeriodiManager scuolaId={SEDE_SCELTA} userId="u-1" />);
    await waitFor(() => expect(chiamate.length).toBeGreaterThan(0));
    expect(chiamate[0].url).toContain(`scuolaId=${SEDE_SCELTA}`);
  });
});

// =============================================================================
// Fase 4 della robustezza (D3-C): un periodo si ARCHIVIA. Il pulsante chiede conferma,
// manda `archiviato: true`, e un periodo archiviato offre solo «Rimetti in elenco».
// =============================================================================
describe('ScrutinioPeriodiManager — archiviare invece di cancellare', () => {
  const chiamate: Chiamata[] = [];
  const periodo = (archiviato_il: string | null) => ({
    id: 'p-1', nome: 'Primo quadrimestre', anno_scolastico: '2026/2027', ordine: 1,
    data_inizio: null, data_fine: null, attivo: true, archiviato_il,
  });
  function fetchConPeriodo(archiviato_il: string | null) {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      chiamate.push({
        url: String(url),
        metodo: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      return { ok: true, json: async () => ({ success: true, data: [periodo(archiviato_il)] }) };
    });
  }
  beforeEach(() => { chiamate.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('«Archivia periodo» chiede conferma e manda archiviato: true', async () => {
    vi.stubGlobal('fetch', fetchConPeriodo(null));
    const conferma = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ScrutinioPeriodiManager scuolaId={SEDE_SCELTA} userId="u-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archivia periodo' }));
    await waitFor(() => expect(chiamate.some((c) => c.metodo === 'PATCH')).toBe(true));
    expect(conferma).toHaveBeenCalledTimes(1);
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.body).toEqual({ id: 'p-1', archiviato: true });
  });

  it('se la conferma è negata non parte niente', async () => {
    vi.stubGlobal('fetch', fetchConPeriodo(null));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ScrutinioPeriodiManager scuolaId={SEDE_SCELTA} userId="u-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archivia periodo' }));
    expect(chiamate.some((c) => c.metodo === 'PATCH')).toBe(false);
  });

  it('un periodo archiviato mostra il segno e solo «Rimetti in elenco», che manda archiviato: false', async () => {
    vi.stubGlobal('fetch', fetchConPeriodo('2026-10-19T20:00:00.000Z'));
    render(<ScrutinioPeriodiManager scuolaId={SEDE_SCELTA} userId="u-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rimetti in elenco' }));
    expect(screen.getByText('archiviato')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Elimina periodo' })).toBeNull();
    await waitFor(() => expect(chiamate.some((c) => c.metodo === 'PATCH')).toBe(true));
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.body).toEqual({ id: 'p-1', archiviato: false });
  });

  it('«Mostra anche gli archiviati» rilegge con archiviati=si', async () => {
    vi.stubGlobal('fetch', fetchConPeriodo(null));
    render(<ScrutinioPeriodiManager scuolaId={SEDE_SCELTA} userId="u-1" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Mostra anche gli archiviati/ }));
    await waitFor(() => expect(chiamate.some((c) => c.url.includes('archiviati=si'))).toBe(true));
  });
});
