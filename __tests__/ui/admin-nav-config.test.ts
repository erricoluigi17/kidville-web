import { describe, it, expect } from 'vitest';
import {
  NAV_GROUPS,
  ALL_HREFS,
  activeHref,
  visibleItem,
  type NavItem,
} from '@/components/features/admin/admin-nav-config';

/**
 * Lock della config nav condivisa del cockpit Direzione/Segreteria (Step 1).
 *
 * La config è la SORGENTE UNICA per sidebar desktop (AdminSidebar), bottom-nav
 * mobile (AdminBottomNav) e bottom-sheet «Menu» (AdminMenuSheet): tutti e tre
 * leggono le stesse `NAV_GROUPS`, lo stesso `activeHref()` (match più lungo) e
 * lo stesso `visibleItem()` (gating per ruolo). Estratta da AdminSidebar.tsx
 * mantenendo semantica identica al vecchio `visible`.
 */

const flat = NAV_GROUPS.flatMap((g) => g.items);
const protocolli = flat.find((i) => i.href === '/admin/protocolli') as NavItem;

describe('activeHref — match più specifico (più lungo)', () => {
  it('su /admin/mensa/cucina evidenzia /admin/mensa/cucina, non /admin/mensa', () => {
    expect(activeHref('/admin/mensa/cucina')).toBe('/admin/mensa/cucina');
  });

  it("/admin è match esatto: una sottorotta NON accende la Dashboard", () => {
    expect(activeHref('/admin')).toBe('/admin');
    expect(activeHref('/admin/students')).toBe('/admin/students');
  });
});

describe('visibleItem — gating per ruolo (semantica del vecchio `visible`)', () => {
  it('Protocollo (roles: admin, segreteria) è nascosto alla cuoca', () => {
    expect(protocolli).toBeDefined();
    expect(visibleItem(protocolli, 'cuoca')).toBe(false);
  });

  it('Protocollo è visibile alla segreteria', () => {
    expect(visibleItem(protocolli, 'segreteria')).toBe(true);
  });

  it('una voce senza roles è visibile a qualunque ruolo (anche null)', () => {
    const dashboard = flat.find((i) => i.href === '/admin') as NavItem;
    expect(visibleItem(dashboard, 'cuoca')).toBe(true);
    expect(visibleItem(dashboard, null)).toBe(true);
  });
});

describe('NAV_GROUPS — copre le rotte cardine della nav', () => {
  it.each(['/admin', '/admin/avvisi', '/admin/pagamenti', '/admin/mensa', '/admin/students'])(
    'contiene la voce %s',
    (href) => {
      expect(ALL_HREFS).toContain(href);
    },
  );
});
