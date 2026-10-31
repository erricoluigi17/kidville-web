import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';

/**
 * Il menu della segreteria a fisarmonica (decisione del titolare, 2026-10-31).
 *
 * Da 33 righe a 7 voci: Home e Anagrafica dirette, cinque gruppi che si aprono uno alla volta.
 * Qui si misura il COMPORTAMENTO, non la config (quella la fissa `admin-nav-config.test.ts`):
 *  - all'arrivo su una pagina è aperto il suo gruppo, e solo quello;
 *  - toccare un altro gruppo lo apre e chiude il precedente; toccare quello aperto lo chiude;
 *  - a gruppo chiuso l'intestazione dice ancora «sei qui» (`data-contiene-pagina`);
 *  - il menu segue il cambio di pagina (un link nel contenuto, il tasto Indietro);
 *  - il ruolo che arriva in due tempi (`null`, poi quello vero) non fa saltare il gruppo aperto.
 *
 * `usePathname` e `useAdminIdentity` sono stubbati via `vi.hoisted`, come in
 * `admin-binario.test.tsx`; next-intl è il mock globale, che legge i cataloghi italiani veri.
 */

const stub = vi.hoisted(() => ({
  pathname: '/admin',
  ruolo: 'segreteria' as string | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const motion = new Proxy({} as Record<string, unknown>, {
    get: (_t, tag: string) => (props: Record<string, unknown>) => {
      const { layoutId, transition, ...rest } = props;
      void layoutId;
      void transition;
      return React.createElement(tag, rest, (props as { children?: React.ReactNode }).children);
    },
  });
  return { motion };
});

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({
    userId: 'u1',
    ruolo: stub.ruolo,
    withUser: (href: string) => href,
  }),
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

vi.mock('@/components/ui/LogoutMenuButton', () => ({
  LogoutMenuButton: ({ className }: { className?: string }) => <button className={className}>Esci</button>,
}));
vi.mock('@/components/ui/CambiaProfiloMenuButton', () => ({
  CambiaProfiloMenuButton: ({ className }: { className?: string }) => (
    <button className={className}>Passa a Genitore</button>
  ),
}));

import { AdminSidebar } from '@/components/features/admin/AdminSidebar';
import { AdminMenuSheet } from '@/components/features/admin/AdminMenuSheet';

/** Le intestazioni dei gruppi: gli unici bottoni del menu con `aria-expanded`. */
function intestazioni(): HTMLElement[] {
  return screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'));
}
function intestazione(nome: RegExp): HTMLElement {
  const trovate = intestazioni().filter((b) => nome.test(b.textContent ?? ''));
  expect(trovate, `intestazione ${nome}`).toHaveLength(1);
  return trovate[0];
}
const aperte = () => intestazioni().filter((b) => b.getAttribute('aria-expanded') === 'true');

beforeEach(() => {
  vi.clearAllMocks();
  stub.pathname = '/admin';
  stub.ruolo = 'segreteria';
  // Il contatore della coda fatture legge a ogni pagina: qui basta che risponda «non disponibile».
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ disponibile: false }) })) as unknown as typeof fetch;
});

describe('sidebar — la fisarmonica', () => {
  it('ha cinque gruppi chiusi o aperti, e Home e Anagrafica come link diretti', () => {
    render(<AdminSidebar />);
    expect(intestazioni().map((b) => b.textContent?.trim())).toEqual([
      'Registro',
      'Comunicazione',
      'Contabilità e servizi',
      'Segreteria',
      'Impostazioni',
    ]);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Anagrafica' })).toBeInTheDocument();
    // Su /admin la pagina è un link diretto: nessun gruppo da aprire.
    expect(aperte()).toHaveLength(0);
  });

  it('a /admin/mensa è aperto solo «Contabilità e servizi», e Mensa è la pagina corrente', () => {
    stub.pathname = '/admin/mensa';
    render(<AdminSidebar />);
    expect(aperte()).toEqual([intestazione(/^Contabilità e servizi/)]);
    const gruppo = screen.getByRole('group', { name: /Contabilità e servizi/ });
    expect(within(gruppo).getByRole('link', { name: 'Mensa' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Protocollo' })).toBeNull();
  });

  it('toccare «Segreteria» la apre e chiude «Contabilità e servizi»', () => {
    stub.pathname = '/admin/mensa';
    render(<AdminSidebar />);
    fireEvent.click(intestazione(/^Segreteria/));
    expect(aperte()).toEqual([intestazione(/^Segreteria/)]);
    expect(screen.getByRole('link', { name: 'Protocollo' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Mensa' })).toBeNull();
  });

  it('toccare il gruppo aperto lo chiude, e l’intestazione dice ancora «sei qui»', () => {
    stub.pathname = '/admin/mensa';
    render(<AdminSidebar />);
    const contabilita = intestazione(/^Contabilità e servizi/);
    expect(contabilita).not.toHaveAttribute('data-contiene-pagina');

    fireEvent.click(contabilita);
    expect(contabilita).toHaveAttribute('aria-expanded', 'false');
    expect(contabilita).toHaveAttribute('data-contiene-pagina', 'true');
    // Gli altri gruppi chiusi non contengono la pagina: niente segno.
    expect(intestazione(/^Segreteria/)).not.toHaveAttribute('data-contiene-pagina');
  });

  it('cambio di pagina ⇒ si apre il gruppo della nuova pagina', () => {
    stub.pathname = '/admin/mensa';
    const { rerender } = render(<AdminSidebar />);
    stub.pathname = '/admin/protocolli';
    rerender(<AdminSidebar />);
    expect(aperte()).toEqual([intestazione(/^Segreteria/)]);
    expect(screen.getByRole('link', { name: 'Protocollo' })).toHaveAttribute('aria-current', 'page');
  });

  it('il ruolo che arriva in due tempi non fa saltare il gruppo aperto', () => {
    stub.pathname = '/admin/protocolli';
    stub.ruolo = null;
    const { rerender } = render(<AdminSidebar />);
    expect(aperte()).toEqual([intestazione(/^Segreteria/)]);
    expect(screen.queryByRole('link', { name: 'Protocollo' })).toBeNull();

    stub.ruolo = 'segreteria';
    rerender(<AdminSidebar />);
    expect(aperte()).toEqual([intestazione(/^Segreteria/)]);
    expect(screen.getByRole('link', { name: 'Protocollo' })).toBeInTheDocument();
  });

  it('l’intestazione è un vero bottone, che non invia moduli e governa il suo gruppo', () => {
    stub.pathname = '/admin/mensa';
    render(<AdminSidebar />);
    const contabilita = intestazione(/^Contabilità e servizi/);
    expect(contabilita.tagName).toBe('BUTTON');
    expect(contabilita).toHaveAttribute('type', 'button');
    const gruppo = screen.getByRole('group', { name: /Contabilità e servizi/ });
    expect(contabilita.getAttribute('aria-controls')).toBe(gruppo.id);
  });
});

// Lo stesso selettore del focus-trap di `AdminMenuSheet` (lì non è esportato).
const FOCUSABILI =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function foglio(onClose = vi.fn()) {
  render(
    <AdminMenuSheet open onClose={onClose} withUser={(h) => h} ruolo="segreteria" returnFocusRef={createRef<HTMLButtonElement>()} />,
  );
  return onClose;
}

describe('foglio «Menu» (telefono) e pannello (tablet) — la stessa fisarmonica', () => {
  it('a /admin/coda-fatture si apre «Contabilità e servizi», senza Contabilità e Mensa che sono già nei tab', () => {
    stub.pathname = '/admin/coda-fatture';
    foglio();
    expect(aperte()).toEqual([intestazione(/^Contabilità e servizi/)]);
    const gruppo = screen.getByRole('group', { name: /Contabilità e servizi/ });
    expect(within(gruppo).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/admin/coda-fatture',
      '/admin/mensa/cucina',
      '/admin/armadietto',
      '/admin/merchandise',
    ]);
  });

  it('a /admin/mensa nessun gruppo aperto: la pagina è un tab, la voce accesa è già lì', () => {
    stub.pathname = '/admin/mensa';
    foglio();
    expect(intestazioni()).toHaveLength(5);
    expect(aperte()).toHaveLength(0);
  });

  it('toccare un gruppo non chiude il foglio; toccare una voce sì', () => {
    stub.pathname = '/admin';
    const onClose = foglio();
    fireEvent.click(intestazione(/^Segreteria/));
    expect(onClose).not.toHaveBeenCalled();
    expect(aperte()).toEqual([intestazione(/^Segreteria/)]);

    fireEvent.click(screen.getByRole('link', { name: 'Protocollo' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('le intestazioni sono fra gli elementi che il focus-trap attraversa', () => {
    foglio();
    const raggiungibili = Array.from(screen.getByRole('dialog').querySelectorAll(FOCUSABILI));
    // Prima il conteggio: un ciclo su zero intestazioni sarebbe verde senza aver controllato nulla.
    expect(intestazioni()).toHaveLength(5);
    for (const b of intestazioni()) expect(raggiungibili).toContain(b);
  });
});

// In Alto Contrasto le utility colore sono inlinate (`@theme inline`) e il verde chiaro del «sei qui»
// non si rimappa da solo: senza una regola esplicita, a gruppo chiuso nessun segno direbbe dove sei.
describe('Alto Contrasto — l’intestazione «sei qui» resta riconoscibile senza colore', () => {
  // Senza commenti: un lock che legge il CSS come testo troverebbe la regola anche nel commento che la spiega.
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /** Le dichiarazioni delle regole il cui elenco di selettori contiene ESATTAMENTE `selettore`. */
  function dichiarazioniDi(selettore: string): string[] {
    const corpi: string[] = [];
    for (const [, selettori, corpo] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (selettori.split(',').some((s) => s.trim() === selettore)) corpi.push(corpo.trim());
    }
    return corpi;
  }

  // Il selettore SENZA pseudo-classi. La variante `:focus-visible` ripete la barra, ma vale solo col
  // fuoco da tastiera: da sola lascerebbe senza segno il gruppo chiuso di chi usa mouse o dito.
  it.each(['kv-admin-nav', 'kv-admin-sheet'])('.%s: barra nera a sinistra, anche senza fuoco', (superficie) => {
    const corpi = dichiarazioniDi(`[data-contrast="high"] .${superficie} button[data-contiene-pagina="true"]`);
    expect(corpi.some((c) => /box-shadow:\s*inset 4px 0 0 #000000\s*(;|$)/.test(c))).toBe(true);
  });
});
