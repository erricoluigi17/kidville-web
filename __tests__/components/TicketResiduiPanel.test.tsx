import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { TicketResiduiPanel } from '@/components/features/admin/mensa/TicketResiduiPanel';

/**
 * Il widget «Pasti ancora disponibili» di Mensa & Cucina.
 *
 * Le tre cose che deve fare, e che qui si verificano una per una:
 *  · elencare TUTTI i bambini in ordine alfabetico, compresi quelli a zero —
 *    in produzione (2026-09-07) sono 625 su 643, cioè la quasi totalità;
 *  · filtrare per classe;
 *  · aprire, al tocco su un nome, QUANDO ha comprato i ticket e QUANDO li ha usati.
 *
 * Il mock globale di next-intl (test/setup.ts) risolve le chiavi contro
 * `messages/it/adminMensa.json`: se una chiave mancasse, a schermo comparirebbe
 * «adminMensa.ticketPasti» e le asserzioni sui testi cadrebbero. Sono anche il
 * collaudo del cablaggio i18n.
 */

const fetchMock = vi.fn();

const ELENCO = {
  success: true,
  data: {
    classi: ['Sezione A', 'Sezione B'],
    alunni: [
      { alunno_id: 'al-1', nome: 'Anna', cognome: 'Bianchi', classe: 'Sezione A', saldo_ticket: 7, ultimo_carico: '2026-07-26T10:00:00Z' },
      { alunno_id: 'al-2', nome: 'Bruno', cognome: 'Neri', classe: 'Sezione B', saldo_ticket: 0, ultimo_carico: null },
      { alunno_id: 'al-3', nome: 'Carla', cognome: 'Rossi', classe: 'Sezione A', saldo_ticket: -2, ultimo_carico: '2026-06-01T10:00:00Z' },
    ],
    totale_residui: 5,
    senza_ticket: 2,
    saldi_non_disponibili: false,
  },
};

const STORICO = {
  success: true,
  data: {
    saldo_ticket: 7,
    ultimo_carico: '2026-07-26T10:00:00Z',
    movimenti: [
      { id: 'm2', tipo: 'consumo', delta: -1, saldo_dopo: 9, data: '2026-07-09', origine: 'prenotazione' },
      { id: 'm1', tipo: 'ricarica', delta: 10, saldo_dopo: 10, data: '2026-07-07', origine: 'segreteria' },
    ],
    storico_non_disponibile: false,
  },
};

const rispostaOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/mensa/ticket-residui/storico')) return Promise.resolve(rispostaOk(STORICO));
    if (url.includes('/api/mensa/ticket-residui')) return Promise.resolve(rispostaOk(ELENCO));
    return Promise.resolve(rispostaOk({ success: true, data: {} }));
  });
});

describe('TicketResiduiPanel — l\'elenco', () => {
  it('mostra ogni bambino col suo residuo, compresi lo zero e il negativo', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);

    expect(await screen.findByText('Bianchi Anna')).toBeInTheDocument();
    expect(screen.getByText('Neri Bruno')).toBeInTheDocument();
    expect(screen.getByText('Rossi Carla')).toBeInTheDocument();
    // il saldo è accanto al nome, non da qualche parte in fondo
    expect(screen.getByText('7 pasti')).toBeInTheDocument();
    expect(screen.getByText('0 pasti')).toBeInTheDocument();
    expect(screen.getByText('-2 pasti')).toBeInTheDocument();
  });

  it('conserva l\'ordine alfabetico servito dal server', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    await screen.findByText('Bianchi Anna');
    const nomi = screen.getAllByRole('button').map(b => b.textContent ?? '');
    const soloNomi = nomi.filter(n => /Bianchi|Neri|Rossi/.test(n));
    expect(soloNomi[0]).toContain('Bianchi');
    expect(soloNomi[1]).toContain('Neri');
    expect(soloNomi[2]).toContain('Rossi');
  });

  it('conta quanti bambini sono senza pasti (0 o sotto)', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    await screen.findByText('Bianchi Anna');
    // Neri (0) e Rossi (−2): la segreteria sa chi sollecitare
    const contatore = screen.getByText('senza pasti').closest('div');
    expect(within(contatore as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('filtra per classe, e il filtro restringe davvero', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    await screen.findByText('Bianchi Anna');

    fireEvent.change(screen.getByLabelText('Sezione'), { target: { value: 'Sezione B' } });

    expect(screen.getByText('Neri Bruno')).toBeInTheDocument();
    expect(screen.queryByText('Bianchi Anna')).not.toBeInTheDocument();
    expect(screen.queryByText('Rossi Carla')).not.toBeInTheDocument();
  });

  it('un errore di caricamento si vede: non diventa «nessun bambino ha pasti»', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Errore nel caricamento degli alunni' }) }));
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Errore nel caricamento/i);
  });

  it('se i saldi non sono stati letti lo dichiara, invece di mostrare zeri credibili', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/ticket-residui')) {
        return Promise.resolve(rispostaOk({
          ...ELENCO,
          data: { ...ELENCO.data, saldi_non_disponibili: true },
        }));
      }
      return Promise.resolve(rispostaOk({ success: true, data: {} }));
    });
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/saldi non sono stati letti/i);
  });
});

describe('TicketResiduiPanel — lo storico al tocco sul nome', () => {
  it('apre acquisti e consumi con le rispettive date', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    const riga = await screen.findByText('Bianchi Anna');

    fireEvent.click(riga);

    expect(await screen.findByText(/Acquisto \+10/)).toBeInTheDocument();
    expect(screen.getByText(/Pasto -1/)).toBeInTheDocument();
    // le DATE, che sono la ragione per cui si apre la riga
    expect(screen.getByText(/07\/07\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/09\/07\/2026/)).toBeInTheDocument();
  });

  it('chiede lo storico di QUEL bambino, e una volta sola', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    const riga = await screen.findByText('Neri Bruno');

    fireEvent.click(riga);
    await screen.findByText(/Acquisto \+10/);
    fireEvent.click(riga); // chiude
    fireEvent.click(riga); // riapre: non deve rifare la chiamata

    const chiamate = fetchMock.mock.calls.filter(c => String(c[0]).includes('/storico'));
    expect(chiamate).toHaveLength(1);
    expect(String(chiamate[0][0])).toContain('alunno_id=al-2');
  });

  it('la riga dichiara se è aperta o chiusa (aria-expanded)', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    const riga = (await screen.findByText('Bianchi Anna')).closest('button') as HTMLElement;

    expect(riga).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(riga);
    expect(riga).toHaveAttribute('aria-expanded', 'true');
  });

  it('storico non leggibile → lo dice, invece di fingere «mai usato»', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/storico')) {
        return Promise.resolve(rispostaOk({ success: true, data: { saldo_ticket: 0, ultimo_carico: null, movimenti: [], storico_non_disponibile: true } }));
      }
      return Promise.resolve(rispostaOk(ELENCO));
    });
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" />);
    fireEvent.click(await screen.findByText('Bianchi Anna'));
    expect(await screen.findByText(/storico dei movimenti non è disponibile/i)).toBeInTheDocument();
  });
});

describe('TicketResiduiPanel — modalità insegnante', () => {
  it('con `sezione` non mostra il filtro classe e vincola la richiesta al server', async () => {
    render(<TicketResiduiPanel userId="U1" scuolaId="sc-1" sezione="Sezione A" />);
    await screen.findByText('Bianchi Anna');

    expect(screen.queryByLabelText('Sezione')).not.toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('classe=Sezione+A');
  });
});
