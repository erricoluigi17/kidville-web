import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { Home, BookOpen, Bell, MessageCircle, LayoutGrid, Euro, UtensilsCrossed, CalendarDays } from 'lucide-react';

/**
 * LA NAVIGAZIONE DEL TABLET — binario (744–1023 px) e sidebar (da 1024 px).
 *
 * Tre cose che un difetto qui romperebbe senza che nessun altro test se ne accorga:
 *   1. il binario apre il menu raggruppato in un pannello che si annuncia come dialogo, si chiude
 *      con Escape e AL CAMBIO DI ROTTA (non nel click: vedi `ElencoGruppiMenu`);
 *   2. la sidebar accende UNA voce sola, la più specifica — `/parent/primaria/assenze` non deve
 *      accendere anche «Registro» (`/parent/primaria`);
 *   3. nel DOM c'è UNA navigazione per volta: `NavigazioneGenitore` / `NavigazioneDocente` non
 *      montano barra e binario insieme (con due, gli E2E per testo trovano doppioni).
 */

const stub = vi.hoisted(() => ({
  pathname: '/parent',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));
vi.mock('@/components/ui/LogoutMenuButton', () => ({ LogoutMenuButton: () => null }));
vi.mock('@/components/ui/CambiaProfiloMenuButton', () => ({ CambiaProfiloMenuButton: () => null }));

import { BarraLaterale, voceAttiva, type TabPrincipale } from '@/components/features/shell/BarraLaterale';
import type { GruppoMenu } from '@/components/features/shell/ElencoGruppiMenu';

const TAB: readonly TabPrincipale[] = [
  { id: 'home', label: 'Home', icon: Home, href: '/parent' },
  { id: 'diario', label: 'Diario', icon: BookOpen, href: '/parent/diary' },
  { id: 'avvisi', label: 'Avvisi', icon: Bell, href: '/parent/avvisi' },
  { id: 'chat', label: 'Chat', icon: MessageCircle, href: '/parent/chat' },
  { id: 'menu', label: 'Menu', icon: LayoutGrid, href: null },
];

const GRUPPI: GruppoMenu[] = [
  {
    label: 'Servizi',
    items: [
      { id: 'mensa', label: 'Mensa', sub: 'Menù e prenotazioni', icon: UtensilsCrossed, href: '/parent/mensa', tint: '#E07A1F' },
      { id: 'pagamenti', label: 'Pagamenti', sub: 'Rette e ricevute', icon: Euro, href: '/parent/pagamenti', tint: '#2E7D32' },
    ],
  },
  {
    label: 'Didattica',
    items: [
      { id: 'registro', label: 'Registro', sub: 'Voti', icon: BookOpen, href: '/parent/primaria', tint: '#1565C0' },
      { id: 'presenze', label: 'Presenze', sub: 'Assenze', icon: CalendarDays, href: '/parent/primaria/assenze', tint: '#6A1B9A' },
      { id: 'calendario', label: 'Calendario', sub: 'Presto', icon: CalendarDays, href: null, tint: '#6A1B9A', soon: true },
      { id: 'chat', label: 'Chat', sub: 'Messaggi', icon: MessageCircle, href: '/parent/chat', tint: '#00838F' },
    ],
  },
];

function monta(formato: 'binario' | 'sidebar', pathname = '/parent', nonLetti = 0) {
  const isActive = (href: string) => (href === '/parent' ? pathname === '/parent' : pathname.startsWith(href));
  const pezzi =
    nonLetti > 0
      ? {
          descrittoDa: 'desc-chat',
          descrizione: <span id="desc-chat" hidden>{`${nonLetti} non letti`}</span>,
          // `aria-hidden` come il badge vero (`useBadgeChatNonLetti`): il numero sta nella descrizione.
          badge: <span aria-hidden="true" data-testid="badge-chat-non-letti">{nonLetti}</span>,
        }
      : { descrittoDa: undefined, descrizione: null, badge: null };
  const props = {
    formato,
    ariaNav: 'Navigazione principale',
    tab: TAB,
    gruppi: GRUPPI,
    pathname,
    isActive,
    menuAcceso: false,
    hrefDi: (h: string) => h,
    idBadge: 'chat',
    nonLetti: pezzi,
    testi: { ariaMenu: 'Apri il menu', eyebrow: 'Kidville', titolo: 'Menu', chiudi: 'Chiudi', inArrivo: 'In arrivo' },
  };
  const vista = render(<BarraLaterale {...props} />);
  return { ...vista, props };
}

afterEach(() => cleanup());

describe('voceAttiva — una voce sola, la più specifica', () => {
  const voci = [TAB[0], ...GRUPPI.flatMap((g) => g.items)];
  it('la home si accende solo sulla home', () => {
    expect(voceAttiva('/parent', voci, '/parent')).toBe('home');
    expect(voceAttiva('/parent/mensa', voci, '/parent')).toBe('mensa');
  });
  it('vince il percorso più lungo', () => {
    expect(voceAttiva('/parent/primaria/assenze', voci, '/parent')).toBe('presenze');
    expect(voceAttiva('/parent/primaria/pagelle', voci, '/parent')).toBe('registro');
  });
  it('un prefisso che somiglia non accende niente', () => {
    expect(voceAttiva('/parent/mensaxyz', voci, '/parent')).toBeNull();
  });
});

describe('BarraLaterale — binario', () => {
  it('ha i tab della barra in basso, con la voce corrente marcata', () => {
    monta('binario', '/parent/avvisi');
    const nav = screen.getByRole('navigation', { name: 'Navigazione principale' });
    const avvisi = within(nav).getByRole('link', { name: 'Avvisi' });
    expect(avvisi.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(document.querySelector('[data-kv-barra-laterale]')?.getAttribute('data-formato')).toBe('binario');
  });

  it('«Menu» apre un dialogo coi gruppi, che si chiude con Escape', async () => {
    monta('binario');
    const menu = screen.getByRole('button', { name: 'Apri il menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menu);
    const dialogo = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(dialogo).getByText('Servizi')).toBeTruthy();
    expect(within(dialogo).getByRole('link', { name: /Mensa/ })).toBeTruthy();
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(dialogo, { key: 'Escape' });
    // Si aspetta la fine dell'animazione d'uscita (`AnimatePresence`), non un'assenza qualsiasi:
    // prima il dialogo c'era, l'abbiamo appena visto.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('il pannello si chiude quando la rotta cambia, non prima', async () => {
    const { rerender, props } = monta('binario');
    fireEvent.click(screen.getByRole('button', { name: 'Apri il menu' }));
    // Toccare una voce di un'altra rotta NON chiude il pannello nel click…
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Mensa/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // …lo chiude il cambio di percorso.
    rerender(<BarraLaterale {...props} pathname="/parent/mensa" />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('il badge dei non letti sta dentro il link della chat, e lo descrive', () => {
    monta('binario', '/parent', 3);
    const chat = within(screen.getByRole('navigation')).getByRole('link', { name: 'Chat' });
    expect(within(chat).getByTestId('badge-chat-non-letti').textContent).toBe('3');
    expect(chat.getAttribute('aria-describedby')).toBe('desc-chat');
  });
});

describe('BarraLaterale — sidebar', () => {
  it('mostra tutte le voci per gruppo, senza il bottone Menu', () => {
    monta('sidebar', '/parent/mensa');
    expect(screen.queryByRole('button', { name: 'Apri il menu' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Navigazione principale' });
    expect(within(nav).getByText('Servizi')).toBeTruthy();
    expect(within(nav).getByText('Didattica')).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Mensa' }).getAttribute('aria-current')).toBe('page');
  });

  it('accende UNA voce sola anche quando due percorsi combaciano', () => {
    monta('sidebar', '/parent/primaria/assenze');
    const correnti = screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(correnti.map((l) => l.textContent)).toEqual(['Presenze']);
  });

  it('una voce senza rotta è spenta e dice «In arrivo»', () => {
    monta('sidebar');
    expect(screen.queryByRole('link', { name: /Calendario/ })).toBeNull();
    const spenta = screen.getByText('Calendario').closest('[aria-disabled="true"]');
    expect(spenta?.textContent).toContain('In arrivo');
  });
});

describe('una navigazione sola nel DOM', () => {
  const originale = window.matchMedia;
  afterEach(() => {
    window.matchMedia = originale;
  });

  function schermo(px: number) {
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes('46.5rem') ? px >= 744 : q.includes('64rem') ? px >= 1024 : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  it.each([
    ['genitore', '/parent'],
    ['docente', '/teacher'],
  ] as const)('%s: sul telefono la barra in basso, sul tablet il binario — mai tutte e due', async (area, rotta) => {
    stub.pathname = rotta;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { gradi: ['infanzia'] } }) })),
    );
    const Nav =
      area === 'genitore'
        ? (await import('@/components/features/parent/NavigazioneGenitore')).NavigazioneGenitore
        : (await import('@/components/features/teacher/NavigazioneDocente')).NavigazioneDocente;

    schermo(390);
    const telefono = render(<Nav />);
    expect(document.querySelectorAll('[data-kv-barra-bassa]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-kv-barra-laterale]')).toHaveLength(0);
    telefono.unmount();

    schermo(834);
    const tablet = render(<Nav />);
    expect(document.querySelectorAll('[data-kv-barra-bassa]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-kv-barra-laterale]')).toHaveLength(1);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    tablet.unmount();
    vi.unstubAllGlobals();
  });
});
