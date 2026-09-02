import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * UNA sola `GET /api/me` per caricamento, con quattro consumatori montati insieme.
 *
 * Il dato «quali profili ha questa persona» serve a QUATTRO posti che vivono
 * nella stessa schermata: la voce «Passa a…» in ognuno dei tre menu e il chip
 * della veste nella AppBar. Senza deduplica sono quattro richieste identiche a
 * millisecondi di distanza — otto sotto `next dev`, dove StrictMode invoca gli
 * effect due volte. È il difetto T11-F3, che sul diario docente valeva
 * quattordici secondi di attesa.
 *
 * ⚠️ IL TEST NON VERIFICA CHE ESISTA UNA CACHE: conta le RICHIESTE che escono
 * davvero. Una cache aggiunta e poi ignorata (la si chiama e si butta via il
 * risultato) riporta il contatore a quattro e questo file torna rosso.
 */

const stub = vi.hoisted(() => ({
  pathname: '/parent',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

vi.mock('@/lib/offline/pulizia-cache', () => ({ svuotaCacheLocale: vi.fn(async () => {}) }));

import { CambiaProfiloMenuButton } from '@/components/ui/CambiaProfiloMenuButton';
import { invalidaProfiliCache, leggiProfili } from '@/lib/auth/use-profili';

type Profilo = { ruolo: string; area: string };
const DOPPIO: Profilo[] = [
  { ruolo: 'educator', area: 'teacher' },
  { ruolo: 'genitore', area: 'parent' },
];

let chiamateMe: string[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  invalidaProfiliCache();
  chiamateMe = [];
  stub.pathname = '/parent';
  window.localStorage.clear();
  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('/api/me')) {
      chiamateMe.push(u);
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ id: 'u-1', role: 'educator', profili: DOPPIO }),
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

describe('profili — la stessa GET non parte quattro volte', () => {
  it('quattro consumatori montati insieme: UNA sola /api/me', async () => {
    render(
      <>
        <CambiaProfiloMenuButton />
        <CambiaProfiloMenuButton />
        <CambiaProfiloMenuButton />
        <CambiaProfiloMenuButton />
      </>,
    );

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(4));

    expect(
      chiamateMe.length,
      'I profili sono stati chiesti più di una volta nello stesso caricamento: ogni ' +
        `consumatore apre la propria richiesta. Osservate: ${chiamateMe.length}.`,
    ).toBe(1);
  });

  it('due letture contemporanee = una sola richiesta sulla rete', async () => {
    const [a, b] = await Promise.all([leggiProfili(), leggiProfili()]);
    expect(a?.map((p) => p.ruolo)).toEqual(['educator', 'genitore']);
    expect(b?.map((p) => p.ruolo)).toEqual(['educator', 'genitore']);
    expect(chiamateMe).toHaveLength(1);
  });

  it('esito non determinabile (rete giù) NON si congela: il mount dopo ritenta', async () => {
    fetchMock.mockImplementationOnce((url: unknown) => {
      chiamateMe.push(String(url));
      return Promise.reject(new TypeError('offline'));
    });

    expect(await leggiProfili()).toBeNull();
    // Rete tornata: la lettura successiva deve rifare la richiesta, non riusare
    // il «non lo so».
    expect((await leggiProfili())?.length).toBe(2);
    expect(chiamateMe).toHaveLength(2);
  });

  it('una route che risponde male NON diventa «questa persona ha un profilo solo»', async () => {
    fetchMock.mockImplementationOnce((url: unknown) => {
      chiamateMe.push(String(url));
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });

    // `null` e non `[]`: sono due cose diverse, e il chiamante deve poterle
    // distinguere. Con `[]` un guasto di rete si tradurrebbe in «nessun profilo»,
    // cioè nella scomparsa silenziosa del comando per chi ne ha due.
    expect(await leggiProfili()).toBeNull();
  });
});
