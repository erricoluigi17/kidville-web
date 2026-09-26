import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi';
import { SedeProvider, useSediAttive } from '@/lib/context/sede-context';

/**
 * Contabilità con PIÙ sedi selezionate (piano 2026-09-26, §3 «Pagina»).
 *
 * Fino a oggi tutta `/admin/pagamenti` stava dentro `SedeRequired`: con due o tre
 * plessi attivi — il caso normale della Direzione, e l'impostazione di chi non ha
 * mai toccato il selettore — lo scadenzario, la cassa, la riconciliazione… si
 * fermavano su «Seleziona una sede». La decisione dell'utente: le sette viste di
 * LETTURA/lavoro ricevono `scuolaId = null` e lavorano su tutte le sedi effettive;
 * solo **Genera** e **Causali**, che scrivono la configurazione di UNA sede,
 * continuano a chiederla.
 *
 * Qui girano il `SedeProvider` e il `SedeRequired` VERI (non un sosia del guard):
 * l'unica cosa finta è la rete. Così il test misura la regola della pagina, e non
 * la fedeltà di un mock alla regola.
 */

const h = vi.hoisted(() => ({
  vista: 'scadenzario' as string,
  sedi: [] as { id: string; nome: string }[],
  sediOk: true,
  montaggi: {} as Record<string, number>,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`vista=${h.vista}`),
  usePathname: () => '/admin/pagamenti',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'seg-1', role: 'segreteria', ready: true }),
}));

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'seg-1', ruolo: 'segreteria', withUser: (x: string) => x }),
  useRuoloCockpit: () => 'segreteria',
}));

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));

// `next/dynamic` sotto jsdom: lo stesso contratto (loader asincrono → componente),
// servito con `React.lazy`. I pannelli sono sostituiti da segnaposto che dicono
// QUALE sede hanno ricevuto e QUANTE volte sono stati montati.
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  return {
    default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
      const Lazy = React.lazy(async () => ({ default: await loader() }));
      const Dinamico = (props: Record<string, unknown>) => (
        <React.Suspense fallback={null}>
          <Lazy {...props} />
        </React.Suspense>
      );
      return Dinamico;
    },
  };
});

function segnaposto(nome: string) {
  return function Pannello({ scuolaId }: { scuolaId: string | null }) {
    useEffect(() => {
      h.montaggi[nome] = (h.montaggi[nome] ?? 0) + 1;
    }, []);
    return <div data-testid={`pannello-${nome}`} data-scuola={scuolaId === null ? 'null' : scuolaId} />;
  };
}

vi.mock('@/components/features/admin/pagamenti/PaymentsDashboard', () => ({ PaymentsDashboard: segnaposto('scadenzario') }));
vi.mock('@/components/features/admin/pagamenti/TransazioniPanel', () => ({ TransazioniPanel: segnaposto('transazioni') }));
vi.mock('@/components/features/admin/pagamenti/SollecitiPanel', () => ({ SollecitiPanel: segnaposto('solleciti') }));
vi.mock('@/components/features/admin/pagamenti/RiconciliazionePanel', () => ({ RiconciliazionePanel: segnaposto('riconciliazione') }));
vi.mock('@/components/features/admin/pagamenti/FiscalePanel', () => ({ FiscalePanel: segnaposto('fiscale') }));
vi.mock('@/components/features/admin/pagamenti/TicketMensaPanel', () => ({ TicketMensaPanel: segnaposto('ticket') }));
vi.mock('@/components/features/admin/pagamenti/CassaPanel', () => ({ CassaPanel: segnaposto('cassa') }));
vi.mock('@/components/features/admin/pagamenti/GeneratoreRette', () => ({ GeneratoreRette: segnaposto('genera-rette') }));
vi.mock('@/components/features/admin/pagamenti/GeneratoreCategoria', () => ({ GeneratoreCategoria: segnaposto('genera-categoria') }));
vi.mock('@/components/features/admin/pagamenti/CausaliPanel', () => ({
  CausaliPanel: segnaposto('causali'),
  CausaliFatturaPanel: segnaposto('causali-fattura'),
}));

import AdminPagamentiPage from '@/app/(dashboard)/admin/pagamenti/page';

/** Un bottone che fa quello che fa il selettore di sede in alto: toglie una sede. */
function TogliSede({ id }: { id: string }) {
  const { toggle } = useSediAttive();
  return <button type="button" onClick={() => toggle(id)}>togli-sede</button>;
}

function renderPagina(extra?: React.ReactNode) {
  return render(
    <SedeProvider>
      {extra}
      <AdminPagamentiPage />
    </SedeProvider>,
  );
}

function scriviCookieSedi(ids: string[]) {
  document.cookie = `sedi_attive=${encodeURIComponent(ids.join(','))}; path=/`;
}

beforeEach(() => {
  h.vista = 'scadenzario';
  h.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ];
  h.sediOk = true;
  h.montaggi = {};
  scriviCookieSedi([]);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (String(url).includes('/api/admin/sedi')) {
        return Promise.resolve(
          h.sediOk
            ? { ok: true, status: 200, json: async () => ({ success: true, data: h.sedi }) }
            : { ok: false, status: 500, json: async () => ({ success: false }) },
        );
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
    }),
  );
});

afterEach(() => {
  scriviCookieSedi([]);
  vi.unstubAllGlobals();
});

const VISTE_MULTI_SEDE = ['scadenzario', 'transazioni', 'solleciti', 'riconciliazione', 'fiscale', 'ticket', 'cassa'] as const;

describe('/admin/pagamenti — più sedi selezionate', () => {
  it('scadenzario con due sedi: il pannello si monta con scuolaId = null, niente «Seleziona una sede»', async () => {
    renderPagina();
    const pannello = await screen.findByTestId('pannello-scadenzario');
    expect(pannello.getAttribute('data-scuola')).toBe('null');
    expect(screen.queryByText('Seleziona una sede')).toBeNull();
  });

  it.each(VISTE_MULTI_SEDE)('vista %s con due sedi: montata, con scuolaId = null', async (vista) => {
    h.vista = vista;
    renderPagina();
    const pannello = await screen.findByTestId(`pannello-${vista}`);
    expect(pannello.getAttribute('data-scuola')).toBe('null');
    expect(screen.queryByText('Seleziona una sede')).toBeNull();
  });

  it('genera con due sedi: chiede la sede (con i bottoni per sceglierla) e NON monta i generatori', async () => {
    h.vista = 'genera';
    renderPagina();
    await screen.findByText('Seleziona una sede');
    expect(screen.getByRole('button', { name: NOME_SEDE_A })).toBeInTheDocument();
    expect(screen.queryByTestId('pannello-genera-rette')).toBeNull();
    expect(screen.queryByTestId('pannello-genera-categoria')).toBeNull();
  });

  it('causali con due sedi: chiede la sede e NON monta gli editor', async () => {
    h.vista = 'causali';
    renderPagina();
    await screen.findByText('Seleziona una sede');
    expect(screen.queryByTestId('pannello-causali')).toBeNull();
    expect(screen.queryByTestId('pannello-causali-fattura')).toBeNull();
  });

  it('genera con due sedi: scelta una sede dall\'avviso, i generatori si montano con QUELLA sede', async () => {
    h.vista = 'genera';
    renderPagina();
    fireEvent.click(await screen.findByRole('button', { name: NOME_SEDE_B }));
    const rette = await screen.findByTestId('pannello-genera-rette');
    expect(rette.getAttribute('data-scuola')).toBe(SEDE_B);
    expect(screen.getByTestId('pannello-genera-categoria').getAttribute('data-scuola')).toBe(SEDE_B);
  });

  it('una sola sede scelta: lo scadenzario riceve QUELLA sede, non null', async () => {
    scriviCookieSedi([SEDE_A]);
    renderPagina();
    const pannello = await screen.findByTestId('pannello-scadenzario');
    expect(pannello.getAttribute('data-scuola')).toBe(SEDE_A);
  });

  it('finché le sedi non sono arrivate non monta nessun pannello (niente fetch con una sede provvisoria)', async () => {
    renderPagina();
    // Sincrono, prima che la fetch delle sedi si risolva: si vede il caricamento.
    expect(screen.getAllByText('Caricamento…').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('pannello-scadenzario')).toBeNull();
    // …e poi il pannello arriva: la PRESENZA chiude il test, non un'assenza.
    await screen.findByTestId('pannello-scadenzario');
    expect(h.montaggi.scadenzario).toBe(1);
  });

  it('elenco sedi non arrivato: dice il guasto invece di aprire i pannelli su uno scope ignoto', async () => {
    h.sediOk = false;
    renderPagina();
    await screen.findByText('Non è stato possibile leggere le tue sedi');
    expect(screen.queryByTestId('pannello-scadenzario')).toBeNull();
  });

  it('nessuna sede associata (elenco arrivato ma vuoto): lo dice, senza chiedere di sceglierne una che non esiste', async () => {
    h.sedi = [];
    h.sediOk = true;
    renderPagina();
    // La PRESENZA del testo vero chiude l'attesa; le assenze si controllano dopo.
    await screen.findByText(/Nessuna sede associata al tuo account/);
    expect(screen.queryByText('Seleziona una sede')).toBeNull();
    expect(screen.queryByText(/Scegline una sola dal menu in alto/)).toBeNull();
    for (const vista of VISTE_MULTI_SEDE) {
      expect(screen.queryByTestId(`pannello-${vista}`)).toBeNull();
    }
  });

  it('da tre sedi a due (scuolaId resta null): il pannello si RIMONTA, quindi ricarica', async () => {
    h.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_C, nome: NOME_SEDE_C },
    ];
    // Tre sedi scelte ESPLICITAMENTE: togliendone una se ne restano due (con il
    // cookie vuoto = «tutte», `toggle` selezionerebbe invece solo quella cliccata).
    scriviCookieSedi([SEDE_A, SEDE_B, SEDE_C]);
    // Di proposito SENZA `SedeScopeBoundary` (che sta nel layout): la pagina deve
    // ricaricare da sola quando cambia lo scope, anche se `scuolaId` non cambia.
    renderPagina(<TogliSede id={SEDE_C} />);
    await screen.findByTestId('pannello-scadenzario');
    expect(h.montaggi.scadenzario).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'togli-sede' }));
    });
    const dopo = await screen.findByTestId('pannello-scadenzario');
    expect(dopo.getAttribute('data-scuola')).toBe('null');
    expect(h.montaggi.scadenzario).toBe(2);
  });
});
