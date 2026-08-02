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
