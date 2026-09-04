import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

/**
 * DOVE STA LA VOCE — nei tre menu veri, e nell'ordine giusto.
 *
 * ─── PERCHÉ NON BASTA IL TEST DEL COMPONENTE ────────────────────────────────
 * `cambia-profilo.test.tsx` monta `CambiaProfiloMenuButton` da solo e prova che
 * si comporta bene. Un componente perfetto che nessuno monta è però esattamente
 * lo stato in cui questa funzione si trovava prima: la rotta che scrive il
 * cookie esisteva già dal 2026-08, e mancava soltanto il comando dentro l'app.
 * Qui si monta la NAVIGAZIONE VERA delle tre aree e si guarda se la voce c'è.
 *
 * ─── E L'ORDINE È PARTE DEL REQUISITO ───────────────────────────────────────
 * Lontano da «Esci», che è distruttivo: chi cerca «cambia veste» col pollice,
 * di fretta, non deve trovarsi il logout sotto il dito.
 *
 * ⚠️ Fino al 2026-09-04 l'ancora dell'ordine era «Alto contrasto», che stava fra
 * «Passa a…» ed «Esci». Non c'è più in questi menu: è diventato un interruttore
 * con lo stato visibile nelle pagine impostazioni (`ContrastSwitch`), perché è
 * uno STATO che dura un anno e non un comando, e in un menu rapido si accendeva
 * per sbaglio senza dare segno di essere acceso. L'asserzione sull'ordine non è
 * stata tolta: è stata SPOSTATA su «Esci», e accanto le si è aggiunto il
 * controllo che «Alto contrasto» in questi menu NON ci sia — così un
 * ripensamento distratto diventa rosso invece che silenzioso.
 */

// Riferimenti STABILI: `useSearchParams` e `useRouter` finiscono nelle deps degli
// effect dell'identità (docente e genitore). Restituire un oggetto NUOVO a ogni
// render manda il componente in loop — e non è un difetto del prodotto, è del
// finto. La lezione è già scritta in `parent-figli-una-chiamata.test.tsx`.
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

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, variants, transition, custom, whileHover, whileTap, layout, layoutId, ...rest } = props;
    void initial; void animate; void exit; void variants; void transition;
    void custom; void whileHover; void whileTap; void layout; void layoutId;
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

vi.mock('@/lib/offline/pulizia-cache', () => ({ svuotaCacheLocale: vi.fn(async () => {}) }));

// Il cockpit legge le sedi da un provider che fa una fetch tutta sua: qui non
// c'entra, e montarlo davvero aggiungerebbe rumore alla misura.
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [], errore: false, selezionate: [], effettive: [], sedeCorrente: null,
    reFetchKey: '', epocaSede: 0, loading: false,
    toggle: () => {}, soloSede: () => {}, tutte: () => {}, ricarica: () => {},
  }),
}));

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider';
import BottomNav from '@/components/features/parent/BottomNav';
import TeacherBottomNav from '@/components/features/teacher/TeacherBottomNav';
import { AdminMenuSheet } from '@/components/features/admin/AdminMenuSheet';
import { invalidaProfiliCache } from '@/lib/auth/use-profili';

type Profilo = { ruolo: string; area: string };
const DOPPIO: Profilo[] = [
  { ruolo: 'educator', area: 'teacher' },
  { ruolo: 'genitore', area: 'parent' },
];
const STAFF_E_GENITORE: Profilo[] = [
  { ruolo: 'segreteria', area: 'admin' },
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

/** Posizione nel DOM: `compareDocumentPosition` dice chi viene prima davvero. */
function precede(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function apriMenu(nome: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: nome }));
}

describe('la voce «Passa a…» è nei tre menu, lontano da «Esci», e l’alto contrasto non c’è più', () => {
  it('menu Famiglia (BottomNav genitore)', async () => {
    render(<AccessibilityProvider><BottomNav /></AccessibilityProvider>);
    await apriMenu(/Apri il menu|Menu/i);

    const passa = await screen.findByRole('button', { name: /Passa a Docente/i });
    const esci = screen.getByRole('button', { name: /Esci/i });

    expect(precede(passa, esci), '«Esci» resta l’ultima, e lontana').toBe(true);
    expect(
      screen.queryByRole('button', { name: /Alto contrasto/i }),
      '«Alto contrasto» non torna nel menu rapido: è un interruttore delle impostazioni',
    ).toBeNull();
  });

  it('menu Docente (TeacherBottomNav)', async () => {
    stub.pathname = '/teacher';
    render(<AccessibilityProvider><TeacherBottomNav /></AccessibilityProvider>);
    await apriMenu(/Apri il menu|Menu/i);

    const passa = await screen.findByRole('button', { name: /Passa a Genitore/i });
    const esci = screen.getByRole('button', { name: /Esci/i });

    expect(precede(passa, esci)).toBe(true);
    expect(screen.queryByRole('button', { name: /Alto contrasto/i })).toBeNull();
  });

  it('menu Direzione (AdminMenuSheet)', async () => {
    stub.pathname = '/admin';
    profiliServiti = STAFF_E_GENITORE;
    const trigger = { current: null } as React.RefObject<HTMLButtonElement | null>;
    render(
      <AccessibilityProvider>
        <AdminMenuSheet open onClose={() => {}} withUser={(h) => h} ruolo="segreteria" returnFocusRef={trigger} />
      </AccessibilityProvider>,
    );

    const passa = await screen.findByRole('button', { name: /Passa a Genitore/i });
    const esci = screen.getByRole('button', { name: /Esci/i });

    expect(precede(passa, esci)).toBe(true);
    expect(screen.queryByRole('button', { name: /Alto contrasto/i })).toBeNull();
  });

  it('CONTROLLO NEGATIVO: con un profilo solo i tre menu non mostrano niente in più', async () => {
    profiliServiti = [{ ruolo: 'educator', area: 'teacher' }];
    stub.pathname = '/teacher';
    render(<AccessibilityProvider><TeacherBottomNav /></AccessibilityProvider>);
    await apriMenu(/Apri il menu|Menu/i);

    // POSITIVO prima del negativo: il menu si è davvero aperto, altrimenti
    // «non trovo la voce» sarebbe vero anche su una schermata vuota.
    // L'ancora positiva era «Alto contrasto»; dal 2026-09-04 non è più in questi
    // menu, quindi il segno che il menu si è davvero aperto è «Esci».
    expect(await screen.findByRole('button', { name: /Esci/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/me'))).toBe(true),
    );

    expect(screen.queryByRole('button', { name: /Passa a/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cambia profilo/i })).toBeNull();
  });
});
