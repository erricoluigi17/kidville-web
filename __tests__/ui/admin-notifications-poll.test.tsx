import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * C2 (ciclo 2) — AdminNotificationsPanel è montato DUE volte: nella topbar
 * desktop (`AdminTopBar`, lg:flex) e nella topbar mobile (`AdminTopBarMobile`,
 * lg:hidden). Entrambe restano nel DOM a ogni breakpoint (sono solo nascoste via
 * CSS): senza guardia entrambe le istanze fanno fetch + poll su /api/notifiche,
 * raddoppiando le chiamate.
 *
 * La prop `attivoSu` (media query) abilita fetch+poll SOLO quando la query
 * combacia. Senza prop il pannello resta sempre attivo (retro-compatibile con
 * usi che non passano la prop).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { AdminNotificationsPanel } from '@/components/features/admin/AdminNotificationsPanel';

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((media: string) => ({
      matches,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('AdminNotificationsPanel — fetch/poll gated dalla media query (C2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: [], non_lette: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('attivoSu che NON combacia → nessuna fetch a /api/notifiche', async () => {
    stubMatchMedia(false);
    render(<AdminNotificationsPanel userId="u1" attivoSu="(min-width: 1024px)" />);
    // lascia flushare effetti + eventuale re-render della media query
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attivoSu che combacia → una sola fetch a /api/notifiche', async () => {
    stubMatchMedia(true);
    render(<AdminNotificationsPanel userId="u1" attivoSu="(min-width: 1024px)" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/notifiche?userId=u1');
  });

  it('senza prop attivoSu → una sola fetch (retro-compatibile)', async () => {
    stubMatchMedia(false); // irrilevante: senza prop l'effetto media non parte
    render(<AdminNotificationsPanel userId="u1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
