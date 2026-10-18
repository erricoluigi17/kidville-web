import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';

/**
 * iPad PR 3 (2026-10-18) — `AdminBinario`, la navigazione del cockpit fra 744 e 1279 px.
 *
 * Il binario non ha una lista sua: legge `TAB_ADMIN` (la stessa della barra in basso del
 * telefono) più Anagrafica, e il suo «Menu» apre `AdminMenuSheet` nella variante `pannello`.
 * Qui si verifica che:
 *  - le voci siano quelle, e che si accenda UNA sola voce;
 *  - una pagina che sta solo nel menu accenda «Menu» (`aria-current="true"`), come fa la barra in
 *    basso: senza, sul tablet nessuna voce direbbe dove sei;
 *  - «Menu» apra il pannello (non il foglio dal basso), che `Esc` chiude restituendo il fuoco;
 *  - il pannello si chiuda da solo quando la rotta cambia (Indietro, un link nel contenuto).
 *
 * `usePathname` e `useAdminIdentity` sono stubbati via `vi.hoisted`, come in
 * `admin-bottom-nav.test.tsx`; i bottoni del fondo del menu sono marker inerti.
 */

const stub = vi.hoisted(() => ({
  pathname: '/admin',
  ruolo: 'segreteria',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
}));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: SEDE_A,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}));

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({
    userId: 'u1',
    ruolo: stub.ruolo,
    withUser: (href: string) => `${href}?userId=u1`,
  }),
}));

vi.mock('@/components/ui/LogoutMenuButton', () => ({
  LogoutMenuButton: ({ className }: { className?: string }) => <button className={className}>Esci</button>,
}));
vi.mock('@/components/ui/CambiaProfiloMenuButton', () => ({
  CambiaProfiloMenuButton: ({ className }: { className?: string }) => (
    <button className={className}>Passa a Genitore</button>
  ),
}));

import { AdminBinario } from '@/components/features/admin/AdminBinario';

function binario(container: HTMLElement) {
  const el = container.querySelector('[data-kv-binario-admin]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.pathname = '/admin';
  stub.ruolo = 'segreteria';
});

describe('AdminBinario — il binario del cockpit sul tablet', () => {
  it('c’è solo sull’iPad in verticale, fra 744 e 1023 px: `tablet:flex` e `lg:hidden`', () => {
    // In orizzontale (da 1024 px) c'è la sidebar piena, come per genitori e docenti: decisione del
    // titolare del 18/10, che dopo la PR 3 vedeva sull'11" in orizzontale «il menu del telefono».
    const { container } = render(<AdminBinario />);
    const cls = binario(container).className.split(/\s+/);
    expect(cls).toContain('hidden');
    expect(cls).toContain('tablet:flex');
    expect(cls).toContain('lg:hidden');
    expect(cls).not.toContain('xl:hidden');
    // largo come `--kv-rail-w` del tablet: se cambia uno, cambia l'altro (globals.css).
    expect(cls).toContain('tablet:w-[88px]');
  });

  it('ha i quattro tab della barra in basso, Anagrafica e «Menu», con il `?userId=` della sessione', () => {
    const { container } = render(<AdminBinario />);
    const nav = within(binario(container)).getByRole('navigation');
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/admin?userId=u1',
      '/admin/avvisi?userId=u1',
      '/admin/pagamenti?userId=u1',
      '/admin/mensa?userId=u1',
      '/admin/students?userId=u1',
    ]);
    expect(within(nav).getByRole('button', { name: /menu/i })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('accende UNA voce sola: Anagrafica su /admin/students', () => {
    stub.pathname = '/admin/students';
    const { container } = render(<AdminBinario />);
    expect(screen.getByText('Anagrafica').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(container.querySelectorAll('[aria-current]').length).toBe(1);
  });

  it('Mensa resta accesa sul report della cucina', () => {
    stub.pathname = '/admin/mensa/cucina';
    render(<AdminBinario />);
    expect(screen.getByText('Mensa').closest('a')).toHaveAttribute('aria-current', 'page');
  });

  it('una pagina che sta solo nel menu accende «Menu» (aria-current="true"), e nessun link', () => {
    stub.pathname = '/admin/impostazioni';
    const { container } = render(<AdminBinario />);
    expect(screen.getByRole('button', { name: /menu/i })).toHaveAttribute('aria-current', 'true');
    expect(container.querySelectorAll('a[aria-current]').length).toBe(0);
  });

  it('«Menu» apre il PANNELLO (non il foglio), modale, e `Esc` lo chiude restituendo il fuoco', () => {
    render(<AdminBinario />);
    const menuBtn = screen.getByRole('button', { name: /menu/i });
    expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(menuBtn);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('[data-kv-menu-admin]')).toHaveAttribute('data-kv-menu-admin', 'pannello');
    expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    // Col pannello aperto si accende «Menu» e si spegne la voce della pagina: una sola accesa.
    expect(screen.getByText('Home').closest('a')).not.toHaveAttribute('aria-current');
    // Il pannello ha le voci del menu, non i tab del binario.
    expect(within(dialog).getByRole('link', { name: /impostazioni/i })).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(menuBtn);
  });

  it('il pannello si chiude da solo quando la rotta cambia', () => {
    const { rerender } = render(<AdminBinario />);
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    stub.pathname = '/admin/impostazioni';
    rerender(<AdminBinario />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
