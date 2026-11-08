import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';
import type { RigaCalendario } from '@/lib/anno-scolastico';
import type { StatoAnno } from '@/lib/anno/tipi';
import { QUERY_SIDEBAR, QUERY_TABLET } from '@/lib/ui/use-formato-guscio';

/**
 * PR 4.2.6 — DOVE STA il selettore dell'anno sullo schermo.
 *
 *  · da 1024 px (sidebar) nella topbar, subito dopo la sede;
 *  · sul binario del tablet (744-1023) e sul telefono NON nella barra: sta nel foglio «Menu»
 *    (bottom-sheet o pannello), sotto il blocco sede, una riga da 44 px per anno;
 *  · la barra mobile non cambia (stessa struttura di figli).
 *
 * Gli anni arrivano dal VERO `AnnoProvider`; calendario, sedi e identità sono finti.
 */

const h = vi.hoisted(() => ({
  ruolo: 'segreteria',
  perSede: {} as Record<string, readonly unknown[]>,
  sedi: [] as { id: string; nome: string }[],
  effettive: [] as string[],
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }));
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: h.ruolo, withUser: (href: string) => href }),
  useRuoloCockpit: () => h.ruolo,
}));
vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: h.perSede, loading: false, errore: false, ricarica: vi.fn() }),
}));
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: h.sedi,
    selezionate: [],
    effettive: h.effettive,
    sedeCorrente: h.effettive.length === 1 ? h.effettive[0] : null,
    reFetchKey: h.effettive.join(','),
    epocaSede: 0,
    loading: false,
    errore: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}));
vi.mock('@/components/ui/LogoutMenuButton', () => ({ LogoutMenuButton: () => <button>Esci</button> }));
vi.mock('@/components/ui/CambiaProfiloMenuButton', () => ({ CambiaProfiloMenuButton: () => <button>Passa a Genitore</button> }));
vi.mock('@/components/ui/UserMenu', () => ({ UserMenu: () => null }));
vi.mock('@/components/features/admin/AdminSearchPanel', () => ({ AdminSearchPanel: () => null }));
vi.mock('@/components/features/admin/AdminNotificationsPanel', () => ({
  AdminNotificationsPanel: () => <div data-testid="notif" />,
}));
// La sede vera scarica il contatore degli alunni: qui basta un segnaposto che dica DOVE sta.
vi.mock('@/components/ui/cockpit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/cockpit')>()),
  SedeSelector: () => <div data-testid="sede-selector" />,
}));

import { AnnoProvider } from '@/lib/context/anno-context';
import { AdminTopBar } from '@/components/features/admin/AdminTopBar';
import { AdminTopBarMobile } from '@/components/features/admin/AdminTopBarMobile';
import { AdminMenuSheet } from '@/components/features/admin/AdminMenuSheet';

const A25 = '22222222-2222-4222-8222-222222222025';
const A26 = '22222222-2222-4222-8222-222222222026';
const A27 = '22222222-2222-4222-8222-222222222027';

function riga(sede: string, anno: number, stato: StatoAnno, annoId: string): RigaCalendario {
  return {
    annoId,
    annoSedeId: `5ed00000-0000-4000-8000-${sede.slice(-6)}${String(anno).padStart(6, '0')}`,
    annoInizio: anno,
    inizio: `${anno}-09-01`,
    fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`,
    preparaSuccessivoDal: `${anno}-03-01`,
    stato,
    domandeAperte: false,
  };
}
const treAnni = (sede: string) => [
  riga(sede, 2025, 'in_chiusura', A25),
  riga(sede, 2026, 'corrente', A26),
  riga(sede, 2027, 'in_preparazione', A27),
];

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

function azzeraCookie() {
  document.cookie = 'anno_attivo=; path=/; max-age=0';
}

beforeEach(() => {
  azzeraCookie();
  h.ruolo = 'segreteria';
  h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }];
  h.effettive = [SEDE_A];
  h.perSede = { [SEDE_A]: treAnni(SEDE_A) };
});
afterEach(() => {
  vi.unstubAllGlobals();
  azzeraCookie();
});

const TRIGGER_ANNO = { name: /Cambia anno scolastico/ };

describe('AdminTopBar — l\'anno sta nella barra solo da 1024 px', () => {
  it('da 1024 px il selettore c\'è, subito dopo la sede, nello stesso gruppo', () => {
    finestra([QUERY_TABLET, QUERY_SIDEBAR]);
    render(<AnnoProvider><AdminTopBar /></AnnoProvider>);
    const sede = screen.getByTestId('sede-selector');
    const anno = screen.getByRole('button', TRIGGER_ANNO);
    expect(sede.parentElement).toBe(anno.closest('div.relative')!.parentElement);
    expect(sede.nextElementSibling).toBe(anno.closest('div.relative'));
  });

  it('fra 744 e 1023 px (binario) la barra NON ha il selettore', () => {
    finestra([QUERY_TABLET]);
    render(<AnnoProvider><AdminTopBar /></AnnoProvider>);
    expect(screen.queryByRole('button', TRIGGER_ANNO)).toBeNull();
  });

  it('sul telefono la barra desktop non ha il selettore', () => {
    finestra([]);
    render(<AnnoProvider><AdminTopBar /></AnnoProvider>);
    expect(screen.queryByRole('button', TRIGGER_ANNO)).toBeNull();
  });

  it('senza anni (database della CI) o senza provider non compare niente di nuovo', () => {
    finestra([QUERY_TABLET, QUERY_SIDEBAR]);
    h.perSede = {};
    const { container, unmount } = render(<AnnoProvider><AdminTopBar /></AnnoProvider>);
    expect(screen.queryByRole('button', TRIGGER_ANNO)).toBeNull();
    const conProvider = container.innerHTML;
    unmount();
    const senza = render(<AdminTopBar />);
    expect(senza.container.innerHTML).toBe(conProvider);
  });
});

describe('AdminTopBarMobile — la barra mobile non cambia', () => {
  it('stessa struttura di figli con o senza il provider dell\'anno, e nessun selettore dell\'anno', () => {
    finestra([]);
    const senza = render(<AdminTopBarMobile />);
    const figliSenza = Array.from(senza.container.querySelector('header')!.children).map((e) => e.tagName);
    senza.unmount();
    const con = render(<AnnoProvider><AdminTopBarMobile /></AnnoProvider>);
    const figliCon = Array.from(con.container.querySelector('header')!.children).map((e) => e.tagName);
    expect(figliCon).toEqual(figliSenza);
    expect(screen.queryByRole('button', TRIGGER_ANNO)).toBeNull();
  });
});

function foglio(variante: 'foglio' | 'pannello' = 'foglio', ruolo = h.ruolo) {
  const ref = createRef<HTMLButtonElement>();
  return render(
    <AnnoProvider>
      <button ref={ref}>Menu</button>
      <AdminMenuSheet open onClose={vi.fn()} withUser={(x) => x} ruolo={ruolo} returnFocusRef={ref} variante={variante} />
    </AnnoProvider>,
  );
}
const gruppoAnno = () => screen.getByText('Anno scolastico', { selector: 'p' }).parentElement as HTMLElement;

describe('AdminMenuSheet — la scelta dell\'anno', () => {
  it('chi ha più di un anno la vede: una riga da 44 px per anno, con lo stato in parole', () => {
    foglio();
    const righe = within(gruppoAnno()).getAllByRole('button');
    expect(righe).toHaveLength(3);
    righe.forEach((r) => expect(r.className).toContain('min-h-[44px]'));
    expect(righe[0]).toHaveTextContent('27/28');
    expect(righe[0]).toHaveTextContent('in preparazione');
    expect(righe[1]).toHaveTextContent('in corso');
    // l'anno attivo è quello premuto
    expect(righe.map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('sta SUBITO SOTTO il blocco sede e sopra Anagrafica', () => {
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }];
    h.effettive = [SEDE_A];
    h.perSede = { [SEDE_A]: treAnni(SEDE_A), [SEDE_B]: treAnni(SEDE_B) };
    foglio();
    const sede = screen.getByText('Sede di lavoro', { selector: 'p' }).parentElement as HTMLElement;
    const anno = gruppoAnno();
    expect(sede.nextElementSibling).toBe(anno);
    expect(anno.nextElementSibling?.tagName).toBe('A'); // Anagrafica
  });

  it('il pannello del binario (variante tablet) la mostra', () => {
    const { container } = foglio('pannello');
    expect(container.querySelector('[data-kv-menu-admin="pannello"]')).not.toBeNull();
    expect(within(gruppoAnno()).getAllByRole('button')).toHaveLength(3);
  });

  it('scegliere un anno non attivo scrive il cookie e NON chiude il foglio; la riga attiva torna al predefinito', () => {
    const chiudi = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <AnnoProvider>
        <AdminMenuSheet open onClose={chiudi} withUser={(x) => x} ruolo="segreteria" returnFocusRef={ref} />
      </AnnoProvider>,
    );
    const righe = () => within(gruppoAnno()).getAllByRole('button');
    fireEvent.click(righe()[0]);
    expect(document.cookie).toContain(`anno_attivo=${A27}`);
    expect(chiudi).not.toHaveBeenCalled();
    expect(righe().map((r) => r.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(righe()[1]);
    expect(document.cookie).not.toContain('anno_attivo=2');
    expect(righe().map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('le righe sono raccolte dal focus-trap del foglio (FOCUSABLE)', () => {
    foglio();
    const dialogo = screen.getByRole('dialog');
    const focalizzabili = Array.from(
      dialogo.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
    within(gruppoAnno()).getAllByRole('button').forEach((r) => expect(focalizzabili).toContain(r));
  });

  it('con un solo anno, per un ruolo che non sceglie o senza provider non compare', () => {
    h.perSede = { [SEDE_A]: [riga(SEDE_A, 2026, 'corrente', A26)] };
    const uno = foglio();
    expect(screen.queryByText('Anno scolastico', { selector: 'p' })).toBeNull();
    uno.unmount();
    h.perSede = { [SEDE_A]: treAnni(SEDE_A) };
    const docente = foglio('foglio', 'teacher');
    expect(screen.queryByText('Anno scolastico', { selector: 'p' })).toBeNull();
    docente.unmount();
    const ref = createRef<HTMLButtonElement>();
    render(<AdminMenuSheet open onClose={vi.fn()} withUser={(x) => x} ruolo="segreteria" returnFocusRef={ref} />);
    expect(screen.queryByText('Anno scolastico', { selector: 'p' })).toBeNull();
  });
});
