import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';
import itChat from '../../messages/it/parentChat.json';
import itComunicazioni from '../../messages/it/adminComunicazioni.json';

/**
 * LA SEGRETERIA VEDE LE FOTO E I DOCUMENTI DELLA CHAT (spec 2026-11-03, Compito 6).
 *
 * Fino a oggi la pagina `/admin/messaggi` non mostrava dell'allegato nemmeno il segnaposto: una
 * bolla con una foto era una bolla con il solo testo. Ora le due schede disegnano la miniatura
 * (che apre il visore a tutto schermo, lo stesso di genitore e docente) e il chip del documento:
 *
 *  · «Con i genitori» → visore con il SOLO «Scarica» (etichetta `chat`), che scarica l'indirizzo
 *    della bolla: la scheda non ha polling e una firma scaduta dopo dieci minuti è il normale
 *    «scaricamento non riuscito» (spec, scelta minore 4);
 *  · «Tutti» (la supervisione silenziosa) → visore con il solo «Scarica», che però passa PRIMA dalla
 *    route di vigilanza: la route lascia la riga `scarico` nel registro, e solo se ci riesce
 *    consegna un indirizzo fresco con cui si scarica. Se la route rifiuta (503: registro guasto o
 *    fuori sede) il file NON arriva e l'avviso è a schermo — è l'unico contrappeso della vigilanza
 *    silenziosa, e un file uscito senza riga è esattamente ciò che questa scheda deve impedire.
 *
 * `@/lib/native/scarica` è finto: ciò che conta è CHI scarica, con QUALE indirizzo (quello della
 * risposta della route, mai quello della bolla) e con quale etichetta. Il resto — visore, comandi,
 * hook delle azioni — è vero. Nomi, URL e uuid sono di fantasia: in questo repo non entrano dati
 * di bambini.
 */

const h = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    scaricaMedia: vi.fn<(input: Record<string, unknown>) => Promise<{ esito: string; motivo?: string }>>(),
    condividiMedia: vi.fn<(input: Record<string, unknown>) => Promise<{ esito: string; motivo?: string }>>(),
    puoCondividere: vi.fn<() => boolean>(),
    logClient: vi.fn(),
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(''),
    usePathname: () => '/admin/messaggi',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'seg-1', role: 'segreteria', ready: true }),
}));

vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
        selezionate: [],
        effettive: [SEDE_A],
        sedeCorrente: SEDE_A,
        reFetchKey: SEDE_A,
        loading: false,
        toggle: vi.fn(),
        soloSede: vi.fn(),
        tutte: vi.fn(),
    }),
}));

vi.mock('@/lib/native/scarica', async () => {
    const vero = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica');
    return {
        ...vero,
        scaricaMedia: h.scaricaMedia,
        condividiMedia: h.condividiMedia,
        puoCondividereFileMedia: h.puoCondividere,
    };
});

vi.mock('@/lib/logging/client', async () => {
    const vero = await vi.importActual<typeof import('@/lib/logging/client')>('@/lib/logging/client');
    return {
        ...vero,
        logClient: h.logClient,
        nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
    };
});

import MessaggiPage from '@/app/(dashboard)/admin/messaggi/page';

const APRI = itChat.chatApriFoto;
const ROUTE_SCARICO = '/api/admin/chat/messages/scarico';
const AVVISO_NON_REGISTRATO =
    'Lo scarico non si è potuto registrare, quindi non è partito. Riprova fra qualche minuto.';

/** L'indirizzo che la bolla porta dalla GET, e quello FRESCO che risponde la route di vigilanza. */
const URL_BOLLA = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/aaaa-foto-gita.jpg?token=della-bolla';
const URL_FRESCO = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/aaaa-foto-gita.jpg?token=fresco';
const URL_DOC = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/bbbb-scheda.pdf?token=d1';
const PERCORSO_GREZZO = 'th-1/cccc-non-firmata.jpg';

const CONTATTI = [
    { parentUserId: 'u-a', parentName: 'Rossi Anna', studentId: 's-a', studentName: 'Alfa Rossi', classe: '2 ANNI', scuolaId: SEDE_A },
];

const THREAD = {
    id: 'th-1',
    last_message_at: '2026-11-03T08:05:00.000Z',
    teacher: { id: 'doc-1', nome: 'Maestra Prova' },
    parent: { id: 'u-a', nome: 'Rossi Anna' },
    student: { nome: 'Alfa Rossi', classe: '2 ANNI' },
    sospensione: null,
};

/** Un testo, una foto, un documento, una foto col percorso grezzo (non firmata): le quattro forme. */
const MESSAGGI = [
    { id: 'm-testo', sender_id: 'u-a', content: 'Buongiorno maestra', attachment_url: null, attachment_type: null, created_at: '2026-11-03T08:00:00.000Z' },
    { id: 'm-foto', sender_id: 'u-a', content: 'Ecco la gita', attachment_url: URL_BOLLA, attachment_type: 'image', created_at: '2026-11-03T08:01:00.000Z' },
    { id: 'm-doc', sender_id: 'doc-1', content: 'La scheda firmata', attachment_url: URL_DOC, attachment_type: 'document', created_at: '2026-11-03T08:02:00.000Z' },
    { id: 'm-grezza', sender_id: 'u-a', content: 'Un’altra foto', attachment_url: PERCORSO_GREZZO, attachment_type: 'image', created_at: '2026-11-03T08:03:00.000Z' },
];

type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };
const rispostaOk = (url: string = URL_FRESCO): Risposta => ({ ok: true, status: 200, json: async () => ({ success: true, url }) });
const rispostaRifiuto = (status: number, codice: string): Risposta => ({ ok: false, status, json: async () => ({ error: 'x', codice }) });

function conRete({ scarico }: { scarico?: () => Promise<Risposta> } = {}) {
    h.fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/admin/chat/contacts')) {
            return Promise.resolve({ ok: true, json: async () => ({ success: true, data: CONTATTI }) });
        }
        if (u === '/api/chat/threads' && init?.method === 'POST') {
            return Promise.resolve({ ok: true, json: async () => ({ id: 'th-1' }) });
        }
        if (u.startsWith('/api/chat/messages?')) {
            return Promise.resolve({ ok: true, json: async () => ({ messages: MESSAGGI, total: MESSAGGI.length }) });
        }
        // La route di scarico PRIMA di quella dei messaggi: sono prefisso l'una dell'altra.
        if (u === ROUTE_SCARICO) return scarico ? scarico() : Promise.resolve(rispostaOk());
        if (u.startsWith('/api/admin/chat/threads')) {
            return Promise.resolve({
                ok: true,
                json: async () => ({ success: true, data: [THREAD], filtri: { docenti: [], genitori: [], classi: [] } }),
            });
        }
        if (u.startsWith('/api/admin/chat/messages?')) {
            return Promise.resolve({ ok: true, json: async () => ({ success: true, data: MESSAGGI }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', h.fetchMock);
}

/** Le chiamate alla route di scarico di vigilanza fatte finora. */
function chiamateScarico() {
    return h.fetchMock.mock.calls.filter(([u]) => String(u) === ROUTE_SCARICO);
}

beforeEach(() => {
    vi.clearAllMocks();
    h.puoCondividere.mockReturnValue(true);
    h.scaricaMedia.mockResolvedValue({ esito: 'web-blob' });
    h.condividiMedia.mockResolvedValue({ esito: 'nativo-foglio' });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Scheda «Con i genitori»: apre la prima famiglia e aspetta che la conversazione sia a schermo. */
async function apriLaConversazioneConUnaFamiglia() {
    render(<MessaggiPage />);
    fireEvent.click(await screen.findByText('Rossi Anna'));
    // Il segnale POSITIVO: il testo di un messaggio. Aspettare un'assenza passerebbe a fetch in volo.
    await screen.findByText('Ecco la gita');
}

/** Scheda «Tutti»: apre la supervisione sulla prima conversazione e aspetta i messaggi. */
async function apriLaSupervisione() {
    render(<MessaggiPage />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itComunicazioni.messaggiTabTutti, 'i') }));
    fireEvent.click(await screen.findByText(/Rossi Anna ↔ Maestra Prova/));
    await screen.findByText('Ecco la gita');
}

/** Tocca l'unica miniatura e restituisce il visore aperto. */
async function apriLaFoto() {
    const miniature = await screen.findAllByRole('button', { name: APRI });
    // Una sola: il percorso grezzo non si disegna e il documento non è una foto.
    expect(miniature).toHaveLength(1);
    fireEvent.click(miniature[0]);
    return screen.getByRole('dialog', { name: 'Foto 1 di 1 della conversazione' });
}

describe('/admin/messaggi — «Con i genitori»: foto e documenti', () => {
    it('la foto compare e apre il visore con solo Scarica', async () => {
        conRete();
        await apriLaConversazioneConUnaFamiglia();

        const miniatura = screen.getByRole('button', { name: APRI });
        expect(within(miniatura).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_BOLLA);
        expect(screen.queryByRole('dialog')).toBeNull();

        const dialogo = await apriLaFoto();
        expect(dialogo.getAttribute('aria-modal')).toBe('true');
        expect(within(dialogo).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_BOLLA);
        expect(within(dialogo).getByRole('button', { name: 'Scarica' })).toBeInTheDocument();
        // Il dispositivo SAPREBBE condividere un file (`puoCondividere` è vero): se «Condividi» non
        // c'è è perché la segreteria non ha quel comando, non perché il test lo nasconde.
        expect(within(dialogo).queryByRole('button', { name: 'Condividi' })).toBeNull();
    });

    it('Scarica scarica l’indirizzo della bolla, con etichetta «chat» e il nome neutro, senza passare dalla vigilanza', async () => {
        conRete();
        await apriLaConversazioneConUnaFamiglia();
        const dialogo = await apriLaFoto();

        fireEvent.click(within(dialogo).getByRole('button', { name: 'Scarica' }));

        await waitFor(() => expect(h.scaricaMedia).toHaveBeenCalledTimes(1));
        expect(h.scaricaMedia).toHaveBeenCalledWith(
            expect.objectContaining({ url: URL_BOLLA, tipo: 'foto', nomeFile: 'kidville-foto.jpg', etichetta: 'chat' }),
        );
        // Questa scheda NON è la supervisione: nessuna riga di registro da chiedere.
        expect(chiamateScarico()).toHaveLength(0);
    });

    it('un documento compare come chip apribile; un messaggio col percorso grezzo non ha né miniatura né chip', async () => {
        conRete();
        await apriLaConversazioneConUnaFamiglia();

        const chip = screen.getByRole('link', { name: /Documento allegato/ });
        expect(chip.getAttribute('href')).toBe(URL_DOC);
        expect(chip.getAttribute('target')).toBe('_blank');
        expect(chip.getAttribute('rel')).toBe('noopener noreferrer');

        // Una miniatura sola (la foto firmata): il percorso grezzo non è un indirizzo, e un `<img>` lì
        // sarebbe un'immagine rotta.
        expect(screen.getAllByRole('button', { name: APRI })).toHaveLength(1);
        for (const img of document.querySelectorAll('img')) {
            expect(img.getAttribute('src')?.startsWith('http'), 'una <img> con un percorso grezzo').toBe(true);
        }
    });
});

describe('/admin/messaggi — «Tutti» (supervisione): foto e documenti', () => {
    it('la foto compare e apre il visore con solo Scarica', async () => {
        conRete();
        await apriLaSupervisione();

        const dialogo = await apriLaFoto();
        expect(within(dialogo).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_BOLLA);
        expect(within(dialogo).getByRole('button', { name: 'Scarica' })).toBeInTheDocument();
        expect(within(dialogo).queryByRole('button', { name: 'Condividi' })).toBeNull();
        // Aprire il visore non scarica niente e non chiede niente alla vigilanza: è il tocco su
        // Scarica che lo fa.
        expect(h.scaricaMedia).not.toHaveBeenCalled();
        expect(chiamateScarico()).toHaveLength(0);
    });

    it('un documento compare come chip apribile anche nella supervisione', async () => {
        conRete();
        await apriLaSupervisione();

        const chip = screen.getByRole('link', { name: /Documento allegato/ });
        expect(chip.getAttribute('href')).toBe(URL_DOC);
        expect(chip.getAttribute('target')).toBe('_blank');
    });

    it('Scarica chiama la route di vigilanza col message_id e scarica l’URL che riceve', async () => {
        conRete();
        await apriLaSupervisione();
        const dialogo = await apriLaFoto();

        fireEvent.click(within(dialogo).getByRole('button', { name: 'Scarica' }));

        await waitFor(() => expect(h.scaricaMedia).toHaveBeenCalledTimes(1));
        expect(chiamateScarico()).toHaveLength(1);
        const [, init] = chiamateScarico()[0] as [string, RequestInit];
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ message_id: 'm-foto' });
        // L'indirizzo è quello della RISPOSTA della route, non quello della bolla: è l'unico che
        // la vigilanza ha firmato dopo aver scritto la riga di registro.
        const dati = h.scaricaMedia.mock.calls[0][0];
        expect(dati.url).toBe(URL_FRESCO);
        expect(dati.url).not.toBe(URL_BOLLA);
        expect(dati).toMatchObject({ tipo: 'foto', nomeFile: 'kidville-foto.jpg', etichetta: 'chat-vigilanza' });
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('la route risponde 503 → avviso a schermo, nessuno scarico', async () => {
        conRete({ scarico: () => Promise.resolve(rispostaRifiuto(503, 'VIGILANZA_NON_TRACCIABILE')) });
        await apriLaSupervisione();
        const dialogo = await apriLaFoto();

        fireEvent.click(within(dialogo).getByRole('button', { name: 'Scarica' }));

        await waitFor(() => expect(window.alert).toHaveBeenCalledWith(AVVISO_NON_REGISTRATO));
        expect(h.scaricaMedia).not.toHaveBeenCalled();
        // Una riga per gesto, a `warn`, con lo STATO e nient'altro di ciò che riguarda il file.
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'warn',
                messaggio: 'chat-vigilanza-scarico-rifiutato',
                campi: { stato: 503 },
            }),
        );
        const righe = JSON.stringify(h.logClient.mock.calls);
        expect(righe, 'un indirizzo firmato (o il nome del file) è finito nei log').not.toContain('firmato.test');
        expect(righe).not.toContain('foto-gita');
    });

    it('un errore di rete: lo stesso avviso, la stessa riga (stato 0, col nome della classe), nessuno scarico', async () => {
        conRete({ scarico: () => Promise.reject(new TypeError('Failed to fetch')) });
        await apriLaSupervisione();
        const dialogo = await apriLaFoto();

        fireEvent.click(within(dialogo).getByRole('button', { name: 'Scarica' }));

        await waitFor(() => expect(window.alert).toHaveBeenCalledWith(AVVISO_NON_REGISTRATO));
        expect(h.scaricaMedia).not.toHaveBeenCalled();
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'warn',
                messaggio: 'chat-vigilanza-scarico-rifiutato',
                campi: { stato: 0, error_code: 'TypeError' },
            }),
        );
    });

    it('un 200 senza indirizzo non è uno scarico: stesso avviso, nessun file', async () => {
        conRete({ scarico: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }) });
        await apriLaSupervisione();
        const dialogo = await apriLaFoto();

        fireEvent.click(within(dialogo).getByRole('button', { name: 'Scarica' }));

        await waitFor(() => expect(window.alert).toHaveBeenCalledWith(AVVISO_NON_REGISTRATO));
        expect(h.scaricaMedia).not.toHaveBeenCalled();
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: 'chat-vigilanza-scarico-rifiutato', campi: { stato: 200 } }),
        );
    });

    it('dopo un rifiuto il pulsante torna premibile, e un nuovo tocco chiede di nuovo alla route', async () => {
        let n = 0;
        conRete({
            scarico: () => {
                n += 1;
                return Promise.resolve(n === 1 ? rispostaRifiuto(503, 'VIGILANZA_NON_TRACCIABILE') : rispostaOk());
            },
        });
        await apriLaSupervisione();
        const dialogo = await apriLaFoto();

        fireEvent.click(within(dialogo).getByRole('button', { name: 'Scarica' }));
        await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1));
        // Il pulsante si riarma quando la promessa si risolve: l'attesa è sulla PRESENZA di «Scarica»
        // (con «Preparo…» il nome cambia), non su un'assenza.
        const di_nuovo = await within(dialogo).findByRole('button', { name: 'Scarica' });
        await waitFor(() => expect(di_nuovo).not.toBeDisabled());
        fireEvent.click(di_nuovo);

        await waitFor(() => expect(h.scaricaMedia).toHaveBeenCalledTimes(1));
        expect(chiamateScarico()).toHaveLength(2);
        expect(h.scaricaMedia.mock.calls[0][0].url).toBe(URL_FRESCO);
    });

    it('due tocchi rapidi su Scarica → UNA sola POST alla route (il pulsante resta spento finché la richiesta è in volo)', async () => {
        // La POST non si risolve finché non lo decide il test: è il «volo» in cui arriva il secondo tocco.
        let risolvi!: (r: Risposta) => void;
        const inVolo = new Promise<Risposta>((r) => { risolvi = r; });
        conRete({ scarico: () => inVolo });
        await apriLaSupervisione();
        const dialogo = await apriLaFoto();
        const scarica = within(dialogo).getByRole('button', { name: 'Scarica' });

        fireEvent.click(scarica);
        // Un giro di microtask FRA i due tocchi, come in un dito vero (due `click` sincroni
        // arriverebbero prima di qualunque `finally` e il test non vedrebbe la differenza): se il
        // visore non attendesse la promessa di `onScaricaVigilanza` il pulsante si riarmerebbe qui,
        // e il secondo tocco partirebbe con la prima richiesta ancora in volo.
        await act(async () => {});
        fireEvent.click(scarica);

        expect(chiamateScarico(), 'il secondo tocco ha chiesto alla vigilanza una seconda riga di registro').toHaveLength(1);
        expect(scarica).toBeDisabled();
        expect(h.scaricaMedia).not.toHaveBeenCalled();

        await act(async () => { risolvi(rispostaOk()); });
        await waitFor(() => expect(h.scaricaMedia).toHaveBeenCalledTimes(1));
        expect(chiamateScarico()).toHaveLength(1);
    });
});
