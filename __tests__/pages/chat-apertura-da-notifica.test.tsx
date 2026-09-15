/**
 * IL TOCCO SULLA NOTIFICA APRE LA CONVERSAZIONE, NELLE DUE PAGINE MONTATE DAVVERO (parte C, 2026-09-15).
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Decisione del titolare (2026-09-14): chi tocca la notifica di un messaggio deve trovarsi DENTRO la
 * conversazione, non davanti alla lista. Il link porta `?thread=<id>` (route), e la conversazione
 * arriva alla pagina in due modi:
 *  · con l'URL, se la pagina si monta adesso (avvio a freddo, tocco da un'altra pagina);
 *  · con l'evento `kv:chat-apri-thread`, se la pagina chat è già aperta — in Next 16 una push allo
 *    stesso URL non la rimonterebbe.
 *
 * Le regole che questo file prova, sulle due pagine con lo stesso copione:
 *  · la conversazione si apre senza nessun clic, a schermo intero su un telefono, e il parametro
 *    sparisce dall'URL (con `userId` intatto): un Indietro o un rendering dopo non la riaprono;
 *  · un id che l'utente non ha: UNA ricarica della lista, poi niente, e una riga di log senza l'id;
 *  · nessuna GET in più: la lista in volo si aspetta, la GET dei messaggi in volo si riusa;
 *  · la scelta fatta a mano vince sempre sulla notifica, anche su quella rimasta in sospeso: per un
 *    docente, finire da solo nella conversazione di un'altra famiglia è proprio il difetto da evitare;
 *  · se la lista non si carica, la richiesta non si butta: si apre quando la lista arriva.
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────
 *
 * La query la dà `window.location`, come in Next 16 (dove `history.replaceState` aggiorna
 * `useSearchParams`). La rete finta risponde per URL e può trattenere o far fallire una richiesta.
 * I testi sono quelli veri del catalogo italiano (mock globale di next-intl in `test/setup.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import type { ComponentType } from 'react';

type Json = Record<string, unknown>;
type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    push: vi.fn(),
    utente: 'gen-1',
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: h.utente, ready: true, role: 'x' }),
}));
vi.mock('@/components/features/chat/useChatRealtime', () => ({ useChatRealtime: () => {} }));
vi.mock('@/components/features/chat/useUnreadNotifications', () => ({ useUnreadNotifications: () => {} }));
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: h.push, refresh: vi.fn(), replace: vi.fn() }),
    // Come Next 16: la query è quella della barra degli indirizzi, e `history.replaceState` la cambia.
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => window.location.pathname,
    useParams: () => ({}),
}));

import ParentChatPage from '@/app/(dashboard)/parent/chat/page';
import TeacherChatPage from '@/app/(dashboard)/teacher/chat/page';
import { richiediAperturaThread } from '@/lib/chat/apertura-thread';

/* ── Dati ──────────────────────────────────────────────────────────────────── */

const TH_A = '00000000-0000-4000-8000-0000000000a1';
const TH_B = '00000000-0000-4000-8000-0000000000b2';
/** Una conversazione che non è di chi guarda. */
const TH_X = '00000000-0000-4000-8000-0000000000c3';

type Pagina = {
    nome: string;
    Pagina: ComponentType;
    rotta: '/parent/chat' | '/teacher/chat';
    io: string;
    altro: string;
    nomeA: string;
    nomeB: string;
    ruoloAltro: string;
};

const PAGINE: Pagina[] = [
    { nome: 'genitore', Pagina: ParentChatPage, rotta: '/parent/chat', io: 'gen-1', altro: 'doc-1', nomeA: 'Maestra Prova', nomeB: 'Maestra Seconda', ruoloAltro: 'teacher' },
    { nome: 'docente', Pagina: TeacherChatPage, rotta: '/teacher/chat', io: 'doc-1', altro: 'gen-1', nomeA: 'Genitore Prova', nomeB: 'Genitore Secondo', ruoloAltro: 'parent' },
];

function thread(p: Pagina, id: string, nomeCompleto: string): Json {
    const [first, last] = nomeCompleto.split(' ');
    const genitore = p.nome === 'genitore';
    return {
        id,
        teacher_id: genitore ? p.altro : p.io,
        parent_id: genitore ? p.io : p.altro,
        student_id: 'alu-1',
        other_user: { first_name: first, last_name: last, role: p.ruoloAltro },
        student: { nome: 'Alunno', cognome: 'Prova', classe_sezione: 'Girasoli' },
        last_message: null,
        last_message_at: id === TH_A ? '2026-09-14T07:00:00.000Z' : '2026-09-14T06:30:00.000Z',
        unread_count: 0,
        sospensione: null,
    };
}

function messaggio(threadId: string, id: string, mittente: string, testo: string): Json {
    return {
        id,
        thread_id: threadId,
        sender_id: mittente,
        content: testo,
        attachment_url: null,
        attachment_type: null,
        read_at: '2026-09-14T08:00:00.000Z',
        delivered_at: null,
        created_at: '2026-09-14T08:00:00.000Z',
    };
}

/* ── La rete finta ─────────────────────────────────────────────────────────── */

const rete = {
    threads: [] as Json[],
    messaggi: {} as Record<string, Json[]>,
    chiamate: [] as Array<{ metodo: string; percorso: string; url: string; body: Json | undefined }>,
    trattenute: [] as Array<{ url: string; libera: () => void; rompi: (e: unknown) => void }>,
    trattieni: null as null | ((metodo: string, url: string) => boolean),
    /** Quali GET della lista (1 = la prima) cadono per rete. */
    threadsCheFalliscono: [] as number[],
};

function ok(data: unknown, status = 200): Risposta {
    return { ok: status < 400, status, json: async () => data };
}

function rispondi(metodo: string, url: string): Risposta {
    const percorso = url.split('?')[0];
    if (percorso === '/api/chat/threads' && metodo === 'GET') {
        const n = rete.chiamate.filter((c) => c.metodo === 'GET' && c.percorso === '/api/chat/threads').length;
        if (rete.threadsCheFalliscono.includes(n)) throw new TypeError('Failed to fetch');
        return ok(rete.threads);
    }
    if (percorso === '/api/chat/messages' && metodo === 'GET') {
        const threadId = new URL(url, 'http://x').searchParams.get('threadId') ?? '';
        const lista = rete.messaggi[threadId] ?? [];
        return ok({ messages: lista, total: lista.length, precedenti: 0 });
    }
    if (percorso === '/api/chat/messages' && metodo === 'POST') {
        const corpo = rete.chiamate[rete.chiamate.length - 1].body ?? {};
        return ok(messaggio(String(corpo.thread_id), `m-post-${rete.chiamate.length}`, h.utente, String(corpo.content)), 201);
    }
    if (percorso === '/api/chat/messages/read') return ok({ success: true });
    if (percorso === '/api/chat/contacts') return ok({ contacts: [], motivo: null });
    return ok({});
}

function fetchFinto(input: string, init?: { method?: string; body?: unknown }): Promise<Risposta> {
    const url = String(input);
    const metodo = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    rete.chiamate.push({ metodo, percorso: url.split('?')[0], url, body });
    // La risposta si calcola ADESSO (il conteggio delle GET della lista è quello di questa richiesta),
    // anche quando la si consegna dopo.
    let esito: { risposta: Risposta } | { errore: unknown };
    try {
        esito = { risposta: rispondi(metodo, url) };
    } catch (e) {
        esito = { errore: e };
    }
    const consegna = (resolve: (r: Risposta) => void, reject: (e: unknown) => void) =>
        'risposta' in esito ? resolve(esito.risposta) : reject(esito.errore);
    if (rete.trattieni?.(metodo, url)) {
        return new Promise((resolve, reject) => {
            rete.trattenute.push({ url, libera: () => consegna(resolve, reject), rompi: reject });
        });
    }
    return new Promise(consegna);
}

function chiamate(metodo: string, percorso: string) {
    return rete.chiamate.filter((c) => c.metodo === metodo && c.percorso === percorso);
}

/** Le GET dei messaggi di una conversazione. */
function getMessaggi(threadId: string) {
    return rete.chiamate.filter((c) => c.metodo === 'GET' && c.url.startsWith(`/api/chat/messages?threadId=${threadId}`));
}

async function libera(frammento: string) {
    const i = rete.trattenute.findIndex((r) => r.url.includes(frammento));
    if (i < 0) throw new Error(`nessuna richiesta trattenuta con ${frammento}`);
    const [r] = rete.trattenute.splice(i, 1);
    await act(async () => {
        r.libera();
        for (let k = 0; k < 5; k++) await Promise.resolve();
    });
}

async function scorri() {
    await act(async () => {
        for (let k = 0; k < 10; k++) await Promise.resolve();
    });
}

/* ── Attrezzi di pagina ────────────────────────────────────────────────────── */

class FintoIO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
}

const suPagina = (url: string) => window.history.replaceState(null, '', url);

async function apri(nome: string) {
    fireEvent.click((await screen.findAllByText(nome))[0]);
}

/**
 * La conversazione è a schermo in ENTRAMBE le istanze e mostra `testo`. Due contenitori vogliono dire
 * anche che la vista mobile è passata alla conversazione: con la lista, quella a schermo intero non c'è.
 */
async function aSchermo(testo: string) {
    await waitFor(() => {
        const scatole = screen.getAllByTestId('chat-messaggi');
        expect(scatole, 'la conversazione non è a schermo intero: la vista mobile è rimasta sulla lista').toHaveLength(2);
        for (const c of scatole) expect(within(c).getByText(testo)).toBeInTheDocument();
    });
}

/** Le righe di log dell'apertura da notifica. */
function logApertura() {
    return h.logClient.mock.calls
        .map((c) => c[0] as { livello: string; evento: string; messaggio: string; route?: string })
        .filter((e) => e.messaggio.startsWith('chat-apertura-da-notifica'));
}

beforeEach(() => {
    rete.threads = [];
    rete.messaggi = {};
    rete.chiamate = [];
    rete.trattenute = [];
    rete.trattieni = null;
    rete.threadsCheFalliscono = [];
    h.logClient.mockClear();
    h.push.mockClear();
    vi.stubGlobal('fetch', vi.fn(fetchFinto));
    vi.stubGlobal('IntersectionObserver', FintoIO as unknown as typeof IntersectionObserver);
    Element.prototype.scrollIntoView = function () {};
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    suPagina('/');
});

/* ── I casi ────────────────────────────────────────────────────────────────── */

describe.each(PAGINE)('chat del $nome — il tocco sulla notifica apre la conversazione', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('?thread=B all’apertura: B si apre senza clic, a schermo intero, e il parametro sparisce (userId resta)', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_A] = [messaggio(TH_A, 'm-a', p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        suPagina(`${p.rotta}?userId=${p.io}&thread=${TH_B}`);

        render(<p.Pagina />);
        await aSchermo('Messaggio di B');

        await waitFor(() => expect(window.location.search, 'il parametro è rimasto: un rendering dopo riaprirebbe la conversazione').toBe(`?userId=${p.io}`));
        expect(window.location.pathname).toBe(p.rotta);
        expect(h.push, 'aprire la conversazione non è una navigazione').not.toHaveBeenCalled();
        // Nessuna richiesta in più: la lista iniziale, e i messaggi della sola conversazione aperta.
        expect(chiamate('GET', '/api/chat/threads')).toHaveLength(1);
        expect(getMessaggi(TH_B)).toHaveLength(1);
        expect(getMessaggi(TH_A)).toHaveLength(0);
        // Il SUCCESSO si registra: senza, «nessun log» non distinguerebbe «si apre» da «non parte niente».
        expect(logApertura()).toEqual([
            expect.objectContaining({ livello: 'warn', evento: 'push', messaggio: 'chat-apertura-da-notifica: aperta (url)', route: p.rotta }),
        ]);
        expect(JSON.stringify(h.logClient.mock.calls), 'l’id della conversazione è finito nel log').not.toContain(TH_B);
    });

    it('?thread=<una conversazione non sua>: UNA ricarica della lista, niente di aperto, un log senza l’id, parametro tolto', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        suPagina(`${p.rotta}?thread=${TH_X}`);

        render(<p.Pagina />);
        await waitFor(() => expect(logApertura()).toHaveLength(1));

        expect(logApertura()[0]).toMatchObject({ livello: 'warn', evento: 'push', messaggio: 'chat-apertura-da-notifica: non-trovata (url)', route: p.rotta });
        expect(chiamate('GET', '/api/chat/threads'), 'la lista si ricarica UNA volta, non di più').toHaveLength(2);
        expect(chiamate('GET', '/api/chat/messages')).toHaveLength(0);
        expect(screen.queryAllByTestId('chat-messaggi')).toHaveLength(0);
        expect(window.location.search).toBe('');
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(TH_X);
    });

    it('?thread=abc (non è un id): nessuna richiesta in più, un log, parametro tolto', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        suPagina(`${p.rotta}?thread=abc`);

        render(<p.Pagina />);
        await waitFor(() => expect(logApertura()).toHaveLength(1));
        await screen.findAllByText(p.nomeA);
        await scorri();

        expect(logApertura()[0]).toMatchObject({ livello: 'warn', evento: 'push', messaggio: 'chat-apertura-da-notifica: id-non-valido (url)' });
        expect(chiamate('GET', '/api/chat/threads')).toHaveLength(1);
        expect(chiamate('GET', '/api/chat/messages')).toHaveLength(0);
        expect(window.location.search).toBe('');
    });

    it('pagina già aperta: il tocco arriva come evento, B si apre senza navigare né ricaricare la lista', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        suPagina(p.rotta);
        render(<p.Pagina />);
        await screen.findAllByText(p.nomeB);

        let consegnato = false;
        act(() => {
            consegnato = richiediAperturaThread(TH_B);
        });
        expect(consegnato, 'la pagina chat montata non ascolta l’evento').toBe(true);
        await aSchermo('Messaggio di B');

        expect(h.push).not.toHaveBeenCalled();
        expect(chiamate('GET', '/api/chat/threads')).toHaveLength(1);
        expect(getMessaggi(TH_B)).toHaveLength(1);
        expect(logApertura()).toEqual([expect.objectContaining({ messaggio: 'chat-apertura-da-notifica: aperta (evento)' })]);

        // Smontata la pagina, non ascolta più: chi tocca deve navigare.
        cleanup();
        expect(richiediAperturaThread(TH_B)).toBe(false);
    });

    it('B è già aperta con la GET dei messaggi in volo: il tocco su B non ne fa partire un’altra', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith(`/api/chat/messages?threadId=${TH_B}`);
        suPagina(p.rotta);
        render(<p.Pagina />);
        await apri(p.nomeB);
        await waitFor(() => expect(rete.trattenute).toHaveLength(1));

        // Consegnato davvero: altrimenti «nessuna seconda GET» sarebbe vero anche per una pagina sorda.
        let consegnato = false;
        act(() => {
            consegnato = richiediAperturaThread(TH_B);
        });
        expect(consegnato, 'la pagina chat montata non ascolta l’evento').toBe(true);
        await scorri();
        expect(getMessaggi(TH_B), 'due GET per la stessa conversazione in volo').toHaveLength(1);

        await libera(`threadId=${TH_B}`);
        await aSchermo('Messaggio di B');
        expect(getMessaggi(TH_B)).toHaveLength(1);
    });

    it('la ricarica della lista fallisce: il parametro resta, e con la lista successiva la conversazione si apre', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        rete.threadsCheFalliscono = [2];
        suPagina(`${p.rotta}?thread=${TH_B}`);

        render(<p.Pagina />);
        await waitFor(() => expect(chiamate('GET', '/api/chat/threads')).toHaveLength(2));
        await scorri();
        expect(window.location.search, 'una lista che non si carica non vuol dire «conversazione non tua»').toBe(`?thread=${TH_B}`);
        expect(logApertura()).toEqual([]);

        // La conversazione (appena creata dall'altra parte) arriva col giro successivo della lista.
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await aSchermo('Messaggio di B');

        expect(chiamate('GET', '/api/chat/threads')).toHaveLength(3);
        expect(window.location.search).toBe('');
        expect(logApertura()).toEqual([expect.objectContaining({ messaggio: 'chat-apertura-da-notifica: aperta (url)' })]);
    });

    it('la ricarica fallisce e poi si sceglie A a mano: quando la lista torna, la notifica NON scavalca la scelta', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio(TH_A, 'm-a', p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        rete.threadsCheFalliscono = [2];
        suPagina(`${p.rotta}?thread=${TH_B}`);

        render(<p.Pagina />);
        await waitFor(() => expect(chiamate('GET', '/api/chat/threads')).toHaveLength(2));
        await scorri();
        await apri(p.nomeA);
        await aSchermo('Messaggio di A');

        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await waitFor(() => expect(chiamate('GET', '/api/chat/threads')).toHaveLength(3));
        await scorri();

        for (const c of screen.getAllByTestId('chat-messaggi')) {
            expect(within(c).getByText('Messaggio di A')).toBeInTheDocument();
            expect(within(c).queryByText('Messaggio di B'), 'la notifica rimasta in sospeso ha scavalcato la scelta fatta a mano').toBeNull();
        }
        expect(getMessaggi(TH_B)).toHaveLength(0);
        expect(window.location.search).toBe('');
        expect(logApertura()).toEqual([]);
    });

    it('si sceglie A a mano mentre la ricarica per B è in volo: vince la scelta, parametro tolto, nessun log', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio(TH_A, 'm-a', p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads') && chiamate('GET', '/api/chat/threads').length >= 2;
        suPagina(`${p.rotta}?thread=${TH_B}`);

        render(<p.Pagina />);
        await waitFor(() => expect(rete.trattenute).toHaveLength(1));
        await apri(p.nomeA);
        await aSchermo('Messaggio di A');

        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        await libera('/api/chat/threads');
        await scorri();

        for (const c of screen.getAllByTestId('chat-messaggi')) {
            expect(within(c).getByText('Messaggio di A')).toBeInTheDocument();
            expect(within(c).queryByText('Messaggio di B')).toBeNull();
        }
        expect(getMessaggi(TH_B)).toHaveLength(0);
        await waitFor(() => expect(window.location.search).toBe(''));
        expect(logApertura()).toEqual([]);
    });

    it('la prima lista non si carica: la richiesta aspetta, e dopo «Riprova» la conversazione si apre', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        rete.threadsCheFalliscono = [1];
        suPagina(`${p.rotta}?thread=${TH_B}`);

        render(<p.Pagina />);
        const riprova = await screen.findAllByRole('button', { name: 'Riprova' });
        expect(window.location.search).toBe(`?thread=${TH_B}`);
        expect(logApertura()).toEqual([]);

        fireEvent.click(riprova[0]);
        await aSchermo('Messaggio di B');

        expect(chiamate('GET', '/api/chat/threads')).toHaveLength(2);
        expect(window.location.search).toBe('');
        expect(logApertura()).toEqual([expect.objectContaining({ messaggio: 'chat-apertura-da-notifica: aperta (url)' })]);
    });
});

describe.each(PAGINE)('chat del $nome — la bozza quando una notifica cambia conversazione', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    /** I campi di scrittura: [0] quello desktop, [1] quello della conversazione a schermo intero di un telefono. */
    const campi = () => screen.getAllByRole('textbox') as HTMLTextAreaElement[];

    it('scritto per A, il tocco apre B: campo vuoto; tornati su A il testo c’è; l’invio da B porta solo il testo di B', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_A] = [messaggio(TH_A, 'm-a', p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio(TH_B, 'm-b', p.altro, 'Messaggio di B')];
        suPagina(p.rotta);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio di A');

        // Sul telefono si scrive nella conversazione a schermo intero.
        fireEvent.change(campi()[1], { target: { value: 'Scritto per la famiglia A' } });

        act(() => {
            richiediAperturaThread(TH_B);
        });
        await aSchermo('Messaggio di B');
        for (const c of campi()) expect(c.value, 'il testo scritto per A è pronto a partire verso B').toBe('');

        await apri(p.nomeA);
        await aSchermo('Messaggio di A');
        expect(campi()[1].value, 'tornati su A, la bozza si è persa').toBe('Scritto per la famiglia A');

        act(() => {
            richiediAperturaThread(TH_B);
        });
        await aSchermo('Messaggio di B');
        fireEvent.change(campi()[1], { target: { value: 'Solo per B' } });
        fireEvent.click(screen.getAllByLabelText('Invia messaggio')[1]);

        await waitFor(() => expect(chiamate('POST', '/api/chat/messages')).toHaveLength(1));
        expect(chiamate('POST', '/api/chat/messages')[0].body).toMatchObject({ thread_id: TH_B, content: 'Solo per B' });
    });
});
