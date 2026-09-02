import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * LA VOCE «PROFILO» DEL DOCENTE ESISTE DAVVERO — e lo slot c’era già.
 *
 * ─── PERCHÉ QUESTO TEST ─────────────────────────────────────────────────────
 *
 * `TeacherBottomNav` dichiarava la voce «Profilo» con `href: null, soon: true`,
 * cioè un riquadro grigio con scritto «In arrivo». Era onesto finché la pagina non
 * c’era. Dal momento in cui il cambio password vive anche nell’area docente, quel
 * badge diventa una bugia detta all’unica popolazione che non ha nessun’altra
 * strada per arrivarci: l’insegnante non ha un profilo genitore da cui passare, e
 * senza questa voce la schermata esisterebbe senza che nessuno possa aprirla.
 *
 * È lo stesso difetto, con un’altra faccia, di `cambia-profilo-nei-menu`: un
 * componente perfetto che nessuno monta.
 *
 * ⚠️ IL BADGE «IN ARRIVO» NON VA TOLTO DAL COMPONENTE, e il controllo positivo qui
 * sotto lo pretende: «Calendario» una rotta non ce l’ha ancora, e deve continuare a
 * dirlo. Un test che si accontentasse di «Profilo è un link» resterebbe verde anche
 * se qualcuno cancellasse il meccanismo del badge per tutte le voci.
 */

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

vi.mock('@/components/ui/LogoutMenuButton', () => ({ LogoutMenuButton: () => null }));
vi.mock('@/components/ui/ContrastMenuButton', () => ({ ContrastMenuButton: () => null }));
vi.mock('@/components/ui/CambiaProfiloMenuButton', () => ({ CambiaProfiloMenuButton: () => null }));

import TeacherBottomNav from '@/components/features/teacher/TeacherBottomNav';
import itNav from '../../messages/it/teacherNav.json';

const NAV = itNav as Record<string, string>;

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) }));

beforeEach(() => {
  vi.clearAllMocks();
  stub.pathname = '/teacher';
  stub.params = new URLSearchParams();
  window.localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function apriIlMenu() {
  render(<TeacherBottomNav />);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(NAV.ariaMenu, 'i') }));
}

describe('TeacherBottomNav — «Profilo» porta da qualche parte', () => {
  it('è un LINK verso /teacher/profilo, non un riquadro spento', () => {
    apriIlMenu();
    const voce = screen.getByRole('link', { name: new RegExp(NAV.voceProfiloLabel, 'i') });
    expect(voce.getAttribute('href')).toBe('/teacher/profilo');
  });

  it('e non porta più il badge «In arrivo»', () => {
    apriIlMenu();
    const voce = screen.getByRole('link', { name: new RegExp(NAV.voceProfiloLabel, 'i') });
    expect(voce.textContent).not.toContain(NAV.badgeInArrivo);
  });

  it('CONTROLLO POSITIVO — il badge esiste ancora, su una voce che una rotta non ce l’ha', () => {
    // Senza questa prova, cancellare il meccanismo del badge renderebbe verdi i due
    // test qui sopra: «Profilo non ha il badge» sarebbe vero perché non ce l'ha
    // nessuno.
    apriIlMenu();
    const calendario = screen.getByText(NAV.voceCalendarioLabel).closest('[aria-disabled="true"]');
    expect(calendario, 'la voce «Calendario» non è più dichiarata come non navigabile').not.toBeNull();
    expect(calendario?.textContent).toContain(NAV.badgeInArrivo);
  });
});
