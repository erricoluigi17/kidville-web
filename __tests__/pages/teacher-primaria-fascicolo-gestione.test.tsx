import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

/**
 * Fascicolo di PRIMARIA — «Modifica», «Sostituisci file», «Elimina» e «Cestino»
 * (spec 2026-09-24, compito F2).
 *
 * Che cosa lega questo file, misurato su ciò che parte verso il server e su ciò
 * che si legge a schermo:
 *  (a) i bottoni di gestione compaiono solo all'AUTORE del documento o a
 *      Segreteria/Direzione; un docente non li vede sui documenti altrui;
 *  (b) un modulo firmato/protocollato (tipo fuori da PEI/PDP/diagnosi/104) ha solo «Elimina»;
 *  (c) la PATCH porta SOLO i campi cambiati; senza cambi non parte;
 *  (d) «Elimina» chiede conferma: senza conferma nessuna DELETE; con conferma la
 *      DELETE porta id e finalità, e l'elenco si rilegge;
 *  (e) «Sostituisci file» manda id e file in multipart; oltre il limite non parte;
 *  (f) «Cestino» elenca le voci del server e «Ripristina» manda l'id, poi rilegge;
 *  (g) un rifiuto si mostra TRADOTTO dal codice; «documento cambiato» chiude la
 *      modale, fa rileggere e il messaggio RESTA in pagina anche se la riga sparisce;
 *      Una fetch che LANCIA (rete) ha esito ignoto: log, modale chiusa, rilettura;
 *  (i) cambiando alunno non resta a schermo niente dell'alunno di prima (documenti
 *      o cestino con i loro bottoni, né il suo 403) mentre la nuova GET è in volo:
 *      si legge «Caricamento…», mai un fascicolo vuoto finto; una sua risposta
 *      arrivata in ritardo viene scartata, e se lancia si logga comunque (`warn`: il canale client non ha `info`);
 *  (l) una lettura dei documenti fallita dà un avviso e un log, mai un fascicolo
 *      vuoto finto né l'elenco vecchio con i suoi bottoni;
 *  (m) con la richiesta in volo le modali non si chiudono (Escape, sfondo): il
 *      rifiuto del server arriva a schermo invece di perdersi in una modale smontata;
 *  (h) le copie client delle liste (tipi, ruoli) coincidono con quelle del server.
 *
 * Nomi di fantasia: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));

const DOCENTE = 'd0c00000-0000-4000-8000-000000000001';
const COLLEGA = 'c0c00000-0000-4000-8000-000000000002';
const SEZIONE = '11111111-1111-4111-8111-111111111111';
const ALUNNO = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const ALUNNO2 = { id: 'aaaa2222-0000-4000-8000-000000000002', nome: 'Anna', cognome: 'Bianchi' };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`userId=${DOCENTE}`),
  useParams: () => ({ sectionId: SEZIONE }),
  usePathname: () => `/teacher/primaria/${SEZIONE}/fascicolo`,
}));

import FascicoloPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/fascicolo/page';
import {
  TIPI_DOCUMENTO_FASCICOLO,
  RUOLI_GESTORE_FASCICOLO,
  corpoModificaFascicolo,
  chiaveErroreFascicolo,
} from '@/lib/primaria/fascicolo-ui';
import { TIPI_FASCICOLO, RUOLI_GESTIONE_FASCICOLO } from '@/lib/primaria/fascicolo-gestione';

const MIO = {
  id: 'f0000001-0000-4000-8000-000000000001',
  document_type: 'pei',
  descrizione: 'Piano annuale',
  file_name: 'pei-mio.pdf',
  expiry_date: '2027-06-30',
  created_at: '2026-09-20T08:00:00Z',
  caricato_da: DOCENTE,
};
const ALTRUI = {
  id: 'f0000002-0000-4000-8000-000000000002',
  document_type: 'pdp',
  descrizione: null,
  file_name: 'pdp-collega.pdf',
  expiry_date: null,
  created_at: '2026-09-21T08:00:00Z',
  caricato_da: COLLEGA,
};
const PRESTAMPATO = {
  id: 'f0000003-0000-4000-8000-000000000003',
  document_type: 'autorizzazione-uscite',
  descrizione: 'Prot. 12',
  file_name: 'modulo-firmato.pdf',
  expiry_date: null,
  created_at: '2026-09-22T08:00:00Z',
  caricato_da: DOCENTE,
};
const NEL_CESTINO = {
  id: 'f0000009-0000-4000-8000-000000000009',
  document_type: 'diagnosi',
  descrizione: null,
  file_name: 'diagnosi-vecchia.pdf',
  expiry_date: null,
  created_at: '2026-09-01T08:00:00Z',
  caricato_da: DOCENTE,
  eliminato_il: '2026-09-24T08:00:00Z',
  eliminato_da: DOCENTE,
  ripristinabileFinoAl: '2026-10-01T08:00:00Z',
  giorniResidui: 5,
};

const fetchMock = vi.fn();
let documenti: Array<Record<string, unknown>> = [];
let alunni: Array<typeof ALUNNO> = [ALUNNO];
let cestino: Array<Record<string, unknown>> = [];
let ruolo = 'educator';
let rispostaMutazione: { status: number; corpo: unknown } = { status: 200, corpo: { success: true } };

const risposta = (status: number, corpo: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

const chiamate = (metodo: string, frammento: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) =>
      String(u).includes(frammento) && ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
  );

/** Le GET dell'elenco documenti (non quelle di `…/pagelle`, `…/cestino`, `…/file`). */
const lettureDocumenti = () =>
  chiamate('GET', '/api/primaria/fascicolo?').filter(([u]) => String(u).startsWith('/api/primaria/fascicolo?'));

beforeEach(() => {
  vi.clearAllMocks();
  documenti = [MIO, ALTRUI];
  alunni = [ALUNNO];
  cestino = [NEL_CESTINO];
  ruolo = 'educator';
  rispostaMutazione = { status: 200, corpo: { success: true, data: {} } };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    if (url.startsWith('/api/primaria/classe/')) return risposta(200, { success: true, data: { alunni } });
    if (url.startsWith('/api/primaria/me')) return risposta(200, { success: true, data: { ruolo, userId: DOCENTE } });
    if (url.startsWith('/api/primaria/fascicolo/pagelle')) return risposta(200, { success: true, data: [] });
    if (url.startsWith('/api/primaria/fascicolo/cestino') && metodo === 'GET') return risposta(200, { success: true, data: cestino });
    if (url.startsWith('/api/primaria/fascicolo?') && metodo === 'GET') return risposta(200, { success: true, data: documenti });
    if (url.startsWith('/api/primaria/fascicolo')) return risposta(rispostaMutazione.status, rispostaMutazione.corpo);
    throw new Error(`fetch inattesa: ${metodo} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

async function svuotaCoda() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Monta la pagina, sceglie l'alunno, aspetta elenco e `/me`. */
async function monta() {
  render(<FascicoloPage />);
  await screen.findByRole('option', { name: /Rossi Mario/ });
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO.id } });
  await screen.findByText(/pei-mio\.pdf/);
  await svuotaCoda();
}

describe('F2 · chi vede i bottoni di gestione', () => {
  it('(a) il docente autore li vede sul SUO documento, non su quello della collega', async () => {
    await monta();
    expect(screen.getByRole('button', { name: 'Modifica pei-mio.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sostituisci file di pei-mio.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Modifica pdp-collega.pdf' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Elimina pdp-collega.pdf' })).toBeNull();
  });

  it('(a) la Segreteria li vede anche sui documenti altrui', async () => {
    ruolo = 'segreteria';
    await monta();
    expect(screen.getByRole('button', { name: 'Modifica pdp-collega.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Elimina pdp-collega.pdf' })).toBeTruthy();
  });

  it('(a) finché `/me` non risponde, nessun bottone (fail-closed)', async () => {
    let sblocca: (v: unknown) => void = () => {};
    const meInSospeso = new Promise((r) => { sblocca = r; });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/primaria/me')) { await meInSospeso; }
      return base(url, init);
    });
    await monta();
    expect(screen.queryByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeNull();
    sblocca(undefined);
    expect(await screen.findByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeTruthy();
  });

  it('(b) un modulo firmato/protocollato ha solo «Elimina»', async () => {
    documenti = [PRESTAMPATO];
    render(<FascicoloPage />);
    await screen.findByRole('option', { name: /Rossi Mario/ });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO.id } });
    await screen.findByText(/modulo-firmato\.pdf/);
    await svuotaCoda();
    expect(screen.getByRole('button', { name: 'Elimina modulo-firmato.pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Modifica modulo-firmato.pdf' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sostituisci file di modulo-firmato.pdf' })).toBeNull();
  });
});

describe('F2 · Modifica', () => {
  it('(c) manda SOLO il campo cambiato', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText('Descrizione'), { target: { value: 'Piano rivisto' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(chiamate('PATCH', '/api/primaria/fascicolo')).toHaveLength(1));
    const [, init] = chiamate('PATCH', '/api/primaria/fascicolo')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ id: MIO.id, descrizione: 'Piano rivisto' });
    expect(await screen.findByText('Documento modificato ✓')).toBeTruthy();
  });

  it('(c) tipo e scadenza svuotata: tipo nuovo e `expiryDate: null`', () => {
    expect(corpoModificaFascicolo(MIO, { documentType: 'pdp', descrizione: 'Piano annuale', expiryDate: '' })).toEqual({
      documentType: 'pdp',
      expiryDate: null,
    });
  });

  it('(c) senza cambi non parte nessuna PATCH, e lo si dice', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await within(dialogo).findByRole('alert')).toBeTruthy();
    expect(within(dialogo).getByRole('alert').textContent).toContain('non c’è nulla da salvare');
    expect(chiamate('PATCH', '/api/primaria/fascicolo')).toHaveLength(0);
  });

  it('(g) un 403 di gestione si mostra tradotto dal codice, non con la prosa del server', async () => {
    rispostaMutazione = { status: 403, corpo: { error: 'PROSA DEL SERVER', codice: 'FASCICOLO_GESTIONE_NEGATA' } };
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText('Descrizione'), { target: { value: 'x' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    const avviso = await within(dialogo).findByRole('alert');
    expect(avviso.textContent).toContain('Solo chi ha caricato il documento');
    expect(avviso.textContent).not.toContain('PROSA DEL SERVER');
  });
});

describe('F2 · Elimina', () => {
  it('(d) senza conferma nessuna DELETE; con conferma DELETE con id e finalità, poi l’elenco si rilegge', async () => {
    await monta();
    fireEvent.change(screen.getByPlaceholderText(/Finalità di accesso/), { target: { value: 'colloquio GLO' } });
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo.textContent).toContain('va nel cestino per 7 giorni');
    expect(chiamate('DELETE', '/api/primaria/fascicolo')).toHaveLength(0);

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(chiamate('DELETE', '/api/primaria/fascicolo')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo2 = await screen.findByRole('dialog');
    const lettePrima = lettureDocumenti().length;
    fireEvent.click(within(dialogo2).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(chiamate('DELETE', '/api/primaria/fascicolo')).toHaveLength(1));
    const url = new URL(String(chiamate('DELETE', '/api/primaria/fascicolo')[0][0]), 'http://x');
    expect(url.pathname).toBe('/api/primaria/fascicolo');
    expect(url.searchParams.get('id')).toBe(MIO.id);
    expect(url.searchParams.get('finalita')).toBe('colloquio GLO');
    await waitFor(() => expect(lettureDocumenti().length).toBeGreaterThan(lettePrima));
    expect(await screen.findByText('Documento nel cestino ✓')).toBeTruthy();
  });

  it('(g) «documento cambiato» (409): la modale si chiude, l’elenco si rilegge SENZA il documento e il messaggio resta in pagina', async () => {
    rispostaMutazione = { status: 409, corpo: { error: 'x', codice: 'FASCICOLO_DOCUMENTO_CAMBIATO' } };
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const lettePrima = lettureDocumenti().length;
    // Nel frattempo un altro utente l'ha eliminato: la rilettura non lo trova più.
    documenti = [ALTRUI];
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(lettureDocumenti().length).toBeGreaterThan(lettePrima));
    // La riga è sparita perché la rilettura è ARRIVATA (presenza, non assenza):
    await screen.findByText(/pdp-collega\.pdf/);
    await waitFor(() => expect(screen.queryByText(/pei-mio\.pdf/)).toBeNull());
    await svuotaCoda();
    expect(screen.queryByRole('dialog')).toBeNull();
    const avviso = screen.getByRole('alert');
    expect(avviso.textContent).toContain('eliminato o sostituito nel frattempo');
  });

  it('(g) la DELETE che LANCIA (rete): log, modale chiusa, elenco riletto, avviso in pagina senza «niente è cambiato»', async () => {
    await monta();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new TypeError('Failed to fetch');
      return base(url, init);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const lettePrima = lettureDocumenti().length;
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({ livello: 'error', messaggio: 'fascicolo-eliminazione-fallita: TypeError' }),
      ),
    );
    await waitFor(() => expect(lettureDocumenti().length).toBeGreaterThan(lettePrima));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('l’operazione potrebbe non essere arrivata');
    expect(avviso.textContent).not.toContain('niente è cambiato');
  });

  it('(g) un rifiuto che NON chiede rilettura resta nella modale, senza rileggere', async () => {
    rispostaMutazione = { status: 403, corpo: { error: 'x', codice: 'FASCICOLO_GESTIONE_NEGATA' } };
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const lettePrima = lettureDocumenti().length;
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    const avviso = await within(dialogo).findByRole('alert');
    expect(avviso.textContent).toContain('Solo chi ha caricato il documento');
    await svuotaCoda();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(lettureDocumenti().length).toBe(lettePrima);
  });
});

describe('F2 · Sostituisci file', () => {
  it('(e) manda id e file in multipart alla route di sostituzione', async () => {
    rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuovo' } } };
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Sostituisci file di pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo.textContent).toContain('nel cestino per 7 giorni');
    const file = new File(['%PDF-1.4'], 'pei-nuovo.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialogo).getByLabelText('Nuovo file (PDF o immagine)'), { target: { files: [file] } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Sostituisci' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/fascicolo/sostituisci')).toHaveLength(1));
    const body = (chiamate('POST', '/api/primaria/fascicolo/sostituisci')[0][1] as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('id')).toBe(MIO.id);
    expect((body.get('file') as File).name).toBe('pei-nuovo.pdf');
    expect(await screen.findByText(/File sostituito ✓/)).toBeTruthy();
  });

  it('(e) oltre il limite di upload non parte niente', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Sostituisci file di pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const grande = new File(['x'], 'grande.pdf', { type: 'application/pdf' });
    Object.defineProperty(grande, 'size', { value: 5 * 1024 * 1024 });
    fireEvent.change(within(dialogo).getByLabelText('Nuovo file (PDF o immagine)'), { target: { files: [grande] } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Sostituisci' }));
    expect(await within(dialogo).findByRole('alert')).toBeTruthy();
    expect(chiamate('POST', '/api/primaria/fascicolo/sostituisci')).toHaveLength(0);
  });
});

describe('F2 · la modale non si chiude con la richiesta in volo', () => {
  /** Tiene in sospeso la mutazione che corrisponde a metodo+frammento; `sblocca` la fa rispondere. */
  function sospendiMutazione(metodo: string, frammento: string) {
    let sblocca: (r: { status: number; corpo: unknown }) => void = () => {};
    const inSospeso = new Promise<{ status: number; corpo: unknown }>((r) => { sblocca = r; });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === metodo && url.startsWith(frammento)) {
        const { status, corpo } = await inSospeso;
        return risposta(status, corpo);
      }
      return base(url, init);
    });
    return (r: { status: number; corpo: unknown }) => sblocca(r);
  }

  /** Escape, clic sullo sfondo (il contenitore fuori dal dialogo): i due gesti che il `Modal` traduce in `onClose`. */
  function provaAChiudere(dialogo: HTMLElement) {
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialogo.parentElement!);
  }

  it('(m) «Sostituisci»: Escape e sfondo durante l’upload non chiudono; il 403 arriva DENTRO la modale', async () => {
    await monta();
    const sblocca = sospendiMutazione('POST', '/api/primaria/fascicolo/sostituisci');
    fireEvent.click(screen.getByRole('button', { name: 'Sostituisci file di pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const file = new File(['%PDF-1.4'], 'pei-nuovo.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialogo).getByLabelText('Nuovo file (PDF o immagine)'), { target: { files: [file] } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Sostituisci' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/fascicolo/sostituisci')).toHaveLength(1));
    // La richiesta è in volo: il bottone lo dice (presenza, non assenza).
    await within(dialogo).findByRole('button', { name: 'Caricamento…' });

    provaAChiudere(dialogo);
    await svuotaCoda();
    expect(screen.getByRole('dialog')).toBe(dialogo);

    sblocca({ status: 403, corpo: { error: 'x', codice: 'FASCICOLO_GESTIONE_NEGATA' } });
    const avviso = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(avviso.textContent).toContain('Solo chi ha caricato il documento');
    expect(chiamate('POST', '/api/primaria/fascicolo/sostituisci')).toHaveLength(1);

    // Finita la richiesta, Escape torna a chiudere.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('(m) «Elimina»: Escape e sfondo con la DELETE in volo non chiudono; il 403 arriva DENTRO la modale', async () => {
    await monta();
    const sblocca = sospendiMutazione('DELETE', '/api/primaria/fascicolo?');
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(chiamate('DELETE', '/api/primaria/fascicolo')).toHaveLength(1));
    await within(dialogo).findByRole('button', { name: 'Salvataggio…' });

    provaAChiudere(dialogo);
    await svuotaCoda();
    expect(screen.getByRole('dialog')).toBe(dialogo);

    sblocca({ status: 403, corpo: { error: 'x', codice: 'FASCICOLO_GESTIONE_NEGATA' } });
    const avviso = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(avviso.textContent).toContain('Solo chi ha caricato il documento');
    expect(chiamate('DELETE', '/api/primaria/fascicolo')).toHaveLength(1);
  });

  it('(m) «Modifica»: Escape e sfondo con la PATCH in volo non chiudono; il 403 arriva DENTRO la modale', async () => {
    await monta();
    const sblocca = sospendiMutazione('PATCH', '/api/primaria/fascicolo?');
    fireEvent.click(screen.getByRole('button', { name: 'Modifica pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText('Descrizione'), { target: { value: 'Piano rivisto' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(chiamate('PATCH', '/api/primaria/fascicolo')).toHaveLength(1));
    await within(dialogo).findByRole('button', { name: 'Salvataggio…' });

    provaAChiudere(dialogo);
    await svuotaCoda();
    expect(screen.getByRole('dialog')).toBe(dialogo);

    sblocca({ status: 403, corpo: { error: 'x', codice: 'FASCICOLO_GESTIONE_NEGATA' } });
    const avviso = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(avviso.textContent).toContain('Solo chi ha caricato il documento');
  });
});

describe('F2 · Cestino', () => {
  it('(f) elenca le voci del server e «Ripristina» manda l’id, poi rilegge documenti e cestino', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: /^Cestino$/ }));
    const vista = await screen.findByTestId('fascicolo-cestino');
    await within(vista).findByText(/diagnosi-vecchia\.pdf/);
    expect(vista.textContent).toContain('ancora 5 giorni');
    const url = new URL(String(chiamate('GET', '/api/primaria/fascicolo/cestino')[0][0]), 'http://x');
    expect(url.searchParams.get('alunnoId')).toBe(ALUNNO.id);

    const documentiPrima = lettureDocumenti().length;
    const cestinoPrima = chiamate('GET', '/api/primaria/fascicolo/cestino').length;
    fireEvent.click(within(vista).getByRole('button', { name: 'Ripristina diagnosi-vecchia.pdf' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/fascicolo/cestino')).toHaveLength(1));
    const [, init] = chiamate('POST', '/api/primaria/fascicolo/cestino')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ id: NEL_CESTINO.id });
    await waitFor(() => expect(lettureDocumenti().length).toBeGreaterThan(documentiPrima));
    await waitFor(() => expect(chiamate('GET', '/api/primaria/fascicolo/cestino').length).toBeGreaterThan(cestinoPrima));
    expect(await screen.findByText('Documento ripristinato ✓')).toBeTruthy();
  });

  it('(f) cestino vuoto: lo si dice; «Torna ai documenti» riporta l’elenco', async () => {
    cestino = [];
    await monta();
    fireEvent.click(screen.getByRole('button', { name: /^Cestino$/ }));
    expect(await screen.findByText('Il cestino è vuoto.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Torna ai documenti/ }));
    expect(await screen.findByText(/pei-mio\.pdf/)).toBeTruthy();
  });

  it('(g) ripristino scaduto: messaggio tradotto', async () => {
    rispostaMutazione = { status: 409, corpo: { error: 'x', codice: 'FASCICOLO_CESTINO_SCADUTO' } };
    await monta();
    fireEvent.click(screen.getByRole('button', { name: /^Cestino$/ }));
    const vista = await screen.findByTestId('fascicolo-cestino');
    await within(vista).findByText(/diagnosi-vecchia\.pdf/);
    fireEvent.click(within(vista).getByRole('button', { name: 'Ripristina diagnosi-vecchia.pdf' }));
    expect(await screen.findByText('Il tempo per ripristinare questo documento è scaduto.')).toBeTruthy();
  });

  it('(g) il ripristino che LANCIA (rete): log, rilettura di cestino e documenti, avviso senza certezze', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: /^Cestino$/ }));
    const vista = await screen.findByTestId('fascicolo-cestino');
    await within(vista).findByText(/diagnosi-vecchia\.pdf/);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.startsWith('/api/primaria/fascicolo/cestino')) throw new TypeError('Failed to fetch');
      return base(url, init);
    });
    const documentiPrima = lettureDocumenti().length;
    const cestinoPrima = chiamate('GET', '/api/primaria/fascicolo/cestino').length;
    fireEvent.click(within(vista).getByRole('button', { name: 'Ripristina diagnosi-vecchia.pdf' }));
    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({ livello: 'error', messaggio: 'fascicolo-ripristino-fallito: TypeError' }),
      ),
    );
    await waitFor(() => expect(lettureDocumenti().length).toBeGreaterThan(documentiPrima));
    await waitFor(() => expect(chiamate('GET', '/api/primaria/fascicolo/cestino').length).toBeGreaterThan(cestinoPrima));
    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('l’operazione potrebbe non essere arrivata');
  });
});

describe('F2 · lettura dei documenti fallita', () => {
  it('(l) la GET dei documenti che LANCIA: avviso e log, NON «Nessun documento nel fascicolo.»', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) throw new TypeError('Failed to fetch');
      return base(url, init);
    });
    render(<FascicoloPage />);
    await screen.findByRole('option', { name: /Rossi Mario/ });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO.id } });
    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('Impossibile caricare i documenti del fascicolo');
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'fascicolo-documenti-non-caricati: TypeError' }),
    );
    expect(screen.queryByText('Nessun documento nel fascicolo.')).toBeNull();
  });

  it('(l) dopo un’eliminazione la rilettura risponde 500: via l’elenco vecchio e i suoi bottoni, avviso al suo posto', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) {
        return risposta(500, { error: 'x', codice: 'LETTURA_FALLITA' });
      }
      return base(url, init);
    });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Impossibile caricare i documenti del fascicolo.')).toBeTruthy();
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'fascicolo-documenti-non-caricati: LETTURA_FALLITA' }),
    );
    expect(screen.queryByText(/pei-mio\.pdf/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeNull();
    expect(screen.queryByText('Nessun documento nel fascicolo.')).toBeNull();
  });

  it('(l) «Riprova» nell’avviso rilegge i documenti: «Caricamento…» durante, poi l’elenco e i bottoni tornano', async () => {
    // La prima GET dei documenti risponde 500; da lì in poi il server è tornato sano
    // ma resta IN SOSPESO finché il test non la sblocca (per vedere «Caricamento…»).
    documenti = [MIO];
    const base = fetchMock.getMockImplementation()!;
    let fallite = 0;
    let sblocca: () => void = () => {};
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) {
        if (fallite === 0) {
          fallite++;
          return risposta(500, { error: 'x', codice: 'LETTURA_FALLITA' });
        }
        await new Promise<void>((r) => { sblocca = r; });
      }
      return base(url, init);
    });
    render(<FascicoloPage />);
    await screen.findByRole('option', { name: /Rossi Mario/ });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO.id } });
    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('Impossibile caricare i documenti del fascicolo.');
    expect(lettureDocumenti()).toHaveLength(1);

    fireEvent.click(within(avviso).getByRole('button', { name: 'Riprova' }));
    // Presenza, non assenza: durante la rilettura c'è «Caricamento…», non un fascicolo vuoto finto.
    expect(await screen.findByText('Caricamento…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Nessun documento nel fascicolo.')).toBeNull();
    expect(lettureDocumenti()).toHaveLength(2);
    expect(new URL(String(lettureDocumenti()[1][0]), 'http://x').searchParams.get('alunnoId')).toBe(ALUNNO.id);

    await act(async () => { sblocca(); });
    expect(await screen.findByText(/pei-mio\.pdf/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Impossibile caricare i documenti del fascicolo.')).toBeNull();
  });

  it('(l) «Riprova» dopo un’eliminazione con rilettura 500: durante la rilettura NON ricompare l’elenco vecchio', async () => {
    await monta();
    fireEvent.click(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' }));
    const dialogo = await screen.findByRole('dialog');
    const base = fetchMock.getMockImplementation()!;
    let stato: 'guasto' | 'sospeso' = 'guasto';
    let sblocca: () => void = () => {};
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) {
        if (stato === 'guasto') return risposta(500, { error: 'x', codice: 'LETTURA_FALLITA' });
        await new Promise<void>((r) => { sblocca = r; });
      }
      return base(url, init);
    });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('Impossibile caricare i documenti del fascicolo.');
    const lettePrima = lettureDocumenti().length;

    stato = 'sospeso';
    documenti = [ALTRUI];
    fireEvent.click(within(avviso).getByRole('button', { name: 'Riprova' }));
    // L'elenco di PRIMA dell'eliminazione (con i suoi «Elimina») non torna a galla mentre
    // la rilettura è in volo: al suo posto «Caricamento…».
    expect(await screen.findByText('Caricamento…')).toBeTruthy();
    expect(screen.queryByText(/pei-mio\.pdf/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeNull();
    expect(lettureDocumenti()).toHaveLength(lettePrima + 1);

    await act(async () => { sblocca(); });
    expect(await screen.findByText(/pdp-collega\.pdf/)).toBeTruthy();
    expect(screen.queryByText(/pei-mio\.pdf/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('F2 · cambio di alunno', () => {
  /** Tiene in sospeso le GET (di `frammento`) per il SECONDO alunno. */
  function sospendiPerAlunno2(frammento: string) {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith(frammento) && url.includes(`alunnoId=${ALUNNO2.id}`)) {
        return new Promise(() => {});
      }
      return base(url, init);
    });
  }

  it('(i) con il cestino aperto, i «Ripristina» del primo alunno spariscono mentre la GET del secondo è in volo', async () => {
    alunni = [ALUNNO, ALUNNO2];
    await monta();
    fireEvent.click(screen.getByRole('button', { name: /^Cestino$/ }));
    const vista = await screen.findByTestId('fascicolo-cestino');
    await within(vista).findByRole('button', { name: 'Ripristina diagnosi-vecchia.pdf' });

    sospendiPerAlunno2('/api/primaria/fascicolo/cestino');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO2.id } });
    await waitFor(() =>
      expect(chiamate('GET', '/api/primaria/fascicolo/cestino').some(([u]) => String(u).includes(ALUNNO2.id))).toBe(true),
    );
    const vista2 = await screen.findByTestId('fascicolo-cestino');
    expect(await within(vista2).findByText('Caricamento…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ripristina/ })).toBeNull();
  });

  it('(i) nell’elenco, i documenti del primo alunno (e i loro «Elimina») spariscono mentre la GET del secondo è in volo', async () => {
    alunni = [ALUNNO, ALUNNO2];
    await monta();
    expect(screen.getByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeTruthy();

    sospendiPerAlunno2('/api/primaria/fascicolo?');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO2.id } });
    await waitFor(() => expect(lettureDocumenti().some(([u]) => String(u).includes(ALUNNO2.id))).toBe(true));
    // In volo si dice «Caricamento…», NON un fascicolo vuoto finto (un docente su rete
    // lenta ci crederebbe e ricaricherebbe un PEI che c'è già).
    expect(await screen.findByText('Caricamento…')).toBeTruthy();
    expect(screen.queryByText('Nessun documento nel fascicolo.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeNull();
  });

  it('(i) un 403 sul primo alunno non resta sotto il secondo mentre la sua GET è in volo', async () => {
    alunni = [ALUNNO, ALUNNO2];
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) {
        if (url.includes(`alunnoId=${ALUNNO.id}`)) return risposta(403, { error: 'x', codice: 'NEGATO' });
        if (url.includes(`alunnoId=${ALUNNO2.id}`)) return new Promise(() => {});
      }
      return base(url, init);
    });
    render(<FascicoloPage />);
    await screen.findByRole('option', { name: /Rossi Mario/ });
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: ALUNNO.id } });
    expect(await screen.findByText('Non sei autorizzato ad accedere al fascicolo di questo alunno.')).toBeTruthy();

    fireEvent.change(select, { target: { value: ALUNNO2.id } });
    await waitFor(() => expect(lettureDocumenti().some(([u]) => String(u).includes(ALUNNO2.id))).toBe(true));
    // Presenza prima dell'assenza: la sezione del secondo alunno è a schermo, in caricamento.
    expect(await screen.findByText('Caricamento…')).toBeTruthy();
    expect(screen.queryByText('Non sei autorizzato ad accedere al fascicolo di questo alunno.')).toBeNull();
  });

  it('(i) la GET del PRIMO alunno che LANCIA dopo il cambio: log `warn`, nessun avviso sotto il secondo', async () => {
    alunni = [ALUNNO, ALUNNO2];
    const PEI_ANNA = { ...MIO, id: 'f0000006-0000-4000-8000-000000000006', file_name: 'pei-anna.pdf' };
    let rifiutaPrimo: (e: unknown) => void = () => {};
    const rispostaPrimo = new Promise((_, rej) => { rifiutaPrimo = rej; });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) {
        if (url.includes(`alunnoId=${ALUNNO.id}`)) return rispostaPrimo;
        if (url.includes(`alunnoId=${ALUNNO2.id}`)) return risposta(200, { success: true, data: [PEI_ANNA] });
      }
      return base(url, init);
    });
    render(<FascicoloPage />);
    await screen.findByRole('option', { name: /Rossi Mario/ });
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: ALUNNO.id } });
    await waitFor(() => expect(lettureDocumenti().some(([u]) => String(u).includes(ALUNNO.id))).toBe(true));
    fireEvent.change(select, { target: { value: ALUNNO2.id } });
    await screen.findByText(/pei-anna\.pdf/);

    rifiutaPrimo(new TypeError('Failed to fetch'));
    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({
          livello: 'warn',
          messaggio: 'fascicolo-documenti-non-caricati-scartata: TypeError (risposta di un alunno non più selezionato)',
        }),
      ),
    );
    await svuotaCoda();
    expect(h.logClient).not.toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/pei-anna\.pdf/)).toBeTruthy();
  });

  it('(i) le pagelle del PRIMO alunno che LANCIANO dopo il cambio: log `warn`, nessun `error`', async () => {
    alunni = [ALUNNO, ALUNNO2];
    let rifiutaPagelle: (e: unknown) => void = () => {};
    const pagellePrimo = new Promise((_, rej) => { rifiutaPagelle = rej; });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/primaria/fascicolo/pagelle') && url.includes(`alunnoId=${ALUNNO.id}`)) return pagellePrimo;
      return base(url, init);
    });
    await monta();
    await waitFor(() =>
      expect(chiamate('GET', '/api/primaria/fascicolo/pagelle').some(([u]) => String(u).includes(ALUNNO.id))).toBe(true),
    );
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO2.id } });
    await waitFor(() => expect(lettureDocumenti().some(([u]) => String(u).includes(ALUNNO2.id))).toBe(true));

    rifiutaPagelle(new TypeError('Failed to fetch'));
    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({
          livello: 'warn',
          messaggio: 'fascicolo-pagelle-non-caricate-scartata: TypeError (risposta di un alunno non più selezionato)',
        }),
      ),
    );
    expect(h.logClient).not.toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }));
  });

  it('(i) la risposta del PRIMO alunno arrivata dopo il cambio non finisce sotto il secondo', async () => {
    alunni = [ALUNNO, ALUNNO2];
    const PEI_ANNA = { ...MIO, id: 'f0000005-0000-4000-8000-000000000005', file_name: 'pei-anna.pdf' };
    let sbloccaPrimo: (v: unknown) => void = () => {};
    const rispostaPrimo = new Promise((r) => { sbloccaPrimo = r; });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/primaria/fascicolo?')) {
        if (url.includes(`alunnoId=${ALUNNO.id}`)) return rispostaPrimo;
        if (url.includes(`alunnoId=${ALUNNO2.id}`)) return risposta(200, { success: true, data: [PEI_ANNA] });
      }
      return base(url, init);
    });
    render(<FascicoloPage />);
    await screen.findByRole('option', { name: /Rossi Mario/ });
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: ALUNNO.id } });
    await waitFor(() => expect(lettureDocumenti().some(([u]) => String(u).includes(ALUNNO.id))).toBe(true));
    fireEvent.change(select, { target: { value: ALUNNO2.id } });
    await screen.findByText(/pei-anna\.pdf/);

    sbloccaPrimo(risposta(200, { success: true, data: [MIO] }));
    await svuotaCoda();
    await svuotaCoda();
    expect(screen.queryByText(/pei-mio\.pdf/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Elimina pei-mio.pdf' })).toBeNull();
    expect(screen.getByText(/pei-anna\.pdf/)).toBeTruthy();
  });
});

describe('F2 · le copie client restano uguali al server', () => {
  it('(h) tipi e ruoli di gestione coincidono con `fascicolo-gestione.ts`', () => {
    expect([...TIPI_DOCUMENTO_FASCICOLO]).toEqual([...TIPI_FASCICOLO]);
    expect([...RUOLI_GESTORE_FASCICOLO].sort()).toEqual([...RUOLI_GESTIONE_FASCICOLO].sort());
  });

  it('(g) il 413 della piattaforma (senza corpo JSON) diventa «file troppo grande»', () => {
    expect(chiaveErroreFascicolo(413, null)).toBe('fascicoloMsgFileTroppoGrande');
    expect(chiaveErroreFascicolo(500, 'QUALCOSA_DI_NUOVO')).toBe('fascicoloErroreGenerico');
  });
});
