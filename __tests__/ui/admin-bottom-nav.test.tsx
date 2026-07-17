import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

/**
 * Step 2 — AdminBottomNav + AdminMenuSheet (bottom-nav mobile del cockpit).
 *
 * Sotto lg il cockpit Direzione/Segreteria naviga da una bottom-nav a pillola
 * (stile BottomNav genitore/docente) con 4 tab reali + un bottone «Menu» che apre
 * un bottom-sheet MODALE con tutte le altre voci. La sorgente delle voci è la
 * config condivisa `admin-nav-config.ts` (gli stessi `visibleItem`/gruppi della
 * sidebar): qui si verifica render, stato attivo (aria-current), gating per
 * ruolo nello sheet, chiusura con Esc e — invariante chiave — che lo sheet NON
 * ripeta gli href dei 4 tab.
 *
 * `usePathname` e `useAdminIdentity` sono stubbati via `vi.hoisted` per poter
 * variare pathname/ruolo per singolo test senza toccare rete o context reale.
 */

const stub = vi.hoisted(() => ({ pathname: '/admin', ruolo: 'segreteria' }));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
}));

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({
    userId: 'u1',
    ruolo: stub.ruolo,
    withUser: (href: string) => `${href}?userId=u1`,
  }),
}));

// I bottoni Contrasto/Logout hanno provider e test propri: qui sono marker inerti
// (come AdminNotificationsPanel nel test della topbar) così lo sheet non richiede
// <AccessibilityProvider> e il test resta focalizzato su nav + sheet.
vi.mock('@/components/ui/ContrastMenuButton', () => ({
  ContrastMenuButton: ({ className }: { className?: string }) => (
    <button className={className}>Alto contrasto</button>
  ),
}));
vi.mock('@/components/ui/LogoutMenuButton', () => ({
  LogoutMenuButton: ({ className }: { className?: string }) => <button className={className}>Esci</button>,
}));

import { AdminBottomNav } from '@/components/features/admin/AdminBottomNav';

const TAB_HREFS = ['/admin', '/admin/avvisi', '/admin/pagamenti', '/admin/mensa'];

beforeEach(() => {
  stub.pathname = '/admin';
  stub.ruolo = 'segreteria';
});

describe('AdminBottomNav — bottom-nav a pillola (Step 2)', () => {
  it('rende i 5 tab: Home · Avvisi · Contabilità · Mensa · Menu', () => {
    render(<AdminBottomNav />);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Avvisi')).toBeInTheDocument();
    expect(screen.getByText('Contabilità')).toBeInTheDocument();
    expect(screen.getByText('Mensa')).toBeInTheDocument();
    // Il quinto è un bottone (apre lo sheet), non un link.
    expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
  });

  it('marca aria-current="page" SOLO sul tab attivo (match esatto su /admin)', () => {
    stub.pathname = '/admin';
    const { container } = render(<AdminBottomNav />);
    const home = screen.getByText('Home').closest('a');
    expect(home).toHaveAttribute('aria-current', 'page');
    // una sola voce attiva in tutta la nav
    expect(container.querySelectorAll('[aria-current="page"]').length).toBe(1);
    // una sottorotta NON accende Home
    expect(screen.getByText('Avvisi').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('il tab Avvisi è attivo su /admin/avvisi e Home non lo è', () => {
    stub.pathname = '/admin/avvisi';
    const { container } = render(<AdminBottomNav />);
    expect(screen.getByText('Avvisi').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Home').closest('a')).not.toHaveAttribute('aria-current');
    expect(container.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });

  it('il tab Mensa resta attivo anche su /admin/mensa/cucina (prefisso)', () => {
    stub.pathname = '/admin/mensa/cucina';
    render(<AdminBottomNav />);
    expect(screen.getByText('Mensa').closest('a')).toHaveAttribute('aria-current', 'page');
  });

  it('il bottone Menu apre un dialog aria-modal e riflette aria-expanded', () => {
    render(<AdminBottomNav />);
    const menuBtn = screen.getByRole('button', { name: /menu/i });
    expect(menuBtn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    // chiuso → nessun dialog
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(menuBtn);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
  });

  it('nello sheet «Protocollo» è visibile alla segreteria', () => {
    stub.ruolo = 'segreteria';
    render(<AdminBottomNav />);
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Protocollo')).toBeInTheDocument();
    // Anagrafica in evidenza in cima
    expect(within(dialog).getByText('Anagrafica')).toBeInTheDocument();
  });

  it('nello sheet «Protocollo» NON è visibile alla cuoca (gating roles)', () => {
    stub.ruolo = 'cuoca';
    render(<AdminBottomNav />);
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('Protocollo')).toBeNull();
  });

  it('Esc chiude lo sheet', () => {
    render(<AdminBottomNav />);
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lo sheet NON contiene gli href dei 4 tab (nessuna voce doppia)', () => {
    stub.ruolo = 'segreteria';
    render(<AdminBottomNav />);
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const dialog = screen.getByRole('dialog');
    const hrefs = within(dialog)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '');
    for (const tab of TAB_HREFS) {
      const ripetuto = hrefs.some((h) => h === tab || h.startsWith(`${tab}?`));
      expect(ripetuto, `lo sheet ripete il tab ${tab}`).toBe(false);
    }
    // ma Report Cucina (/admin/mensa/cucina), che NON è un tab, resta nello sheet
    expect(hrefs.some((h) => h.startsWith('/admin/mensa/cucina'))).toBe(true);
  });

  // ── Stato attivo (C3) + contrasti token (C5) ──────────────────────────────
  it('la label di un tab inattivo usa il token text-kidville-sub (non muted)', () => {
    stub.pathname = '/admin';
    render(<AdminBottomNav />);
    // Su /admin, "Avvisi" è inattivo → label secondaria a contrasto AA.
    const avvisiLabel = screen.getByText('Avvisi');
    expect(avvisiLabel.className).toContain('text-kidville-sub');
    expect(avvisiLabel.className).not.toContain('text-kidville-muted');
  });

  it('su /admin/students accende il pill «Menu» e nessun tab resta aria-current', () => {
    stub.pathname = '/admin/students';
    const { container } = render(<AdminBottomNav />);
    const menuBtn = screen.getByRole('button', { name: /menu/i });
    // Il primo <span> del bottone è il pill dell'icona.
    expect(menuBtn.querySelector('span')?.className).toContain('bg-kidville-green');
    // Anagrafica vive nello sheet: nessun TAB (link) è la voce corrente.
    expect(container.querySelectorAll('a[aria-current="page"]').length).toBe(0);
  });

  it('su /admin/mensa/cucina Mensa è aria-current e il Menu resta spento', () => {
    stub.pathname = '/admin/mensa/cucina';
    render(<AdminBottomNav />);
    expect(screen.getByText('Mensa').closest('a')).toHaveAttribute('aria-current', 'page');
    const menuBtn = screen.getByRole('button', { name: /menu/i });
    expect(menuBtn.querySelector('span')?.className).not.toContain('bg-kidville-green');
    expect(menuBtn).not.toHaveAttribute('aria-current');
  });

  it('con lo sheet aperto (partendo da /admin) solo il Menu è acceso', () => {
    stub.pathname = '/admin';
    const { container } = render(<AdminBottomNav />);
    const menuBtn = screen.getByRole('button', { name: /menu/i });
    fireEvent.click(menuBtn);
    // Menu acceso…
    expect(menuBtn.querySelector('span')?.className).toContain('bg-kidville-green');
    // …e i tab cedono l'attivo (mutua esclusività: nessun tab acceso).
    expect(container.querySelectorAll('a[aria-current="page"]').length).toBe(0);
    const homePill = screen.getByText('Home').closest('a')?.querySelector('span');
    expect(homePill?.className).not.toContain('bg-kidville-green');
  });
});
