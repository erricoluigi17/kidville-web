/**
 * P4a — `CassaPanel` con una sede e con più sedi (contratto K3 + P4b).
 *
 * La LETTURA della cassa unisce le sedi, ma ogni sede resta un cassetto a sé: il
 * saldo e l'ultimo svuotamento si mostrano PER SEDE più il totale, i movimenti e lo
 * storico portano la sede, e le finestre di scrittura ricevono le sedi effettive.
 *
 * I finti rispondono DIVERSAMENTE per sede (saldo, fondo, uscite del mese,
 * svuotamenti), così un dato attribuito alla sede sbagliata si vede nel numero a
 * schermo. E «Uscite del mese» ha nel payload due valori volutamente diversi: le
 * uscite di sempre (`totali`, 1.000 €) e quelle del mese (`uscite_mese`, 42 €).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ ruolo: 'admin' as string }));
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: state.ruolo, withUser: (h: string) => h }),
}));

type CtxSedi = { sedi: { id: string; nome: string }[]; effettive: string[]; sedeCorrente: string | null };
const UNA_SEDE: CtxSedi = { sedi: [{ id: 'sc-a', nome: 'Alfa' }], effettive: ['sc-a'], sedeCorrente: 'sc-a' };
// «Esterna» è accessibile ma NON selezionata: non deve finire nelle finestre.
const DUE_SEDI: CtxSedi = {
  sedi: [{ id: 'sc-a', nome: 'Alfa' }, { id: 'sc-b', nome: 'Beta' }, { id: 'sc-x', nome: 'Esterna' }],
  effettive: ['sc-a', 'sc-b'],
  sedeCorrente: null,
};
const sediCtx = vi.hoisted(() => ({ valore: null as unknown }));
vi.mock('@/lib/context/sede-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/context/sede-context')>()),
  useSediAttive: () => sediCtx.valore,
}));

const log = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock('@/lib/logging/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/client')>()),
  logClient: log.client,
}));

import { CassaPanel } from '@/components/features/admin/pagamenti/CassaPanel';

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const RIGA_A = {
  id: 'm-a', scuola_id: 'sc-a', scuola_nome: 'Kidville Alfa', tipo: 'uscita', importo: 20, metodo: 'contanti',
  data: '2026-09-10', categoria_id: 'c1', descrizione: 'Detersivi Alfa', note: null, allegato_path: null,
  incasso_id: null, chiusura_id: null, registrato_da: 'u1', creato_il: '2026-09-10T10:00:00Z',
  storno_di: null, stornato_il: null, storno_motivo: null, origine: 'cassa', categoria_nome: 'Pulizie',
};
// `scuola_nome: null` (lettura dei nomi fallita sul server): si ripiega sul nome del selettore.
const RIGA_B = {
  ...RIGA_A, id: 'm-b', scuola_id: 'sc-b', scuola_nome: null, tipo: 'entrata', importo: 35,
  descrizione: 'Quota Beta', categoria_id: null, categoria_nome: null,
};

// Le uscite di SEMPRE sommano 1.000 €; quelle del mese 42 €.
const TOTALI = { entrate: 500, uscite_contanti: 900, uscite_altre: 100, prelievi: 0, rettifiche: 0 };
const USCITE_MESE_UNA = { da: '2026-09-01', a: '2026-09-30', totale: 42, per_sede: [{ scuola_id: 'sc-a', scuola_nome: 'Kidville Alfa', totale: 42 }] };
const USCITE_MESE_DUE = {
  da: '2026-09-01', a: '2026-09-30', totale: 42,
  per_sede: [
    { scuola_id: 'sc-a', scuola_nome: 'Kidville Alfa', totale: 30 },
    { scuola_id: 'sc-b', scuola_nome: 'Kidville Beta', totale: 12 },
  ],
};

const saldoSede = (id: string, nome: string, fondo: number, saldo: number) => ({
  scuola_id: id, scuola_nome: nome, disponibile: true, fondo, saldo_atteso: saldo,
  entrate_contanti: 0, uscite_contanti: 0, prelievi: 0, rettifiche: 0, entrato_oggi: [],
});
const SALDO_UNA = { ...saldoSede('sc-a', 'Kidville Alfa', 100, 130), per_sede: [saldoSede('sc-a', 'Kidville Alfa', 100, 130)] };
const SALDO_DUE = {
  disponibile: true, fondo: 150, saldo_atteso: 200, entrate_contanti: 0, uscite_contanti: 0, prelievi: 0, rettifiche: 0,
  entrato_oggi: [{ metodo: 'contanti', totale: 15 }],
  per_sede: [saldoSede('sc-a', 'Kidville Alfa', 100, 130), saldoSede('sc-b', 'Kidville Beta', 50, 70)],
};

const chiusura = (id: string, sede: string, nome: string, il: string, prelevato: number) => ({
  id, scuola_id: sede, scuola_nome: nome, eseguita_il: il, saldo_atteso: prelevato + 10, contato: prelevato + 10,
  differenza: 0, prelevato, fondo_lasciato: 10, note: null, eseguita_da: 'u1',
});
// Ordine del server: `eseguita_il` DECRESCENTE su tutte le sedi, quindi le sedi si mescolano.
const CHIUSURE_MISTE = [
  chiusura('ch-b1', 'sc-b', 'Kidville Beta', '2026-08-25T17:00:00Z', 55),
  chiusura('ch-a2', 'sc-a', 'Kidville Alfa', '2026-08-20T17:00:00Z', 340),
  chiusura('ch-a1', 'sc-a', 'Kidville Alfa', '2026-08-01T17:00:00Z', 111),
];

interface Opts {
  movimenti?: unknown[];
  totali?: unknown;
  usciteMese?: unknown; // `undefined` = chiave assente
  saldo?: unknown;
  chiusure?: unknown[];
  stati?: Partial<Record<'movimenti' | 'saldo' | 'chiusura', number>>;
  /** GET che non arrivano al server: la fetch RIFIUTA con `TypeError: Failed to fetch`. */
  rete?: Partial<Record<'saldo' | 'chiusura', true>>;
}

function installFetch(o: Opts = {}) {
  const stati = o.stati ?? {};
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/cassa/movimenti')) {
      if (stati.movimenti) return jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, stati.movimenti);
      const body: Record<string, unknown> = { disponibile: true, movimenti: o.movimenti ?? [] };
      if (o.totali) body.totali = o.totali;
      if (o.usciteMese !== undefined) body.uscite_mese = o.usciteMese;
      return jsonRes(body);
    }
    if (u.includes('/cassa/saldo')) {
      if (o.rete?.saldo) throw new TypeError('Failed to fetch');
      if (stati.saldo) return jsonRes({ error: 'x' }, stati.saldo);
      return jsonRes(o.saldo ?? { disponibile: false, per_sede: [] });
    }
    if (u.includes('/cassa/chiusura')) {
      if (o.rete?.chiusura) throw new TypeError('Failed to fetch');
      if (stati.chiusura) return jsonRes({ error: 'x' }, stati.chiusura);
      return jsonRes({ disponibile: true, chiusure: o.chiusure ?? [] });
    }
    if (u.includes('/cassa/report')) return jsonRes({ disponibile: true, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [], per_sede: [] });
    if (u.includes('/cassa/categorie')) return jsonRes({ disponibile: true, categorie: [] });
    if (u.includes('/admin/settings/categorie')) return jsonRes({ success: true, data: [] });
    if (u.includes('/admin/settings')) return jsonRes({ success: true, data: { cassa_config: {} } });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const urls = (fn: ReturnType<typeof installFetch>) => fn.mock.calls.map(([u]) => String(u));

/** Il riquadro KPI con quell'etichetta esatta (la StatCard intera). */
function statCard(container: HTMLElement, etichetta: string): HTMLElement {
  const lab = Array.from(container.querySelectorAll('div.mt-1')).find((d) => d.textContent === etichetta);
  if (!lab) throw new Error(`StatCard «${etichetta}» assente`);
  return lab.closest('.rounded-card') as HTMLElement;
}

/** La riga della tabella «Cassa per sede» di quella sede (o del totale). */
function rigaPerSede(chiave: string): HTMLElement {
  return screen.getByTestId(`cassa-per-sede-${chiave}`);
}

beforeEach(() => { sediCtx.valore = DUE_SEDI; log.client.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); state.ruolo = 'admin'; });

// ─────────────────────────────────────────────────────────────────────────────
describe('CassaPanel — una sede', () => {
  beforeEach(() => { sediCtx.valore = UNA_SEDE; });

  it('ogni GET porta scuola_id della pagina; niente colonna Sede né tabella per sede', async () => {
    const fn = installFetch({ movimenti: [RIGA_A], totali: TOTALI, usciteMese: USCITE_MESE_UNA, saldo: SALDO_UNA, chiusure: [] });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    await screen.findByText(/Mai svuotata:/);
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/admin/settings/categorie'))).toBe(true));
    for (const rotta of ['/cassa/movimenti', '/cassa/saldo', '/cassa/chiusura', '/cassa/report', '/admin/settings/categorie']) {
      const chiamate = urls(fn).filter((u) => u.includes(rotta));
      expect(chiamate.length, rotta).toBeGreaterThan(0);
      for (const u of chiamate) expect(u, rotta).toContain('scuola_id=sc-a');
    }
    expect(Array.from(container.querySelectorAll('th')).some((th) => th.textContent === 'Sede')).toBe(false);
    expect(screen.queryByTestId('cassa-per-sede')).toBeNull();
    expect(screen.getByTestId('cassa-ultimo-svuotamento')).toBeTruthy();
  });

  it('«Uscite del mese» è uscite_mese.totale, non le uscite di sempre (il difetto corretto)', async () => {
    installFetch({ movimenti: [RIGA_A], totali: TOTALI, usciteMese: USCITE_MESE_UNA, saldo: SALDO_UNA });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    await screen.findByText(/Saldo atteso in cassa/);
    const card = statCard(container, 'Uscite del mese');
    expect(card.textContent).toContain('€ 42,00');
    expect(card.textContent).not.toContain('1.000,00');
  });

  it('uscite_mese null (lettura fallita sul server) → «—», mai la somma delle uscite di sempre', async () => {
    installFetch({ movimenti: [RIGA_A], totali: TOTALI, usciteMese: null, saldo: SALDO_UNA });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    await screen.findByText(/Saldo atteso in cassa/);
    const card = statCard(container, 'Uscite del mese');
    expect(card.textContent).toContain('—');
    expect(card.textContent).toContain('non lette: riprova più tardi');
    expect(card.textContent).not.toMatch(/1\.000,00|€ 0,00/);
  });

  it('la finestra dell’uscita riceve la sede della pagina: nessun selettore, categorie di quella sede', async () => {
    const fn = installFetch({ movimenti: [RIGA_A] });
    render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    await screen.findAllByText('Detersivi Alfa');
    fireEvent.click(screen.getByRole('button', { name: /Registra uscita/i }));
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/cassa/categorie') && u.includes('scuola_id=sc-a'))).toBe(true));
    expect(screen.queryByRole('combobox', { name: 'Sede' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CassaPanel — più sedi (scuolaId null)', () => {
  it('nessuna GET porta scuola_id: il server legge tutte le sedi attive', async () => {
    const fn = installFetch({ movimenti: [RIGA_A, RIGA_B], totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, chiusure: CHIUSURE_MISTE });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/admin/settings/categorie'))).toBe(true));
    for (const rotta of ['/cassa/movimenti', '/cassa/saldo', '/cassa/chiusura', '/cassa/report', '/admin/settings/categorie']) {
      const chiamate = urls(fn).filter((u) => u.includes(rotta));
      expect(chiamate.length, rotta).toBeGreaterThan(0);
      for (const u of chiamate) expect(u, rotta).not.toContain('scuola_id');
    }
  });

  it('saldo e fondo PER SEDE più il totale: ogni sede col suo cassetto', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, chiusure: [] });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    const kpi = statCard(container, 'Saldo atteso in cassa');
    expect(kpi.textContent).toContain('€ 200,00');
    expect(kpi.textContent).toContain('totale delle sedi');

    const alfa = rigaPerSede('sc-a');
    expect(alfa.textContent).toContain('Kidville Alfa');
    expect(alfa.textContent).toContain('€ 130,00');
    expect(alfa.textContent).toContain('€ 100,00');
    const beta = rigaPerSede('sc-b');
    expect(beta.textContent).toContain('Kidville Beta');
    expect(beta.textContent).toContain('€ 70,00');
    expect(beta.textContent).toContain('€ 50,00');
    expect(beta.textContent).not.toContain('€ 130,00');
    const tot = rigaPerSede('totale');
    expect(tot.textContent).toContain('€ 200,00');
    expect(tot.textContent).toContain('€ 150,00');
    // con le somme disponibili «Entrato oggi» è la somma, non il «—» dei casi degradati
    const oggi = statCard(container, 'Entrato oggi');
    expect(oggi.textContent).toContain('€ 15,00');
    expect(oggi.textContent).not.toContain('—');
  });

  it('ultimo svuotamento PER SEDE: la prima chiusura di ciascuna, non l’ultima di tutte', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, chiusure: CHIUSURE_MISTE });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    const alfa = rigaPerSede('sc-a');
    expect(alfa.textContent).toContain('20/08/2026');
    expect(alfa.textContent).toContain('€ 340,00');
    expect(alfa.textContent).not.toContain('25/08/2026');
    expect(alfa.textContent).not.toContain('01/08/2026');
    const beta = rigaPerSede('sc-b');
    expect(beta.textContent).toContain('25/08/2026');
    expect(beta.textContent).toContain('€ 55,00');
    // la riga unica «Ultimo svuotamento» direbbe «la cassa» svuotata il 25/08: con più
    // cassetti non esiste, c'è la tabella per sede
    expect(screen.queryByTestId('cassa-ultimo-svuotamento')).toBeNull();
  });

  it('una sede mai svuotata lo dice, anche se un’altra sede è stata svuotata', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, chiusure: [CHIUSURE_MISTE[1]] });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    expect(rigaPerSede('sc-a').textContent).toContain('20/08/2026');
    const beta = rigaPerSede('sc-b');
    expect(beta.textContent).toContain('Mai svuotata');
    expect(beta.textContent).not.toContain('20/08/2026');
  });

  it('uscite del mese per sede, e il totale nel riquadro', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    expect(statCard(container, 'Uscite del mese').textContent).toContain('€ 42,00');
    expect(rigaPerSede('sc-a').textContent).toContain('€ 30,00');
    expect(rigaPerSede('sc-b').textContent).toContain('€ 12,00');
    expect(rigaPerSede('totale').textContent).toContain('€ 42,00');
  });

  it('un saldo NON disponibile in una sede: niente somma, e il dettaglio dice quale', async () => {
    const saldo = { disponibile: false, per_sede: [saldoSede('sc-a', 'Kidville Alfa', 100, 130), { scuola_id: 'sc-b', scuola_nome: 'Kidville Beta', disponibile: false }] };
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    const kpi = statCard(container, 'Saldo atteso in cassa');
    expect(kpi.textContent).toContain('—');
    expect(kpi.textContent).not.toContain('130,00');
    expect(rigaPerSede('sc-a').textContent).toContain('€ 130,00');
    expect(rigaPerSede('sc-b').textContent).toContain('non disponibile');
    expect(rigaPerSede('totale').textContent).not.toContain('130,00');
    // «Entrato oggi» senza somme non è «€ 0,00 · nessun incasso oggi»: non si sa
    const oggi = statCard(container, 'Entrato oggi');
    expect(oggi.textContent).toContain('—');
    expect(oggi.textContent).toContain('non disponibile');
    expect(oggi.textContent).not.toContain('€ 0,00');
    expect(oggi.textContent).not.toContain('nessun incasso oggi');
  });

  it('colonna Sede nella tabella dei movimenti e sede nelle card mobili (ripiego sul nome del selettore)', async () => {
    installFetch({ movimenti: [RIGA_A, RIGA_B] });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findAllByText('Detersivi Alfa');
    const tabella = container.querySelector('[data-testid="cassa-movimenti-tabella"]') as HTMLElement;
    const intestazioni = Array.from(tabella.querySelectorAll('thead th')).map((th) => th.textContent);
    const colSede = intestazioni.indexOf('Sede');
    expect(colSede).toBeGreaterThanOrEqual(0);
    // Si legge la CELLA della colonna Sede, non la riga: «Quota Beta» contiene già «Beta».
    const cellaSede = (descrizione: string) => {
      const riga = Array.from(tabella.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes(descrizione));
      return riga?.querySelectorAll('td')[colSede]?.textContent;
    };
    expect(cellaSede('Detersivi Alfa')).toBe('Kidville Alfa');
    // `scuola_nome: null` → il nome del selettore, mai l'uuid né una cella vuota
    expect(cellaSede('Quota Beta')).toBe('Beta');

    const cards = screen.getAllByTestId('cassa-movimento-card');
    expect(cards.find((c) => c.textContent?.includes('Detersivi Alfa'))?.textContent).toContain('Kidville Alfa');
    const cardB = cards.find((c) => c.textContent?.includes('Quota Beta'));
    expect(within(cardB as HTMLElement).getByText(/Beta ·|· Beta|^Beta$/)).toBeTruthy();
  });

  it('storico svuotamenti con colonna Sede, raggruppato per sede', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, chiusure: CHIUSURE_MISTE });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    const storico = container.querySelector('#cassa-storico') as HTMLElement;
    expect(Array.from(storico.querySelectorAll('th')).map((th) => th.textContent)).toContain('Sede');
    const righe = Array.from(storico.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent);
    // dal server: Beta, Alfa, Alfa (per data) → raggruppate: Alfa, Alfa, Beta (ordine delle sedi)
    expect(righe).toEqual(['Kidville Alfa', 'Kidville Alfa', 'Kidville Beta']);
    const date = Array.from(storico.querySelectorAll('tbody tr')).map((r) => r.querySelectorAll('td')[1]?.textContent);
    expect(date).toEqual(['20/08/2026', '01/08/2026', '25/08/2026']);
  });

  it('le finestre di scrittura ricevono le sedi EFFETTIVE e nessuna sede preselezionata', async () => {
    const fn = installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    fireEvent.click(screen.getByRole('button', { name: /Registra uscita/i }));
    const dialogo = await screen.findByRole('dialog');
    const sede = within(dialogo).getByRole('combobox', { name: 'Sede' }) as HTMLSelectElement;
    expect(sede.value).toBe('');
    const opzioni = Array.from(sede.options).filter((o) => o.value).map((o) => o.textContent);
    expect(opzioni).toEqual(['Alfa', 'Beta']);
    // prima della scelta nessuna lettura delle categorie di cassa (di QUALE sede?)
    expect(urls(fn).some((u) => u.includes('/cassa/categorie?') && u.includes('scuola_id='))).toBe(false);
  });

  it('Categorie e Impostazioni con più sedi: selettore vuoto con le sedi EFFETTIVE, nessuna lettura prima della scelta', async () => {
    const fn = installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    // il report monta nello stesso commit delle due sezioni: quando la sua GET è partita,
    // anche gli effetti di Categorie e Impostazioni sono già stati eseguiti
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/admin/settings/categorie'))).toBe(true));
    for (const id of ['cassa-cat-sede', 'cassa-cfg-sede']) {
      const sede = container.querySelector(`#${id}`) as HTMLSelectElement | null;
      expect(sede, id).not.toBeNull();
      expect(screen.getAllByRole('combobox', { name: 'Sede' })).toContain(sede);
      expect(sede!.value, id).toBe('');
      expect(Array.from(sede!.options).filter((o) => o.value).map((o) => o.textContent), id).toEqual(['Alfa', 'Beta']);
    }
    // nessuna preselezione «a caso»: né le categorie di cassa né le impostazioni di una sede
    expect(urls(fn).filter((u) => u.includes('/cassa/categorie'))).toEqual([]);
    expect(urls(fn).filter((u) => u.includes('/api/admin/settings?'))).toEqual([]);
    expect(screen.getByText('Scegli la sede di cui vedere e modificare le categorie di uscita.')).toBeTruthy();
    expect(screen.getByText('Scegli la sede: fondo cassa e soglia d’avviso sono di ogni sede.')).toBeTruthy();
  });

  it('Categorie e Impostazioni con UNA sede: nessun selettore, e le due letture portano la sede della pagina', async () => {
    sediCtx.valore = UNA_SEDE;
    const fn = installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_UNA, saldo: SALDO_UNA });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    await screen.findByTestId('cassa-ultimo-svuotamento');
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/cassa/categorie'))).toBe(true));
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/api/admin/settings?'))).toBe(true));
    for (const rotta of ['/cassa/categorie', '/api/admin/settings?']) {
      for (const u of urls(fn).filter((x) => x.includes(rotta))) expect(u, rotta).toContain('scuola_id=sc-a');
    }
    expect(container.querySelector('#cassa-cat-sede')).toBeNull();
    expect(container.querySelector('#cassa-cfg-sede')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Sede' })).toBeNull();
  });

  it('svuota cassa con più sedi: il selettore c’è, e nessun saldo prima della scelta', async () => {
    const fn = installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByTestId('cassa-per-sede');
    const saldiPrima = urls(fn).filter((u) => u.includes('/cassa/saldo')).length;
    fireEvent.click(screen.getByRole('button', { name: /Svuota cassa/i }));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByRole('combobox', { name: 'Sede' })).toBeTruthy();
    expect(urls(fn).filter((u) => u.includes('/cassa/saldo')).length).toBe(saldiPrima);
  });

  it('svuotamenti non letti (500): non si dice «Mai svuotata», si dice che non si sa', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, stati: { chiusura: 500 } });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    expect((await screen.findAllByText(/Impossibile leggere gli svuotamenti/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Mai svuotata/)).toBeNull();
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-chiusure-lettura-rifiutata', stato: 500 }));
  });

  it('svuotamenti non letti con UNA sede: la riga di stato non dice «Mai svuotata»', async () => {
    sediCtx.valore = UNA_SEDE;
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_UNA, saldo: SALDO_UNA, stati: { chiusura: 403 } });
    render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    const riga = await screen.findByTestId('cassa-ultimo-svuotamento');
    await waitFor(() => expect(riga.textContent).toContain('Impossibile leggere gli svuotamenti'));
    expect(riga.textContent).not.toContain('Mai svuotata');
  });

  it('movimenti rifiutati (403): errore e log con lo stato, mai «nessun movimento»', async () => {
    installFetch({ stati: { movimenti: 403 } });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    expect(await screen.findByText('Impossibile caricare i movimenti di cassa.')).toBeTruthy();
    expect(screen.queryByText(/Nessun movimento/i)).toBeNull();
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-movimenti-lettura-rifiutata', stato: 403 }));
  });

  it('saldo rifiutato (403): KPI «—» e log con lo stato', async () => {
    installFetch({ totali: TOTALI, usciteMese: USCITE_MESE_DUE, stati: { saldo: 403 } });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    await screen.findByText(/Saldo atteso in cassa/);
    await waitFor(() => expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-saldo-lettura-rifiutata', stato: 403 })));
    // la pagina dice PERCHÉ c'è il «—»: il saldo non è stato letto, non è un dato mancante
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Impossibile leggere il saldo di cassa');
    const kpi = statCard(container, 'Saldo atteso in cassa');
    expect(kpi.textContent).toContain('—');
    expect(kpi.textContent).toContain('Impossibile leggere il saldo di cassa');
    const oggi = statCard(container, 'Entrato oggi');
    expect(oggi.textContent).toContain('—');
    expect(oggi.textContent).toContain('Impossibile leggere il saldo di cassa');
    expect(oggi.textContent).not.toContain('€ 0,00');
    expect(oggi.textContent).not.toContain('nessun incasso oggi');
  });

  it('saldo che non arriva (errore di RETE): «—» spiegato, log del saldo, movimenti in pagina senza l’avviso dei movimenti', async () => {
    installFetch({ movimenti: [RIGA_A, RIGA_B], totali: TOTALI, usciteMese: USCITE_MESE_DUE, chiusure: CHIUSURE_MISTE, rete: { saldo: true } });
    const { container } = render(<CassaPanel userId="u1" scuolaId={null} />);
    expect((await screen.findAllByText(/Impossibile leggere il saldo di cassa/)).length).toBeGreaterThan(0);
    const oggi = statCard(container, 'Entrato oggi');
    expect(oggi.textContent).toContain('—');
    expect(oggi.textContent).not.toMatch(/€ 0,00|nessun incasso oggi/);
    expect(statCard(container, 'Saldo atteso in cassa').textContent).toContain('—');
    expect(rigaPerSede('sc-a').textContent).not.toContain('€ 130,00');
    // gli svuotamenti sono arrivati: restano quelli veri
    expect(rigaPerSede('sc-a').textContent).toContain('20/08/2026');
    expect(screen.getAllByText('Detersivi Alfa').length).toBeGreaterThan(0);
    expect(screen.queryByText('Impossibile caricare i movimenti di cassa.')).toBeNull();
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-saldo-caricamento-fallito: TypeError', stato: 0 }));
    expect(log.client).not.toHaveBeenCalledWith(expect.objectContaining({ messaggio: expect.stringContaining('cassa-movimenti-caricamento-fallito') }));
  });

  it('svuotamenti che non arrivano (errore di RETE), più sedi: mai «Mai svuotata», i movimenti restano', async () => {
    installFetch({ movimenti: [RIGA_A, RIGA_B], totali: TOTALI, usciteMese: USCITE_MESE_DUE, saldo: SALDO_DUE, rete: { chiusura: true } });
    render(<CassaPanel userId="u1" scuolaId={null} />);
    expect((await screen.findAllByText(/Impossibile leggere gli svuotamenti/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Mai svuotata/)).toBeNull();
    expect(screen.queryByText(/compariranno gli svuotamenti/)).toBeNull();
    // il saldo è arrivato: resta quello vero
    expect(rigaPerSede('sc-a').textContent).toContain('€ 130,00');
    expect(screen.getAllByText('Detersivi Alfa').length).toBeGreaterThan(0);
    expect(screen.queryByText('Impossibile caricare i movimenti di cassa.')).toBeNull();
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-chiusure-caricamento-fallito: TypeError', stato: 0 }));
    expect(log.client).not.toHaveBeenCalledWith(expect.objectContaining({ messaggio: expect.stringContaining('cassa-movimenti-caricamento-fallito') }));
  });

  it('svuotamenti che non arrivano (errore di RETE), una sede: la riga di stato non dice «Mai svuotata»', async () => {
    sediCtx.valore = UNA_SEDE;
    installFetch({ movimenti: [RIGA_A], totali: TOTALI, usciteMese: USCITE_MESE_UNA, saldo: SALDO_UNA, rete: { chiusura: true } });
    render(<CassaPanel userId="u1" scuolaId="sc-a" />);
    const riga = await screen.findByTestId('cassa-ultimo-svuotamento');
    await waitFor(() => expect(riga.textContent).toContain('Impossibile leggere gli svuotamenti'));
    expect(screen.queryByText(/Mai svuotata/)).toBeNull();
    expect(screen.queryByText(/compariranno gli svuotamenti/)).toBeNull();
    expect(screen.getAllByText('Detersivi Alfa').length).toBeGreaterThan(0);
    expect(screen.queryByText('Impossibile caricare i movimenti di cassa.')).toBeNull();
    expect(log.client).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-chiusure-caricamento-fallito: TypeError', stato: 0 }));
  });
});
