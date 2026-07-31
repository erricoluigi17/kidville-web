import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act, type ReactElement } from 'react';

/**
 * IDRATAZIONE — l'identità docente non può entrare in un attributo al primo render.
 *
 * LA STORIA. `getCurrentTeacherId()` legge `localStorage` dentro il corpo del
 * componente. Sul server `localStorage` non esiste: la funzione ritorna `null`,
 * e la bottom-nav docente veniva servita con `href="/teacher?userId=null"`. Nel
 * browser la stessa riga leggeva l'uuid vero, quindi il PRIMO render client
 * produceva `href="/teacher?userId=<uuid>"`. React se ne accorge, lo segnala a
 * livello ERROR su ogni caricamento di /teacher, /teacher/diary, /teacher/chat,
 * /teacher/gallery — e **non ripara gli attributi**: il link che il docente si
 * ritrova sotto il dito resta quello sbagliato, con la stringa «null» al posto
 * del suo id.
 *
 * COME SI RIPRODUCE QUI. Il primo passaggio (`renderToString`) gira con
 * `localStorage` VUOTO: è la fotografia esatta del render server, dove lo
 * storage non esiste e ogni lettura vale `null`. Poi si popola lo storage e si
 * idrata quell'HTML — cioè si mette il browser nella condizione reale
 * (identità persistita da un accesso precedente). Nessuna asserzione-fantoccio:
 * l'HTML del server e il DOM dopo l'idratazione sono osservati davvero.
 *
 * LE TRE INVARIANTI, e perché servono tutte e tre:
 *  1. l'HTML del server non contiene mai `userId=null` (la stringa «null» è un
 *     id che non esiste, e viaggia dritta dentro le route API);
 *  2. l'idratazione non produce nessun errore React di mismatch;
 *  3. dopo l'idratazione gli href hanno l'uuid VERO — altrimenti «si aggiusta»
 *     togliendo la propagazione dell'identità, e la navigazione docente perde
 *     l'utente per cui sta operando.
 */

const TEACHER_ID = '5d9bfea6-1111-4222-8333-444444444444';

const stub = vi.hoisted(() => ({
  pathname: '/teacher',
  search: '',
  params: {} as Record<string, string>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => new URLSearchParams(stub.search),
  useParams: () => stub.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// I gradi arrivano da /api/primaria/me: qui sono fermi e "non pronti" (nessun
// filtro sulle voci), così l'unica variabile del test è l'identità.
vi.mock('@/lib/auth/use-teacher-gradi', () => ({
  useTeacherGradi: () => ({
    gradi: [] as string[],
    hasInfanzia: false,
    hasPrimaria: false,
    isPrimariaOnly: false,
    isInfanziaOnly: false,
    diarioPrimariaVisibile: false,
    ready: false,
  }),
}));

import TeacherBottomNav from '@/components/features/teacher/TeacherBottomNav';
import { ClasseShell } from '@/components/features/primaria/ClasseShell';

interface EsitoRoundTrip {
  htmlServer: string;
  container: HTMLElement;
  erroriIdratazione: string[];
  root: Root;
}

/**
 * Render server → idratazione client, come in produzione.
 * `localStorage` vuoto durante `renderToString` = il server, dove non esiste.
 */
async function roundTrip(
  node: ReactElement,
  identitaLocale: string | null = TEACHER_ID,
): Promise<EsitoRoundTrip> {
  window.localStorage.clear();
  const htmlServer = renderToString(node);

  // Il browser, invece, ha l'identità persistita dall'accesso precedente —
  // salvo il caso `null`, che è il docente arrivato da un link nudo con la sola
  // sessione (nessun `kv_teacher_id` in questo dispositivo/scheda).
  if (identitaLocale) window.localStorage.setItem('kv_teacher_id', identitaLocale);

  const container = document.createElement('div');
  container.innerHTML = htmlServer;
  document.body.appendChild(container);

  const erroriIdratazione: string[] = [];
  const spia = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const testo = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    if (/hydrat|did not match|didn't match/i.test(testo)) erroriIdratazione.push(testo);
  });

  let root!: Root;
  await act(async () => {
    root = hydrateRoot(container, node);
  });
  spia.mockRestore();

  return { htmlServer, container, erroriIdratazione, root };
}

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

function chiamateFetch(): string[] {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stub.pathname = '/teacher';
  stub.search = '';
  stub.params = {};
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('TeacherBottomNav — identità docente e idratazione', () => {
  it('il render server non emette mai `userId=null` negli href', async () => {
    const { htmlServer, root } = await roundTrip(<TeacherBottomNav />);
    await act(async () => root.unmount());

    expect(
      htmlServer.includes('userId=null'),
      'La bottom-nav docente è stata servita con href="/teacher?userId=null": ' +
        '«null» viene poi spedito come identità alle route /api/*.',
    ).toBe(false);
  });

  it("l'idratazione non segnala nessun mismatch", async () => {
    const { erroriIdratazione, root } = await roundTrip(<TeacherBottomNav />);
    await act(async () => root.unmount());

    expect(
      erroriIdratazione,
      'React ha segnalato un mismatch di idratazione: gli attributi NON vengono ' +
        'riparati, quindi il difetto resta visibile nel DOM del docente.',
    ).toEqual([]);
  });

  it("dopo l'idratazione gli href portano l'uuid vero del docente", async () => {
    const { container, root } = await roundTrip(<TeacherBottomNav />);
    const link = hrefs(container);
    await act(async () => root.unmount());

    expect(link.length).toBeGreaterThan(0);
    expect(link).toContain(`/teacher?userId=${TEACHER_ID}`);
    expect(link.every((h) => !h.includes('userId=null'))).toBe(true);
  });

  it("con ?userId= nella URL server e client coincidono già al primo render", async () => {
    stub.search = `userId=${TEACHER_ID}`;
    const { htmlServer, erroriIdratazione, container, root } = await roundTrip(<TeacherBottomNav />);
    const link = hrefs(container);
    await act(async () => root.unmount());

    // L'URL è la stessa sul server e sul client: l'identità è nota da subito.
    expect(htmlServer).toContain(`userId=${TEACHER_ID}`);
    expect(erroriIdratazione).toEqual([]);
    expect(link).toContain(`/teacher?userId=${TEACHER_ID}`);
  });
});

describe('ClasseShell — identità docente e idratazione', () => {
  beforeEach(() => {
    stub.pathname = '/teacher/primaria/sez-1';
    stub.params = { sectionId: 'sez-1' };
  });

  it('il render server non emette mai `userId=null` negli href dei tab classe', async () => {
    const { htmlServer, root } = await roundTrip(
      <ClasseShell basePrefix="/teacher/primaria">contenuto</ClasseShell>,
    );
    await act(async () => root.unmount());

    expect(htmlServer.includes('userId=null')).toBe(false);
  });

  it("l'idratazione non segnala nessun mismatch e i tab prendono l'uuid vero", async () => {
    const { erroriIdratazione, container, root } = await roundTrip(
      <ClasseShell basePrefix="/teacher/primaria">contenuto</ClasseShell>,
    );
    const link = hrefs(container);
    await act(async () => root.unmount());

    expect(erroriIdratazione).toEqual([]);
    expect(link).toContain(`/teacher/primaria/sez-1/registro?userId=${TEACHER_ID}`);
    expect(link.every((h) => !h.includes('userId=null'))).toBe(true);
  });

  it('nessuna chiamata API parte con `userId=null`, e l\'identità arriva comunque', async () => {
    const { root } = await roundTrip(
      <ClasseShell basePrefix="/teacher/primaria">contenuto</ClasseShell>,
    );
    await act(async () => root.unmount());

    const chiamate = chiamateFetch();
    expect(
      chiamate.filter((u) => u.includes('userId=null')),
      'Una GET è partita con userId=null: la route risponde su un id inesistente ' +
        'e il risultato è un 4xx silenzioso in faccia alla docente.',
    ).toEqual([]);
    expect(chiamate.some((u) => u.includes(`userId=${TEACHER_ID}`))).toBe(true);
  });

  it('senza identità locale la GET parte lo stesso, ma SENZA il parametro', async () => {
    // Il docente arrivato da un link nudo: nessun `kv_teacher_id`, solo la
    // sessione. Prima qui partiva letteralmente `?userId=null`, e
    // `resolveIdentity` sul percorso legacy ci costruiva sopra una query su un
    // id inesistente. Omettere il parametro lascia lavorare la sessione.
    const { root } = await roundTrip(
      <ClasseShell basePrefix="/teacher/primaria">contenuto</ClasseShell>,
      null,
    );
    await act(async () => root.unmount());

    const chiamate = chiamateFetch();
    expect(chiamate.filter((u) => u.includes('userId'))).toEqual([]);
    expect(chiamate.some((u) => u.startsWith('/api/primaria/me'))).toBe(true);
    expect(chiamate.some((u) => u.startsWith('/api/primaria/classe/sez-1'))).toBe(true);
  });

  it('una sola GET per endpoint: il doppio passaggio non raddoppia le chiamate', async () => {
    const { root } = await roundTrip(
      <ClasseShell basePrefix="/teacher/primaria">contenuto</ClasseShell>,
    );
    await act(async () => root.unmount());

    const chiamate = chiamateFetch();
    expect(chiamate.filter((u) => u.startsWith('/api/primaria/me')).length).toBe(1);
    expect(chiamate.filter((u) => u.startsWith('/api/primaria/classe/')).length).toBe(1);
  });
});
