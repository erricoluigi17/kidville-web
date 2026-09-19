import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

/**
 * IL GIORNO DEL REGISTRO SOPRAVVIVE AL GIRO SULLE ALTRE LINGUETTE.
 *
 * ─── LA SEGNALAZIONE ────────────────────────────────────────────────────────
 * «Nel registro non si riesce a tornare indietro con le date». Sulla pagina del
 * registro il giorno scelto vive ormai nell'URL (`?data=yyyy-mm-dd`), così che un
 * F5 e i tasti avanti/indietro del browser lo conservino. Ma gli href delle dieci
 * linguette della cornice di classe li costruisce `ClasseShell`, e portavano il
 * solo `?userId=`: Registro al 10 settembre → «Appello» → «Registro» riapriva su
 * OGGI. Da fuori è indistinguibile dal difetto di partenza.
 *
 * ─── PERCHÉ SI CONTROLLA ANCHE LA LINGUETTA CHE LA DATA NON LA LEGGE ────────
 * Perché è quella di TRANSITO. Oggi solo Registro legge `?data=`; Appello ha un
 * selettore con stato proprio e Compiti ragiona per periodo relativo. Se il
 * valore non sopravvive al passaggio su Appello, il ritorno su Registro riparte
 * da oggi comunque — cioè il difetto resta, con l'href di «Registro» decorato.
 * Un test che guardasse la sola linguetta «Registro» sarebbe verde su una
 * correzione che non corregge niente.
 *
 * ─── LE TRE FAMIGLIE CHE QUESTO FILE SORVEGLIA ──────────────────────────────
 *  1. la PROPAGAZIONE: il giorno arriva a tutte le linguette, transito compreso;
 *  2. il CALENDARIO: `?data=2026-02-30` ha la forma giusta e non esiste — non
 *     deve viaggiare (e non basta una regex a dirlo: `Date.parse` su quel giorno
 *     in V8 non è `NaN`, vale il 2 marzo);
 *  3. l'IDENTITÀ: `?userId=` continua a comportarsi ESATTAMENTE come prima, e la
 *     stringa `userId=null` resta impossibile anche nel passaggio di render in
 *     cui l'identità non è ancora risolta.
 *
 * ⚠️ Le linguette si cercano per RUOLO e NOME accessibile, mai con `getByText`:
 * «Registro» e «Compiti» compaiono anche nel contenuto della pagina, e
 * `getByText` pesca il primo sosia.
 */

const DOCENTE = '5d9bfea6-1111-4222-8333-444444444444';
const SEZIONE = 'sez-1';
const BASE = `/teacher/primaria/${SEZIONE}`;
const GIORNO = '2026-09-10';

/** Le dieci linguette, con il segmento che ciascuna apre. */
const LINGUETTE: { nome: string; seg: string }[] = [
  { nome: 'Panoramica', seg: '' },
  { nome: 'Registro', seg: 'registro' },
  { nome: 'Compiti', seg: 'compiti' },
  { nome: 'Appello', seg: 'appello' },
  { nome: 'Valutazioni', seg: 'valutazioni' },
  { nome: 'Note', seg: 'note' },
  { nome: 'Orario', seg: 'orario' },
  { nome: 'Prospetto', seg: 'prospetto' },
  { nome: 'Scrutinio', seg: 'scrutinio' },
  { nome: 'Fascicolo', seg: 'fascicolo' },
];

const stub = vi.hoisted(() => ({
  pathname: '/teacher/primaria/sez-1/registro',
  search: '',
  params: { sectionId: 'sez-1' } as Record<string, string>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => new URLSearchParams(stub.search),
  useParams: () => stub.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// `next/link` vero pretende il router dell'App Router: qui interessa l'ANCORA,
// cioè l'href che il docente si ritrova davvero sotto il dito.
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});

import { ClasseShell } from '@/components/features/primaria/ClasseShell';

function shell() {
  return <ClasseShell basePrefix="/teacher/primaria">contenuto della linguetta</ClasseShell>;
}

/** Monta la cornice e aspetta gli effetti (le due GET di nome classe e ruolo). */
async function monta() {
  await act(async () => {
    render(shell());
  });
}

/** L'href di una linguetta, cercata per ruolo e nome: niente sosia. */
function hrefLinguetta(nome: string): string {
  return screen.getByRole('link', { name: nome }).getAttribute('href') ?? '';
}

function tuttiGliHref(): string[] {
  return Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

function chiamateFetch(): string[] {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  stub.pathname = `${BASE}/registro`;
  stub.search = '';
  stub.params = { sectionId: SEZIONE };
  window.localStorage.clear();
  window.localStorage.setItem('kv_teacher_id', DOCENTE);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { section: { name: '3 A' }, ruolo: 'educator' } }),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('ClasseShell — il giorno scelto nel registro viaggia con le linguette', () => {
  it('con ?data= valido «Registro» lo conserva, e `userId` resta il primo parametro', async () => {
    stub.search = `userId=${DOCENTE}&data=${GIORNO}`;
    await monta();

    // Uguaglianza ESATTA e non `toContain`: cattura anche il parametro duplicato
    // e l'ordine ribaltato, che sono due modi di «funzionare per sbaglio».
    expect(hrefLinguetta('Registro')).toBe(`${BASE}/registro?userId=${DOCENTE}&data=${GIORNO}`);
  });

  it('anche la linguetta di TRANSITO porta il giorno: è lì che si perdeva', async () => {
    stub.search = `userId=${DOCENTE}&data=${GIORNO}`;
    await monta();

    // Appello non legge `?data=` (ha un suo selettore): il valore le serve solo
    // per restituirlo a «Registro» al ritorno. Senza questo, il giro
    // Registro → Appello → Registro riapre su oggi — il difetto segnalato.
    expect(hrefLinguetta('Appello')).toBe(`${BASE}/appello?userId=${DOCENTE}&data=${GIORNO}`);
    expect(hrefLinguetta('Compiti')).toBe(`${BASE}/compiti?userId=${DOCENTE}&data=${GIORNO}`);
  });

  it('tutte e dieci le linguette lo portano, la freccia «indietro» no', async () => {
    stub.search = `userId=${DOCENTE}&data=${GIORNO}`;
    await monta();

    for (const { nome, seg } of LINGUETTE) {
      expect(hrefLinguetta(nome), `linguetta ${nome}`).toBe(
        `${BASE}${seg ? `/${seg}` : ''}?userId=${DOCENTE}&data=${GIORNO}`,
      );
    }

    // La freccia esce dalla classe e torna all'elenco: lì un giorno non vuol
    // dire niente, e il suo href resta quello di sempre.
    const indietro = screen.getByRole('link', { name: 'Torna indietro' });
    expect(indietro.getAttribute('href')).toBe(`/teacher/primaria?userId=${DOCENTE}`);
  });

  it('il giorno NON entra nelle GET della cornice: resta un fatto di navigazione', async () => {
    stub.search = `userId=${DOCENTE}&data=${GIORNO}`;
    await monta();

    const chiamate = chiamateFetch();
    expect(chiamate.length).toBeGreaterThan(0);
    expect(
      chiamate.filter((u) => u.includes('data=')),
      'Il giorno è finito nella query di una route che non lo prevede.',
    ).toEqual([]);
    expect(chiamate.every((u) => u.includes(`userId=${DOCENTE}`))).toBe(true);
  });

  it('senza ?data= gli href sono identici a prima: nessun `data=` spurio', async () => {
    stub.search = `userId=${DOCENTE}`;
    await monta();

    expect(hrefLinguetta('Registro')).toBe(`${BASE}/registro?userId=${DOCENTE}`);
    const href = tuttiGliHref();
    expect(href.length).toBe(LINGUETTE.length + 1); // dieci linguette + la freccia
    expect(href.some((h) => h.includes('data='))).toBe(false);
    expect(href.some((h) => h.includes('undefined') || h.includes('null'))).toBe(false);
  });

  it.each([
    ['2026-02-30', 'giorno che nel calendario non esiste'],
    ['2026-13-01', 'mese inesistente'],
    ['2026-9-10', 'forma non ISO (mese a una cifra)'],
    ['10/09/2026', 'formato italiano invece che ISO'],
    ['oggi', 'testo libero'],
    ['', 'parametro vuoto'],
  ])('con ?data=%s (%s) la data non si propaga', async (valore) => {
    stub.search = `userId=${DOCENTE}&data=${encodeURIComponent(valore)}`;
    await monta();

    expect(hrefLinguetta('Registro')).toBe(`${BASE}/registro?userId=${DOCENTE}`);
    expect(tuttiGliHref().some((h) => h.includes('data='))).toBe(false);
  });

  it("con identità non ancora risolta nessun href contiene `userId=null`, e il giorno c'è lo stesso", () => {
    // Il PRIMO passaggio (render server): `localStorage` non esiste, quindi
    // l'identità locale non è ancora risolta. Il giorno invece l'URL ce l'ha già,
    // e il server lo vede: deve uscire nell'HTML senza trascinarsi un `userId`
    // inventato.
    stub.search = `data=${GIORNO}`;
    window.localStorage.clear();

    const html = renderToString(shell());

    expect(html.includes('userId=null'), 'La stringa «null» viaggia poi come identità nelle /api/*.').toBe(false);
    expect(html.includes('userId=')).toBe(false);
    expect(html).toContain(`${BASE}/registro?data=${GIORNO}`);
  });

  it('senza identità e senza data gli href restano nudi', async () => {
    stub.search = '';
    window.localStorage.clear();
    await monta();

    expect(hrefLinguetta('Registro')).toBe(`${BASE}/registro`);
    expect(tuttiGliHref().every((h) => !h.includes('?'))).toBe(true);
  });
});
