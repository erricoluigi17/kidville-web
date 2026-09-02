import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

/**
 * LO SWITCH DI PROFILO — e la regola che viene prima di tutte le altre.
 *
 * ─── IL NUMERO CHE DECIDE LA FORMA ──────────────────────────────────────────
 * Misurato in produzione il 2026-09-01: **cinque** persone hanno una riga
 * `utenti` da personale *e* il ponte `parents.auth_user_id`. Le altre **617**
 * hanno un profilo solo. Una voce di menu che non fa niente, mostrata a 617
 * persone su 622, non è una funzione in più: è rumore in un menu che quelle
 * persone useranno ogni giorno.
 *
 *   → con meno di due profili il componente non renderizza NIENTE.
 *
 * ─── E CON DUE PROFILI, UN TOCCO SOLO ───────────────────────────────────────
 * Due profili è l'unico caso reale. Un menu che ne elenca due, di cui uno è
 * quello che stai già indossando, è un passaggio in più senza informazione:
 * l'etichetta dice già la destinazione — «Passa a Genitore».
 *
 * ─── LE QUATTRO COSE CHE DEVONO SUCCEDERE, IN QUEST'ORDINE ──────────────────
 *  1. POST `/api/auth/active-role` — e se NON risponde 2xx **non si naviga**:
 *     atterrare in un'area con un cookie che il server non ha scritto è il ramo
 *     peggiore, non il migliore (lezione scritta in `login/page.tsx:146-156`);
 *  2. `svuotaCacheLocale()` ATTESA prima di navigare — la cache offline contiene
 *     dati di minori raccolti nella veste precedente;
 *  3. UNA sola navigazione, `router.replace`, **senza `router.refresh()`**: il
 *     `refresh()` in coda è ciò che su iOS produceva `NSURLErrorCancelled (-999)`
 *     in un accesso su sei (S28, lock `ios-navigazione-annullata.test.ts`);
 *  4. l'annuncio in una regione `role="status"`, perché il cambio si SENTA e non
 *     solo avvenga.
 */

const stub = vi.hoisted(() => ({
  pathname: '/parent',
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: stub.push, replace: stub.replace, refresh: stub.refresh, prefetch: vi.fn() }),
}));

const spie = vi.hoisted(() => ({
  svuota: vi.fn(async () => {}),
  log: vi.fn(),
}));

vi.mock('@/lib/offline/pulizia-cache', () => ({ svuotaCacheLocale: spie.svuota }));

vi.mock('@/lib/logging/client', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/client')>();
  return { ...vero, logClient: spie.log };
});

import { CambiaProfiloMenuButton } from '@/components/ui/CambiaProfiloMenuButton';
import { invalidaProfiliCache } from '@/lib/auth/use-profili';

type Profilo = { ruolo: string; area: string };

const DOPPIO: Profilo[] = [
  { ruolo: 'educator', area: 'teacher' },
  { ruolo: 'genitore', area: 'parent' },
];
const SOLO_DOCENTE: Profilo[] = [{ ruolo: 'educator', area: 'teacher' }];

let profiliServiti: Profilo[] = DOPPIO;
let esitoCambio: { ok: boolean; stato: number } = { ok: true, stato: 200 };
let chiamate: string[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  invalidaProfiliCache();
  chiamate = [];
  profiliServiti = DOPPIO;
  esitoCambio = { ok: true, stato: 200 };
  stub.pathname = '/parent';
  window.localStorage.clear();
  window.localStorage.setItem('kv_user_id', 'u-1');
  window.localStorage.setItem('kv_user_role', 'genitore');

  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    chiamate.push(u);
    if (u.includes('/api/me')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ id: 'u-1', role: 'educator', profili: profiliServiti }),
      });
    }
    if (u.includes('/api/auth/active-role')) {
      return Promise.resolve({
        ok: esitoCambio.ok,
        status: esitoCambio.stato,
        json: async () => ({ ok: esitoCambio.ok }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Il bottone come lo vedrà chi lo cerca: per NOME, non per classe. */
const bottonePassa = (a: string) => screen.queryByRole('button', { name: new RegExp(`Passa a ${a}`, 'i') });

describe('CambiaProfiloMenuButton — chi ha un profilo solo non vede niente', () => {
  it('617 persone su 622: con un profilo solo il componente non renderizza NULLA', async () => {
    profiliServiti = SOLO_DOCENTE;
    stub.pathname = '/teacher';
    const { container } = render(<CambiaProfiloMenuButton />);

    // Si aspetta che la risposta sia stata servita: senza questo, il vuoto
    // misurato sarebbe solo «non ha ancora caricato», cioè un test che non sa
    // fallire.
    await waitFor(() => expect(chiamate.some((c) => c.includes('/api/me'))).toBe(true));
    await waitFor(() => expect(container.querySelector('button')).toBeNull());

    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('nemmeno un attimo: durante il caricamento non c’è nessun bottone che poi sparisce', () => {
    profiliServiti = SOLO_DOCENTE;
    const { container } = render(<CambiaProfiloMenuButton />);
    expect(container.innerHTML).toBe('');
  });

  it('un profilo solo E veste NON risolvibile: continua a non renderizzare niente', async () => {
    /*
     * ⚠️ QUESTO TEST ESISTE PERCHÉ IL PRECEDENTE NON SAPEVA FALLIRE.
     *
     * Misurato con una manomissione (M5): togliendo la guardia
     * `profili.length < 2` i due test qui sopra restavano VERDI, perché a
     * salvarli interveniva una SECONDA guardia — «nessuna destinazione
     * alternativa» — che con un profilo solo e la veste risolta è sempre vera.
     * Due guardie, un solo caso misurato: la prima poteva sparire senza che
     * niente diventasse rosso.
     *
     * Qui la veste NON è risolvibile — il percorso è di un'area che nessun
     * profilo copre e `kv_user_role` non c'è (storage appena svuotato, primo
     * accesso su un dispositivo nuovo, cookie di veste scaduto) — quindi
     * l'unico profilo diventa «un'alternativa» e la seconda guardia non scatta.
     * Senza la prima, comparirebbe «Passa a Docente» a un docente che è già
     * docente: un comando che non porta da nessuna parte, per 617 persone.
     */
    profiliServiti = SOLO_DOCENTE;
    stub.pathname = '/parent';
    window.localStorage.removeItem('kv_user_role');

    const { container } = render(<CambiaProfiloMenuButton />);
    await waitFor(() => expect(chiamate.some((c) => c.includes('/api/me'))).toBe(true));
    // Un giro di render dopo la risposta: se qualcosa dovesse comparire, a
    // questo punto è comparso.
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('con DUE profili compare un bottone solo, e dice la destinazione', async () => {
    render(<CambiaProfiloMenuButton />);
    const b = await screen.findByRole('button', { name: /Passa a Docente/i });

    // La veste attiva è «genitore» (siamo su /parent): la destinazione è l'altra.
    expect(b).toBeInTheDocument();
    expect(bottonePassa('Genitore')).toBeNull();
    // Con due profili non c'è nessun menu da aprire: il bottone È l'azione.
    expect(b.getAttribute('aria-haspopup')).toBeNull();
    // Nome TESTUALE, non solo icona (lock `bottone-icona-con-nome`).
    expect(b.textContent).toContain('Passa a Docente');

    /*
     * IL NOME ACCESSIBILE, ESATTO — non una regex.
     *
     * Questo è il selettore su cui si aggancia lo spec E2E del doppio profilo
     * (`e2e/doppio-profilo.spec.ts`), e un `getByRole('button', { name: '…' })`
     * di Playwright confronta il nome CALCOLATO. Se l'icona `lucide` cominciasse
     * a contribuire al nome, o se l'etichetta prendesse un prefisso, la regex
     * qui sopra resterebbe verde e l'E2E diventerebbe rosso su un prodotto sano.
     */
    expect(screen.getByRole('button', { name: 'Passa a Docente' })).toBe(b);
  });

  it('la veste attiva segue l’AREA in cui si sta guardando, non un ricordo', async () => {
    // Stessa identità, stesso `kv_user_role` di prima (genitore), ma la
    // schermata è quella docente: la destinazione dev'essere «Genitore».
    stub.pathname = '/teacher/diary';
    render(<CambiaProfiloMenuButton />);
    expect(await screen.findByRole('button', { name: /Passa a Genitore/i })).toBeInTheDocument();
    expect(bottonePassa('Docente')).toBeNull();
  });
});

describe('CambiaProfiloMenuButton — il gesto, passo per passo', () => {
  it('un tocco: POST, cache svuotata, UNA replace e nessun refresh', async () => {
    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    await waitFor(() => expect(stub.replace).toHaveBeenCalledTimes(1));

    const post = chiamate.filter((c) => c.includes('/api/auth/active-role'));
    expect(post).toHaveLength(1);
    expect(spie.svuota).toHaveBeenCalledTimes(1);
    expect(stub.replace).toHaveBeenCalledWith('/teacher');
    expect(
      stub.refresh,
      'Il `refresh()` in coda alla `replace` è ciò che su iOS annullava la ' +
        'navigazione (NSURLErrorCancelled -999) in un caso su sei.',
    ).not.toHaveBeenCalled();
    expect(stub.push).not.toHaveBeenCalled();
  });

  it('la cache è svuotata PRIMA della navigazione, non dopo', async () => {
    const ordine: string[] = [];
    spie.svuota.mockImplementationOnce(async () => { ordine.push('svuota'); });
    stub.replace.mockImplementationOnce(() => { ordine.push('replace'); });

    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    await waitFor(() => expect(ordine).toEqual(['svuota', 'replace']));
  });

  it('il ruolo memorizzato passa alla nuova veste, il figlio scelto viene dimenticato', async () => {
    window.localStorage.setItem('kv_student_id', 'alunno-scelto-da-genitore');
    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    await waitFor(() => expect(stub.replace).toHaveBeenCalled());
    expect(window.localStorage.getItem('kv_user_role')).toBe('educator');
    expect(window.localStorage.getItem('kv_student_id')).toBeNull();
  });

  it('l’esito si ANNUNCIA: una regione role="status" dice in che veste si è ora', async () => {
    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Ora stai usando Kidville come Docente'),
    );
  });

  it('l’annuncio è dipinto PRIMA della navigazione: altrimenti nessuno lo sente', async () => {
    const ordine: string[] = [];
    stub.replace.mockImplementationOnce(() => {
      ordine.push(screen.getByRole('status').textContent?.trim() ? 'annuncio-pronto' : 'annuncio-vuoto');
    });

    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    await waitFor(() => expect(ordine).toEqual(['annuncio-pronto']));
  });
});

describe('CambiaProfiloMenuButton — quando il server dice di no', () => {
  it('403: NESSUNA navigazione, un errore in linea, e una riga di log', async () => {
    esitoCambio = { ok: false, stato: 403 };
    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('Non è stato possibile cambiare profilo');
    expect(
      stub.replace,
      'Atterrare in un’area con un cookie che il server non ha scritto è il ramo ' +
        'peggiore di un guasto qui, non il migliore: si resta dove si è.',
    ).not.toHaveBeenCalled();
    expect(spie.svuota).not.toHaveBeenCalled();

    // La riga di log esiste ED È SPEDIBILE. `livelloEvento` in `logging/client.ts`
    // SCARTA IN SILENZIO qualunque evento che porti uno `stato` fra 400 e 599 non
    // compreso in ANOMALIE_4XX: passare `stato: 403` qui darebbe un test verde e
    // nessuna riga in `app_log`. Lo status vive dentro il messaggio.
    expect(spie.log).toHaveBeenCalledTimes(1);
    const evento = spie.log.mock.calls[0][0] as { stato?: number; messaggio: string; livello: string };
    expect(evento.stato).toBeUndefined();
    expect(evento.messaggio).toContain('http=403');
    expect(evento.livello).toBe('warn');
  });

  it('rete giù: stesso trattamento — si resta dove si è e si logga', async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      chiamate.push(u);
      if (u.includes('/api/me')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'u-1', profili: DOPPIO }) });
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });

    render(<CambiaProfiloMenuButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Passa a Docente/i }));

    await screen.findByRole('alert');
    expect(stub.replace).not.toHaveBeenCalled();
    expect(spie.log).toHaveBeenCalledTimes(1);
    // Nessuno stato: la richiesta non è mai arrivata. È l'unico caso che solo il
    // client può vedere, e `livelloEvento` lo lascia passare come `warn`.
    expect((spie.log.mock.calls[0][0] as { stato?: number }).stato).toBeUndefined();
  });

  it('dopo un guasto si può ritentare: il bottone non resta inattivo', async () => {
    esitoCambio = { ok: false, stato: 500 };
    render(<CambiaProfiloMenuButton />);
    const b = await screen.findByRole('button', { name: /Passa a Docente/i });
    fireEvent.click(b);
    await screen.findByRole('alert');

    await waitFor(() => expect(b).not.toBeDisabled());

    esitoCambio = { ok: true, stato: 200 };
    fireEvent.click(b);
    await waitFor(() => expect(stub.replace).toHaveBeenCalledWith('/teacher'));
  });
});

describe('CambiaProfiloMenuButton — tre profili o più: lì il picker serve davvero', () => {
  it('con tre profili si apre un dialogo, e ogni voce è una destinazione', async () => {
    profiliServiti = [
      { ruolo: 'educator', area: 'teacher' },
      { ruolo: 'genitore', area: 'parent' },
      { ruolo: 'segreteria', area: 'admin' },
    ];
    render(<CambiaProfiloMenuButton />);

    const trigger = await screen.findByRole('button', { name: /Cambia profilo/i });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger);

    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toBeInTheDocument();
    // Le due destinazioni possibili, non la veste che si sta già indossando.
    expect(screen.getByRole('button', { name: /Passa a Docente/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Passa a Segreteria/i })).toBeInTheDocument();
    expect(bottonePassa('Genitore')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Passa a Segreteria/i }));
    await waitFor(() => expect(stub.replace).toHaveBeenCalledWith('/admin'));
  });
});
