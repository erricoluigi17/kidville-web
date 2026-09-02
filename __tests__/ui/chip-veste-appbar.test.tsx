import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * IL CHIP DELLA VESTE — ciò che rende il cambio VISIBILE e non solo AVVENUTO.
 *
 * Un'insegnante che è anche genitore si fa la stessa domanda dieci volte al
 * giorno: «in che veste sto guardando questa schermata?». Prima di oggi non
 * c'era nessuna risposta a schermo: la si deduceva dall'URL, o dal fatto che i
 * dati sembrassero quelli giusti — cioè quando era già tardi.
 *
 * ─── LA VESTE LA DICE IL PERCORSO, NON UN RICORDO ───────────────────────────
 * Il chip non legge `kv_user_role` per primo. Se lo facesse, un valore stantìo
 * («genitore») su una schermata `/teacher` mostrerebbe la parola sbagliata
 * proprio a chi il chip lo guarda per non sbagliarsi. La fonte è l'area del
 * percorso; `kv_user_role` interviene solo dove il percorso non decide, e solo
 * se nomina un ruolo che la persona ha davvero.
 *
 * ─── E PER 617 PERSONE SU 622 NON ESISTE ────────────────────────────────────
 * Con un profilo solo non c'è nessuna veste da distinguere: il chip sarebbe
 * un'etichetta che ripete una cosa sola per sempre.
 */

const stub = vi.hoisted(() => ({
  pathname: '/parent',
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

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, variants, transition, layout, layoutId, ...rest } = props;
    void initial; void animate; void exit; void variants; void transition; void layout; void layoutId;
    return rest;
  };
  const motion = new Proxy({} as Record<string, unknown>, {
    get: (_t, tag: string) => (props: Record<string, unknown>) =>
      React.createElement(tag, strip(props), (props as { children?: React.ReactNode }).children),
  });
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

// Il centro notifiche fa polling per conto suo: qui non c'entra.
vi.mock('@/components/features/shell/NotificationsPanel', () => ({
  NotificationsPanel: () => null,
}));

import { AppBar } from '@/components/features/shell/AppBar';
import { invalidaProfiliCache } from '@/lib/auth/use-profili';

type Profilo = { ruolo: string; area: string };
const DOPPIO: Profilo[] = [
  { ruolo: 'educator', area: 'teacher' },
  { ruolo: 'genitore', area: 'parent' },
];

let profiliServiti: Profilo[] = DOPPIO;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  invalidaProfiliCache();
  profiliServiti = DOPPIO;
  stub.pathname = '/parent';
  window.localStorage.clear();
  // `useSessionIdentity` chiederebbe a sua volta /api/me se lo storage fosse
  // vuoto: qui l'identità c'è già, così ciò che si misura è il chip.
  window.localStorage.setItem('kv_user_id', 'u-1');

  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('/api/me')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ id: 'u-1', role: 'educator', profili: profiliServiti }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppBar — il chip della veste', () => {
  it('area genitore, due profili: il chip dice «Genitore»', async () => {
    render(<AppBar area="parent" />);
    const chip = await screen.findByTestId('chip-ruolo-attivo');
    expect(chip.textContent).toBe('Genitore');
  });

  it('stessa persona, area docente: il chip dice «Docente»', async () => {
    stub.pathname = '/teacher/diary';
    render(<AppBar area="teacher" />);
    const chip = await screen.findByTestId('chip-ruolo-attivo');
    expect(chip.textContent).toBe('Docente');
  });

  it('un profilo solo: nessun chip, e non è «non ha ancora caricato»', async () => {
    profiliServiti = [{ ruolo: 'genitore', area: 'parent' }];
    render(<AppBar area="parent" />);

    // POSITIVO prima del negativo: la barra c'è davvero e i profili sono arrivati.
    expect(await screen.findByRole('banner')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/me'))).toBe(true),
    );
    expect(screen.queryByTestId('chip-ruolo-attivo')).toBeNull();
  });

  it('lo screen reader sente di che cosa si tratta, non solo la parola «Genitore»', async () => {
    render(<AppBar area="parent" />);
    await screen.findByTestId('chip-ruolo-attivo');
    // «Profilo attivo Genitore»: la parola da sola non dice niente a chi non
    // vede la pillola verde in cui sta.
    expect(screen.getByRole('banner').textContent).toContain('Profilo attivo');
  });

  it('IL GIALLO DI BRAND NON ENTRA QUI: sul verde è 4,05:1, sotto la soglia', async () => {
    render(<AppBar area="parent" />);
    const chip = await screen.findByTestId('chip-ruolo-attivo');
    const contenitore = chip.parentElement!;
    const classi = `${contenitore.className} ${chip.className}`;
    expect(classi).not.toMatch(/kidville-yellow/);
    expect(classi).toContain('text-white');
    expect(classi).toContain('bg-white/15');
  });
});
