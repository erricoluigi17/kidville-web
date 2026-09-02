import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import itPassword from '../../messages/it/password.json';
import itProfilo from '../../messages/it/profilo.json';
import itSettings from '../../messages/it/adminSettings.json';

/**
 * IL CAMBIO PASSWORD È RAGGIUNGIBILE DA TUTTE E TRE LE VESTI.
 *
 * ─── PERCHÉ NON BASTA IL TEST DEL COMPONENTE ────────────────────────────────
 *
 * `cambia-password-card.test.tsx` monta il form da solo e prova che si comporta
 * bene. Un form perfetto che nessuno monta è però esattamente lo stato in cui questa
 * funzione si trovava prima: la route `POST /api/account/password` esiste, è verde e
 * ha il suo tetto — e nessuno, in tutta l’app, poteva chiamarla. Qui si montano le
 * TRE schermate vere e si guarda se il comando c’è.
 *
 * ─── E L’ORDINE, NEL PROFILO DEL GENITORE, È PARTE DEL REQUISITO ────────────
 *
 * legali → sicurezza dell’accesso → biometrico → elimina account. Il comando
 * distruttivo resta ULTIMO: chi cerca «cambia password» col pollice, di fretta, non
 * deve trovarsi sotto il dito la richiesta di cancellazione dell’account.
 *
 * ─── PERCHÉ L’ACCORDION È CHIUSO ────────────────────────────────────────────
 *
 * Perché quella pagina è già lunga, e perché un form password sempre aperto invita i
 * gestori di password del telefono a offrire un salvataggio che nessuno ha chiesto —
 * su una schermata che l’utente ha aperto per tutt’altro.
 */

const stub = vi.hoisted(() => ({
  pathname: '/parent/profilo',
  params: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u-1', role: 'genitore', ready: true }),
}));

vi.mock('@/lib/auth/logout', () => ({ doLogout: vi.fn(async () => {}) }));

// La biometria interroga il bridge nativo: qui serve solo che la card compaia, così
// l'ORDINE delle sezioni si può misurare davvero.
vi.mock('@/lib/native/biometric', () => ({
  biometriaDisponibile: vi.fn(async () => true),
  biometriaAttiva: () => false,
  impostaBiometria: vi.fn(),
  verificaBiometria: vi.fn(async () => ({ ok: true })),
}));

// Il cockpit legge le sedi da un provider con una fetch tutta sua. Qui interessa il
// contrario: che la sezione «Il mio account» NON passi di lì — la password non è un
// affare di sede, e chiederne una prima di poterla cambiare sarebbe un muro inventato.
vi.mock('@/lib/context/sede-context', async () => {
  const React = await import('react');
  return {
    SedeRequired: () => React.createElement('div', { 'data-sede-richiesta': '' }),
    useSediAttive: () => ({
      sedi: [], errore: false, selezionate: [], effettive: [], sedeCorrente: null,
      reFetchKey: '', epocaSede: 0, loading: false,
      toggle: () => {}, soloSede: () => {}, tutte: () => {}, ricarica: () => {},
    }),
  };
});

import ParentProfiloPage from '@/app/(dashboard)/parent/profilo/page';
import TeacherProfiloPage from '@/app/(dashboard)/teacher/profilo/page';
import AdminImpostazioniPage from '@/app/(dashboard)/admin/impostazioni/page';

const P = itPassword as Record<string, string>;
const PROFILO = itProfilo as Record<string, string>;
const SETTINGS = itSettings as Record<string, string>;

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ richiesta: null }) }));

beforeEach(() => {
  vi.clearAllMocks();
  stub.pathname = '/parent/profilo';
  stub.params = new URLSearchParams();
  vi.stubGlobal('fetch', fetchMock);
  document.documentElement.setAttribute('lang', 'it');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('lang');
});

/** Chi viene prima nel DOM: `compareDocumentPosition` lo dice davvero. */
function primaDi(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const sezioneDi = (el: Element | null) => el?.closest('section') ?? null;

describe('profilo del GENITORE — la sicurezza dell’accesso, chiusa e al posto giusto', () => {
  const apri = () => screen.getByRole('button', { name: new RegExp(P.sezioneApri, 'i') });

  it('l’accordion è CHIUSO di default e il form non è nemmeno nel DOM', async () => {
    render(<ParentProfiloPage />);
    await waitFor(() => expect(apri()).toBeInTheDocument());
    expect(apri()).toHaveAttribute('aria-expanded', 'false');
    // «Non visibile» non basta: un campo password montato e nascosto è comunque un
    // campo che un gestore di password del telefono vede e offre di riempire.
    expect(screen.queryByLabelText(P.labelNuova)).toBeNull();
    // …e il comando dichiara COSA apre, altrimenti da tastiera è un bottone muto.
    const controllato = apri().getAttribute('aria-controls');
    expect(controllato, 'l’accordion non dichiara `aria-controls`').toBeTruthy();
  });

  it('premendolo si apre, e il pannello dichiarato è quello che compare', async () => {
    render(<ParentProfiloPage />);
    await waitFor(() => expect(apri()).toBeInTheDocument());
    const controllato = apri().getAttribute('aria-controls')!;
    fireEvent.click(apri());
    expect(apri()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(P.labelAttuale)).toBeInTheDocument();
    expect(screen.getByLabelText(P.labelNuova)).toBeInTheDocument();
    expect(screen.getByLabelText(P.labelConferma)).toBeInTheDocument();
    expect(document.getElementById(controllato)?.contains(screen.getByLabelText(P.labelNuova))).toBe(true);
  });

  it('sta FRA i link legali e il blocco biometrico, e prima di «elimina account»', async () => {
    render(<ParentProfiloPage />);
    await waitFor(() => expect(screen.getByText(PROFILO.bioTitolo)).toBeInTheDocument());

    const legali = sezioneDi(screen.getByText(PROFILO.linkPrivacy));
    const sicurezza = sezioneDi(apri());
    const biometrico = sezioneDi(screen.getByText(PROFILO.bioTitolo));
    const elimina = sezioneDi(screen.getByText(PROFILO.eliminaTitolo));

    for (const [nome, el] of [['legali', legali], ['sicurezza', sicurezza], ['biometrico', biometrico], ['elimina', elimina]] as const) {
      expect(el, `sezione «${nome}» non trovata`).toBeTruthy();
    }
    expect(primaDi(legali!, sicurezza!), 'la sicurezza sta prima dei link legali').toBe(true);
    expect(primaDi(sicurezza!, biometrico!), 'la sicurezza sta dopo il blocco biometrico').toBe(true);
    // Il distruttivo resta ULTIMO: chi cerca «cambia password» di fretta non deve
    // trovarsi sotto il dito la cancellazione dell'account.
    expect(primaDi(biometrico!, elimina!)).toBe(true);
  });

  it('il comando dell’accordion si preme col pollice (≥44px)', async () => {
    render(<ParentProfiloPage />);
    await waitFor(() => expect(apri()).toBeInTheDocument());
    expect(apri().className).toMatch(/min-h-\[44px\]|\bh-11\b|py-3\.5|py-4/);
  });
});

describe('profilo del DOCENTE — la gemella magra', () => {
  it('esiste e monta lo stesso form, con i tre campi', () => {
    stub.pathname = '/teacher/profilo';
    render(<TeacherProfiloPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(P.profiloDocenteTitolo);
    expect(screen.getByLabelText(P.labelAttuale)).toBeInTheDocument();
    expect(screen.getByLabelText(P.labelNuova)).toBeInTheDocument();
    expect(screen.getByLabelText(P.labelConferma)).toBeInTheDocument();
  });

  it('il form è APERTO: qui la pagina non ha nient’altro da mostrare', () => {
    // L'accordion del genitore esiste perché quella pagina è lunga. Questa no: un
    // accordion su una schermata con dentro una cosa sola è un clic in più che
    // nasconde l'unica ragione per cui la pagina si apre.
    stub.pathname = '/teacher/profilo';
    const { container } = render(<TeacherProfiloPage />);
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });
});

describe('impostazioni della SEGRETERIA — «Il mio account»', () => {
  it('la voce esiste nella navigazione delle impostazioni', () => {
    stub.pathname = '/admin/impostazioni';
    render(<AdminImpostazioniPage />);
    expect(screen.getAllByRole('button', { name: new RegExp(SETTINGS.voceAccount, 'i') }).length).toBeGreaterThan(0);
  });

  it('con ?sezione=account compare il form, e NON si chiede nessuna sede', () => {
    // ⚠️ La password non è un affare di sede. Ogni altra sezione di questa pagina
    // configura UN plesso e passa da `SedeRequired`; questa no, e chiedere di
    // scegliere una sede prima di poter cambiare la propria password sarebbe un muro
    // inventato — per giunta davanti a chi le sedi le ha tutte e tre.
    stub.pathname = '/admin/impostazioni';
    stub.params = new URLSearchParams('sezione=account');
    render(<AdminImpostazioniPage />);
    expect(screen.getByLabelText(P.labelAttuale)).toBeInTheDocument();
    expect(document.querySelector('[data-sede-richiesta]'), 'la sezione chiede una sede').toBeNull();
  });

  it('CONTROLLO POSITIVO — le altre sezioni la sede continuano a chiederla', () => {
    // Senza, il test qui sopra sarebbe verde anche se qualcuno togliesse
    // `SedeRequired` da tutta la pagina: e lì i dati finirebbero nel plesso sbagliato,
    // in silenzio.
    stub.pathname = '/admin/impostazioni';
    stub.params = new URLSearchParams('sezione=pagamenti');
    render(<AdminImpostazioniPage />);
    expect(document.querySelector('[data-sede-richiesta]')).not.toBeNull();
  });
});
