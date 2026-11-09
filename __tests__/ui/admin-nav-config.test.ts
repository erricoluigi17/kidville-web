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
    ['navgruppo_comunicazione', ['/admin/messaggi', '/admin/avvisi', '/admin/news', '/admin/compiti', '/admin/votazioni', '/admin/moderazione']],
    ['navgruppo_contabilita_servizi', ['/admin/pagamenti', '/admin/coda-fatture', '/admin/mensa', '/admin/mensa/cucina', '/admin/armadietto', '/admin/merchandise']],
    ['navgruppo_segreteria', ['/admin/crm', '/admin/candidature', '/admin/modulistica', '/admin/documenti-firmati', '/admin/protocolli', '/admin/storici', '/admin/students/conferme', '/admin/students/anno-prossimo']],
    ['navgruppo_impostazioni', ['/admin/impostazioni', '/admin/tools', '/admin/gdpr']],
  ];

  it("7 voci di primo livello, nell'ordine e col contenuto decisi il 31/10", () => {
    expect(NAV_GROUPS.map((g) => [g.titleKey ?? null, g.items.map((i) => i.href)])).toEqual(ATTESO);
  });

  // 27 rotte il 31/10, più `/admin/votazioni` (Comunicazione, 2026-11-02) e `/admin/students/conferme` (Segreteria, 4.5.6) = 29, più `/admin/students/anno-prossimo` (Segreteria, 4.7.3) = 30.
  it('nessuna voce persa: le 27 rotte di prima più Votazioni, Conferme e Anno prossimo, nessuna doppia', () => {
    expect(ALL_HREFS).toHaveLength(30);
    expect(new Set(ALL_HREFS).size).toBe(30);
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

// Le conferme per l'anno prossimo (`/admin/students/conferme`, 4.5.6): una voce nel gruppo Segreteria, perché la pagina non
// si raggiungeva da nessun menu. La vedono i tre ruoli che le route `/api/admin/anni/[annoSedeId]/conferme` ammettono.
describe('Conferme anno prossimo — voce nel gruppo Segreteria', () => {
  const segreteria = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_segreteria');
  const conferme = (segreteria?.items ?? []).find((i) => i.href === '/admin/students/conferme') as NavItem;

  it('esiste, nel gruppo Segreteria, col percorso della pagina', () => {
    expect(conferme).toBeDefined();
    expect(ALL_HREFS).toContain('/admin/students/conferme');
  });

  it('la vedono admin, coordinatrice e segreteria — non la cuoca', () => {
    expect(conferme.roles).toEqual(['admin', 'coordinator', 'segreteria']);
    expect(visibleItem(conferme, 'admin')).toBe(true);
    expect(visibleItem(conferme, 'coordinator')).toBe(true);
    expect(visibleItem(conferme, 'segreteria')).toBe(true);
    expect(visibleItem(conferme, 'cuoca')).toBe(false);
  });

  it.each(['it', 'en'])("l'etichetta nav_conferme_anno esiste nel catalogo %s", async (lingua) => {
    const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
    expect(conferme.labelKey).toBe('nav_conferme_anno');
    expect(typeof catalogo.nav_conferme_anno).toBe('string');
  });

  it("su /admin/students/conferme si accende la voce Conferme, non l'Anagrafica, e si apre il gruppo Segreteria", () => {
    expect(activeHref('/admin/students/conferme')).toBe('/admin/students/conferme');
    expect(gruppoDellaPagina('/admin/students/conferme')).toBe('navgruppo_segreteria');
    expect(activeHref('/admin/students/abc')).toBe('/admin/students');
  });
});

// Il cruscotto dell'anno prossimo (`/admin/students/anno-prossimo`, 4.7.3): una voce nel gruppo Segreteria, per gli stessi tre ruoli.
describe('Anno prossimo (cruscotto) — voce nel gruppo Segreteria', () => {
  const segreteria = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_segreteria');
  const cruscotto = (segreteria?.items ?? []).find((i) => i.href === '/admin/students/anno-prossimo') as NavItem;

  it('esiste nel gruppo Segreteria; la vedono admin, coordinatrice e segreteria, non la cuoca', () => {
    expect(cruscotto).toBeDefined();
    expect(visibleItem(cruscotto, 'admin')).toBe(true);
    expect(visibleItem(cruscotto, 'coordinator')).toBe(true);
    expect(visibleItem(cruscotto, 'segreteria')).toBe(true);
    expect(visibleItem(cruscotto, 'cuoca')).toBe(false);
  });

  it.each(['it', 'en'])("l'etichetta nav_cruscotto_anno esiste nel catalogo %s", async (lingua) => {
    const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
    expect(cruscotto.labelKey).toBe('nav_cruscotto_anno');
    expect(typeof catalogo.nav_cruscotto_anno).toBe('string');
  });

  it('su /admin/students/anno-prossimo si accende la voce del cruscotto e si apre il gruppo Segreteria', () => {
    expect(activeHref('/admin/students/anno-prossimo')).toBe('/admin/students/anno-prossimo');
    expect(gruppoDellaPagina('/admin/students/anno-prossimo')).toBe('navgruppo_segreteria');
  });
});

// Le Votazioni dei rappresentanti (`/admin/votazioni`, 2026-11-02): una voce nel gruppo Comunicazione,
// fra Compiti e Moderazione. La vedono i tre ruoli che le route `/api/admin/votazioni/*` ammettono
// (`RUOLI_VOTAZIONI`): una voce che risponde 403 a chi la clicca è un menu che mente.
describe('Votazioni — voce nel gruppo Comunicazione', () => {
  const comunicazione = NAV_GROUPS.find((g) => g.titleKey === 'navgruppo_comunicazione');
  const voci = comunicazione?.items ?? [];
  const votazioni = voci.find((i) => i.href === '/admin/votazioni') as NavItem;

  it('esiste, nel gruppo Comunicazione, subito dopo Compiti', () => {
    expect(votazioni).toBeDefined();
    expect(voci.findIndex((i) => i.href === '/admin/votazioni')).toBe(voci.findIndex((i) => i.href === '/admin/compiti') + 1);
    expect(ALL_HREFS).toContain('/admin/votazioni');
  });

  // L'elenco dei ruoli sta scritto nella config (importare `accesso.ts` porterebbe `next/server` e il
  // gate del server nel bundle del browser): questo è il punto in cui le due copie si confrontano.
  it('i ruoli sono esattamente RUOLI_VOTAZIONI: admin, coordinatrice e segreteria — non la cuoca', async () => {
    const { RUOLI_VOTAZIONI } = await import('@/lib/votazioni/accesso');
    expect(votazioni.roles).toEqual([...RUOLI_VOTAZIONI]);
    expect(visibleItem(votazioni, 'admin')).toBe(true);
    expect(visibleItem(votazioni, 'coordinator')).toBe(true);
    expect(visibleItem(votazioni, 'segreteria')).toBe(true);
    expect(visibleItem(votazioni, 'cuoca')).toBe(false);
  });

  it.each(['it', 'en'])("l'etichetta nav_votazioni esiste nel catalogo %s", async (lingua) => {
    const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
    expect(votazioni.labelKey).toBe('nav_votazioni');
    expect(typeof catalogo.nav_votazioni).toBe('string');
  });

  it('su /admin/votazioni evidenzia le Votazioni, e il gruppo che si apre è Comunicazione', () => {
    expect(activeHref('/admin/votazioni')).toBe('/admin/votazioni');
    expect(gruppoDellaPagina('/admin/votazioni')).toBe('navgruppo_comunicazione');
  });

  it('la cuoca non le trova nemmeno nel gruppo visibile', () => {
    const gruppo = gruppiVisibili('cuoca').find((g) => g.titleKey === 'navgruppo_comunicazione');
    expect(gruppo?.items.map((i) => i.href) ?? []).not.toContain('/admin/votazioni');
  });
});
