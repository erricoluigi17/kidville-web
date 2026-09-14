/**
 * LE DUE PAGINE DELLA CHAT, MONTATE DAVVERO, CON LO STESSO COPIONE.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * `parent/chat` e `teacher/chat` sono gemelle: ~700 righe ciascuna, stessa logica di thread,
 * messaggi, polling, realtime, invio e segna-letti. Il 2026-09-14 quella logica esce dalle pagine
 * e va in un hook condiviso (`useConversazioneChat`), e subito dopo si correggono i difetti che la
 * segnalazione del titolare ha portato alla luce (il messaggio doppio, la chat che salta in cima
 * ogni 30 secondi, i messaggi segnati letti senza essere visti…).
 *
 * Un'estrazione di queste dimensioni, nello stesso rilascio delle correzioni e con l'E2E che gira
 * solo in CI, si fa solo con una rete sotto. La prima parte di questo file è la CARATTERIZZAZIONE:
 * i comportamenti che devono restare IDENTICI prima e dopo l'estrazione, sulle due pagine. La
 * seconda parte sono i difetti, uno per blocco, ciascuno visto rosso sul codice di prima.
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────
 *
 * `fetch` risponde per URL e può TRATTENERE una richiesta (per mettere in fila gli eventi come
 * accadono in produzione: l'INSERT del realtime prima della 201). `useChatRealtime` è finto ma
 * INSTRADA come quello vero, con `threadAperto()` se c'è e `selectedThreadId` altrimenti: così il
 * copione vale con tutte e due le firme del hook, e un rosso è un rosso della pagina, non del finto.
 *
 * Le pagine montano DUE `ChatMessageArea` (desktop e mobile, entrambe nel DOM di jsdom): i conteggi
 * si fanno DENTRO ciascun contenitore `chat-messaggi`, mai sul documento.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import type { ComponentType } from 'react';

type Json = Record<string, unknown>;
type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };
type OpzioniRealtime = {
    threads: Array<{ id: string }>;
    threadAperto?: () => string | null;
    selectedThreadId?: string | null;
    onNewMessage: (m: Json) => void;
    onThreadUnread: (threadId: string, m: Json) => void;
    onMessageUpdate: (m: Json) => void;
    onThreadSconosciuto?: (m: Json) => void;
};

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    utente: 'gen-1',
    realtime: null as null | Record<string, unknown>,
}));

vi.mock('next-intl', () => {
    const t = (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join(',')}` : k);
    return {
        useTranslations: () => Object.assign(t, { rich: t, markup: t, raw: t, has: () => true }),
        useLocale: () => 'it',
        useFormatter: () => ({ dateTime: (x: unknown) => String(x), number: (x: unknown) => String(x) }),
    };
});
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

/* ── La rete finta ──────────────────────────────────────────────────────────── */

const rete = {
    threads: [] as Json[],
    messaggi: {} as Record<string, Json[]>,
    chiamate: [] as Array<{ metodo: string; percorso: string; url: string; body: Json | undefined }>,
    trattenute: [] as Array<{ metodo: string; url: string; libera: () => void; rompi: (e: unknown) => void }>,
    trattieni: null as null | ((metodo: string, url: string) => boolean),
    threadsCheFalliscono: 0,
    esitoPost: null as null | ((body: Json) => Risposta),
    contatorePost: 0,
};

function ok(data: unknown, status = 200): Risposta {
    return { ok: status < 400, status, json: async () => data };
}

function rispondi(metodo: string, url: string, body: Json | undefined): Risposta {
    const percorso = url.split('?')[0];
    if (percorso === '/api/chat/threads' && metodo === 'GET') {
        if (rete.threadsCheFalliscono > 0) {
            rete.threadsCheFalliscono--;
            throw new TypeError('Failed to fetch');
        }
        return ok(rete.threads);
    }
    if (percorso === '/api/chat/messages/read') return ok({ success: true });
    if (percorso === '/api/chat/messages' && metodo === 'GET') {
        const threadId = new URL(url, 'http://x').searchParams.get('threadId') ?? '';
        const lista = rete.messaggi[threadId] ?? [];
        return ok({ messages: lista, total: lista.length });
    }
    if (percorso === '/api/chat/messages' && metodo === 'POST' && body) {
        if (rete.esitoPost) return rete.esitoPost(body);
        rete.contatorePost++;
        const nuovo = messaggio(`m-post-${rete.contatorePost}`, String(body.thread_id), String(body.sender_id), String(body.content), {
            created_at: `2026-09-14T09:00:0${rete.contatorePost}.000Z`,
        });
        rete.messaggi[String(body.thread_id)] = [...(rete.messaggi[String(body.thread_id)] ?? []), nuovo];
        return ok(nuovo, 201);
    }
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
                metodo,
                url,
                libera: () => {
                    try {
                        resolve(rispondi(metodo, url, body));
                    } catch (e) {
                        reject(e);
                    }
                },
                rompi: reject,
            });
        });
    }
    try {
        return Promise.resolve(rispondi(metodo, url, body));
    } catch (e) {
        return Promise.reject(e);
    }
}

function chiamate(metodo: string, percorso: string) {
    return rete.chiamate.filter((c) => c.metodo === metodo && c.percorso === percorso);
}

/** Libera la prima richiesta trattenuta che corrisponde, lasciando girare le risposte. */
async function libera(metodo: string, frammento: string) {
    const i = rete.trattenute.findIndex((r) => r.metodo === metodo && r.url.includes(frammento));
    if (i < 0) throw new Error(`nessuna richiesta trattenuta ${metodo} ${frammento}`);
    const [r] = rete.trattenute.splice(i, 1);
    await act(async () => {
        r.libera();
        for (let k = 0; k < 5; k++) await Promise.resolve();
    });
}

/* ── Il realtime finto, che instrada come quello vero ─────────────────────── */

function realtime(): OpzioniRealtime {
    if (!h.realtime) throw new Error('useChatRealtime non è stato montato');
    return h.realtime as unknown as OpzioniRealtime;
}

function threadApertoPerIlCanale(o: OpzioniRealtime): string | null {
    return typeof o.threadAperto === 'function' ? o.threadAperto() : (o.selectedThreadId ?? null);
}

function emettiInsert(m: Json) {
    act(() => {
        const o = realtime();
        if (!o.threads.some((t) => t.id === m.thread_id)) {
            o.onThreadSconosciuto?.(m);
            return;
        }
        if (m.thread_id === threadApertoPerIlCanale(o)) o.onNewMessage(m);
        else o.onThreadUnread(String(m.thread_id), m);
    });
}

/* ── Dati ──────────────────────────────────────────────────────────────────── */

const TH_A = '00000000-0000-4000-8000-0000000000a1';
const TH_B = '00000000-0000-4000-8000-0000000000b2';

type Pagina = {
    nome: string;
    Pagina: ComponentType;
    io: string;
    altro: string;
    nomeA: string;
    nomeB: string;
    ruoloAltro: string;
    invioNonRiuscito: string;
    indietro: string;
};

const PAGINE: Pagina[] = [
    {
        nome: 'genitore',
        Pagina: ParentChatPage,
        io: 'gen-1',
        altro: 'doc-1',
        nomeA: 'Dora Docente',
        nomeB: 'Ada Altra',
        ruoloAltro: 'teacher',
        invioNonRiuscito: 'invioNonRiuscito',
        indietro: 'backToList',
    },
    {
        nome: 'docente',
        Pagina: TeacherChatPage,
        io: 'doc-1',
        altro: 'gen-1',
        nomeA: 'Gina Genitore',
        nomeB: 'Ugo Uno',
        ruoloAltro: 'parent',
        invioNonRiuscito: 'chatInvioNonRiuscito',
        indietro: 'chatTornaAllaLista',
    },
];

function messaggio(id: string, threadId: string, mittente: string, testo: string, extra: Json = {}): Json {
    return {
        id,
        thread_id: threadId,
        sender_id: mittente,
        content: testo,
        attachment_url: null,
        attachment_type: null,
        read_at: null,
        delivered_at: null,
        created_at: '2026-09-14T08:00:00.000Z',
        ...extra,
    };
}

function thread(p: Pagina, id: string, nomeCompleto: string, extra: Json = {}): Json {
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
        last_message_at: '2026-09-14T07:00:00.000Z',
        unread_count: 0,
        sospensione: null,
        ...extra,
    };
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

function contenitori() {
    return screen.getAllByTestId('chat-messaggi');
}

async function scrivi(testo: string) {
    const campo = (await screen.findAllByRole('textbox'))[0];
    fireEvent.change(campo, { target: { value: testo } });
    fireEvent.click(screen.getAllByLabelText('chatInputAriaInvia')[0]);
}

beforeEach(() => {
    rete.threads = [];
    rete.messaggi = {};
    rete.chiamate = [];
    rete.trattenute = [];
    rete.trattieni = null;
    rete.threadsCheFalliscono = 0;
    rete.esitoPost = null;
    rete.contatorePost = 0;
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

describe.each(PAGINE)('chat del $nome — caratterizzazione (identica prima e dopo l’estrazione)', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('aprire una conversazione chiede i messaggi di QUEL thread e li mostra', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno')];
        render(<p.Pagina />);

        await apri(p.nomeA);

        await waitFor(() => expect(contenitori().length).toBeGreaterThan(0));
        for (const c of contenitori()) expect(within(c).getByText('Buongiorno')).toBeInTheDocument();
        expect(chiamate('GET', '/api/chat/messages').map((c) => c.url)).toContain(`/api/chat/messages?threadId=${TH_A}`);
    });

    it('un testo inviato parte col thread aperto e compare nella conversazione', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno')];
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Buongiorno');

        await scrivi('Ciao, a domani');

        await waitFor(() => expect(chiamate('POST', '/api/chat/messages')).toHaveLength(1));
        expect(chiamate('POST', '/api/chat/messages')[0].body).toMatchObject({ thread_id: TH_A, sender_id: p.io, content: 'Ciao, a domani' });
        await waitFor(() => {
            for (const c of contenitori()) expect(within(c).getAllByText('Ciao, a domani').length).toBeGreaterThan(0);
        });
    });

    it('realtime: un messaggio altrui nel thread aperto compare; in un altro thread accende il badge', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno')];
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Buongiorno');

        emettiInsert(messaggio('m-2', TH_A, p.altro, 'Arrivato adesso', { created_at: '2026-09-14T08:01:00.000Z' }));
        await waitFor(() => {
            for (const c of contenitori()) expect(within(c).getByText('Arrivato adesso')).toBeInTheDocument();
        });

        emettiInsert(messaggio('m-3', TH_B, p.altro, 'Da un altro thread', { created_at: '2026-09-14T08:02:00.000Z' }));
        const riga = (await screen.findAllByText(p.nomeB))[0].closest('button') as HTMLElement;
        await waitFor(() => expect(within(riga).getByText('1')).toBeInTheDocument());
    });

    it('403 «conversazione sospesa» ricarica i thread; un 500 mostra l’avviso d’invio', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno')];
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Buongiorno');

        const primaDelRifiuto = chiamate('GET', '/api/chat/threads').length;
        rete.esitoPost = () => ok({ motivo: 'conversazione_sospesa' }, 403);
        await scrivi('Primo tentativo');
        await waitFor(() => expect(chiamate('GET', '/api/chat/threads').length).toBe(primaDelRifiuto + 1));

        rete.esitoPost = () => ok({ error: 'x' }, 500);
        await scrivi('Secondo tentativo');
        expect((await screen.findAllByRole('alert')).some((el) => el.textContent === p.invioNonRiuscito)).toBe(true);
    });
});

describe.each(PAGINE)('chat del $nome — C1: un messaggio inviato è UNA bolla', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('l’INSERT del realtime arriva PRIMA della 201 (la POST attende notifica e firma): una bolla per contenitore', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno')];
        rete.trattieni = (metodo) => metodo === 'POST';
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Buongiorno');

        await scrivi('Ciao, a domani');
        await waitFor(() => expect(rete.trattenute.some((r) => r.metodo === 'POST')).toBe(true));

        // Il realtime consegna la riga del database mentre la POST è ancora in volo.
        emettiInsert(messaggio('m-post-1', TH_A, p.io, 'Ciao, a domani', { created_at: '2026-09-14T09:00:01.000Z' }));
        await libera('POST', '/api/chat/messages');

        await waitFor(() => expect(chiamate('POST', '/api/chat/messages')).toHaveLength(1));
        const scatole = contenitori();
        expect(scatole.length).toBeGreaterThan(0);
        for (const c of scatole) {
            expect(within(c).getAllByText('Buongiorno')).toHaveLength(1);
            expect(within(c).getAllByText('Ciao, a domani'), 'il messaggio inviato compare due volte').toHaveLength(1);
        }
    });
});

describe.each(PAGINE)('chat del $nome — D2: ciò che appartiene a una conversazione non finisce in un’altra', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('la risposta LENTA dei messaggi di A, arrivata dopo aver aperto B, non compare sotto B', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_A] = [messaggio('m-a', TH_A, p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio('m-b', TH_B, p.altro, 'Messaggio di B')];
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.includes(`threadId=${TH_A}`);
        render(<p.Pagina />);

        await apri(p.nomeA);
        await waitFor(() => expect(rete.trattenute).toHaveLength(1));
        await apri(p.nomeB);
        await screen.findAllByText('Messaggio di B');

        await libera('GET', `threadId=${TH_A}`);

        const scatole = contenitori();
        expect(scatole.length).toBeGreaterThan(0);
        for (const c of scatole) {
            expect(within(c).getByText('Messaggio di B')).toBeInTheDocument();
            expect(within(c).queryByText('Messaggio di A'), 'i messaggi di una famiglia sotto la conversazione di un’altra').toBeNull();
        }
    });

    it('il testo scritto per A non resta nel campo quando si apre B', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_A] = [messaggio('m-a', TH_A, p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio('m-b', TH_B, p.altro, 'Messaggio di B')];
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Messaggio di A');

        const campo = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
        fireEvent.change(campo, { target: { value: 'Scritto per A' } });
        expect(campo.value).toBe('Scritto per A');

        await apri(p.nomeB);
        await screen.findAllByText('Messaggio di B');
        for (const t of screen.getAllByRole('textbox') as HTMLTextAreaElement[]) {
            expect(t.value, 'il testo per una famiglia è rimasto pronto a partire verso un’altra').toBe('');
        }
    });

    it('l’avviso di un invio fallito su A non compare su B', async () => {
        rete.threads = [thread(p, TH_A, p.nomeA), thread(p, TH_B, p.nomeB)];
        rete.messaggi[TH_A] = [messaggio('m-a', TH_A, p.altro, 'Messaggio di A')];
        rete.messaggi[TH_B] = [messaggio('m-b', TH_B, p.altro, 'Messaggio di B')];
        rete.esitoPost = () => ok({ error: 'x' }, 500);
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Messaggio di A');
        await scrivi('Non partirà');
        expect((await screen.findAllByRole('alert')).some((el) => el.textContent === p.invioNonRiuscito)).toBe(true);

        await apri(p.nomeB);
        await screen.findAllByText('Messaggio di B');
        expect(screen.queryAllByRole('alert').some((el) => el.textContent === p.invioNonRiuscito)).toBe(false);
    });
});

describe.each(PAGINE)('chat del $nome — D1: il polling non tocca ciò che si sta leggendo', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('al tick di 30 s niente spinner e la lista resta la STESSA (stesso nodo DOM, nessun salto in cima)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.threads = [thread(p, TH_A, p.nomeA)];
        // Messaggio SENZA allegato: `firmaAllegatiChat` rifirma a ogni GET, quindi un messaggio con
        // allegato cambia identità a ogni polling anche quando nulla è cambiato davvero.
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno', { read_at: '2026-09-14T08:05:00.000Z' })];
        render(<p.Pagina />);
        await apri(p.nomeA);
        const nodo = (await screen.findAllByText('Buongiorno'))[0];

        const primaDelTick = chiamate('GET', '/api/chat/messages').length;
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.includes('/api/chat/messages?');
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await waitFor(() => expect(chiamate('GET', '/api/chat/messages').length).toBe(primaDelTick + 1));

        // La GET del polling è ancora in volo: è qui che lo spinner prendeva il posto della lista.
        expect(screen.queryAllByText('loadingMessages'), 'il polling ha smontato la conversazione per mostrare lo spinner').toHaveLength(0);
        expect(screen.getAllByText('Buongiorno')[0]).toBe(nodo);

        await libera('GET', `threadId=${TH_A}`);
        expect(screen.getAllByText('Buongiorno')[0], 'la lista è stata ricreata: lo scorrimento riparte da capo').toBe(nodo);
    });
});

describe.each(PAGINE)('chat del $nome — D3: «Indietro» chiude davvero la conversazione', (p) => {
    beforeEach(() => {
        h.utente = p.io;
    });

    it('dopo Indietro un messaggio in arrivo accende il badge, non parte nessuna PATCH e il polling dei messaggi si ferma', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.threads = [thread(p, TH_A, p.nomeA)];
        rete.messaggi[TH_A] = [messaggio('m-1', TH_A, p.altro, 'Buongiorno', { read_at: '2026-09-14T08:05:00.000Z' })];
        render(<p.Pagina />);
        await apri(p.nomeA);
        await screen.findAllByText('Buongiorno');

        fireEvent.click(screen.getByLabelText(p.indietro));
        // L'ancora positiva: la lista è tornata (su mobile la conversazione a schermo intero è sparita).
        await waitFor(() => expect(screen.queryByLabelText(p.indietro)).toBeNull());

        const patchPrima = chiamate('PATCH', '/api/chat/messages/read').length;
        emettiInsert(messaggio('m-2', TH_A, p.altro, 'Arrivato dopo Indietro', { created_at: '2026-09-14T08:10:00.000Z' }));

        const riga = (await screen.findAllByText(p.nomeA))[0].closest('button') as HTMLElement;
        await waitFor(() => expect(within(riga).getByText('1')).toBeInTheDocument());
        expect(
            chiamate('PATCH', '/api/chat/messages/read').length,
            'segnato letto un messaggio che nessuno ha visto: il mittente vede la spunta',
        ).toBe(patchPrima);

        const getPrima = chiamate('GET', '/api/chat/messages').length;
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await act(async () => {
            for (let k = 0; k < 5; k++) await Promise.resolve();
        });
        expect(chiamate('GET', '/api/chat/messages').length, 'il polling continua su una conversazione chiusa').toBe(getPrima);
    });
});
