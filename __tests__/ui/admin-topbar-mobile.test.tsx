import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';

/**
 * Step 3 — AdminTopBarMobile (barra verde del brand, <lg).
 *
 * Su mobile la topbar admin passa dalla barra BIANCA (badge K + hamburger →
 * drawer) alla barra VERDE del brand, allineata all'AppBar genitore/docente:
 * wordmark `logo-light.png` (link alla home admin con ?userId=) + campanella
 * notifiche. NIENTE hamburger, NIENTE badge K: la navigazione mobile è la
 * bottom-nav (Step 2/4).
 *
 * Dal 2026-07-31 la barra porta anche il SELETTORE DI SEDE compatto (W3-D /
 * R73): con tre plessi in produzione «in quale sede sto guardando» era
 * un'informazione che sotto i 1024px non compariva da nessuna parte, e il
 * selettore viveva solo nella topbar desktop `hidden … lg:flex`.
 *
 * `useAdminIdentity` e `useSediAttive` sono stubbati e `AdminNotificationsPanel`
 * è mockato a un marker inerte così il test non tocca fetch né il context reale.
 */

const stub = vi.hoisted(() => ({
  sedi: [] as { id: string; nome: string }[],
  effettive: [] as string[],
  soloSede: vi.fn(),
  toggle: vi.fn(),
  tutte: vi.fn(),
}));

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({
    userId: 'u1',
    ruolo: 'admin',
    withUser: (href: string) => `${href}?userId=u1`,
  }),
}));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: stub.sedi,
    selezionate: [],
    effettive: stub.effettive,
    sedeCorrente: stub.effettive.length === 1 ? stub.effettive[0] : null,
    reFetchKey: stub.effettive.join(','),
    epocaSede: 0,
    loading: false,
    toggle: stub.toggle,
    soloSede: stub.soloSede,
    tutte: stub.tutte,
  }),
}));

vi.mock('@/components/features/admin/AdminNotificationsPanel', () => ({
  AdminNotificationsPanel: ({ userId }: { userId: string | null }) => (
    <div data-testid="notif-panel">{userId ?? 'nessun-utente'}</div>
  ),
}));

import { AdminTopBarMobile } from '@/components/features/admin/AdminTopBarMobile';

beforeEach(() => {
  vi.clearAllMocks();
  // Caso base: UNA sola sede accessibile — nessuna scelta da fare.
  stub.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }];
  stub.effettive = [SEDE_A];
});

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

describe('AdminTopBarMobile — il selettore di sede compatto (W3-D / R73)', () => {
  it('con una sola sede accessibile non si monta: non c\'è niente da scegliere', () => {
    render(<AdminTopBarMobile />);
    expect(screen.queryByText(NOME_SEDE_A)).toBeNull();
    expect(screen.queryByText(/tutte le sedi/i)).toBeNull();
  });

  it('con due sedi mostra lo scope attivo e apre la scelta', () => {
    stub.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ];
    stub.effettive = [SEDE_A, SEDE_B];
    render(<AdminTopBarMobile />);

    const trigger = screen.getByText(/tutte le sedi/i).closest('button') as HTMLButtonElement;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText(NOME_SEDE_B));
    expect(stub.toggle).toHaveBeenCalledWith(SEDE_B);
  });

  it('con una sola sede ATTIVA su due accessibili la barra scrive quale', () => {
    stub.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ];
    stub.effettive = [SEDE_B];
    render(<AdminTopBarMobile />);
    expect(screen.getByText(NOME_SEDE_B)).toBeInTheDocument();
  });

  // La variante compatta NON scarica il contatore alunni: montata su OGNI
  // pagina del cockpit mobile, sarebbe una chiamata a /api/admin/dashboard in
  // più a ogni apertura, per un dato che sulla barra non c'è nemmeno spazio di
  // mostrare.
  it('non chiama /api/admin/dashboard', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    stub.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ];
    stub.effettive = [SEDE_A, SEDE_B];
    render(<AdminTopBarMobile />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
