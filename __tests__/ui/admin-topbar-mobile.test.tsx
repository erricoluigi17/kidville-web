import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Step 3 — AdminTopBarMobile (barra verde del brand, <lg).
 *
 * Su mobile la topbar admin passa dalla barra BIANCA (badge K + hamburger →
 * drawer) alla barra VERDE del brand, allineata all'AppBar genitore/docente:
 * wordmark `logo-light.png` (link alla home admin con ?userId=) + campanella
 * notifiche. NIENTE hamburger, NIENTE badge K: la navigazione mobile è la
 * bottom-nav (Step 2/4).
 *
 * `useAdminIdentity` è stubbato (userId risolto) e `AdminNotificationsPanel`
 * è mockato a un marker inerte così il test non tocca fetch né il context reale.
 */

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({
    userId: 'u1',
    ruolo: 'admin',
    withUser: (href: string) => `${href}?userId=u1`,
  }),
}));

vi.mock('@/components/features/admin/AdminNotificationsPanel', () => ({
  AdminNotificationsPanel: ({ userId }: { userId: string | null }) => (
    <div data-testid="notif-panel">{userId ?? 'nessun-utente'}</div>
  ),
}));

import { AdminTopBarMobile } from '@/components/features/admin/AdminTopBarMobile';

describe('AdminTopBarMobile — barra verde del brand (Step 3)', () => {
  it('mostra il wordmark Kidville come link alla home admin con ?userId=', () => {
    render(<AdminTopBarMobile />);
    const logo = screen.getByAltText('Kidville');
    expect(logo).toBeInTheDocument();
    const link = logo.closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '/admin?userId=u1');
  });

  it('rende la campanella notifiche passando lo userId risolto', () => {
    render(<AdminTopBarMobile />);
    expect(screen.getByTestId('notif-panel')).toHaveTextContent('u1');
  });

  it('NON contiene hamburger né voce «Menu» né badge K', () => {
    render(<AdminTopBarMobile />);
    expect(screen.queryByLabelText(/menu/i)).toBeNull();
    expect(screen.queryByText('Menu')).toBeNull();
    // Il badge K quadrato della vecchia topbar bianca non deve esistere più.
    expect(screen.queryByText('K', { exact: true })).toBeNull();
  });
});
