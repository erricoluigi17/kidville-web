import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * Fascicolo di PRIMARIA — «Apri» un documento e «Apri PDF» di una pagella
 * (spec 2026-09-24, compito F3).
 *
 * Prima: il documento si apriva con un `window.open` DOPO l'`await` della route
 * (nella WebView dell'app non apre niente: su iOS è bloccato), e la pagella con un
 * `window.open` sulla route (nella WebView niente schede). Ora:
 *
 *  · APP → il documento passa da `apriDocumento` (anteprima di sistema) con
 *    l'indirizzo FIRMATO della route, un nome SENZA il nome caricato (può
 *    contenere quello del minore) e il mime giusto; la pagella da
 *    `scaricaDocumento` (foglio «Salva su File») con la route della stessa origine.
 *    Nessun `window.open`. Un esito non riuscito si dice a schermo.
 *  · WEB → resta com'era: `window.open` dell'indirizzo firmato (qui con l'helper
 *    VERO, non un finto) e `window.open` della route della pagella.
 *
 * Nomi di fantasia: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nativo: vi.fn(() => false) }));

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: h.nativo }));
// Per difetto l'helper è quello VERO (il web si prova su ciò che fa davvero); i test
// dell'app ne fissano l'esito, perché i plugin nativi in jsdom non ci sono.
vi.mock('@/lib/native/scarica', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/native/scarica')>();
  return {
    ...vero,
    apriDocumento: vi.fn(vero.apriDocumento),
    scaricaDocumento: vi.fn(vero.scaricaDocumento),
  };
});

const DOCENTE = 'd0c00000-0000-4000-8000-000000000001';
const SEZIONE = '11111111-1111-4111-8111-111111111111';
const ALUNNO = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const ALUNNO2 = { id: 'aaaa2222-0000-4000-8000-000000000002', nome: 'Anna', cognome: 'Bianchi' };
const SCRUTINIO = '5c000000-0000-4000-8000-00000000000a';
const URL_FIRMATO = 'https://archivio.example.test/storage/v1/object/sign/sensitive_documents/x.pdf?token=abc';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`userId=${DOCENTE}`),
  useParams: () => ({ sectionId: SEZIONE }),
  usePathname: () => `/teacher/primaria/${SEZIONE}/fascicolo`,
}));

import FascicoloPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/fascicolo/page';
import { apriDocumento, scaricaDocumento, type RisultatoScaricoNativo } from '@/lib/native/scarica';
import {
  ESTENSIONE_PER_MIME_FASCICOLO_CLIENT,
  fileDocumentoFascicolo,
  nomeFilePagellaFascicolo,
} from '@/lib/primaria/fascicolo-scarico';
import { ESTENSIONE_PER_MIME_FASCICOLO } from '@/lib/primaria/fascicolo-gestione';
import itShared from '../../messages/it/shared.json';
import itTeacher from '../../messages/it/teacherPrimaria.json';

const apri = vi.mocked(apriDocumento);
const scarica = vi.mocked(scaricaDocumento);

/** Un nome caricato che contiene quello dell'alunno: non deve arrivare sul dispositivo. */
const DOC = {
  id: 'f0000001-0000-4000-8000-000000000001',
  document_type: 'pei',
  descrizione: 'Piano annuale',
  file_name: 'PEI Rossi Mario.pdf',
  expiry_date: null,
  created_at: '2026-09-20T08:00:00Z',
  caricato_da: DOCENTE,
};

const PAGELLE = [
  {
    annoScolastico: '2025/2026',
    pagelle: [
      { scrutinioId: SCRUTINIO, annoScolastico: '2025/2026', periodoNome: 'Primo quadrimestre', dataChiusura: null, dataPubblicazione: '2026-02-10' },
    ],
  },
];

const fetchMock = vi.fn();
const apriFinestra = vi.fn();
let rispostaFile: { status: number; corpo: unknown } = { status: 200, corpo: {} };

const risposta = (status: number, corpo: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

const chiamateFile = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/primaria/fascicolo/file'));

beforeEach(async () => {
  vi.clearAllMocks();
  // `clearAllMocks` non toglie le implementazioni fissate dai test dell'app: si
  // rimette l'helper VERO, o i test del web proverebbero il finto.
  const vero = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica');
  apri.mockImplementation(vero.apriDocumento);
  scarica.mockImplementation(vero.scaricaDocumento);
  h.nativo.mockReturnValue(false);
  rispostaFile = { status: 200, corpo: { success: true, data: { url: URL_FIRMATO, fileName: DOC.file_name } } };
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/primaria/classe/')) return risposta(200, { success: true, data: { alunni: [ALUNNO, ALUNNO2] } });
    if (url.startsWith('/api/primaria/me')) return risposta(200, { success: true, data: { ruolo: 'educator', userId: DOCENTE } });
    if (url.startsWith('/api/primaria/fascicolo/pagelle')) return risposta(200, { success: true, data: PAGELLE });
    if (url.startsWith('/api/primaria/fascicolo/file')) return risposta(rispostaFile.status, rispostaFile.corpo);
    if (url.startsWith('/api/primaria/fascicolo?')) return risposta(200, { success: true, data: [DOC] });
    throw new Error(`fetch inattesa: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  apriFinestra.mockImplementation(() => ({ opener: {}, closed: false }));
  vi.stubGlobal('open', apriFinestra);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function svuotaCoda() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function monta() {
  render(<FascicoloPage />);
  await screen.findByRole('option', { name: /Rossi Mario/ });
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO.id } });
  await screen.findByText(/PEI Rossi Mario\.pdf/);
  await screen.findByText('Primo quadrimestre');
  await svuotaCoda();
}

const bottoneApri = () => screen.getByRole('button', { name: 'Apri' });
const bottonePagella = () => screen.getByRole('button', { name: 'Apri PDF' });

describe('F3 · nome del file sul dispositivo', () => {
  it('niente nome caricato: tipo + frammento di uuid, mime dall’indirizzo firmato', () => {
    expect(fileDocumentoFascicolo(DOC, URL_FIRMATO, DOC.file_name)).toEqual({ nomeFile: 'fascicolo-pei-f0000001', mime: 'application/pdf' });
  });

  it('nome caricato SENZA estensione (provider Android, «dott.ssa …»): il mime viene dall’indirizzo', () => {
    expect(fileDocumentoFascicolo(DOC, URL_FIRMATO, '1000012345')).toEqual({ nomeFile: 'fascicolo-pei-f0000001', mime: 'application/pdf' });
    expect(fileDocumentoFascicolo(DOC, URL_FIRMATO, 'Relazione dott.ssa Bianchi')).toEqual({ nomeFile: 'fascicolo-pei-f0000001', mime: 'application/pdf' });
  });

  it('indirizzo ed estensione del nome in disaccordo: vince l’indirizzo', () => {
    const png = 'https://archivio.example.test/storage/v1/object/sign/sensitive_documents/a/1-x.png?token=abc.pdf#b.pdf';
    expect(fileDocumentoFascicolo(DOC, png, 'scansione.pdf')).toEqual({ nomeFile: 'fascicolo-pei-f0000001', mime: 'image/png' });
  });

  it('ripiego sul nome solo se l’indirizzo non ha un tipo riconosciuto (righe vecchie)', () => {
    const senzaEstensione = 'https://archivio.example.test/storage/v1/object/sign/sensitive_documents/a/1-x?token=abc';
    expect(fileDocumentoFascicolo(DOC, senzaEstensione, 'scansione.JPEG')).toEqual({ nomeFile: 'fascicolo-pei-f0000001', mime: 'image/jpeg' });
    // Percorso storico con l’estensione del nome: `jpeg` si riconosce anche nell’indirizzo.
    expect(fileDocumentoFascicolo(DOC, `${senzaEstensione.replace('1-x?', '1-x.JPEG?')}`, null)).toEqual({ nomeFile: 'fascicolo-pei-f0000001', mime: 'image/jpeg' });
  });

  it('tipo non ammesso dal caricamento o assente → nessun mime; tipo non sicuro → «documento»', () => {
    const heic = 'https://archivio.example.test/storage/v1/object/sign/sensitive_documents/a/1-x.heic?token=abc';
    expect(fileDocumentoFascicolo(DOC, heic, 'foto.heic')).toEqual({ nomeFile: 'fascicolo-pei-f0000001' });
    expect(fileDocumentoFascicolo(DOC, null, 'relazione.exe')).toEqual({ nomeFile: 'fascicolo-pei-f0000001' });
    expect(fileDocumentoFascicolo(DOC, undefined, null)).toEqual({ nomeFile: 'fascicolo-pei-f0000001' });
    expect(fileDocumentoFascicolo(DOC, 'https://h.test/a/b.constructor?t=1', 'x.constructor')).toEqual({ nomeFile: 'fascicolo-pei-f0000001' });
    expect(fileDocumentoFascicolo({ ...DOC, document_type: '../Rossi Mario' }, URL_FIRMATO, 'a.pdf').nomeFile).toBe('fascicolo-documento-f0000001');
  });

  it('la copia client della mappa mime→estensione è IDENTICA a quella del server', () => {
    expect(ESTENSIONE_PER_MIME_FASCICOLO_CLIENT).toEqual(ESTENSIONE_PER_MIME_FASCICOLO);
  });

  it('pagella: alunno e scrutinio, mai nomi', () => {
    expect(nomeFilePagellaFascicolo(ALUNNO.id, SCRUTINIO)).toBe('pagella-aaaa1111-5c000000.pdf');
  });
});

describe('F3 · APP — documento nell’anteprima, pagella nel foglio', () => {
  beforeEach(() => {
    h.nativo.mockReturnValue(true);
    apri.mockResolvedValue({ esito: 'nativo-anteprima' });
    scarica.mockResolvedValue({ esito: 'nativo-file' });
  });

  it('«Apri»: indirizzo firmato all’helper, con nome senza il nome caricato; niente window.open', async () => {
    await monta();
    fireEvent.change(screen.getByPlaceholderText(/finalit/i), { target: { value: 'verifica PEI' } });
    fireEvent.click(bottoneApri());
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    const [url] = chiamateFile()[0];
    expect(String(url)).toContain(`documentoId=${DOC.id}`);
    expect(String(url)).toContain(`userId=${DOCENTE}`);
    expect(String(url)).toContain('finalita=verifica%20PEI');
    const input = apri.mock.calls[0][0];
    expect(input).toMatchObject({
      sorgente: URL_FIRMATO,
      nomeFile: 'fascicolo-pei-f0000001',
      mime: 'application/pdf',
      etichetta: 'fascicolo',
    });
    expect(JSON.stringify(input)).not.toMatch(/Rossi|Mario/);
    expect(apriFinestra).not.toHaveBeenCalled();
  });

  it('«Apri» di un PDF caricato con un nome SENZA estensione: il mime arriva lo stesso (dall’indirizzo)', async () => {
    rispostaFile = { status: 200, corpo: { success: true, data: { url: URL_FIRMATO, fileName: '1000012345' } } };
    await monta();
    fireEvent.click(bottoneApri());
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    expect(apri.mock.calls[0][0]).toMatchObject({ sorgente: URL_FIRMATO, mime: 'application/pdf' });
  });

  it('route che rifiuta (403): testo tradotto dallo STATO, mai la prosa del server; log con lo stato', async () => {
    rispostaFile = { status: 403, corpo: { error: 'Accesso non consentito' } };
    await monta();
    fireEvent.click(bottoneApri());
    const avviso = await screen.findByText(itTeacher.fascicoloNonAutorizzato);
    // Nella sezione Documenti (l'esito della gestione, `role=alert`), non nella scheda di caricamento.
    expect(avviso.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText('Accesso non consentito')).toBeNull();
    expect(apri).not.toHaveBeenCalled();
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'fascicolo-apertura-indirizzo-non-ottenuto: http-403' }),
    );
  });

  it('route che risponde HTML (json lancia): avviso generico e log, niente eccezione', async () => {
    rispostaFile = { status: 502, corpo: null };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/primaria/fascicolo/file')) {
        return { ok: false, status: 502, json: async () => { throw new SyntaxError('html'); } };
      }
      if (url.startsWith('/api/primaria/classe/')) return risposta(200, { success: true, data: { alunni: [ALUNNO] } });
      if (url.startsWith('/api/primaria/me')) return risposta(200, { success: true, data: { ruolo: 'educator', userId: DOCENTE } });
      if (url.startsWith('/api/primaria/fascicolo/pagelle')) return risposta(200, { success: true, data: PAGELLE });
      return risposta(200, { success: true, data: [DOC] });
    });
    await monta();
    fireEvent.click(bottoneApri());
    const avviso = await screen.findByText(itTeacher.fascicoloDownloadNonRiuscito);
    expect(avviso.closest('[role="alert"]')).not.toBeNull();
    expect(apri).not.toHaveBeenCalled();
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'fascicolo-apertura-indirizzo-non-ottenuto: SyntaxError' }),
    );
  });

  it('esito non riuscito → «non si è aperto»; binario 1.0 → «aggiorna l’app»; poi un’apertura riuscita lo toglie', async () => {
    await monta();
    apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-404' });
    fireEvent.click(bottoneApri());
    expect(await screen.findByText(itShared.documentoNonAperto)).toBeTruthy();

    apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem', binarioDaAggiornare: true });
    await waitFor(() => expect((bottoneApri() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(bottoneApri());
    expect(await screen.findByText(itShared.documentoAppDaAggiornare)).toBeTruthy();

    apri.mockResolvedValueOnce({ esito: 'nativo-anteprima' });
    await waitFor(() => expect((bottoneApri() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(bottoneApri());
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText(itShared.documentoAppDaAggiornare)).toBeNull());
  });

  it('500 della route e poi un’apertura riuscita: l’avviso sparisce', async () => {
    rispostaFile = { status: 500, corpo: { success: false, error: 'Object not found' } };
    await monta();
    fireEvent.click(bottoneApri());
    expect(await screen.findByText(itTeacher.fascicoloDownloadNonRiuscito)).toBeTruthy();
    expect(screen.queryByText('Object not found')).toBeNull();
    expect(apri).not.toHaveBeenCalled();

    rispostaFile = { status: 200, corpo: { success: true, data: { url: URL_FIRMATO, fileName: DOC.file_name } } };
    await waitFor(() => expect((bottoneApri() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(bottoneApri());
    // Prima la PRESENZA della chiamata all'helper, poi l'assenza dell'avviso.
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    await svuotaCoda();
    expect(screen.queryByText(itTeacher.fascicoloDownloadNonRiuscito)).toBeNull();
  });

  it('doppio tocco durante un’apertura: una sola anteprima', async () => {
    await monta();
    let risolvi!: (r: RisultatoScaricoNativo) => void;
    apri.mockImplementationOnce(() => new Promise<RisultatoScaricoNativo>((r) => { risolvi = r; }));
    fireEvent.click(bottoneApri());
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    fireEvent.click(bottoneApri());
    await svuotaCoda();
    expect(apri).toHaveBeenCalledTimes(1);
    expect(chiamateFile()).toHaveLength(1);
    await act(async () => { risolvi({ esito: 'nativo-anteprima' }); });
    await waitFor(() => expect((bottoneApri() as HTMLButtonElement).disabled).toBe(false));
  });

  it('esito arrivato dopo un cambio di alunno: nessun avviso sotto l’altro alunno', async () => {
    await monta();
    let risolvi!: (r: RisultatoScaricoNativo) => void;
    apri.mockImplementationOnce(() => new Promise<RisultatoScaricoNativo>((r) => { risolvi = r; }));
    fireEvent.click(bottoneApri());
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: ALUNNO2.id } });
    await act(async () => { risolvi({ esito: 'non-riuscito', motivo: 'http-500' }); });
    await screen.findByText(/PEI Rossi Mario\.pdf/);
    await svuotaCoda();
    expect(screen.queryByText(itShared.documentoNonAperto)).toBeNull();
  });

  it('«Apri PDF» della pagella: route della stessa origine a scaricaDocumento; niente window.open', async () => {
    await monta();
    fireEvent.click(bottonePagella());
    await waitFor(() => expect(scarica).toHaveBeenCalledTimes(1));
    expect(scarica.mock.calls[0][0]).toMatchObject({
      sorgente: `/api/primaria/pagella?scrutinioId=${SCRUTINIO}&alunnoId=${ALUNNO.id}&userId=${DOCENTE}`,
      nomeFile: 'pagella-aaaa1111-5c000000.pdf',
      mime: 'application/pdf',
      etichetta: 'pagella',
    });
    expect(apriFinestra).not.toHaveBeenCalled();
    expect(apri).not.toHaveBeenCalled();
  });

  it('pagella non salvata → avviso; binario 1.0 → «aggiorna l’app»; doppio tocco ignorato', async () => {
    await monta();
    let risolvi!: (r: RisultatoScaricoNativo) => void;
    scarica.mockImplementationOnce(() => new Promise<RisultatoScaricoNativo>((r) => { risolvi = r; }));
    fireEvent.click(bottonePagella());
    fireEvent.click(bottonePagella());
    await svuotaCoda();
    expect(scarica).toHaveBeenCalledTimes(1);
    await act(async () => { risolvi({ esito: 'non-riuscito', motivo: 'http-500' }); });
    expect(await screen.findByText(itShared.documentoNonSalvato)).toBeTruthy();

    scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem', binarioDaAggiornare: true });
    fireEvent.click(bottonePagella());
    expect(await screen.findByText(itShared.documentoAppDaAggiornare)).toBeTruthy();

    scarica.mockResolvedValueOnce({ esito: 'nativo-file' });
    fireEvent.click(bottonePagella());
    await waitFor(() => expect(screen.queryByText(itShared.documentoAppDaAggiornare)).toBeNull());
    expect(scarica).toHaveBeenCalledTimes(3);
  });
});

describe('F3 · WEB — resta com’era', () => {
  it('«Apri»: scheda nuova sull’indirizzo firmato (helper vero)', async () => {
    await monta();
    fireEvent.click(bottoneApri());
    await waitFor(() => expect(apriFinestra).toHaveBeenCalledTimes(1));
    expect(apriFinestra).toHaveBeenCalledWith(URL_FIRMATO, '_blank');
    expect(scarica).not.toHaveBeenCalled();
    await svuotaCoda();
    expect(screen.queryByText(itShared.documentoNonAperto)).toBeNull();
  });

  it('«Apri PDF»: scheda nuova sulla route, nessun helper', async () => {
    await monta();
    fireEvent.click(bottonePagella());
    expect(apriFinestra).toHaveBeenCalledWith(
      `/api/primaria/pagella?scrutinioId=${SCRUTINIO}&alunnoId=${ALUNNO.id}&userId=${DOCENTE}`,
      '_blank',
    );
    expect(scarica).not.toHaveBeenCalled();
    expect(apri).not.toHaveBeenCalled();
  });
});
