import { describe, it, expect } from 'vitest';
import {
  NAV_GROUPS,
  ALL_HREFS,
  activeHref,
  visibleItem,
  gruppoDellaPagina,
  gruppiVisibili,
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

// Il menu a 7 voci (decisione del titolare, 2026-10-31): da 27 voci in 7 gruppi, 33 righe, a due
// link diretti e cinque gruppi che si aprono a fisarmonica. Le voci raggruppate per lavoro e non per
// tipo di pagina. Questo lock fissa contenuto e ordine: una voce nuova si aggiunge QUI, nel gruppo
// del suo lavoro, e non in fondo dove c'è posto (così era nato il gruppo «Amministrazione» da 10).
describe('Menu a 7 voci — struttura decisa il 31/10', () => {
  const ATTESO: [string | null, string[]][] = [
    [null, ['/admin']],
    [null, ['/admin/students']],
    ['navgruppo_registro', ['/admin/appello', '/admin/diary', '/admin/primaria', '/admin/competenze', '/admin/gallery']],
    ['navgruppo_comunicazione', ['/admin/messaggi', '/admin/avvisi', '/admin/news', '/admin/compiti', '/admin/moderazione']],
    ['navgruppo_contabilita_servizi', ['/admin/pagamenti', '/admin/coda-fatture', '/admin/mensa', '/admin/mensa/cucina', '/admin/armadietto', '/admin/merchandise']],
    ['navgruppo_segreteria', ['/admin/crm', '/admin/candidature', '/admin/modulistica', '/admin/documenti-firmati', '/admin/protocolli', '/admin/storici']],
    ['navgruppo_impostazioni', ['/admin/impostazioni', '/admin/tools', '/admin/gdpr']],
  ];

  it("7 voci di primo livello, nell'ordine e col contenuto decisi il 31/10", () => {
    expect(NAV_GROUPS.map((g) => [g.titleKey ?? null, g.items.map((i) => i.href)])).toEqual(ATTESO);
  });

  it('nessuna voce persa: le stesse 27 rotte di prima, nessuna doppia', () => {
    expect(ALL_HREFS).toHaveLength(27);
    expect(new Set(ALL_HREFS).size).toBe(27);
  });

  it.each(['it', 'en'])('link diretti con una voce sola; ogni gruppo con titolo ha icona e titolo nel catalogo %s', async (lingua) => {
    const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
    for (const g of NAV_GROUPS) {
      if (g.title === null) {
        expect(g.items).toHaveLength(1);
        expect(g.icon).toBeUndefined();
        continue;
      }
      expect(g.icon).toBeDefined();
      expect(typeof catalogo[g.titleKey!]).toBe('string');
    }
  });

  it.each([
    ['/admin', null],
    ['/admin/students', null],
    ['/admin/mensa/cucina', 'navgruppo_contabilita_servizi'],
    ['/admin/protocolli', 'navgruppo_segreteria'],
    ['/admin/qualcosa-che-non-esiste', null],
  ])('gruppoDellaPagina(%s) = %s', (href, atteso) => {
    expect(gruppoDellaPagina(href)).toBe(atteso);
  });

  // Il foglio del telefono esclude le voci già nei tab in basso: su una pagina-tab non apre nulla.
  it('gruppoDellaPagina ignora gli href esclusi', () => {
    expect(gruppoDellaPagina('/admin/mensa', new Set(['/admin/mensa']))).toBeNull();
  });

  it('gruppiVisibili toglie un gruppo rimasto vuoto', () => {
    const gruppi = gruppiVisibili('segreteria', new Set(['/admin/impostazioni', '/admin/tools', '/admin/gdpr']));
    expect(gruppi.map((g) => g.titleKey)).not.toContain('navgruppo_impostazioni');
  });

  it('gruppiVisibili nasconde alla cuoca CRM, Candidature, Protocollo e Storici', () => {
    const segreteria = gruppiVisibili('cuoca').find((g) => g.titleKey === 'navgruppo_segreteria')!;
    expect(segreteria.items.map((i) => i.href)).toEqual(['/admin/modulistica', '/admin/documenti-firmati']);
  });
});

// Le candidature («Lavora con noi») escono da Modulistica e diventano una voce
// propria del menu (decisione del titolare, 2026-10-17): sono centinaia di
// curriculum da scorrere ogni settimana, e una linguetta al quarto posto di una
// pagina che parla d'altro non è un posto dove si torna. Dal 31/10 il gruppo è «Segreteria».
describe('Candidature — voce propria nel gruppo Segreteria', () => {
  const segreteria = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_segreteria');
  const voci = segreteria?.items ?? [];
  const candidature = voci.find((i) => i.href === '/admin/candidature') as NavItem;

  it('esiste, nel gruppo Segreteria, subito sopra Modulistica', () => {
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

// Il CRM della segreteria (`/admin/crm`, 2026-10-30): una voce propria, vicino a Candidature, nel
// gruppo Segreteria dal 31/10. Lo vedono i due ruoli che le route `/api/admin/crm/*` ammettono
// (`RUOLI_CRM`): una voce che risponde 403 a chi la clicca è un menu che mente.
describe('CRM — voce propria nel gruppo Segreteria', () => {
  const segreteria = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_segreteria');
  const voci = segreteria?.items ?? [];
  const crm = voci.find((i) => i.href === '/admin/crm') as NavItem;

  it('esiste, nel gruppo Segreteria, subito sopra Candidature', () => {
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
