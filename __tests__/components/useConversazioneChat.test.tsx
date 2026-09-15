import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';

/**
 * `useConversazioneChat` — IL HOOK, DA SOLO, CON LA RETE IN MANO.
 *
 * I test di pagina (`__tests__/pages/chat-stato-conversazione.test.tsx`) provano ciò che si vede.
 * Questo file prova ciò che non si vede ma costa: quante richieste partono, in che ordine
 * arrivano le risposte, a quale conversazione vengono applicate. La rete è finta e TRATTIENE a
 * comando: così si mettono in fila gli eventi come succedono su un telefono lento — la GET di un
 * thread che risponde dopo che se n'è aperto un altro, la 201 che arriva dopo l'INSERT del realtime.
 */

type Json = Record<string, unknown>;
type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };
type Richiesta = {
    metodo: string;
    url: string;
    percorso: string;
    body: Json | undefined;
    risolvi: (r: Risposta) => void;
    rompi: (e: unknown) => void;
    chiusa: boolean;
};

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    realtime: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@/components/features/chat/useChatRealtime', () => ({
    useChatRealtime: (o: Record<string, unknown>) => {
        h.realtime = o;
    },
}));
vi.mock('@/components/features/chat/useUnreadNotifications', () => ({ useUnreadNotifications: () => {} }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

import { useConversazioneChat } from '@/components/features/chat/useConversazioneChat';

/* ── La rete ────────────────────────────────────────────────────────────────── */

const IO = 'gen-1';
const TA = { id: 'th-a', teacher_id: 'doc-1', parent_id: IO, student_id: 'alu-1', other_user: { first_name: 'A', last_name: 'A', role: 'teacher' }, student: { nome: 'N', cognome: 'C', classe_sezione: 'S' }, last_message: null, last_message_at: '2026-09-14T07:00:00.000Z', unread_count: 0, sospensione: null };
const TB = { ...TA, id: 'th-b' };

const rete = {
    richieste: [] as Richiesta[],
    threads: [TA, TB] as Json[],
    messaggi: {} as Record<string, Json[]>,
    /** Se restituisce `true` la richiesta resta in sospeso finché il test non la chiude. */
    trattieni: (() => false) as (metodo: string, url: string) => boolean,
    /** Lo stato HTTP della PATCH di lettura (200 se non indicato). */
    statoPatch: 200,
    /**
     * Il server della parte B, quando serve: la finestra e le pagine precedenti (`primaDi`), con il
     * conteggio `precedenti`. Assente = il server di oggi (`{ messages, total }`).
     */
    pagine: null as null | ((threadId: string, primaDi: string | null) => { messages: Json[]; precedenti: number }),
};

function ok(data: unknown, status = 200): Risposta {
    return { ok: status < 400, status, json: async () => data };
}

function rispostaNormale(metodo: string, url: string): Risposta {
    const percorso = url.split('?')[0];
    if (percorso === '/api/chat/threads' && metodo === 'GET') return ok(rete.threads);
    if (percorso === '/api/chat/messages' && metodo === 'GET') {
        const parametri = new URL(url, 'http://x').searchParams;
        const threadId = parametri.get('threadId') ?? '';
        if (rete.pagine) return ok(rete.pagine(threadId, parametri.get('primaDi')));
        return ok({ messages: rete.messaggi[threadId] ?? [], total: 0 });
    }
    if (percorso === '/api/chat/messages/read') return ok({ success: rete.statoPatch < 400 }, rete.statoPatch);
    return ok({});
}

function fetchFinto(input: string, init?: { method?: string; body?: unknown }): Promise<Risposta> {
    const url = String(input);
    const metodo = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    return new Promise<Risposta>((resolve, reject) => {
        const r: Richiesta = {
            metodo,
            url,
            percorso: url.split('?')[0],
            body,
            risolvi: (x) => {
                r.chiusa = true;
                resolve(x);
            },
            rompi: (e) => {
                r.chiusa = true;
                reject(e);
            },
            chiusa: false,
        };
        rete.richieste.push(r);
        if (!rete.trattieni(metodo, url)) r.risolvi(rispostaNormale(metodo, url));
    });
}

function conta(metodo: string, percorso: string): number {
    return rete.richieste.filter((r) => r.metodo === metodo && r.percorso === percorso).length;
}

async function scorri() {
    await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    });
}

function realtime() {
    if (!h.realtime) throw new Error('useChatRealtime non montato');
    return h.realtime as {
        threadAperto?: () => string | null;
        selectedThreadId?: string | null;
        onNewMessage: (m: Json) => void;
        onThreadUnread: (id: string, m: Json) => void;
        onMessageUpdate: (m: Json) => void;
        onThreadSconosciuto?: (m: Json) => void;
        onRiconnesso?: (i: { riconnessoAt: number; ms: number; errori: number }) => void;
    };
}

function monta(rotta: '/parent/chat' | '/teacher/chat' = '/parent/chat') {
    return renderHook(() => useConversazioneChat({ userId: IO, ready: true, rotta }));
}

beforeEach(() => {
    rete.richieste = [];
    rete.threads = [TA, TB];
    rete.messaggi = {};
    rete.trattieni = () => false;
    rete.statoPatch = 200;
    rete.pagine = null;
    h.realtime = null;
    h.logClient.mockClear();
    vi.stubGlobal('fetch', vi.fn(fetchFinto));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('useConversazioneChat — thread sconosciuti dal realtime', () => {
    it('un INSERT di un thread che la lista non conosce costa UNA GET dei thread, anche se ne arrivano due', async () => {
        const { result } = monta();
        await waitFor(() => expect(result.current.statoThreads).toBe('pronto'));
        const prima = conta('GET', '/api/chat/threads');

        const rt = realtime();
        expect(typeof rt.onThreadSconosciuto, 'il hook non ascolta i thread sconosciuti').toBe('function');
        act(() => {
            rt.onThreadSconosciuto?.({ id: 'm-1', thread_id: 'th-nuovo', sender_id: 'doc-1' });
            rt.onThreadSconosciuto?.({ id: 'm-2', thread_id: 'th-nuovo', sender_id: 'doc-1' });
        });
        await scorri();

        expect(conta('GET', '/api/chat/threads')).toBe(prima + 1);
    });
});

function nuovoMessaggio(extra: Json = {}): Json {
    return {
        id: 'm-9',
        thread_id: 'th-a',
        sender_id: IO,
        content: 'Ciao',
        attachment_url: null,
        attachment_type: null,
        read_at: null,
        delivered_at: null,
        created_at: '2026-09-14T09:00:00.000Z',
        ...extra,
    };
}

async function pronto(result: { current: { statoThreads: string } }) {
    await waitFor(() => expect(result.current.statoThreads).toBe('pronto'));
}

describe('useConversazioneChat — C1: un messaggio inviato è UN messaggio', () => {
    it('INSERT del realtime prima della 201 dello stesso messaggio: resta uno', async () => {
        rete.trattieni = (metodo) => metodo === 'POST';
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await scorri();

        let invio: Promise<unknown> = Promise.resolve();
        act(() => {
            invio = result.current.invia('Ciao');
        });
        await waitFor(() => expect(conta('POST', '/api/chat/messages')).toBe(1));

        act(() => realtime().onNewMessage(nuovoMessaggio()));
        const post = rete.richieste.find((r) => r.metodo === 'POST');
        await act(async () => {
            post?.risolvi(ok(nuovoMessaggio(), 201));
            await invio;
        });

        expect(result.current.messaggi.map((m) => m.id)).toEqual(['m-9']);
    });

    it('…e con un polling che lo porta già, fra l’INSERT e la 201', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.trattieni = (metodo) => metodo === 'POST';
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await scorri();

        let invio: Promise<unknown> = Promise.resolve();
        act(() => {
            invio = result.current.invia('Ciao');
        });
        await waitFor(() => expect(conta('POST', '/api/chat/messages')).toBe(1));
        act(() => realtime().onNewMessage(nuovoMessaggio()));

        // Il server ha già la riga: il tick di polling la riporta prima che la 201 torni.
        rete.messaggi['th-a'] = [nuovoMessaggio()];
        const primaDelTick = conta('GET', '/api/chat/messages');
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await waitFor(() => expect(conta('GET', '/api/chat/messages')).toBe(primaDelTick + 1));
        await scorri();

        const post = rete.richieste.find((r) => r.metodo === 'POST');
        await act(async () => {
            post?.risolvi(ok(nuovoMessaggio(), 201));
            await invio;
        });

        expect(result.current.messaggi.map((m) => m.id)).toEqual(['m-9']);
    });
});

describe('useConversazioneChat — D2: una risposta lenta non tocca la conversazione aperta dopo', () => {
    it('GET di A in volo, si apre B: i messaggi restano di B e lo spinner scende con la GET di B', async () => {
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-a', thread_id: 'th-a', sender_id: 'doc-1' })];
        rete.messaggi['th-b'] = [nuovoMessaggio({ id: 'm-b', thread_id: 'th-b', sender_id: 'doc-1' })];
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.includes('/api/chat/messages?');
        const { result } = monta();
        await pronto(result);

        act(() => result.current.apri(TA as never));
        act(() => result.current.apri(TB as never));
        const [getA, getB] = rete.richieste.filter((r) => r.percorso === '/api/chat/messages');
        expect(getA.url).toContain('threadId=th-a');
        expect(getB.url).toContain('threadId=th-b');

        await act(async () => {
            getA.risolvi(rispostaNormale('GET', getA.url));
        });
        await scorri();
        expect(result.current.messaggi.map((m) => m.id), 'la risposta di A è finita sotto B').toEqual([]);
        expect(result.current.caricamentoMessaggi, 'lo spinner di B l’ha spento la GET di A').toBe(true);

        await act(async () => {
            getB.risolvi(rispostaNormale('GET', getB.url));
        });
        await scorri();
        expect(result.current.messaggi.map((m) => m.id)).toEqual(['m-b']);
        expect(result.current.caricamentoMessaggi).toBe(false);
    });

    it('POST su A in volo, si apre B, arriva la 201: B resta com’è, l’anteprima di A si aggiorna, e l’esito lo dice', async () => {
        rete.messaggi['th-b'] = [nuovoMessaggio({ id: 'm-b', thread_id: 'th-b', sender_id: 'doc-1' })];
        rete.trattieni = (metodo) => metodo === 'POST';
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await scorri();

        let invio: Promise<{ esito: string; threadAncoraAperto?: boolean }> = Promise.resolve({ esito: 'x' });
        act(() => {
            invio = result.current.invia('Per A') as never;
        });
        await waitFor(() => expect(conta('POST', '/api/chat/messages')).toBe(1));
        act(() => result.current.apri(TB as never));
        await scorri();
        expect(result.current.messaggi.map((m) => m.id)).toEqual(['m-b']);

        const post = rete.richieste.find((r) => r.metodo === 'POST');
        let esito: { esito: string; threadAncoraAperto?: boolean } = { esito: 'x' };
        await act(async () => {
            post?.risolvi(ok(nuovoMessaggio({ id: 'm-per-a', thread_id: 'th-a', content: 'Per A' }), 201));
            esito = await invio;
        });

        expect(result.current.messaggi.map((m) => m.id), 'la 201 di A è finita sotto B').toEqual(['m-b']);
        expect(result.current.threads.find((th) => th.id === 'th-a')?.last_message?.content).toBe('Per A');
        expect(esito).toMatchObject({ esito: 'ok', threadAncoraAperto: false });
    });

    it('il realtime legge il thread aperto SUBITO dopo apri(), senza aspettare un render', () => {
        const { result } = monta();
        act(() => {
            result.current.apri(TA as never);
            // Stesso turno: nessun effect è ancora girato. Un INSERT che arriva qui va instradato su A.
            expect(realtime().threadAperto?.()).toBe('th-a');
        });
    });

    it('un MIO messaggio arrivato in un thread in background non accende il badge', async () => {
        const { result } = monta();
        await pronto(result);
        act(() => realtime().onThreadUnread('th-b', nuovoMessaggio({ id: 'm-mio', thread_id: 'th-b', sender_id: IO, created_at: '2026-09-14T10:00:00.000Z' })));
        expect(result.current.threads.find((th) => th.id === 'th-b')?.unread_count).toBe(0);
        expect(result.current.nonLetti).toBe(0);

        act(() => realtime().onThreadUnread('th-b', nuovoMessaggio({ id: 'm-suo', thread_id: 'th-b', sender_id: 'doc-1', created_at: '2026-09-14T10:01:00.000Z' })));
        expect(result.current.threads.find((th) => th.id === 'th-b')?.unread_count).toBe(1);
        expect(result.current.nonLetti).toBe(1);
    });
});

function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (nascosta ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}

describe('useConversazioneChat — D1: il polling dei messaggi è silenzioso', () => {
    afterEach(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    it('né il tick di 30 s né la ripresa accendono caricamentoMessaggi, e il separatore resta quello dell’apertura', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1', read_at: null })];
        const storia: boolean[] = [];
        const { result } = renderHook(() => {
            const r = useConversazioneChat({ userId: IO, ready: true, rotta: '/parent/chat' });
            storia.push(r.caricamentoMessaggi);
            return r;
        });
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi.map((m) => m.id)).toEqual(['m-1']));
        await waitFor(() => expect(result.current.caricamentoMessaggi).toBe(false));
        expect(result.current.primoNonLettoId).toBe('m-1');

        // Il server nel frattempo li ha segnati letti: il separatore deve restare dov'era.
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1', read_at: '2026-09-14T09:10:00.000Z' })];
        storia.length = 0;
        const prima = conta('GET', '/api/chat/messages');

        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await waitFor(() => expect(conta('GET', '/api/chat/messages')).toBe(prima + 1));
        await scorri();

        act(() => visibilita(true));
        act(() => visibilita(false));
        await waitFor(() => expect(conta('GET', '/api/chat/messages')).toBe(prima + 2));
        await scorri();

        expect(storia.includes(true), 'il polling ha acceso lo spinner (la lista si smonta e si torna in cima)').toBe(false);
        expect(result.current.primoNonLettoId).toBe('m-1');
    });
});

/** Altezze e scorrimento di un contenitore, come li misurerebbe un browser (jsdom non impagina). */
type Geometria = { scrollHeight: number; clientHeight: number; scrollTop: number };

/** Impaginato, e chi legge è in fondo: l'ultimo messaggio si vede. */
const IN_FONDO: Geometria = { scrollHeight: 3000, clientHeight: 500, scrollTop: 2500 };
/** Impaginato, e chi legge è in cima a una conversazione lunga: l'ultimo messaggio è sotto la piega. */
const PIU_SU: Geometria = { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 };
/** `display:none` — l'istanza nascosta delle due che le pagine montano: tutte le misure a zero. */
const NON_IMPAGINATO: Geometria = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };

/**
 * La conversazione montata a schermo, come la monta la pagina: un contenitore `chat-messaggi`. Il hook
 * manda la PATCH immediata solo se ce n'è uno visibile, non coperto da `inert`, e con chi legge in
 * fondo; senza, il test della deduplica passerebbe per il motivo sbagliato (nessuna PATCH immediata da
 * deduplicare). Per questo la geometria di default è «in fondo»: ogni caso che si aspetta NESSUNA PATCH
 * deve averla per una ragione sola, quella che dichiara.
 */
function montaContenitore(coperto = false, geometria: Geometria = IN_FONDO): () => void {
    const radice = document.createElement('div');
    if (coperto) radice.setAttribute('inert', '');
    const contenitore = document.createElement('div');
    contenitore.setAttribute('data-testid', 'chat-messaggi');
    for (const [chiave, valore] of Object.entries(geometria)) {
        Object.defineProperty(contenitore, chiave, { configurable: true, get: () => valore });
    }
    radice.appendChild(contenitore);
    document.body.appendChild(radice);
    return () => radice.remove();
}

describe('useConversazioneChat — D3: segnare letto solo ciò che si è visto, una volta', () => {
    let smonta: () => void = () => {};
    beforeEach(() => {
        smonta = montaContenitore();
    });
    afterEach(() => {
        smonta();
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    async function aperto(extra: Json[] = []) {
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1', read_at: '2026-09-14T08:00:00.000Z' }), ...extra];
        const reso = monta();
        await pronto(reso.result);
        act(() => reso.result.current.apri(TA as never));
        await waitFor(() => expect(reso.result.current.messaggi).toHaveLength(1 + extra.length));
        return reso;
    }

    it('la PATCH immediata del realtime e quella dell’IntersectionObserver per lo stesso id partono UNA volta', async () => {
        const { result } = await aperto();
        const altrui = nuovoMessaggio({ id: 'm-2', sender_id: 'doc-1', created_at: '2026-09-14T09:01:00.000Z' });
        act(() => realtime().onNewMessage(altrui));
        await scorri();
        // L'ancora: la PATCH immediata è partita davvero. Senza, la deduplica qui sotto sarebbe verde
        // anche togliendola, perché resterebbe solo quella dell'observer.
        expect(conta('PATCH', '/api/chat/messages/read'), 'la PATCH immediata non è partita: niente da deduplicare').toBe(1);
        await act(async () => {
            await result.current.segnaLetti(['m-2']);
        });
        await scorri();
        const patch = rete.richieste.filter((r) => r.percorso === '/api/chat/messages/read');
        expect(patch, 'due PATCH per lo stesso messaggio').toHaveLength(1);
        expect(patch[0].body).toMatchObject({ messageIds: ['m-2'] });
    });

    it('una PATCH rifiutata (500) non segna letto in locale, e lo stesso id si può ritentare', async () => {
        // Il non letto arriva dalla GET (non dal realtime): è il percorso dell'IntersectionObserver.
        const { result } = await aperto([nuovoMessaggio({ id: 'm-3', sender_id: 'doc-1', read_at: null, created_at: '2026-09-14T09:02:00.000Z' })]);
        rete.statoPatch = 500;
        await act(async () => {
            await result.current.segnaLetti(['m-3']);
        });
        await scorri();
        expect(result.current.messaggi.find((m) => m.id === 'm-3')?.read_at, 'segnato letto in locale un messaggio che il server non ha registrato').toBeNull();

        rete.statoPatch = 200;
        const prima = conta('PATCH', '/api/chat/messages/read');
        await act(async () => {
            await result.current.segnaLetti(['m-3']);
        });
        await scorri();
        expect(conta('PATCH', '/api/chat/messages/read')).toBe(prima + 1);
        expect(result.current.messaggi.find((m) => m.id === 'm-3')?.read_at).not.toBeNull();
    });

    it('un messaggio altrui arrivato a documento NASCOSTO non parte come letto', async () => {
        await aperto();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        const prima = conta('PATCH', '/api/chat/messages/read');
        act(() => realtime().onNewMessage(nuovoMessaggio({ id: 'm-4', sender_id: 'doc-1', created_at: '2026-09-14T09:03:00.000Z' })));
        await scorri();
        expect(conta('PATCH', '/api/chat/messages/read'), 'segnato letto col telefono in tasca').toBe(prima);
    });

    it('chiudi(): nessun thread aperto, e il realtime instrada il messaggio in background', async () => {
        const { result } = await aperto();
        expect(typeof (result.current as { chiudi?: unknown }).chiudi, 'il hook non sa chiudere una conversazione').toBe('function');
        act(() => (result.current as unknown as { chiudi: () => void }).chiudi());
        expect(result.current.threadAperto).toBeNull();
        expect(result.current.messaggi).toEqual([]);
        expect(realtime().threadAperto?.()).toBeNull();
    });
});

describe('useConversazioneChat — D6: lo stato della lista dice la verità', () => {
    it('prima GET fallita → «errore» e UN log col gettone nel messaggio; Riprova riuscita → «pronto»', async () => {
        let falliscono = 2;
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads') && falliscono-- > 0;
        const { result } = monta();

        await waitFor(() => expect(rete.richieste.filter((r) => r.percorso === '/api/chat/threads')).toHaveLength(1));
        await act(async () => {
            rete.richieste[0].rompi(new TypeError('Failed to fetch https://app.example/api/chat/threads?userId=gen-1'));
        });
        await scorri();
        expect(result.current.statoThreads).toBe('errore');
        expect(result.current.threads).toEqual([]);

        const logLista = h.logClient.mock.calls.map((c) => c[0] as { messaggio: string; livello: string; evento: string });
        const nonCaricate = logLista.filter((e) => e.messaggio.startsWith('chat-conversazioni-non-caricate'));
        expect(nonCaricate).toHaveLength(1);
        expect(nonCaricate[0]).toMatchObject({ livello: 'warn', evento: 'fetch', messaggio: 'chat-conversazioni-non-caricate: TypeError' });
        expect(JSON.stringify(nonCaricate[0])).not.toContain('gen-1');

        // Riprova, che fallisce ancora con un 500: resta «errore», e nessun secondo log per lo stesso guasto.
        const r = result.current as unknown as { riprovaThreads: () => Promise<void>; riprovando: boolean };
        expect(typeof r.riprovaThreads, 'nessun modo di riprovare').toBe('function');
        let riprova: Promise<void> = Promise.resolve();
        act(() => {
            riprova = (result.current as unknown as { riprovaThreads: () => Promise<void> }).riprovaThreads();
        });
        expect((result.current as unknown as { riprovando: boolean }).riprovando).toBe(true);
        const seconda = rete.richieste.filter((x) => x.percorso === '/api/chat/threads')[1];
        await act(async () => {
            seconda.risolvi(ok({ error: 'x' }, 500));
            await riprova;
        });
        expect(result.current.statoThreads).toBe('errore');
        expect((result.current as unknown as { riprovando: boolean }).riprovando).toBe(false);
        expect(h.logClient.mock.calls.filter((c) => String((c[0] as { messaggio: string }).messaggio).startsWith('chat-conversazioni-non-caricate'))).toHaveLength(1);

        // La terza va.
        await act(async () => {
            await (result.current as unknown as { riprovaThreads: () => Promise<void> }).riprovaThreads();
        });
        expect(result.current.statoThreads).toBe('pronto');
        expect(result.current.threads.map((th) => th.id)).toEqual(['th-a', 'th-b']);
    });

    it('con una lista già caricata, una GET fallita non la svuota e non passa a «errore»', async () => {
        const { result } = monta();
        await pronto(result);
        expect(result.current.threads).toHaveLength(2);

        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads');
        let ricarica: Promise<unknown> = Promise.resolve();
        act(() => {
            ricarica = result.current.ricaricaThreads();
        });
        const ultima = rete.richieste.filter((x) => x.percorso === '/api/chat/threads').at(-1);
        await act(async () => {
            ultima?.rompi(new TypeError('Failed to fetch'));
            await ricarica;
        });
        expect(result.current.statoThreads).toBe('pronto');
        expect(result.current.threads).toHaveLength(2);
    });
});

type ConApertura = {
    apriPerId: (id: string) => Promise<'aperto' | 'non-trovato' | 'errore' | 'annullato'>;
    ricaricaThreads: (opz?: { forza?: boolean }) => Promise<unknown>;
};

describe('useConversazioneChat — carico: le richieste in volo si riusano, le aperture non si scavalcano', () => {
    it('apri() sullo stesso thread con la GET dei messaggi in volo non ne fa partire un’altra', async () => {
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/messages?');
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        act(() => result.current.apri(TA as never));
        await scorri();
        expect(conta('GET', '/api/chat/messages'), 'due GET per lo stesso thread in volo').toBe(1);
    });

    it('apri() sullo stesso thread già caricato: UNA GET silenziosa, lista mai azzerata, niente spinner', async () => {
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1' })];
        const storia: Array<{ n: number; spinner: boolean }> = [];
        const { result } = renderHook(() => {
            const r = useConversazioneChat({ userId: IO, ready: true, rotta: '/parent/chat' });
            storia.push({ n: r.messaggi.length, spinner: r.caricamentoMessaggi });
            return r;
        });
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi).toHaveLength(1));
        await waitFor(() => expect(result.current.caricamentoMessaggi).toBe(false));

        storia.length = 0;
        const prima = conta('GET', '/api/chat/messages');
        act(() => result.current.apri(TA as never));
        await scorri();
        expect(conta('GET', '/api/chat/messages')).toBe(prima + 1);
        expect(storia.some((x) => x.n === 0), 'la conversazione già aperta è stata svuotata').toBe(false);
        expect(storia.some((x) => x.spinner), 'la conversazione già aperta è stata coperta dallo spinner').toBe(false);
    });

    it('il tick del polling con la GET dei messaggi ancora in volo non ne aggiunge un’altra', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { result } = monta();
        await pronto(result);
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/messages?');
        act(() => result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await scorri();
        expect(conta('GET', '/api/chat/messages')).toBe(1);
    });

    it('apriPerId(X) con la lista in volo, poi l’utente tocca Y: alla risposta resta aperto Y', async () => {
        const { result } = monta();
        await pronto(result);
        const r = result.current as unknown as ConApertura;
        expect(typeof r.apriPerId, 'il hook non sa aprire una conversazione per id').toBe('function');

        rete.threads = [TA, TB, { ...TA, id: 'th-x' }];
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads');
        let esito: Promise<string> = Promise.resolve('');
        act(() => {
            esito = (result.current as unknown as ConApertura).apriPerId('th-x');
        });
        await waitFor(() => expect(rete.richieste.filter((x) => x.percorso === '/api/chat/threads' && !x.chiusa)).toHaveLength(1));

        act(() => result.current.apri(TB as never)); // la scelta dell'utente
        const inVolo = rete.richieste.find((x) => x.percorso === '/api/chat/threads' && !x.chiusa);
        let valore = '';
        await act(async () => {
            inVolo?.risolvi(rispostaNormale('GET', inVolo.url));
            valore = await esito;
        });

        expect(result.current.threadAperto?.id, 'la notifica ha scavalcato la conversazione scelta a mano').toBe('th-b');
        expect(valore).toBe('annullato');
    });

    it('apriPerId durante il caricamento iniziale attende QUELLA lista e apre, senza GET in più', async () => {
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads');
        const { result } = monta();
        await waitFor(() => expect(conta('GET', '/api/chat/threads')).toBe(1));
        let esito: Promise<string> = Promise.resolve('');
        act(() => {
            esito = (result.current as unknown as ConApertura).apriPerId('th-b');
        });
        await scorri();
        const iniziale = rete.richieste.find((x) => x.percorso === '/api/chat/threads');
        let valore = '';
        await act(async () => {
            iniziale?.risolvi(rispostaNormale('GET', iniziale.url));
            valore = await esito;
        });
        expect(valore).toBe('aperto');
        expect(result.current.threadAperto?.id).toBe('th-b');
        expect(conta('GET', '/api/chat/threads')).toBe(1);
    });

    it('apriPerId di un id che la lista non ha: UNA ricarica, poi «non-trovato»', async () => {
        const { result } = monta();
        await pronto(result);
        let valore = '';
        await act(async () => {
            valore = await (result.current as unknown as ConApertura).apriPerId('th-estraneo');
        });
        expect(valore).toBe('non-trovato');
        expect(conta('GET', '/api/chat/threads')).toBe(2);
        expect(result.current.threadAperto).toBeNull();
    });

    it('apriPerId con la lista che non si carica: «errore», e nessuna conversazione aperta', async () => {
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads');
        const { result } = monta();
        await waitFor(() => expect(conta('GET', '/api/chat/threads')).toBe(1));
        let esito: Promise<string> = Promise.resolve('');
        act(() => {
            esito = (result.current as unknown as ConApertura).apriPerId('th-b');
        });
        await scorri();
        let valore = '';
        await act(async () => {
            for (const x of rete.richieste.filter((y) => y.percorso === '/api/chat/threads' && !y.chiusa)) x.rompi(new TypeError('Failed to fetch'));
            valore = await esito;
        });
        expect(valore).toBe('errore');
        expect(result.current.threadAperto).toBeNull();
    });

    it('un thread sconosciuto dal realtime e l’apertura dalla notifica dello stesso thread: UNA ricarica sola', async () => {
        const { result } = monta();
        await pronto(result);
        rete.threads = [TA, TB, { ...TA, id: 'th-x' }];
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads');
        const prima = conta('GET', '/api/chat/threads');

        act(() => realtime().onThreadSconosciuto?.(nuovoMessaggio({ id: 'm-x', thread_id: 'th-x', sender_id: 'doc-1' })));
        let esito: Promise<string> = Promise.resolve('');
        act(() => {
            esito = (result.current as unknown as ConApertura).apriPerId('th-x');
        });
        await scorri();
        expect(conta('GET', '/api/chat/threads'), 'due ricariche forzate concorrenti non si sono fuse').toBe(prima + 1);

        let valore = '';
        await act(async () => {
            for (const x of rete.richieste.filter((y) => y.percorso === '/api/chat/threads' && !y.chiusa)) x.risolvi(rispostaNormale('GET', x.url));
            valore = await esito;
        });
        expect(valore).toBe('aperto');
    });

    it('ricaricaThreads({forza}) non si fonde con una GET partita PRIMA; senza forza sì', async () => {
        const { result } = monta();
        await pronto(result);
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/threads');
        const prima = conta('GET', '/api/chat/threads');
        act(() => {
            void (result.current as unknown as ConApertura).ricaricaThreads();
        });
        act(() => {
            void (result.current as unknown as ConApertura).ricaricaThreads();
        });
        await scorri();
        expect(conta('GET', '/api/chat/threads'), 'due ricariche semplici concorrenti non si sono fuse').toBe(prima + 1);

        await new Promise((r) => setTimeout(r, 5));
        act(() => {
            void (result.current as unknown as ConApertura).ricaricaThreads({ forza: true });
        });
        await scorri();
        expect(conta('GET', '/api/chat/threads'), 'la ricarica forzata ha riusato una lista partita prima').toBe(prima + 2);
    });

    it('INSERT realtime del PROPRIO allegato (percorso) con la POST in volo: nessuna GET di rifirma', async () => {
        rete.trattieni = (metodo) => metodo === 'POST';
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await scorri();
        const primaGet = conta('GET', '/api/chat/messages');
        act(() => {
            void result.current.invia('📎 Allegato', 'gen-1/foto.png', 'image');
        });
        await waitFor(() => expect(conta('POST', '/api/chat/messages')).toBe(1));

        act(() => realtime().onNewMessage(nuovoMessaggio({ id: 'm-foto', attachment_url: 'gen-1/foto.png', attachment_type: 'image', content: '📎 Allegato' })));
        await scorri();
        expect(conta('GET', '/api/chat/messages'), 'la 201 porta già il link firmato: la GET di rifirma è di troppo').toBe(primaGet);
    });
});

describe('useConversazioneChat — D4: al rientro del realtime si recupera ciò che il canale ha perso, senza GET doppie', () => {
    afterEach(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    async function apertoSuA() {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-14T10:00:00.000Z'));
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1', read_at: '2026-09-14T09:00:00.000Z' })];
        const reso = monta();
        await pronto(reso.result);
        act(() => reso.result.current.apri(TA as never));
        await waitFor(() => expect(reso.result.current.messaggi).toHaveLength(1));
        return reso;
    }

    function rientri() {
        return h.logClient.mock.calls
            .map((c) => c[0] as { messaggio: string; campi?: Record<string, unknown> })
            .filter((e) => e.messaggio.startsWith('chat-realtime-rientrato'));
    }

    it('richieste partite poco prima del rientro lo coprono: nessuna GET in più, e il log lo dice', async () => {
        await apertoSuA();
        const rt = realtime();
        expect(typeof rt.onRiconnesso, 'il hook non ascolta il rientro del realtime').toBe('function');
        vi.setSystemTime(new Date('2026-09-14T10:00:01.000Z')); // 1 s dopo le GET: dentro il margine
        const primaT = conta('GET', '/api/chat/threads');
        const primaM = conta('GET', '/api/chat/messages');

        act(() => rt.onRiconnesso?.({ riconnessoAt: Date.now(), ms: 8_000, errori: 2 }));
        await scorri();

        expect(conta('GET', '/api/chat/threads')).toBe(primaT);
        expect(conta('GET', '/api/chat/messages')).toBe(primaM);
        expect(rientri()).toHaveLength(1);
        expect(rientri()[0]).toMatchObject({ messaggio: 'chat-realtime-rientrato: nessuno' });
        for (const v of Object.values(rientri()[0].campi ?? {})) expect(typeof v).toBe('number');
    });

    it('nessuna richiesta nel margine: UNA GET della lista e UNA dei messaggi aperti, silenziose', async () => {
        const { result } = await apertoSuA();
        vi.setSystemTime(new Date('2026-09-14T10:00:30.000Z')); // 30 s dopo: le GET di prima non coprono il buco
        const primaT = conta('GET', '/api/chat/threads');
        const primaM = conta('GET', '/api/chat/messages');

        act(() => realtime().onRiconnesso?.({ riconnessoAt: Date.now(), ms: 25_000, errori: 1 }));
        expect(result.current.caricamentoMessaggi, 'il recupero ha acceso lo spinner').toBe(false);
        await scorri();

        expect(conta('GET', '/api/chat/threads')).toBe(primaT + 1);
        expect(conta('GET', '/api/chat/messages')).toBe(primaM + 1);
        expect(rientri()[0]).toMatchObject({ messaggio: 'chat-realtime-rientrato: ricarica' });
    });

    it('una GET dei messaggi ancora in volo ma partita PRIMA del margine non basta: ne parte una nuova', async () => {
        const { result } = await apertoSuA();
        vi.setSystemTime(new Date('2026-09-14T10:00:10.000Z'));
        rete.trattieni = (metodo, url) => metodo === 'GET' && url.startsWith('/api/chat/messages?');
        act(() => result.current.apri(TA as never)); // GET silenziosa, trattenuta, partita a :10
        await scorri();
        const primaM = conta('GET', '/api/chat/messages');

        vi.setSystemTime(new Date('2026-09-14T10:00:30.000Z'));
        act(() => realtime().onRiconnesso?.({ riconnessoAt: Date.now(), ms: 15_000, errori: 1 }));
        await scorri();
        expect(conta('GET', '/api/chat/messages'), 'la GET vecchia non contiene i messaggi persi dopo di lei').toBe(primaM + 1);
    });

    it('a pagina NASCOSTA nessuna GET: la ripresa ne farà una, dopo il rientro', async () => {
        await apertoSuA();
        vi.setSystemTime(new Date('2026-09-14T10:00:30.000Z'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        const primaT = conta('GET', '/api/chat/threads');
        const primaM = conta('GET', '/api/chat/messages');

        act(() => realtime().onRiconnesso?.({ riconnessoAt: Date.now(), ms: 25_000, errori: 1 }));
        await scorri();

        expect(conta('GET', '/api/chat/threads')).toBe(primaT);
        expect(conta('GET', '/api/chat/messages')).toBe(primaM);
        expect(rientri()[0]).toMatchObject({ messaggio: 'chat-realtime-rientrato: pagina-nascosta' });
    });
});

describe('useConversazioneChat — [inert]: sotto il blocco biometrico non si segna letto niente', () => {
    it('con la conversazione coperta da inert, un messaggio altrui dal realtime non parte come letto', async () => {
        const smonta = montaContenitore(true);
        try {
            rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1', read_at: '2026-09-14T08:00:00.000Z' })];
            const { result } = monta();
            await pronto(result);
            act(() => result.current.apri(TA as never));
            await waitFor(() => expect(result.current.messaggi).toHaveLength(1));
            const prima = conta('PATCH', '/api/chat/messages/read');

            act(() => realtime().onNewMessage(nuovoMessaggio({ id: 'm-2', sender_id: 'doc-1', created_at: '2026-09-14T09:05:00.000Z' })));
            await scorri();

            expect(conta('PATCH', '/api/chat/messages/read'), 'segnato letto un messaggio coperto dal blocco: il mittente vede la spunta').toBe(prima);
        } finally {
            smonta();
        }
    });
});

describe('useConversazioneChat — chi legge più su non si vede segnare letto il messaggio che arriva in coda', () => {
    /**
     * Dal 2026-09-14 un messaggio in arrivo porta in fondo SOLO chi era già in fondo (`ChatMessageArea`,
     * regola `vicinoAlFondo`): chi sta leggendo più su resta dov'è, e il messaggio nuovo resta sotto la
     * piega. La PATCH immediata del realtime guardava solo che la conversazione fosse visibile, e il
     * mittente vedeva «letto» su un messaggio che nessuno aveva ancora raggiunto. Deve decidere con la
     * stessa regola del componente; per chi legge più su ci pensa l'IntersectionObserver, quando la bolla
     * compare davvero.
     */
    let smonta: Array<() => void> = [];
    beforeEach(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });
    afterEach(() => {
        smonta.forEach((f) => f());
        smonta = [];
    });

    async function apertoConUnMessaggio() {
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1', read_at: '2026-09-14T08:00:00.000Z' })];
        const reso = monta();
        await pronto(reso.result);
        act(() => reso.result.current.apri(TA as never));
        await waitFor(() => expect(reso.result.current.messaggi).toHaveLength(1));
        return reso;
    }

    const arrivaAltrui = (id: string) =>
        act(() => realtime().onNewMessage(nuovoMessaggio({ id, sender_id: 'doc-1', created_at: '2026-09-14T09:20:00.000Z' })));

    it('chi legge più su: il messaggio altrui compare, ma NON parte come letto', async () => {
        smonta.push(montaContenitore(false, PIU_SU));
        const { result } = await apertoConUnMessaggio();
        const prima = conta('PATCH', '/api/chat/messages/read');

        arrivaAltrui('m-2');
        await scorri();

        expect(result.current.messaggi.map((m) => m.id)).toEqual(['m-1', 'm-2']);
        expect(conta('PATCH', '/api/chat/messages/read'), 'segnato letto un messaggio rimasto sotto la piega: il mittente vede la spunta').toBe(prima);
    });

    it('l’istanza nascosta (display:none, misure a zero) non decide per quella che si vede', async () => {
        // Le pagine montano DUE ChatMessageArea, e su un telefono quella desktop è display:none. Per
        // `vicinoAlFondo` le sue misure a zero valgono «in fondo»: da sola non deve bastare a segnare letto.
        smonta.push(montaContenitore(false, NON_IMPAGINATO));
        smonta.push(montaContenitore(false, PIU_SU));
        await apertoConUnMessaggio();
        const prima = conta('PATCH', '/api/chat/messages/read');

        arrivaAltrui('m-2');
        await scorri();

        expect(conta('PATCH', '/api/chat/messages/read'), 'l’istanza che non si vede ha segnato letto per quella che si vede').toBe(prima);
    });

    it('chi è in fondo alla conversazione che si vede: la PATCH immediata parte, per quel messaggio', async () => {
        smonta.push(montaContenitore(false, NON_IMPAGINATO));
        smonta.push(montaContenitore(false, IN_FONDO));
        await apertoConUnMessaggio();
        const prima = conta('PATCH', '/api/chat/messages/read');

        arrivaAltrui('m-2');
        await scorri();

        const patch = rete.richieste.filter((r) => r.percorso === '/api/chat/messages/read');
        expect(patch, 'chi è in fondo non si vede più segnare letto il messaggio appena arrivato').toHaveLength(prima + 1);
        expect(patch[patch.length - 1].body).toMatchObject({ messageIds: ['m-2'] });
    });
});

type ConPrecedenti = {
    haPrecedenti: boolean;
    caricandoPrecedenti: boolean;
    errorePrecedenti: boolean;
    caricaPrecedenti: () => Promise<void>;
};

/** Sessanta messaggi nel thread A: il server di B risponde con gli ultimi 50 e poi con i 10 prima. */
function serverConStorico(threadId = 'th-a') {
    const tutti = Array.from({ length: 60 }, (_, i) =>
        nuovoMessaggio({
            id: `m-${String(i + 1).padStart(3, '0')}`,
            thread_id: threadId,
            sender_id: 'doc-1',
            read_at: '2026-09-14T08:00:00.000Z',
            created_at: new Date(Date.UTC(2026, 8, 14, 8, 0, 0) + i * 60_000).toISOString(),
        }),
    );
    rete.pagine = (id, primaDi) => {
        if (id !== threadId) return { messages: [], precedenti: 0 };
        if (!primaDi) return { messages: tutti.slice(10), precedenti: 10 };
        const indice = tutti.findIndex((m) => m.id === primaDi);
        return { messages: tutti.slice(Math.max(0, indice - 50), indice), precedenti: Math.max(0, indice - 50) };
    };
}

describe('useConversazioneChat — innesto della parte B: i messaggi precedenti', () => {
    it('col server di oggi (nessun `precedenti` in risposta) il pulsante non c’è', async () => {
        rete.messaggi['th-a'] = [nuovoMessaggio({ id: 'm-1', sender_id: 'doc-1' })];
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi).toHaveLength(1));
        expect((result.current as unknown as ConPrecedenti).haPrecedenti).toBe(false);
    });

    it('carica la pagina precedente con primaDi, la antepone, e il pulsante sparisce quando non ce ne sono altre', async () => {
        serverConStorico();
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi).toHaveLength(50));
        const r = () => result.current as unknown as ConPrecedenti;
        expect(r().haPrecedenti, 'la finestra dichiara 10 precedenti ma il pulsante non c’è').toBe(true);
        expect(typeof r().caricaPrecedenti).toBe('function');

        await act(async () => {
            await r().caricaPrecedenti();
        });

        const conCursore = rete.richieste.filter((x) => x.url.includes('primaDi='));
        expect(conCursore).toHaveLength(1);
        expect(conCursore[0].url).toBe('/api/chat/messages?threadId=th-a&primaDi=m-011');
        expect(result.current.messaggi).toHaveLength(60);
        expect(result.current.messaggi[0].id).toBe('m-001');
        expect(r().haPrecedenti).toBe(false);
        expect(r().caricandoPrecedenti).toBe(false);
        expect(r().errorePrecedenti).toBe(false);
    });

    it('il tocco che arriva appena la lista è a schermo, prima degli effetti passivi, chiede la pagina (non esce in silenzio)', async () => {
        // Dopo il commit che dipinge la lista e il pulsante, React cede il passo al browser prima di
        // eseguire gli `useEffect`: un tocco può arrivare lì in mezzo. Il `useLayoutEffect` del banco gira
        // proprio in quel punto — dopo il commit, prima di ogni `useEffect` — ed è il tocco più rapido
        // possibile. Trovato dal test di pagina `__tests__/pages/chat-precedenti.test.tsx`, dove i timer
        // finti allargano quella finestra: il tocco non partiva, e nessun avviso lo diceva.
        serverConStorico();
        const tocchi: Array<Promise<void>> = [];
        const { result } = renderHook(() => {
            const r = useConversazioneChat({ userId: IO, ready: true, rotta: '/parent/chat' });
            const aSchermo = r.messaggi.length;
            useLayoutEffect(() => {
                if (aSchermo === 50 && tocchi.length === 0) tocchi.push((r as unknown as ConPrecedenti).caricaPrecedenti());
            });
            return r;
        });
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(tocchi).toHaveLength(1));
        await act(async () => {
            await tocchi[0];
        });

        expect(
            rete.richieste.filter((x) => x.url.includes('primaDi=')).map((x) => x.url),
            'il tocco sul pulsante appena comparso non ha chiesto niente: la testa della lista era ancora vuota',
        ).toEqual(['/api/chat/messages?threadId=th-a&primaDi=m-011']);
        await waitFor(() => expect(result.current.messaggi).toHaveLength(60));
    });

    it('doppio click: una GET sola, e «caricando» mentre è in volo', async () => {
        serverConStorico();
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi).toHaveLength(50));
        rete.trattieni = (metodo, url) => url.includes('primaDi=');

        act(() => {
            void (result.current as unknown as ConPrecedenti).caricaPrecedenti();
            void (result.current as unknown as ConPrecedenti).caricaPrecedenti();
        });
        await scorri();
        expect(rete.richieste.filter((x) => x.url.includes('primaDi='))).toHaveLength(1);
        expect((result.current as unknown as ConPrecedenti).caricandoPrecedenti).toBe(true);
    });

    it('la pagina di A arrivata dopo aver aperto B non entra in B e non accende nessun avviso', async () => {
        serverConStorico();
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi).toHaveLength(50));
        rete.trattieni = (metodo, url) => url.includes('primaDi=');
        act(() => {
            void (result.current as unknown as ConPrecedenti).caricaPrecedenti();
        });
        await scorri();

        act(() => result.current.apri(TB as never));
        await waitFor(() => expect(result.current.caricamentoMessaggi).toBe(false));
        const pagina = rete.richieste.find((x) => x.url.includes('primaDi='));
        await act(async () => {
            pagina?.risolvi(rispostaNormale('GET', pagina.url));
        });
        await scorri();

        expect(result.current.messaggi.some((m) => m.thread_id === 'th-a'), 'i precedenti di A sono finiti sotto B').toBe(false);
        expect((result.current as unknown as ConPrecedenti).caricandoPrecedenti).toBe(false);
        expect((result.current as unknown as ConPrecedenti).errorePrecedenti).toBe(false);
    });

    it('rete caduta: avviso, UN log col gettone e senza testo dei messaggi, nessuna riprova automatica', async () => {
        serverConStorico();
        const { result } = monta();
        await pronto(result);
        act(() => result.current.apri(TA as never));
        await waitFor(() => expect(result.current.messaggi).toHaveLength(50));
        rete.trattieni = (metodo, url) => url.includes('primaDi=');
        let chiamata: Promise<void> = Promise.resolve();
        act(() => {
            chiamata = (result.current as unknown as ConPrecedenti).caricaPrecedenti();
        });
        await scorri();
        const pagina = rete.richieste.find((x) => x.url.includes('primaDi='));
        await act(async () => {
            pagina?.rompi(new TypeError('Failed to fetch Messaggio 11'));
            await chiamata;
        });
        await scorri();

        expect((result.current as unknown as ConPrecedenti).errorePrecedenti).toBe(true);
        expect((result.current as unknown as ConPrecedenti).caricandoPrecedenti).toBe(false);
        const eventi = h.logClient.mock.calls.map((c) => c[0] as { messaggio: string; livello: string; evento: string });
        const falliti = eventi.filter((e) => e.messaggio.startsWith('chat-caricamento-precedenti-fallito'));
        expect(falliti).toEqual([expect.objectContaining({ livello: 'warn', evento: 'fetch', messaggio: 'chat-caricamento-precedenti-fallito: TypeError' })]);
        expect(JSON.stringify(falliti)).not.toContain('Messaggio');
        expect(rete.richieste.filter((x) => x.url.includes('primaDi=')), 'è partita una riprova automatica').toHaveLength(1);
    });
});
