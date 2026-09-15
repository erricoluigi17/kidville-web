/**
 * «CARICA MESSAGGI PRECEDENTI» NELLE DUE PAGINE DELLA CHAT, MONTATE DAVVERO (parte B, 2026-09-15).
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Dal 2026-09-14 la GET dei messaggi porta gli ULTIMI 50 — prima portava i 50 più VECCHI, e in 7
 * conversazioni lunghe 48 messaggi non comparivano mai — e lo storico si chiede a mano. I pezzi sono
 * provati uno per uno: la route (`__tests__/api/chat-messages-coda.test.ts`), il hook
 * (`__tests__/components/useConversazioneChat.test.tsx`), il componente
 * (`__tests__/components/ChatMessageArea-precedenti.test.tsx`). Ma il pulsante esiste per chi usa la
 * PAGINA, e le pagine montano DUE `ChatMessageArea` (desktop e mobile a schermo intero): se una delle
 * due non riceve le prop, tutti i pezzi restano verdi e su un telefono il pulsante non c'è.
 *
 * Le due pagine, genitore e docente, con lo stesso copione:
 *  · il pulsante c'è in ENTRAMBI i contenitori, e chiede la pagina con `primaDi` = il primo messaggio
 *    in mano, pagina dopo pagina, finché il server ne dichiara;
 *  · i precedenti sopravvivono al polling di 30 s, che riporta la sola finestra;
 *  · la pagina di A che arriva dopo aver aperto B non entra in B, e un suo guasto non accende l'avviso
 *    in B;
 *  · un caricamento fallito non si riprova da solo: avviso, e il pulsante per riprovare a mano;
 *  · chi legge più su non si vede segnare letto il messaggio che arriva in coda.
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────
 *
 * La rete finta risponde come la route del commit bfc03890: la finestra degli ultimi 50 con
 * `{ messages, total, precedenti }`; `primaDi` deve essere l'uuid di un messaggio di QUELLA
 * conversazione (altrimenti 400); `offset` è rifiutato con 400. I testi sono quelli veri del catalogo
 * italiano (mock globale di next-intl in `test/setup.ts`): una chiave mancante si vedrebbe.
 * `useChatRealtime` è finto ma instrada come quello vero. jsdom non impagina: dove conta dove sta chi
 * legge, la geometria del contenitore è dichiarata, ed è l'unica cosa finta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import type { ComponentType } from 'react';

type Json = Record<string, unknown>;
type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };
type OpzioniRealtime = {
    threadAperto?: () => string | null;
    onNewMessage: (m: Json) => void;
    onThreadUnread: (threadId: string, m: Json) => void;
};

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    utente: 'gen-1',
    realtime: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: h.utente, ready: true, role: 'x' }),
}));
vi.mock('@/components/features/chat/useChatRealtime', () => ({
    useChatRealtime: (o: Record<string, unknown>) => {
        h.realtime = o;
    },
}));
vi.mock('@/components/features/chat/useUnreadNotifications', () => ({ useUnreadNotifications: () => {} }));
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    usePathname: () => '/parent/chat',
    useParams: () => ({}),
}));

import ParentChatPage from '@/app/(dashboard)/parent/chat/page';
import TeacherChatPage from '@/app/(dashboard)/teacher/chat/page';

/* ── Dati ──────────────────────────────────────────────────────────────────── */

const TH_A = '00000000-0000-4000-8000-0000000000a1';
const TH_B = '00000000-0000-4000-8000-0000000000b2';
const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PULSANTE = 'Carica messaggi precedenti';
const PULSANTE_OCCUPATO = /Caricamento messaggi/;
const AVVISO = 'Non è stato possibile caricare i messaggi precedenti. Riprova.';

type Conv = 'a' | 'b';

/** L'id del messaggio `n` (1 = il più vecchio) di una conversazione: un uuid, come quelli veri. */
const idMsg = (conv: Conv, n: number) => `00000000-0000-4000-8${conv === 'a' ? 'aaa' : 'bbb'}-${String(n).padStart(12, '0')}`;
const da = (primo: number, ultimo: number) => Array.from({ length: ultimo - primo + 1 }, (_, i) => primo + i);
const ids = (conv: Conv, primo: number, ultimo: number) => da(primo, ultimo).map((n) => idMsg(conv, n));

function messaggio(conv: Conv, n: number, mittente: string, extra: Json = {}): Json {
    return {
        id: idMsg(conv, n),
        thread_id: conv === 'a' ? TH_A : TH_B,
        sender_id: mittente,
        content: `Messaggio ${conv.toUpperCase()} ${n}`,
        attachment_url: null,
        attachment_type: null,
        read_at: '2026-09-14T08:00:00.000Z',
        delivered_at: null,
        created_at: new Date(Date.UTC(2026, 8, 14, 6, 0, 0) + n * 60_000).toISOString(),
        ...extra,
    };
}

const conversazione = (conv: Conv, quanti: number, mittente: string) => da(1, quanti).map((n) => messaggio(conv, n, mittente));

type Pagina = {
    nome: string;
    Pagina: ComponentType;
    io: string;
    altro: string;
    nomeA: string;
    nomeB: string;
    ruoloAltro: string;
};

const PAGINE: Pagina[] = [
    { nome: 'genitore', Pagina: ParentChatPage, io: 'gen-1', altro: 'doc-1', nomeA: 'Maestra Prova', nomeB: 'Maestra Seconda', ruoloAltro: 'teacher' },
    { nome: 'docente', Pagina: TeacherChatPage, io: 'doc-1', altro: 'gen-1', nomeA: 'Genitore Prova', nomeB: 'Genitore Secondo', ruoloAltro: 'parent' },
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

/* ── La rete finta, che risponde come la route ────────────────────────────── */

const rete = {
    threads: [] as Json[],
    /** Tutti i messaggi di ogni conversazione, dal più vecchio. La GET ne restituisce una finestra. */
    storico: {} as Record<string, Json[]>,
    chiamate: [] as Array<{ metodo: string; percorso: string; url: string; body: Json | undefined }>,
    trattenute: [] as Array<{ url: string; libera: () => void; rompi: (e: unknown) => void }>,
    trattieni: null as null | ((metodo: string, url: string) => boolean),
    /** Quante delle prossime GET con `primaDi` cadono per rete. */
    precedentiCheFalliscono: 0,
};

function ok(data: unknown, status = 200): Risposta {
    return { ok: status < 400, status, json: async () => data };
}

/** GET /api/chat/messages come la route: gli ultimi 50 prima del cursore (o della coda), e quanti ne restano prima. */
function finestra(url: string): Risposta {
    const q = new URL(url, 'http://x').searchParams;
    if (q.has('offset')) return ok({ error: 'Parametro «offset» non più supportato' }, 400);
    const tutti = rete.storico[q.get('threadId') ?? ''] ?? [];
    let fine = tutti.length;
    const primaDi = q.get('primaDi');
    if (primaDi !== null) {
        const i = RX_UUID.test(primaDi) ? tutti.findIndex((m) => m.id === primaDi) : -1;
        if (i < 0) return ok({ error: 'Il messaggio di riferimento non appartiene a questa conversazione' }, 400);
        fine = i;
    }
    const messages = tutti.slice(Math.max(0, fine - 50), fine);
    return ok({ messages, total: fine, precedenti: Math.max(0, fine - messages.length) });
}

function rispondi(metodo: string, url: string): Risposta {
    const percorso = url.split('?')[0];
    if (percorso === '/api/chat/threads' && metodo === 'GET') return ok(rete.threads);
    if (percorso === '/api/chat/messages' && metodo === 'GET') {
        if (url.includes('primaDi=') && rete.precedentiCheFalliscono > 0) {
            rete.precedentiCheFalliscono--;
            throw new TypeError('Failed to fetch');
        }
        return finestra(url);
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
    if (rete.trattieni?.(metodo, url)) {
        return new Promise((resolve, reject) => {
            rete.trattenute.push({
                url,
                libera: () => {
                    try {
                        resolve(rispondi(metodo, url));
                    } catch (e) {
                        reject(e);
                    }
                },
                rompi: reject,
            });
        });
    }
    try {
        return Promise.resolve(rispondi(metodo, url));
    } catch (e) {
        return Promise.reject(e);
    }
}

function chiamate(metodo: string, percorso: string) {
    return rete.chiamate.filter((c) => c.metodo === metodo && c.percorso === percorso);
}

/** Le GET dei precedenti, nell'ordine in cui sono partite. */
function urlPrecedenti(): string[] {
    return rete.chiamate.filter((c) => c.metodo === 'GET' && c.url.includes('primaDi=')).map((c) => c.url);
}

/** Chiude la richiesta trattenuta che contiene `frammento`: con la sua risposta, o con un guasto di rete. */
async function libera(frammento: string, esito: 'risposta' | 'guasto' = 'risposta') {
    const i = rete.trattenute.findIndex((r) => r.url.includes(frammento));
    if (i < 0) throw new Error(`nessuna richiesta trattenuta con ${frammento}`);
    const [r] = rete.trattenute.splice(i, 1);
    await act(async () => {
        if (esito === 'guasto') r.rompi(new TypeError('Failed to fetch'));
        else r.libera();
        for (let k = 0; k < 5; k++) await Promise.resolve();
    });
}

async function scorri() {
    await act(async () => {
        for (let k = 0; k < 5; k++) await Promise.resolve();
    });
}

/* ── Il realtime finto, che instrada come quello vero ─────────────────────── */

function emettiInsert(m: Json) {
    act(() => {
        if (!h.realtime) throw new Error('useChatRealtime non è stato montato');
        const o = h.realtime as unknown as OpzioniRealtime;
        if (m.thread_id === o.threadAperto?.()) o.onNewMessage(m);
        else o.onThreadUnread(String(m.thread_id), m);
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

async function apri(nome: string) {
    fireEvent.click((await screen.findAllByText(nome))[0]);
}

/** I contenitori dei messaggi: [0] la conversazione desktop, [1] quella a schermo intero di un telefono. */
function contenitori() {
    return screen.getAllByTestId('chat-messaggi');
}

/** Gli id dei messaggi a schermo in un contenitore, dall'alto. */
function idsIn(contenitore: HTMLElement): string[] {
    return Array.from(contenitore.querySelectorAll('[data-msg-id]')).map((el) => el.getAttribute('data-msg-id') ?? '');
}

/** La conversazione è a schermo in ENTRAMBE le istanze, e mostra `testo`. */
async function aSchermo(testo: string) {
    await waitFor(() => {
        const scatole = contenitori();
        expect(scatole).toHaveLength(2);
        for (const c of scatole) expect(within(c).getByText(testo)).toBeInTheDocument();
    });
}

/** Il tocco sul pulsante della conversazione a schermo intero: quella che si vede su un telefono. */
function toccaCaricaPrecedenti() {
    const pulsante = within(contenitori()[1]).queryByRole('button', { name: PULSANTE });
    if (!pulsante) throw new Error('nella conversazione a schermo intero il pulsante «Carica messaggi precedenti» non c’è');
    fireEvent.click(pulsante);
}

/** Altezze e scorrimento di un contenitore, come li misurerebbe un browser. Si possono cambiare dopo. */
function geometria(contenitore: HTMLElement, iniziale: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    const g = { ...iniziale };
    for (const chiave of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
        Object.defineProperty(contenitore, chiave, {
            configurable: true,
            get: () => g[chiave],
            set: (v: number) => {
                g[chiave] = v;
            },
        });
    }
    // Chi scorre genera eventi di scroll: è da lì che il componente sa dove sta chi legge.
    fireEvent.scroll(contenitore);
    return g;
}

beforeEach(() => {
    rete.threads = [];
    rete.storico = {};
    rete.chiamate = [];
    rete.trattenute = [];
    rete.trattieni = null;
    rete.precedentiCheFalliscono = 0;
    h.realtime = null;
    h.logClient.mockClear();
    vi.stubGlobal('fetch', vi.fn(fetchFinto));
    vi.stubGlobal('IntersectionObserver', FintoIO as unknown as typeof IntersectionObserver);
    Element.prototype.scrollIntoView = function () {};
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/* ── I casi ────────────────────────────────────────────────────────────────── */

describe.each(PAGINE)('chat del $nome — «Carica messaggi precedenti» è collegato alla pagina', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('c’è in ENTRAMBE le conversazioni montate, e chiede ogni pagina con primaDi = il primo messaggio in mano', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.storico[TH_A] = conversazione('a', 120, p.altro);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio A 120');

        // La finestra: gli ultimi 50, e un pulsante per istanza (desktop e schermo intero).
        for (const c of contenitori()) {
            expect(idsIn(c)).toEqual(ids('a', 71, 120));
            expect(within(c).queryByRole('button', { name: PULSANTE }), 'in questa istanza di ChatMessageArea il pulsante non c’è').not.toBeNull();
        }

        toccaCaricaPrecedenti();
        await aSchermo('Messaggio A 21');
        for (const c of contenitori()) {
            expect(idsIn(c), 'doppioni o buchi fra la pagina e la finestra').toEqual(ids('a', 21, 120));
            expect(within(c).queryByRole('button', { name: PULSANTE }), 'il server dichiara altri precedenti ma il pulsante è sparito').not.toBeNull();
        }

        toccaCaricaPrecedenti();
        await aSchermo('Messaggio A 1');
        for (const c of contenitori()) {
            expect(idsIn(c)).toEqual(ids('a', 1, 120));
            expect(within(c).queryByRole('button', { name: PULSANTE }), 'il pulsante resta senza più niente da caricare').toBeNull();
        }

        // Il cursore è sempre il primo messaggio in mano, e nessuna richiesta usa `offset`.
        expect(urlPrecedenti()).toEqual([
            `/api/chat/messages?threadId=${TH_A}&primaDi=${idMsg('a', 71)}`,
            `/api/chat/messages?threadId=${TH_A}&primaDi=${idMsg('a', 21)}`,
        ]);
        expect(rete.chiamate.filter((c) => c.url.includes('offset'))).toEqual([]);
    });

    it('i precedenti restano dopo il polling di 30 s, che riporta la sola finestra (con un messaggio nuovo)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.storico[TH_A] = conversazione('a', 60, p.altro);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio A 60');
        toccaCaricaPrecedenti();
        await aSchermo('Messaggio A 1');

        // Mentre si legge lo storico arriva un messaggio: la finestra del polling diventa 12..61.
        rete.storico[TH_A] = [...rete.storico[TH_A], messaggio('a', 61, p.altro)];
        const finestra = `/api/chat/messages?threadId=${TH_A}`;
        const finestrePrima = rete.chiamate.filter((c) => c.url === finestra).length;
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await aSchermo('Messaggio A 61');

        expect(rete.chiamate.filter((c) => c.url === finestra), 'il tick non ha chiesto la finestra').toHaveLength(finestrePrima + 1);
        for (const c of contenitori()) {
            expect(idsIn(c), 'il polling ha portato via i messaggi precedenti caricati a mano').toEqual(ids('a', 1, 61));
            expect(within(c).queryByRole('button', { name: PULSANTE }), 'il pulsante è ricomparso: la finestra del polling si è presa la testa').toBeNull();
        }
    });

    it('la pagina di A che arriva dopo aver aperto B non entra in B, e B chiede la sua pagina col suo cursore', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.storico[TH_A] = conversazione('a', 60, p.altro);
        rete.storico[TH_B] = conversazione('b', 60, p.altro);
        rete.trattieni = (metodo, url) => url.includes(`threadId=${TH_A}&primaDi=`);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio A 60');

        toccaCaricaPrecedenti();
        await waitFor(() => expect(rete.trattenute).toHaveLength(1));
        // In volo il pulsante è occupato in tutte e due le istanze: un secondo tocco non ne chiede un'altra.
        for (const c of contenitori()) expect(within(c).getByRole('button', { name: PULSANTE_OCCUPATO })).toBeDisabled();

        await apri(p.nomeB);
        await aSchermo('Messaggio B 60');
        await libera(`threadId=${TH_A}&primaDi=`);

        for (const c of contenitori()) {
            expect(within(c).queryByText('Messaggio A 1'), 'i messaggi di una famiglia sotto la conversazione di un’altra').toBeNull();
            expect(idsIn(c)).toEqual(ids('b', 11, 60));
            expect(within(c).queryByRole('alert')).toBeNull();
            expect(within(c).getByRole('button', { name: PULSANTE })).toBeEnabled();
        }

        toccaCaricaPrecedenti();
        await aSchermo('Messaggio B 1');
        expect(urlPrecedenti()).toEqual([
            `/api/chat/messages?threadId=${TH_A}&primaDi=${idMsg('a', 11)}`,
            `/api/chat/messages?threadId=${TH_B}&primaDi=${idMsg('b', 11)}`,
        ]);
        for (const c of contenitori()) expect(idsIn(c)).toEqual(ids('b', 1, 60));
    });

    it('il guasto della pagina di A, arrivato dopo aver aperto B, non accende l’avviso in B', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.storico[TH_A] = conversazione('a', 60, p.altro);
        rete.storico[TH_B] = conversazione('b', 60, p.altro);
        rete.trattieni = (metodo, url) => url.includes(`threadId=${TH_A}&primaDi=`);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio A 60');
        toccaCaricaPrecedenti();
        await waitFor(() => expect(rete.trattenute).toHaveLength(1));

        await apri(p.nomeB);
        await aSchermo('Messaggio B 60');
        await libera(`threadId=${TH_A}&primaDi=`, 'guasto');

        for (const c of contenitori()) {
            expect(within(c).queryByRole('alert'), 'l’avviso del guasto di A è comparso sotto B').toBeNull();
            expect(within(c).getByRole('button', { name: PULSANTE })).toBeEnabled();
        }
    });

    it('un caricamento fallito non si riprova da solo: avviso, UN log senza testo, e il pulsante per riprovare a mano', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.storico[TH_A] = conversazione('a', 60, p.altro);
        rete.precedentiCheFalliscono = 1;
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio A 60');

        toccaCaricaPrecedenti();
        await waitFor(() => {
            for (const c of contenitori()) expect(within(c).getByRole('alert')).toHaveTextContent(AVVISO);
        });

        // Due giri di polling: la finestra si ricarica, la pagina precedente no.
        for (let giro = 0; giro < 2; giro++) {
            await act(async () => {
                vi.advanceTimersByTime(30_000);
            });
            await scorri();
        }
        expect(urlPrecedenti(), 'è partita una riprova automatica').toHaveLength(1);
        for (const c of contenitori()) {
            expect(within(c).getByRole('alert')).toHaveTextContent(AVVISO);
            expect(within(c).getByRole('button', { name: PULSANTE })).toBeEnabled();
        }

        const eventi = h.logClient.mock.calls.map((c) => c[0] as { messaggio: string; livello: string; evento: string });
        const falliti = eventi.filter((e) => e.messaggio.startsWith('chat-caricamento-precedenti-fallito'));
        expect(falliti).toEqual([expect.objectContaining({ livello: 'warn', evento: 'fetch', messaggio: 'chat-caricamento-precedenti-fallito: TypeError' })]);
        expect(JSON.stringify(falliti), 'il testo dei messaggi è finito nel log').not.toContain('Messaggio');

        // A mano, sì.
        toccaCaricaPrecedenti();
        await aSchermo('Messaggio A 1');
        expect(urlPrecedenti()).toHaveLength(2);
        for (const c of contenitori()) expect(within(c).queryByRole('alert')).toBeNull();
    });
});

describe.each(PAGINE)('chat del $nome — chi legge più su non si vede segnare letto il messaggio che arriva', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('su un telefono, leggendo più su: il messaggio compare ma non parte come letto; tornati in fondo, il successivo sì', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.storico[TH_A] = conversazione('a', 60, p.altro);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await aSchermo('Messaggio A 60');

        // Un telefono: l'istanza desktop è display:none (le sue misure restano a zero, come in jsdom),
        // quella a schermo intero è impaginata, e chi legge sta in cima alla conversazione.
        const telefono = contenitori()[1];
        const g = geometria(telefono, { scrollHeight: 6000, clientHeight: 600, scrollTop: 0 });
        const patchPrima = chiamate('PATCH', '/api/chat/messages/read').length;

        emettiInsert(messaggio('a', 61, p.altro, { read_at: null, created_at: '2026-09-14T08:00:00.000Z' }));
        await aSchermo('Messaggio A 61');
        await scorri();
        expect(
            chiamate('PATCH', '/api/chat/messages/read'),
            'segnato letto un messaggio rimasto sotto la piega: il mittente vede la spunta',
        ).toHaveLength(patchPrima);

        // Chi legge torna in fondo: il messaggio che arriva adesso lo vede arrivare.
        g.scrollTop = 5400;
        fireEvent.scroll(telefono);
        emettiInsert(messaggio('a', 62, p.altro, { read_at: null, created_at: '2026-09-14T08:01:00.000Z' }));
        await waitFor(() => expect(chiamate('PATCH', '/api/chat/messages/read')).toHaveLength(patchPrima + 1));
        expect(chiamate('PATCH', '/api/chat/messages/read').at(-1)?.body).toMatchObject({ messageIds: [idMsg('a', 62)] });
    });
});
