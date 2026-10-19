import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QUERY_SIDEBAR, QUERY_TABLET } from '@/lib/ui/use-formato-guscio';

/**
 * iPad (2026-10-19) — il testo d'esempio della ricerca della segreteria.
 *
 * Da 1024 px (sidebar) la ricerca ha spazio per «Cerca alunno, genitore, codice fiscale…»
 * intero. Sotto, sull'iPad in verticale col binario, il campo è largo ~310 px e accanto c'è il
 * nome della sede: il testo intero finiva coi puntini (284 px di caratteri in 256 utili, con la
 * sede degli E2E; peggio con «KIDVILLE GIUGLIANO»). Lì si usa quello corto, «…CF…».
 *
 * Le soglie sono quelle del guscio (`useFormatoGuscio`): qui si finge `matchMedia` per ciascun
 * formato. Il nome accessibile del campo non cambia mai: è `aria-label`, non il testo d'esempio.
 */

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: 'segreteria', withUser: (h: string) => `${h}?userId=u1` }),
}));
vi.mock('@/components/ui/cockpit', () => ({ SedeSelector: () => null }));
vi.mock('@/components/ui/UserMenu', () => ({ UserMenu: () => null }));
vi.mock('@/components/features/admin/AdminSearchPanel', () => ({ AdminSearchPanel: () => null }));
vi.mock('@/components/features/admin/AdminNotificationsPanel', () => ({ AdminNotificationsPanel: () => null }));

import { AdminTopBar } from '@/components/features/admin/AdminTopBar';

const INTERO = 'Cerca alunno, genitore, codice fiscale…';
const CORTO = 'Cerca alunno, genitore, CF…';

/** Finge una finestra larga quanto basta perché combacino solo le query date. */
function finestra(combaciano: string[]) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((media: string) => ({
      matches: combaciano.includes(media),
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminTopBar — testo d’esempio della ricerca per formato', () => {
  it('da 1024 px (sidebar, iPad in orizzontale) è quello intero', () => {
    finestra([QUERY_TABLET, QUERY_SIDEBAR]);
    render(<AdminTopBar />);
    expect(screen.getByRole('textbox', { name: 'Ricerca globale' })).toHaveAttribute('placeholder', INTERO);
  });

  it('fra 744 e 1023 px (binario, iPad in verticale) è quello corto', () => {
    finestra([QUERY_TABLET]);
    render(<AdminTopBar />);
    expect(screen.getByRole('textbox', { name: 'Ricerca globale' })).toHaveAttribute('placeholder', CORTO);
  });

  it('il corto è davvero più corto, e dice ancora che si cerca anche per codice fiscale', () => {
    expect(CORTO.length).toBeLessThan(INTERO.length - 10);
    expect(CORTO).toMatch(/\bCF\b/);
    expect(CORTO.endsWith('…')).toBe(true);
  });
});
