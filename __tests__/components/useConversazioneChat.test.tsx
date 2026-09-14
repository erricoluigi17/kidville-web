import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

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
};

function ok(data: unknown, status = 200): Risposta {
    return { ok: status < 400, status, json: async () => data };
}

function rispostaNormale(metodo: string, url: string): Risposta {
    const percorso = url.split('?')[0];
    if (percorso === '/api/chat/threads' && metodo === 'GET') return ok(rete.threads);
    if (percorso === '/api/chat/messages' && metodo === 'GET') {
        const threadId = new URL(url, 'http://x').searchParams.get('threadId') ?? '';
        return ok({ messages: rete.messaggi[threadId] ?? [], total: 0 });
    }
    if (percorso === '/api/chat/messages/read') return ok({ success: true });
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
