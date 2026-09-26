import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

// ─── TransazioniPanel con più sedi (contratto K4, 2026-09-26) ─────────────────
// Una famiglia con figli in due plessi paga voci di entrambi: il server divide il
// pagamento in una transazione per sede. Il pannello deve:
//   · non mandare più `scuola_id` (la sede la decide il server);
//   · dire PRIMA di confermare che le transazioni saranno N, con il riepilogo per sede;
//   · con un'eccedenza a credito, chiedere OBBLIGATORIAMENTE la sede del credito;
//   · mostrare una ricevuta per ogni transazione creata;
//   · nel registro, le colonne Sede e Pagante.

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const SEDE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SEDE_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const sediMock = vi.hoisted(() => ({
  valore: {
    sedi: [] as { id: string; nome: string }[],
    effettive: [] as string[],
  },
}));

vi.mock('@/lib/context/sede-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/sede-context')>()),
  useSediAttive: () => sediMock.valore,
}));

// Il logger del client si spia (resto del modulo originale, `nomeErrore` compreso):
// i catch del pannello devono LASCIARE TRACCIA, non solo mostrare un messaggio.
vi.mock('@/lib/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/client')>()),
  logClient: vi.fn(),
}));

import { TransazioniPanel } from '@/components/features/admin/pagamenti/TransazioniPanel';
import { logClient } from '@/lib/logging/client';

// Nomi di sede fittizi ma con la forma vera («Kidville …»): nessun dato personale.
const NOME_A = 'Kidville Alfa';
const NOME_B = 'Kidville Beta';

const famigliaDueSedi = {
  parent: { id: 'genitore-1', nome: 'Mario Rossi' },
  figli: [
    { id: 'al-1', nome: 'Uno', cognome: 'Rossi', saldo_ticket: 0, scuola_id: SEDE_A, scuola_nome: NOME_A },
    { id: 'al-2', nome: 'Due', cognome: 'Rossi', saldo_ticket: 0, scuola_id: SEDE_B, scuola_nome: NOME_B },
  ],
  voci: [
    { id: 'v1', alunno_id: 'al-1', scuola_id: SEDE_A, scuola_nome: NOME_A, descrizione: 'Retta Uno', importo: 100, importo_pagato: 0, residuo: 100, scadenza: null, stato_effettivo: 'aperto' },
    { id: 'v2', alunno_id: 'al-2', scuola_id: SEDE_B, scuola_nome: NOME_B, descrizione: 'Retta Due', importo: 80, importo_pagato: 0, residuo: 80, scadenza: null, stato_effettivo: 'aperto' },
  ],
  credito: 0,
};

const famigliaUnaSede = {
  parent: { id: 'genitore-1', nome: 'Mario Rossi' },
  figli: [
    { id: 'al-1', nome: 'Uno', cognome: 'Rossi', saldo_ticket: 0, scuola_id: SEDE_A, scuola_nome: NOME_A },
  ],
  voci: [
    { id: 'v1', alunno_id: 'al-1', scuola_id: SEDE_A, scuola_nome: NOME_A, descrizione: 'Retta Uno', importo: 100, importo_pagato: 0, residuo: 100, scadenza: null, stato_effettivo: 'aperto' },
  ],
  credito: 0,
};

type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };
const risposta = (status: number, corpo: unknown): Risposta => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

interface Opzioni {
  famiglia: unknown;
  parents?: unknown[];
  registro?: unknown[];
  /** Risposte alle POST, in ordine. */
  post?: Risposta[];
  /** La GET della famiglia cade per un guasto di rete (fetch che rigetta). */
  famigliaRete?: boolean;
  /** La POST di annullo cade per un guasto di rete. */
  annulloRete?: boolean;
  /** La GET del registro cade per un guasto di rete. */
  registroRete?: boolean;
  /** La GET dell'elenco dei paganti cade per un guasto di rete. */
  parentsRete?: boolean;
  /** Risposta HTTP della GET del registro, al posto di quella riuscita (es. un 500 `{ error }`). */
  registroRisposta?: Risposta;
  /** Risposta HTTP della GET dei paganti, al posto dell'elenco (es. un 500 `{ error }`). */
  parentsRisposta?: Risposta;
  /** Risposta HTTP della GET della famiglia, al posto di quella riuscita (es. un 500 `{ error }`). */
  famigliaRisposta?: Risposta;
}

function stubFetch(o: Opzioni) {
  const post = [...(o.post ?? [])];
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/pagamenti/famiglia')) {
      if (o.famigliaRete) throw new TypeError('Failed to fetch');
      if (o.famigliaRisposta) return o.famigliaRisposta;
      return risposta(200, { success: true, data: o.famiglia });
    }
    if (u.includes('/annulla') && init?.method === 'POST' && o.annulloRete) throw new TypeError('Failed to fetch');
    if (u.includes('/api/admin/parents') && o.parentsRete) throw new TypeError('Failed to fetch');
    if (u.includes('/api/admin/parents') && o.parentsRisposta) return o.parentsRisposta;
    if (u.includes('/api/admin/parents')) return risposta(200, o.parents ?? [{ id: 'genitore-1', first_name: 'Mario', last_name: 'Rossi', scuole_ids: [SEDE_A] }]);
    if (u.includes('/api/pagamenti/transazioni') && init?.method === 'POST') {
      return post.shift() ?? risposta(500, { error: 'nessuna risposta preparata' });
    }
    if (u.includes('/api/pagamenti/transazioni') && o.registroRete) throw new TypeError('Failed to fetch');
    if (u.includes('/api/pagamenti/transazioni') && o.registroRisposta) return o.registroRisposta;
    if (u.includes('/api/pagamenti/transazioni')) return risposta(200, { success: true, data: o.registro ?? [], disponibile: true });
    return risposta(200, { success: true });
  });
}

type FetchMock = ReturnType<typeof stubFetch>;

const corpiPost = (fm: FetchMock) =>
  fm.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

/** Apre il pagante e arriva allo step «importi». */
async function apriFamiglia() {
  fireEvent.click(await screen.findByRole('button', { name: /Mario Rossi/ }));
  await screen.findByText(/Voci da saldare/);
}

function impostaTotale(v: string) {
  fireEvent.change(screen.getByLabelText('Totale versato (€)'), { target: { value: v } });
}

const bottoneRegistra = () => screen.getByRole('button', { name: 'Registra incasso' }) as HTMLButtonElement;

beforeEach(() => {
  sediMock.valore = {
    sedi: [{ id: SEDE_A, nome: NOME_A }, { id: SEDE_B, nome: NOME_B }],
    effettive: [SEDE_A, SEDE_B],
  };
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('TransazioniPanel — una sede (comportamento invariato)', () => {
  it('niente avviso di divisione, niente sede_eccedenza, POST SENZA scuola_id, una sola ricevuta', async () => {
    sediMock.valore = { sedi: [{ id: SEDE_A, nome: NOME_A }], effettive: [SEDE_A] };
    const fm = stubFetch({
      famiglia: famigliaUnaSede,
      post: [risposta(200, {
        success: true,
        data: {
          transazione_id: 'tx-1', incassi: 1,
          transazioni: [{ transazione_id: 'tx-1', scuola_id: SEDE_A, scuola_nome: NOME_A, importo_totale: 100 }],
        },
      })],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={SEDE_A} />);
    await apriFamiglia();
    impostaTotale('100');

    // Una sede sola: la famiglia non è multi-sede, quindi nessun nome di sede accanto
    // a figli e voci, e nessun avviso «verranno create N transazioni».
    expect(screen.queryByText(NOME_A)).toBeNull();
    expect(screen.queryByText(/una per sede/)).toBeNull();
    expect(screen.queryByLabelText('Sede a cui attribuire il credito')).toBeNull();

    fireEvent.click(bottoneRegistra());
    await screen.findByText(/^Transazione registrata/);
    // Una transazione sola: il messaggio del caso multiplo non deve comparire.
    expect(screen.queryByText(/transazioni registrate/)).toBeNull();

    const [corpo] = corpiPost(fm);
    expect(corpo).not.toHaveProperty('scuola_id');
    expect(corpo).not.toHaveProperty('sede_eccedenza');
    expect(corpo.voci).toEqual([{ pagamento_id: 'v1', importo: 100 }]);

    const link = screen.getByRole('link', { name: /Ricevuta famiglia/ });
    expect(link.getAttribute('href')).toContain('/api/pagamenti/transazioni/tx-1/ricevuta');
    expect(screen.getAllByRole('link', { name: /Ricevuta/ })).toHaveLength(1);
  });

  it('server vecchio senza `transazioni[]`: la ricevuta usa `transazione_id` (compatibilità)', async () => {
    sediMock.valore = { sedi: [{ id: SEDE_A, nome: NOME_A }], effettive: [SEDE_A] };
    const fm = stubFetch({
      famiglia: famigliaUnaSede,
      post: [risposta(200, { success: true, data: { transazione_id: 'tx-vecchia' } })],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={SEDE_A} />);
    await apriFamiglia();
    impostaTotale('100');
    fireEvent.click(bottoneRegistra());
    const link = await screen.findByRole('link', { name: /Ricevuta famiglia/ });
    expect(link.getAttribute('href')).toContain('/api/pagamenti/transazioni/tx-vecchia/ricevuta');
  });
});

describe('TransazioniPanel — due sedi', () => {
  it('figli e voci mostrano la sede; avviso «2 transazioni, una per sede» col riepilogo; POST senza scuola_id; una ricevuta per transazione', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      post: [risposta(200, {
        success: true,
        data: {
          transazione_id: 'tx-a', incassi: 1,
          transazioni: [
            { transazione_id: 'tx-a', scuola_id: SEDE_A, scuola_nome: NOME_A, importo_totale: 100 },
            { transazione_id: 'tx-b', scuola_id: SEDE_B, scuola_nome: NOME_B, importo_totale: 80 },
          ],
        },
      })],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();

    // Con `scuolaId={null}` anche la GET della famiglia viaggia SENZA scuola_id:
    // interpolare la prop produrrebbe `scuola_id=null`.
    const urlFamiglia = fm.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/pagamenti/famiglia'));
    expect(urlFamiglia.length).toBeGreaterThan(0);
    for (const u of urlFamiglia) {
      expect(u).not.toContain('scuola_id');
      expect(u).not.toContain('null');
      expect(u).not.toContain('undefined');
    }

    // Sede accanto ai figli (intestazione del blocco voci + blocco ricariche) e alle
    // voci. L'intestazione si guarda DA SOLA: il blocco del figlio contiene anche la
    // riga della voce, che porta lo stesso nome di sede e coprirebbe l'assenza.
    expect(within(screen.getByTestId('tx-figlio-intestazione-al-1')).getByText(NOME_A)).toBeInTheDocument();
    expect(within(screen.getByTestId('tx-figlio-intestazione-al-2')).getByText(NOME_B)).toBeInTheDocument();
    // Intestazione + voce: due occorrenze per blocco, né più né meno.
    expect(within(screen.getByTestId('tx-figlio-al-1')).getAllByText(NOME_A)).toHaveLength(2);
    expect(within(screen.getByTestId('tx-figlio-al-2')).getAllByText(NOME_B)).toHaveLength(2);
    expect(within(screen.getByTestId('tx-voce-v1')).getByText(NOME_A)).toBeInTheDocument();
    expect(within(screen.getByTestId('tx-voce-v2')).getByText(NOME_B)).toBeInTheDocument();
    expect(within(screen.getByTestId('tx-ricarica-al-2')).getByText(NOME_B)).toBeInTheDocument();

    impostaTotale('180');

    // Avviso di divisione con il riepilogo per sede, dentro una regione live
    // (chi usa uno screen reader deve sapere che il pagamento verrà diviso).
    const avviso = screen.getByTestId('tx-divisione-sedi');
    expect(avviso).toHaveTextContent('Verranno create 2 transazioni, una per sede');
    const regione = avviso.closest('[role="status"]');
    expect(regione).not.toBeNull();
    expect(regione).toHaveAttribute('aria-live', 'polite');
    expect(regione).toHaveAttribute('data-testid', 'tx-divisione-sedi-regione');
    const righe = within(avviso).getAllByRole('listitem');
    expect(righe).toHaveLength(2);
    expect(righe[0]).toHaveTextContent(NOME_A);
    expect(righe[0]).toHaveTextContent('100,00');
    expect(righe[1]).toHaveTextContent(NOME_B);
    expect(righe[1]).toHaveTextContent('80,00');

    // Senza eccedenza il menu della sede del credito non serve.
    expect(screen.queryByLabelText('Sede a cui attribuire il credito')).toBeNull();

    fireEvent.click(bottoneRegistra());
    // Il messaggio ESATTO del caso multiplo: «Transazione registrata» qui sarebbe falso.
    await screen.findByText(/2 transazioni registrate, una per sede/);
    expect(screen.queryByText(/^Transazione registrata/)).toBeNull();

    const [corpo] = corpiPost(fm);
    expect(corpo).not.toHaveProperty('scuola_id');
    expect(corpo).not.toHaveProperty('sede_eccedenza');
    expect(corpo.voci).toEqual([
      { pagamento_id: 'v1', importo: 100 },
      { pagamento_id: 'v2', importo: 80 },
    ]);

    // Una ricevuta per ogni transazione, ciascuna con la sua sede.
    const esito = screen.getByTestId('tx-esito-transazioni');
    const link = within(esito).getAllByRole('link');
    expect(link).toHaveLength(2);
    expect(link[0].getAttribute('href')).toContain('/api/pagamenti/transazioni/tx-a/ricevuta');
    expect(link[0]).toHaveTextContent(NOME_A);
    expect(link[1].getAttribute('href')).toContain('/api/pagamenti/transazioni/tx-b/ricevuta');
    expect(link[1]).toHaveTextContent(NOME_B);
  });

  it('una ricarica mensa conta nella sede dell\'ALUNNO, non in quella delle voci', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();
    // Solo la voce della sede A, più una ricarica per il figlio della sede B.
    fireEvent.click(screen.getByLabelText('Includi Retta Due'));
    fireEvent.change(screen.getByLabelText('Euro ricarica Due Rossi'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Ticket ricarica Due Rossi'), { target: { value: '6' } });
    impostaTotale('130');
    const avviso = screen.getByTestId('tx-divisione-sedi');
    const righe = within(avviso).getAllByRole('listitem');
    expect(righe).toHaveLength(2);
    expect(righe[1]).toHaveTextContent(NOME_B);
    expect(righe[1]).toHaveTextContent('30,00');
    // Qui la voce è UNA: la spiegazione deve nominare anche le ricariche, altrimenti
    // «le voci appartengono a sedi diverse» sarebbe falso.
    expect(avviso).toHaveTextContent('Voci e ricariche di questo incasso appartengono a sedi diverse');
    expect(avviso).not.toHaveTextContent('Le voci appartengono');
  });

  it('un esito senza transazione_id (RPC con meno esiti) non produce un link rotto', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      post: [risposta(200, {
        success: true,
        data: {
          transazione_id: 'tx-a',
          transazioni: [
            { transazione_id: 'tx-a', scuola_id: SEDE_A, scuola_nome: NOME_A, importo_totale: 100 },
            { transazione_id: null, scuola_id: SEDE_B, scuola_nome: NOME_B, importo_totale: 80 },
          ],
        },
      })],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();
    impostaTotale('180');
    fireEvent.click(bottoneRegistra());
    const esito = await screen.findByTestId('tx-esito-transazioni');
    expect(within(esito).getAllByRole('link')).toHaveLength(1);
    expect(within(esito).getByText(/Ricevuta non disponibile/)).toBeInTheDocument();
    expect(esito.innerHTML).not.toContain('/transazioni/null/');
    expect(esito.innerHTML).not.toContain('/transazioni//');
  });
});

describe('TransazioniPanel — eccedenza con più sedi', () => {
  it('menu «Sede a cui attribuire il credito» OBBLIGATORIO: finché non si sceglie non si registra; poi sede_eccedenza viaggia nella POST', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      post: [
        risposta(409, { error: 'Eccedenza da confermare', eccedenza: 20 }),
        risposta(200, {
          success: true,
          data: {
            transazione_id: 'tx-a',
            transazioni: [
              { transazione_id: 'tx-a', scuola_id: SEDE_A, scuola_nome: NOME_A, importo_totale: 100 },
              { transazione_id: 'tx-b', scuola_id: SEDE_B, scuola_nome: NOME_B, importo_totale: 100 },
            ],
          },
        }),
      ],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();
    impostaTotale('200'); // 180 allocati → 20 di eccedenza

    const menu = screen.getByLabelText('Sede a cui attribuire il credito') as HTMLSelectElement;
    // Solo le sedi dell'operazione, più l'opzione vuota iniziale.
    const valori = Array.from(menu.options).map((o) => o.value);
    expect(valori).toEqual(['', SEDE_A, SEDE_B]);
    expect(menu.value).toBe('');
    expect(bottoneRegistra().disabled).toBe(true);
    // Il testo d'aiuto (l'unico che spiega perché «Registra incasso» è spento) è
    // collegato alla select.
    expect(menu).toHaveAttribute('aria-describedby', 'tx-sede-eccedenza-aiuto');
    expect(document.getElementById('tx-sede-eccedenza-aiuto')).toHaveTextContent('20,00');

    fireEvent.change(menu, { target: { value: SEDE_B } });
    expect(bottoneRegistra().disabled).toBe(false);

    // Il riepilogo attribuisce l'eccedenza alla sede scelta.
    const righe = within(screen.getByTestId('tx-divisione-sedi')).getAllByRole('listitem');
    expect(righe[1]).toHaveTextContent('100,00');
    expect(righe[0]).toHaveTextContent('100,00');

    fireEvent.click(bottoneRegistra());
    // 409 → conferma esplicita del credito (mai silenziosa), che dice la sede.
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveTextContent(NOME_B);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Conferma credito' }));
    await screen.findByTestId('tx-esito-transazioni');

    const corpi = corpiPost(fm);
    expect(corpi).toHaveLength(2);
    for (const c of corpi) {
      expect(c).not.toHaveProperty('scuola_id');
      expect(c.sede_eccedenza).toBe(SEDE_B);
      expect(c.eccedenza_a_credito).toBe(20);
    }
    expect(corpi[1].conferma_eccedenza).toBe('credito_famiglia');
  });

  it('con eccedenza ma una sola sede nell\'operazione il menu non compare e sede_eccedenza non si manda', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      post: [risposta(409, { error: 'Eccedenza', eccedenza: 10 })],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();
    fireEvent.click(screen.getByLabelText('Includi Retta Due')); // resta solo la sede A
    impostaTotale('110');
    expect(screen.queryByLabelText('Sede a cui attribuire il credito')).toBeNull();
    expect(screen.queryByTestId('tx-divisione-sedi')).toBeNull();
    // La regione live resta montata (vuota): quando l'avviso comparirà, comparirà
    // DENTRO una regione già presente, ed è così che uno screen reader lo annuncia.
    expect(screen.getByTestId('tx-divisione-sedi-regione')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('tx-divisione-sedi-regione')).toBeEmptyDOMElement();
    fireEvent.click(bottoneRegistra());
    await screen.findByRole('dialog');
    const [corpo] = corpiPost(fm);
    expect(corpo).not.toHaveProperty('sede_eccedenza');
  });

  it('la sede del credito scelta e poi resa estranea (voce tolta) si scarta: menu sparito, POST senza sede_eccedenza', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      post: [risposta(409, { error: 'Eccedenza da confermare', eccedenza: 100 })],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();
    impostaTotale('200'); // 180 allocati su due sedi → 20 di eccedenza

    fireEvent.change(screen.getByLabelText('Sede a cui attribuire il credito'), { target: { value: SEDE_B } });
    expect(bottoneRegistra().disabled).toBe(false);

    // Si toglie la voce della sede B: l'operazione resta su una sede sola, e la
    // scelta «sede B» non ha più niente a cui riferirsi.
    fireEvent.click(screen.getByLabelText('Includi Retta Due'));
    expect(screen.queryByLabelText('Sede a cui attribuire il credito')).toBeNull();
    expect(screen.queryByTestId('tx-divisione-sedi')).toBeNull();

    fireEvent.click(bottoneRegistra());
    const dialogo = await screen.findByRole('dialog');
    // Il dialogo non nomina una sede che non c'entra più.
    expect(dialogo).not.toHaveTextContent(NOME_B);

    const corpi = corpiPost(fm);
    expect(corpi).toHaveLength(1);
    expect(corpi[0]).not.toHaveProperty('sede_eccedenza');
    expect(corpi[0].voci).toEqual([{ pagamento_id: 'v1', importo: 100 }]);
    expect(corpi[0].eccedenza_a_credito).toBe(100);
  });

  // Sequenza REALE della route: il 409 dell'eccedenza viene PRIMA del controllo sulla
  // sede del credito, quindi i 422 SEDE_ECCEDENZA_* arrivano solo dalla SECONDA POST,
  // quella con `conferma_eccedenza`, lanciata dal bottone dentro il dialogo. Mentre il
  // dialogo è aperto il resto della pagina è `inert`/`aria-hidden`: un avviso rimasto lì
  // sotto non lo vede né l'operatore né lo screen reader.
  async function secondaPostDalDialogo(seconda: Risposta | 'rete') {
    const post: Risposta[] = [risposta(409, { error: 'Eccedenza da confermare', eccedenza: 20 })];
    if (seconda !== 'rete') post.push(seconda);
    const base = stubFetch({ famiglia: famigliaDueSedi, post });
    let nPost = 0;
    const fm = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pagamenti/transazioni') && init?.method === 'POST') {
        nPost += 1;
        if (nPost === 2 && seconda === 'rete') throw new TypeError('Failed to fetch');
      }
      return base(url, init);
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await apriFamiglia();
    impostaTotale('200'); // 180 allocati → 20 di eccedenza su due sedi
    fireEvent.change(screen.getByLabelText('Sede a cui attribuire il credito'), { target: { value: SEDE_A } });
    fireEvent.click(bottoneRegistra());
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Conferma credito' }));
    // Si aspetta la PRESENZA dell'avviso (accessibile: fuori da ogni ramo inerte).
    const alert = await screen.findByRole('alert');
    return { fm, alert };
  }

  /** L'avviso è visibile e annunciabile: dialogo chiuso, nessun antenato inerte. */
  function avvisoRaggiungibile(alert: HTMLElement) {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
  }

  it('POST confermata → 422 SEDE_ECCEDENZA_ESTRANEA: il dialogo si chiude e l\'avviso porta il testo del codice', async () => {
    const { fm, alert } = await secondaPostDalDialogo(
      risposta(422, { error: 'Sede del credito estranea (dal server)', codice: 'SEDE_ECCEDENZA_ESTRANEA' }),
    );
    avvisoRaggiungibile(alert);
    // Il testo del CODICE (catalogo shared), non il generico «Errore nella registrazione».
    expect(alert).toHaveTextContent(/deve essere una delle sedi di questo pagamento/);
    expect(alert).not.toHaveTextContent('Errore nella registrazione della transazione');
    const corpi = corpiPost(fm);
    expect(corpi).toHaveLength(2);
    expect(corpi[0]).not.toHaveProperty('conferma_eccedenza');
    expect(corpi[1].conferma_eccedenza).toBe('credito_famiglia');
    expect(corpi[1].sede_eccedenza).toBe(SEDE_A);
    // Nessun esito: niente è stato registrato.
    expect(screen.queryByTestId('tx-esito-transazioni')).toBeNull();
  });

  it('POST confermata → 422 SEDE_ECCEDENZA_MANCANTE: il dialogo si chiude e l\'avviso porta il testo del codice', async () => {
    const { alert } = await secondaPostDalDialogo(
      risposta(422, { error: 'Scegli la sede del credito (dal server)', codice: 'SEDE_ECCEDENZA_MANCANTE' }),
    );
    avvisoRaggiungibile(alert);
    expect(alert).toHaveTextContent(/scegli su quale sede registrare il credito famiglia/);
    expect(alert).not.toHaveTextContent('Errore nella registrazione della transazione');
  });

  it('POST confermata → 503 della RPC: il dialogo si chiude e l\'errore si vede', async () => {
    const { alert } = await secondaPostDalDialogo(risposta(503, { error: 'Servizio momentaneamente non disponibile (dal server)' }));
    avvisoRaggiungibile(alert);
    // La prosa del server (senza `codice`) arriva intatta: non il fallback generico.
    expect(alert).toHaveTextContent('Servizio momentaneamente non disponibile (dal server)');
    expect(alert).not.toHaveTextContent('Errore nella registrazione della transazione');
  });

  it('POST confermata che cade per la rete: il dialogo si chiude, l\'errore si vede e resta traccia nel log', async () => {
    const { alert } = await secondaPostDalDialogo('rete');
    avvisoRaggiungibile(alert);
    // Il guasto di rete ha il SUO messaggio (transErrRete), non quello della registrazione rifiutata.
    // Esatto: «Errore di rete» è anche il prefisso di transErrReteFamiglia/transErrReteAnnullo.
    expect(alert).toHaveTextContent(/^Errore di rete$/);
    expect(alert).not.toHaveTextContent('Errore nella registrazione della transazione');
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
      messaggio: expect.stringContaining('transazioni-registrazione-rete'),
    }));
  });
});

describe('TransazioniPanel — registro e paganti', () => {
  it('registro: colonne Sede e Pagante con scuola_nome e pagante_nome; la GET non porta scuola_id', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      registro: [
        { id: 'tx-1', pagante_parent_id: 'genitore-1', importo_totale: 100, metodo: 'bonifico', riferimento: 'CRO1', data_valuta: '2026-09-20', scuola_nome: NOME_A, pagante_nome: 'Mario Rossi' },
        { id: 'tx-2', pagante_parent_id: 'genitore-2', importo_totale: 50, metodo: 'pos', riferimento: null, data_valuta: '2026-09-21', scuola_nome: null, pagante_nome: null },
        // Degrado `nomi-sede-non-letti`: il server dà l'id ma non il nome. Il nome si
        // ricava dalle sedi già note al client (`useSediAttive`), come per voci ed esito.
        { id: 'tx-3', pagante_parent_id: 'genitore-1', importo_totale: 30, metodo: 'contanti', riferimento: null, data_valuta: '2026-09-22', scuola_id: SEDE_B, scuola_nome: null, pagante_nome: 'Mario Rossi' },
      ],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);

    const tabella = await screen.findByRole('table');
    const intestazioni = within(tabella).getAllByRole('columnheader').map((h) => h.textContent);
    expect(intestazioni).toContain('Sede');
    expect(intestazioni).toContain('Pagante');

    const righe = within(tabella).getAllByRole('row').slice(1);
    const celle1 = within(righe[0]).getAllByRole('cell').map((c) => c.textContent);
    const iSede = intestazioni.indexOf('Sede');
    const iPag = intestazioni.indexOf('Pagante');
    expect(celle1[iSede]).toBe(NOME_A);
    expect(celle1[iPag]).toBe('Mario Rossi');
    const celle2 = within(righe[1]).getAllByRole('cell').map((c) => c.textContent);
    expect(celle2[iSede]).toBe('—');
    expect(celle2[iPag]).toBe('—');
    const celle3 = within(righe[2]).getAllByRole('cell').map((c) => c.textContent);
    expect(celle3[iSede]).toBe(NOME_B);

    const urlGet = fm.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/pagamenti/transazioni'));
    expect(urlGet.length).toBeGreaterThan(0);
    for (const u of urlGet) {
      expect(u).not.toContain('scuola_id');
      expect(u).not.toContain('null');
      expect(u).not.toContain('undefined');
    }
  });

  it('badge delle sedi accanto ai paganti (da scuole_ids)', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      parents: [
        { id: 'genitore-1', first_name: 'Mario', last_name: 'Rossi', scuole_ids: [SEDE_A, SEDE_B] },
        { id: 'genitore-2', first_name: 'Anna', last_name: 'Bianchi', scuole_ids: [SEDE_B] },
      ],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    const mario = await screen.findByRole('button', { name: /Mario Rossi/ });
    expect(within(mario).getByText(NOME_A)).toBeInTheDocument();
    expect(within(mario).getByText(NOME_B)).toBeInTheDocument();
    const anna = screen.getByRole('button', { name: /Anna Bianchi/ });
    expect(within(anna).getByText(NOME_B)).toBeInTheDocument();
    expect(within(anna).queryByText(NOME_A)).toBeNull();
  });

  it('con UNA sede selezionata, un pagante con figli in DUE sedi mostra entrambe; uno con una sede sola no', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      parents: [
        { id: 'genitore-1', first_name: 'Mario', last_name: 'Rossi', scuole_ids: [SEDE_A, SEDE_B] },
        { id: 'genitore-2', first_name: 'Anna', last_name: 'Bianchi', scuole_ids: [SEDE_A] },
      ],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={SEDE_A} />);
    const mario = await screen.findByRole('button', { name: /Mario Rossi/ });
    expect(within(mario).getByText(NOME_A)).toBeInTheDocument();
    expect(within(mario).getByText(NOME_B)).toBeInTheDocument();
    const anna = screen.getByRole('button', { name: /Anna Bianchi/ });
    expect(within(anna).queryByText(NOME_A)).toBeNull();
  });

  it('con una sede sola i badge dei paganti non compaiono', async () => {
    sediMock.valore = { sedi: [{ id: SEDE_A, nome: NOME_A }], effettive: [SEDE_A] };
    const fm = stubFetch({ famiglia: famigliaUnaSede });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={SEDE_A} />);
    const mario = await screen.findByRole('button', { name: /Mario Rossi/ });
    expect(within(mario).queryByText(NOME_A)).toBeNull();
  });
});

describe('TransazioniPanel — i guasti di rete lasciano traccia nei log (AGENTS.md regola 6)', () => {
  const messaggiLog = () => vi.mocked(logClient).mock.calls.map(([e]) => (e as { messaggio: string }).messaggio);

  it('GET della famiglia che cade alla scelta del pagante: messaggio a schermo E log col solo nome dell\'errore', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, famigliaRete: true });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Mario Rossi/ }));
    await screen.findByText('Errore di rete nel caricamento della famiglia');
    expect(messaggiLog()).toContain('transazioni-famiglia-rete: TypeError');
    // Niente dati personali nel log: né il nome del pagante né il suo id.
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toMatch(/Mario|Rossi|genitore-1/);
  });

  it('GET della famiglia che cade nella precompilazione: si resta su «scegli pagante» e il guasto è loggato', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, famigliaRete: true });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} precompila={{ parent: 'genitore-1', tot: 50 }} />);
    await waitFor(() => expect(messaggiLog()).toContain('transazioni-precompila-famiglia-rete: TypeError'));
    // Non si resta in silenzio: l'avviso di rete compare nello step «scegli pagante».
    expect(await screen.findByText('Errore di rete nel caricamento della famiglia')).toHaveAttribute('role', 'alert');
    expect(screen.getByLabelText('Cerca pagante')).toBeInTheDocument();
    // La chiamata c'è stata (è quella caduta) e, con `scuolaId={null}`, senza scuola_id.
    const urlFamiglia = fm.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/pagamenti/famiglia'));
    expect(urlFamiglia.length).toBeGreaterThan(0);
    for (const u of urlFamiglia) {
      expect(u).not.toContain('scuola_id');
      expect(u).not.toContain('null');
      expect(u).not.toContain('undefined');
    }
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toContain('genitore-1');
  });

  it('POST di annullo che cade: messaggio a schermo E log', async () => {
    const fm = stubFetch({
      famiglia: famigliaDueSedi,
      annulloRete: true,
      registro: [
        { id: 'tx-1', pagante_parent_id: 'genitore-1', importo_totale: 100, metodo: 'bonifico', riferimento: null, data_valuta: '2026-09-20', scuola_nome: NOME_A, pagante_nome: 'Mario Rossi' },
      ],
    });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    const tabella = await screen.findByRole('table');
    fireEvent.click(within(tabella).getByRole('button', { name: /Annulla/ }));
    fireEvent.change(await screen.findByLabelText('Motivo dell’annullo'), { target: { value: 'Doppio incasso' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferma annullo' }));
    await screen.findByText('Errore di rete nell’annullo');
    expect(messaggiLog()).toContain('transazioni-annullo-rete: TypeError');
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toContain('Doppio incasso');
  });
  it('GET del registro che cade: «registro non caricato» (MAI «nessuna transazione») E log', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, registroRete: true });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await screen.findByText('Impossibile caricare il registro.');
    expect(messaggiLog()).toContain('transazioni-registro-rete: TypeError');
    // Il guasto non si traveste da registro vuoto.
    expect(screen.queryByText('Nessuna transazione registrata.')).toBeNull();
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toMatch(/u1|Mario|genitore-1/);
  });

  it('GET dei paganti che cade: «elenco non caricato» (MAI «nessun tutore») E log', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, parentsRete: true });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await screen.findByText('Impossibile caricare l’elenco dei paganti.');
    expect(messaggiLog()).toContain('transazioni-paganti-rete: TypeError');
    expect(screen.queryByText('Nessun tutore trovato.')).toBeNull();
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toMatch(/u1|Mario|genitore-1/);
  });

  // ── Risposte HTTP d'errore: la fetch NON rigetta, ma il server ha detto no ──
  // Il guasto del giro 3 intercettava solo la fetch che rigetta: un 500 `{ error }`
  // arrivava a `r.json()` senza intoppi e finiva mostrato come «registro non
  // disponibile su questo ambiente» o come «nessun tutore trovato».
  const chiamateLog = () => vi.mocked(logClient).mock.calls.map(([e]) => e as { messaggio: string; stato?: number });

  it('GET del registro con 500 { error }: il messaggio del server, MAI «non disponibile» né «nessuna transazione»', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, registroRisposta: risposta(500, { error: 'Errore nel recupero delle transazioni' }) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    const avviso = await screen.findByText('Errore nel recupero delle transazioni');
    expect(avviso).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Registro non disponibile su questo ambiente.')).toBeNull();
    expect(screen.queryByText('Nessuna transazione registrata.')).toBeNull();
    expect(chiamateLog()).toContainEqual(expect.objectContaining({ messaggio: 'transazioni-registro-http', stato: 500 }));
  });

  it('GET del registro con 403 senza corpo utile: il testo generico, MAI «non disponibile»', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, registroRisposta: risposta(403, {}) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    expect(await screen.findByText('Impossibile caricare il registro.')).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Registro non disponibile su questo ambiente.')).toBeNull();
    expect(screen.queryByText('Nessuna transazione registrata.')).toBeNull();
    expect(chiamateLog()).toContainEqual(expect.objectContaining({ messaggio: 'transazioni-registro-http', stato: 403 }));
  });

  it('GET del registro 200 con disponibile:false: «non disponibile» resta, ed è l\'unico caso', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, registroRisposta: risposta(200, { success: true, data: [], disponibile: false }) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await screen.findByText('Registro non disponibile su questo ambiente.');
    expect(screen.queryByText('Impossibile caricare il registro.')).toBeNull();
    expect(screen.queryByText('Nessuna transazione registrata.')).toBeNull();
  });

  it('GET dei paganti con 500 { error }: il messaggio del server, MAI «nessun tutore»', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, parentsRisposta: risposta(500, { error: 'Errore interno del server' }) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    expect(await screen.findByText('Errore interno del server')).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Nessun tutore trovato.')).toBeNull();
    expect(chiamateLog()).toContainEqual(expect.objectContaining({ messaggio: 'transazioni-paganti-http', stato: 500 }));
  });

  it('GET dei paganti con 401 senza corpo utile: il testo generico, MAI «nessun tutore»', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, parentsRisposta: risposta(401, {}) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    expect(await screen.findByText('Impossibile caricare l’elenco dei paganti.')).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Nessun tutore trovato.')).toBeNull();
    expect(chiamateLog()).toContainEqual(expect.objectContaining({ messaggio: 'transazioni-paganti-http', stato: 401 }));
  });

  it('GET dei paganti 200 con { data: [] }: elenco valido e vuoto, «nessun tutore» e nessun errore', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, parentsRisposta: risposta(200, { data: [] }) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    await screen.findByText('Nessun tutore trovato.');
    expect(screen.queryByText('Impossibile caricare l’elenco dei paganti.')).toBeNull();
  });

  // Con K4 la GET della famiglia risponde 500 quando fallisce la lettura di
  // `student_parents`/`alunni`/`ticket_mensa`, dove prima restituiva «nessun figlio».
  it('precompilazione con la famiglia a 500 { error }: avviso del server a schermo, resta «scegli pagante», log con stato', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, famigliaRisposta: risposta(500, { error: 'Errore nel recupero delle voci' }) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} precompila={{ parent: 'genitore-1', tot: 50, rif: 'CRO-1' }} />);
    expect(await screen.findByText('Errore nel recupero delle voci')).toHaveAttribute('role', 'alert');
    expect(screen.getByLabelText('Cerca pagante')).toBeInTheDocument();
    expect(screen.queryByText(/Voci da saldare/)).toBeNull();
    expect(chiamateLog()).toContainEqual(expect.objectContaining({ messaggio: 'transazioni-precompila-famiglia-http', stato: 500 }));
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toMatch(/genitore-1|CRO-1|Mario/);
  });

  it('scelta del pagante con la famiglia a 403: messaggio a schermo E log con stato', async () => {
    const fm = stubFetch({ famiglia: famigliaDueSedi, famigliaRisposta: risposta(403, {}) });
    vi.stubGlobal('fetch', fm);
    render(<TransazioniPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Mario Rossi/ }));
    expect(await screen.findByText('Impossibile caricare la famiglia')).toHaveAttribute('role', 'alert');
    expect(screen.getByLabelText('Cerca pagante')).toBeInTheDocument();
    expect(chiamateLog()).toContainEqual(expect.objectContaining({ messaggio: 'transazioni-famiglia-http', stato: 403 }));
    expect(JSON.stringify(vi.mocked(logClient).mock.calls)).not.toMatch(/genitore-1|Mario|Rossi/);
  });
});
