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

// Le candidature («Lavora con noi») escono da Modulistica e diventano una voce
// propria del menu (decisione del titolare, 2026-10-17): sono centinaia di
// curriculum da scorrere ogni settimana, e una linguetta al quarto posto di una
// pagina che parla d'altro non è un posto dove si torna.
describe('Candidature — voce propria nel gruppo Amministrazione', () => {
  const amministrazione = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_amministrazione');
  const voci = amministrazione?.items ?? [];
  const candidature = voci.find((i) => i.href === '/admin/candidature') as NavItem;

  it('esiste, nel gruppo Amministrazione, subito sopra Modulistica', () => {
    expect(candidature).toBeDefined();
    const posCand = voci.findIndex((i) => i.href === '/admin/candidature');
    const posModulistica = voci.findIndex((i) => i.href === '/admin/modulistica');
    expect(posCand).toBe(posModulistica - 1);
  });

  // Gli stessi tre ruoli che `requireStaff` ammette sulla GET dell'elenco: la
  // `cuoca` entra nell'area admin per il report cucina, e una voce che promette i
  // curriculum per poi risponderle 403 sarebbe un menu che mente.
  it('la vedono admin, coordinatrice e segreteria — non la cuoca', () => {
    expect(visibleItem(candidature, 'admin')).toBe(true);
    expect(visibleItem(candidature, 'coordinator')).toBe(true);
    expect(visibleItem(candidature, 'segreteria')).toBe(true);
    expect(visibleItem(candidature, 'cuoca')).toBe(false);
  });

  it.each(['it', 'en'])("l'etichetta nav_candidature esiste nel catalogo %s", async (lingua) => {
    const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
    expect(candidature.labelKey).toBe('nav_candidature');
    expect(typeof catalogo.nav_candidature).toBe('string');
  });
});

// Il CRM della segreteria (`/admin/crm`, 2026-10-30): una voce propria nel gruppo Amministrazione,
// vicino a Candidature. Lo vedono i due ruoli che le route `/api/admin/crm/*` ammettono
// (`RUOLI_CRM`): una voce che risponde 403 a chi la clicca è un menu che mente.
describe('CRM — voce propria nel gruppo Amministrazione', () => {
  const amministrazione = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_amministrazione');
  const voci = amministrazione?.items ?? [];
  const crm = voci.find((i) => i.href === '/admin/crm') as NavItem;

  it('esiste, nel gruppo Amministrazione, subito sopra Candidature', () => {
    expect(crm).toBeDefined();
    expect(voci.findIndex((i) => i.href === '/admin/crm')).toBe(voci.findIndex((i) => i.href === '/admin/candidature') - 1);
    expect(ALL_HREFS).toContain('/admin/crm');
  });

  it('la vedono segreteria e admin — non la coordinatrice, non la cuoca', async () => {
    const { RUOLI_CRM } = await import('@/lib/crm/accesso');
    expect(crm.roles).toEqual([...RUOLI_CRM]);
    expect(visibleItem(crm, 'segreteria')).toBe(true);
    expect(visibleItem(crm, 'admin')).toBe(true);
    expect(visibleItem(crm, 'coordinator')).toBe(false);
    expect(visibleItem(crm, 'cuoca')).toBe(false);
  });

  it.each(['it', 'en'])("l'etichetta nav_crm esiste nel catalogo %s", async (lingua) => {
    const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
    expect(crm.labelKey).toBe('nav_crm');
    expect(typeof catalogo.nav_crm).toBe('string');
  });

  it("su /admin/crm evidenzia il CRM", () => {
    expect(activeHref('/admin/crm')).toBe('/admin/crm');
  });
});
