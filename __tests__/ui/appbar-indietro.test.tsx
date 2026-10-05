import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import condivisi from '../../messages/it/shared.json';

/**
 * LA FRECCIA «INDIETRO» DELL'APPBAR — e le schermate che ne hanno già una migliore.
 *
 * La freccia porta «su di un livello», IN AVANTI (niente `router.back()`: con deep link
 * e riavvii della shell nativa la history può uscire dall'app). Dove la pagina ha già il
 * proprio ritorno, la freccia non si disegna: due «indietro» che portano in posti
 * diversi sono un indovinello.
 *
 * Sulla scheda anagrafica dell'insegnante la differenza si vede: «Tutti gli alunni»
 * riapre l'elenco CON i filtri che c'erano, la freccia lo riaprirebbe senza.
 */

const S = condivisi as Record<string, string>;

const stub = vi.hoisted(() => ({
  pathname: '/teacher',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});

vi.mock('next/image', async () => {
  const React = await import('react');
  return {
    default: ({ alt, ...rest }: { alt: string }) => React.createElement('img', { alt, ...rest }),
  };
});

// Il centro notifiche fa polling per conto suo: qui non c'entra.
vi.mock('@/components/features/shell/NotificationsPanel', () => ({
  NotificationsPanel: () => null,
}));

import { AppBar } from '@/components/features/shell/AppBar';
import { invalidaProfiliCache } from '@/lib/auth/use-profili';

const fetchMock = vi.fn();
const ID = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  invalidaProfiliCache();
  window.localStorage.clear();
  window.localStorage.setItem('kv_user_id', 'u-1');
  fetchMock.mockImplementation((url: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/api/me')
          ? { id: 'u-1', role: 'educator', profili: [{ ruolo: 'educator', area: 'teacher' }] }
          : { success: true, data: [] },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppBar — la freccia «indietro»', () => {
  it('sull’elenco degli alunni c’è, e porta alla home docente con l’identità', async () => {
    stub.pathname = '/teacher/alunni';
    render(<AppBar area="teacher" />);
    const freccia = await screen.findByRole('link', { name: S.indietro });
    await waitFor(() => expect(freccia.getAttribute('href')).toBe('/teacher?userId=u-1'));
  });

  it('sulla scheda di un bambino NON c’è: il ritorno lo fa «Tutti gli alunni», con i filtri', async () => {
    stub.pathname = `/teacher/alunni/${ID}`;
    render(<AppBar area="teacher" />);
    // POSITIVO prima del negativo: la barra è disegnata, e il suo link alla home c'è.
    expect(await screen.findByRole('link', { name: S.homeKidville })).toBeTruthy();
    expect(screen.queryByRole('link', { name: S.indietro })).toBeNull();
  });
});
