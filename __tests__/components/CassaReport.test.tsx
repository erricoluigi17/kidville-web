/**
 * P4a — `CassaReport` con una sede e con più sedi (contratti K3 §4 e K2 §1).
 *
 * - Con una sede: ogni GET porta `scuola_id`, e il report resta quello di prima.
 * - Con più sedi (`scuolaId` null): nessuna GET porta `scuola_id` (il server legge le
 *   sedi attive), in cima gli aggregati di tutte le sedi e sotto il dettaglio per sede.
 * - Le categorie di pagamento senza `scuola_id` arrivano da TUTTE le sedi (K2): due
 *   «Gita» omonime di sedi diverse sono due voci distinte, col nome della sede.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const log = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock('@/lib/logging/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/client')>()),
  logClient: log.client,
}));

import { CassaReport } from '@/components/features/admin/pagamenti/CassaReport';

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const SEDI = [{ id: 'sc-a', nome: 'Alfa' }, { id: 'sc-b', nome: 'Beta' }];

const entrata = (id: string, nome: string, totale: number) => ({ categoria_id: id, categoria_nome: nome, totale, per_metodo: { contanti: totale } });
const uscita = (id: string, nome: string, totale: number) => ({ categoria_id: id, categoria_nome: nome, totale, contanti: totale });

const REPORT_DUE = {
  disponibile: true,
  entrate_per_categoria: [entrata('g1', 'Retta', 300)],
  uscite_per_categoria: [uscita('u1', 'Pulizie', 42)],
  mensile: [{ mese: '2026-09', entrate: 300, uscite: 42 }],
  per_sede: [
    { scuola_id: 'sc-a', scuola_nome: 'Kidville Alfa', entrate_per_categoria: [entrata('g1', 'Retta', 200)], uscite_per_categoria: [uscita('u1', 'Pulizie', 30)], mensile: [{ mese: '2026-09', entrate: 200, uscite: 30 }] },
    // `scuola_nome: null` (nomi non letti dal server): si ripiega sul nome del selettore.
    { scuola_id: 'sc-b', scuola_nome: null, entrate_per_categoria: [entrata('g1', 'Retta', 100)], uscite_per_categoria: [uscita('u1', 'Pulizie', 12)], mensile: [{ mese: '2026-09', entrate: 100, uscite: 12 }] },
  ],
};
const REPORT_UNA = {
  disponibile: true,
  entrate_per_categoria: [entrata('g1', 'Retta', 200)],
  uscite_per_categoria: [uscita('u1', 'Pulizie', 30)],
  mensile: [],
  per_sede: [REPORT_DUE.per_sede[0]],
};

const CATEGORIE_DUE = [
  { id: 'g1', nome: 'Retta', slug: 'retta', scuola_id: null },
  { id: 'ga', nome: 'Gita', slug: 'gita', scuola_id: 'sc-a' },
  { id: 'gb', nome: 'Gita', slug: 'gita', scuola_id: 'sc-b' },
];

function installFetch(o: { report?: unknown; reportStato?: number; categorie?: unknown[]; categorieStato?: number; categorieRete?: true } = {}) {
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/cassa/report')) {
      if (o.reportStato) return jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, o.reportStato);
      return jsonRes(o.report ?? REPORT_DUE);
    }
    if (u.includes('/admin/settings/categorie')) {
      if (o.categorieRete) throw new TypeError('Failed to fetch');
      if (o.categorieStato) return jsonRes({ error: 'x' }, o.categorieStato);
      return jsonRes({ success: true, data: o.categorie ?? [] });
    }
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const urls = (fn: ReturnType<typeof installFetch>) => fn.mock.calls.map(([u]) => String(u));

beforeEach(() => log.client.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('CassaReport — una sede', () => {
  it('report, categorie e CSV portano scuola_id; nessun dettaglio per sede', async () => {
    const fn = installFetch({ report: REPORT_UNA, categorie: [CATEGORIE_DUE[0], CATEGORIE_DUE[1]] });
    render(<CassaReport userId="u1" scuolaId="sc-a" sedi={[SEDI[0]]} />);
    await screen.findByText('Pulizie');
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/admin/settings/categorie'))).toBe(true));
    for (const u of urls(fn)) expect(u).toContain('scuola_id=sc-a');
    expect(screen.getByRole('link', { name: /Scarica CSV/ }).getAttribute('href')).toContain('scuola_id=sc-a');
    expect(screen.queryByTestId('cassa-report-per-sede')).toBeNull();
    // con una sede il nome della categoria resta quello di prima, senza suffisso
    await screen.findByRole('option', { name: 'Gita' });
  });

  it('una sede: due categorie con lo STESSO slug (globale e della sede) restano una voce sola', async () => {
    const globale = { id: 'gg', nome: 'Gita', slug: 'gita', scuola_id: null };
    installFetch({ report: REPORT_UNA, categorie: [globale, CATEGORIE_DUE[1]] });
    render(<CassaReport userId="u1" scuolaId="sc-a" sedi={[SEDI[0]]} />);
    await screen.findByRole('option', { name: 'Gita' });
    const select = screen.getByLabelText('Categoria di pagamento') as HTMLSelectElement;
    const gite = Array.from(select.options).filter((o) => o.textContent === 'Gita');
    expect(gite).toHaveLength(1);
    // ultima arrivata vince, come prima del multi-sede
    expect(gite[0].value).toBe('ga');
  });
});

describe('CassaReport — più sedi (scuolaId null)', () => {
  it('nessuna GET porta scuola_id, nemmeno il CSV', async () => {
    const fn = installFetch({ categorie: CATEGORIE_DUE });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    await screen.findByTestId('cassa-report-per-sede');
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/admin/settings/categorie'))).toBe(true));
    for (const u of urls(fn)) expect(u).not.toContain('scuola_id');
    expect(screen.getByRole('link', { name: /Scarica CSV/ }).getAttribute('href')).not.toContain('scuola_id');
  });

  it('in cima gli aggregati di tutte le sedi, sotto il conto di ciascuna', async () => {
    installFetch({ categorie: CATEGORIE_DUE });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    const perSede = await screen.findByTestId('cassa-report-per-sede');
    // aggregato: 300 di entrate, 42 di uscite (la prima tabella entrate, fuori dal dettaglio)
    const tabelle = Array.from(document.querySelectorAll('table')).filter((t) => !perSede.contains(t));
    expect(tabelle[0].textContent).toContain('€ 300,00');
    expect(tabelle[1].textContent).toContain('€ 42,00');

    const alfa = screen.getByTestId('cassa-report-sede-sc-a');
    expect(alfa.textContent).toContain('Kidville Alfa');
    expect(alfa.textContent).toContain('€ 200,00');
    expect(alfa.textContent).toContain('€ 30,00');
    const beta = screen.getByTestId('cassa-report-sede-sc-b');
    expect(beta.textContent).toContain('Beta');
    expect(beta.textContent).toContain('€ 100,00');
    expect(beta.textContent).toContain('€ 12,00');
    expect(beta.textContent).not.toContain('€ 200,00');
    // il dettaglio per categoria di ciascuna sede
    expect(within(perSede).getByText('Dettaglio di Kidville Alfa')).toBeTruthy();
    expect(within(perSede).getByText('Dettaglio di Beta')).toBeTruthy();
  });

  it('due categorie omonime di sedi diverse sono due voci distinte, col nome della sede; il filtro usa l’id giusto', async () => {
    const fn = installFetch({ categorie: CATEGORIE_DUE });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    await screen.findByRole('option', { name: 'Gita — Beta' });
    expect(screen.getByRole('option', { name: 'Gita — Alfa' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Retta' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Categoria di pagamento'), { target: { value: 'gb' } });
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/cassa/report') && u.includes('categoria_pagamento_id=gb'))).toBe(true));
  });

  it('report rifiutato (403): errore e log con lo stato, mai «nessuna entrata»', async () => {
    installFetch({ reportStato: 403 });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    expect(await screen.findByText('Impossibile caricare il report. Riprova.')).toBeTruthy();
    expect(screen.queryByText(/Nessuna entrata/)).toBeNull();
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-report-lettura-rifiutata', stato: 403 }));
  });

  /**
   * «Categorie non lette» ≠ «nessuna categoria»: con il solo «Tutte» nel filtro e
   * nessun avviso l'operatore crederebbe che non ci sia niente da filtrare.
   */
  function attendiAvvisoCategorie() {
    return screen.findByText('Impossibile leggere le categorie di pagamento: il filtro mostra solo «Tutte». Riprova più tardi.');
  }

  it('categorie rifiutate (500): log con lo stato, e un avviso collegato al filtro', async () => {
    installFetch({ categorieStato: 500 });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    await waitFor(() => expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-report-categorie-lettura-rifiutata', stato: 500 })));
    const avviso = await attendiAvvisoCategorie();
    expect(avviso.getAttribute('role')).toBe('alert');
    const select = screen.getByLabelText('Categoria di pagamento') as HTMLSelectElement;
    expect(select.getAttribute('aria-describedby')).toBe(avviso.id);
    expect(avviso.id).not.toBe('');
  });

  it('categorie che non arrivano (errore di RETE): log con stato 0 e lo stesso avviso', async () => {
    installFetch({ categorieRete: true });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    const avviso = await attendiAvvisoCategorie();
    expect(avviso.getAttribute('role')).toBe('alert');
    expect((screen.getByLabelText('Categoria di pagamento') as HTMLSelectElement).getAttribute('aria-describedby')).toBe(avviso.id);
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-report-categorie-caricamento-fallito: TypeError', stato: 0 }));
    // il report è arrivato: l'avviso riguarda solo il filtro, non il report
    expect(await screen.findByTestId('cassa-report-per-sede')).toBeTruthy();
    expect(screen.queryByText('Impossibile caricare il report. Riprova.')).toBeNull();
  });

  it('categorie lette: nessun avviso e il filtro non è collegato a niente', async () => {
    installFetch({ categorie: CATEGORIE_DUE });
    render(<CassaReport userId="u1" scuolaId={null} sedi={SEDI} />);
    await screen.findByRole('option', { name: 'Gita — Beta' });
    expect(screen.queryByText(/Impossibile leggere le categorie di pagamento/)).toBeNull();
    expect((screen.getByLabelText('Categoria di pagamento') as HTMLSelectElement).hasAttribute('aria-describedby')).toBe(false);
  });
});
