import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Il foglio MENU non deve chiudersi NELLO STESSO click che avvia la navigazione.
 *
 * IL DIFETTO, misurato — non dedotto. Su `main` l'E2E `parent-news.spec.ts:51`
 * («apro il menu e vado alla sezione News») falliva a intermittenza da giorni, e
 * due ipotesi erano già state provate e smontate: il focus trap (ritirato, vedi il
 * commento in `BottomNav.tsx`) e l'overlay del loader globale (mitigato con
 * `attendiFineCaricamento`, senza effetto). La traccia Playwright della run
 * 30920578641 ha mostrato la sequenza vera:
 *
 *   · il click sulla voce ARRIVA (Playwright lo esegue dopo 4 tentativi, quando
 *     l'animazione del foglio si ferma);
 *   · la richiesta RSC verso `/parent/news` PARTE e torna `200` in 283 ms;
 *   · e l'URL resta su `/parent` per tutti i 5 secondi successivi.
 *
 * Cioè: la navigazione parte, i dati arrivano, e la transizione non si conclude
 * mai. La causa è `onClick={() => setShowMenu(false)}` sul `<Link>`: il click
 * avvia la navigazione di Next — che è una **transizione React** — e nello stesso
 * istante smonta il `<Link>` che quella transizione sta portando. Se il payload
 * arriva prima dello smontaggio la navigazione passa; se arriva dopo, si perde.
 * È una corsa, ed è per questo che sembrava capriccio del test: la stessa riga di
 * codice passava a 5,6 s e falliva a 6,9 s.
 *
 * NON È UN DIFETTO DEL TEST. È la navigazione principale di ogni famiglia: su una
 * rete lenta — un genitore col telefono davanti a scuola — il payload tarda, e
 * toccare «News» non porta da nessuna parte.
 *
 * LA REGOLA CHE QUESTO FILE BLOCCA: il foglio si chiude **quando la rotta è
 * cambiata**, non quando si clicca. L'unica eccezione è la voce della rotta in cui
 * si è già, dove nessuna navigazione avverrebbe e il foglio resterebbe aperto per
 * sempre.
 *
 * Vale per ENTRAMBE le bottom-nav — genitore e docente — perché lo schema era
 * copiato in tutte e due.
 */

const stub = vi.hoisted(() => ({ pathname: '/parent' }));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// `next/link` reale pretende un router: qui basta l'ancora, perché ciò che si
// verifica è se il foglio resta montato, non dove porta il link.
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
  return { motion, AnimatePresence: ({ children }: { children: React.ReactNode }) => children };
});

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl');
  const nav = (await import('../../messages/it/nav.json')).default as Record<string, string>;
  const traduci = createTranslator({ locale: 'it', messages: { nav } as never, namespace: 'nav' as never });
  return { useTranslations: () => traduci, useLocale: () => 'it' };
});

vi.mock('@/lib/auth/use-child-school-type', () => ({
  useChildSchoolType: () => ({ schoolType: 'infanzia', loading: false }),
}));

vi.mock('@/components/ui/LogoutMenuButton', () => ({ LogoutMenuButton: () => null }));
vi.mock('@/components/ui/ContrastMenuButton', () => ({ ContrastMenuButton: () => null }));

const { default: BottomNav } = await import('@/components/features/parent/BottomNav');

function apriIlMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Menu/i }));
}

describe('BottomNav — il foglio MENU e la navigazione', () => {
  beforeEach(() => {
    stub.pathname = '/parent';
  });

  it('il click su una voce NON chiude il foglio: chiuderlo smonta il Link e annulla la navigazione', () => {
    render(<BottomNav />);
    apriIlMenu();

    const voceNews = screen.getByRole('link', { name: /News/i });
    expect(voceNews).toHaveAttribute('href', '/parent/news');

    fireEvent.click(voceNews);

    // Il foglio deve essere ANCORA a schermo: la transizione di Next è in corso e
    // il `<Link>` che la porta non può sparire sotto di lei.
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(screen.queryByRole('link', { name: /News/i })).not.toBeNull();
  });

  it('il foglio si chiude quando la rotta è davvero cambiata', () => {
    const { rerender } = render(<BottomNav />);
    apriIlMenu();
    expect(screen.queryByRole('dialog')).not.toBeNull();

    stub.pathname = '/parent/news';
    rerender(<BottomNav />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sulla voce della rotta corrente il foglio si chiude subito: lì nessuna navigazione avverrebbe', () => {
    stub.pathname = '/parent/news';
    render(<BottomNav />);
    apriIlMenu();

    fireEvent.click(screen.getByRole('link', { name: /News/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
