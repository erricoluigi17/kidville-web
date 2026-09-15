import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * IL CANALE REALTIME DELLA CHAT — quando nasce, quando muore, e cosa dice quando cade.
 *
 * ─── D5: IL CANALE NON DIPENDE DALLA LISTA DEI THREAD ───────────────────────
 *
 * L'effect che apriva il canale dipendeva da `threads.map(t => t.id).join(',')`, cioè dall'ORDINE
 * della lista: ogni messaggio che riordinava i thread (il più recente sale in cima) faceva
 * `removeChannel` + `channel` — un leave e un join — e nella finestra fra i due gli INSERT si
 * perdevano. Il canale non ha filtri lato server (la RLS consegna solo i messaggi dei propri
 * thread), quindi la lista serve solo al filtro lato client, via ref. Con zero thread il canale non
 * nasceva affatto: la prima conversazione aperta dall'altra parte arrivava solo al polling.
 *
 * ─── D4: IL CANALE CHE CADE NON TACE PIÙ ─────────────────────────────────────
 *
 * Il callback di `subscribe` guardava solo CHANNEL_ERROR, ignorava l'errore che lo accompagna e
 * scriveva un log per OGNI tentativo (2.034 da iOS in 8 giorni, motivo mai registrato). Dopo una
 * caduta nessuno recuperava gli INSERT persi, e un CLOSED non chiesto lasciava il canale morto.
 * Qui: un log per interruzione col motivo come gettone nel messaggio, `onRiconnesso` al rientro,
 * il CLOSED del proprio smontaggio ignorato, quello inatteso ricreato al massimo tre volte.
 */

type Handler = (payload: { new: Record<string, unknown> }) => void;
type CallbackStato = (status: string, err?: unknown) => void;

const sb = vi.hoisted(() => ({
    creati: [] as Array<{ topic: string; api: unknown; handlers: Record<string, Handler>; stato: CallbackStato | null }>,
    rimossi: 0,
    /**
     * Il `removeChannel` vero emette CLOSED: subito se il socket non è connesso (leave di phoenix
     * senza ack), dopo l'ack se lo è. Qui subito, che è il caso in cui il flag dello smontaggio
     * deve già essere alzato.
     */
    closedAllaRimozione: true,
}));

vi.mock('@/lib/supabase/browser-client', () => ({
    getSupabase: () => ({
        channel: (topic: string) => {
            const voce = { topic, api: null as unknown, handlers: {} as Record<string, Handler>, stato: null as CallbackStato | null };
            const api = {
                on: (_tipo: string, filtro: { event: string }, fn: Handler) => {
                    voce.handlers[filtro.event] = fn;
                    return api;
                },
                subscribe: (cb: CallbackStato) => {
                    voce.stato = cb;
                    return api;
                },
            };
            voce.api = api;
            sb.creati.push(voce);
            return api;
        },
        removeChannel: (canale: unknown) => {
            sb.rimossi++;
            const voce = sb.creati.find((v) => v.api === canale);
            if (sb.closedAllaRimozione) voce?.stato?.('CLOSED');
            return Promise.resolve('ok');
        },
    }),
}));

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({
    logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

import { useChatRealtime } from '@/components/features/chat/useChatRealtime';

const A = { id: 'th-a' };
const B = { id: 'th-b' };
const C = { id: 'th-c' };

function messaggio(threadId: string, extra: Record<string, unknown> = {}) {
    return { id: `m-${threadId}`, thread_id: threadId, sender_id: 'doc-1', content: 'x', attachment_url: null, attachment_type: null, read_at: null, created_at: '2026-09-14T08:00:00.000Z', ...extra };
}

type Props = { userId: string; threads: Array<{ id: string }>; aperto: string | null };

function monta(iniziali: Props, extra: Record<string, unknown> = {}) {
    const cb = {
        onNewMessage: vi.fn(),
        onThreadUnread: vi.fn(),
        onMessageUpdate: vi.fn(),
        onThreadSconosciuto: vi.fn(),
        onRiconnesso: vi.fn(),
    };
    const reso = renderHook(
        (p: Props) =>
            useChatRealtime({
                userId: p.userId,
                // @ts-expect-error — il finto porta solo l'id, che è tutto ciò che il hook legge
                threads: p.threads,
                threadAperto: () => p.aperto,
                rotta: '/parent/chat',
                ...cb,
                ...extra,
            }),
        { initialProps: iniziali },
    );
    return { ...reso, cb };
}

function ultimo() {
    const v = sb.creati.at(-1);
    if (!v) throw new Error('nessun canale creato');
    return v;
}

beforeEach(() => {
    sb.creati.length = 0;
    sb.rimossi = 0;
    sb.closedAllaRimozione = true;
    logClient.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useChatRealtime — D5: il canale non si rifà a ogni riordino', () => {
    it('riordinare i thread o aggiungerne uno non rimuove né ricrea il canale', () => {
        const { rerender } = monta({ userId: 'u-1', threads: [A, B], aperto: null });
        expect(sb.creati).toHaveLength(1);

        rerender({ userId: 'u-1', threads: [B, A], aperto: null });
        rerender({ userId: 'u-1', threads: [C, B, A], aperto: null });

        expect(sb.rimossi, 'un riordino ha fatto leave: gli INSERT di quella finestra sono persi').toBe(0);
        expect(sb.creati).toHaveLength(1);
    });

    it('sottoscrive anche con ZERO thread (la RLS filtra lato server)', () => {
        monta({ userId: 'u-1', threads: [], aperto: null });
        expect(sb.creati).toHaveLength(1);
        expect(ultimo().stato, 'il canale non è stato sottoscritto').not.toBeNull();
    });

    it('cambiare utente ricrea il canale', () => {
        const { rerender } = monta({ userId: 'u-1', threads: [A], aperto: null });
        rerender({ userId: 'u-2', threads: [A], aperto: null });
        expect(sb.rimossi).toBe(1);
        expect(sb.creati.map((c) => c.topic)).toEqual(['chat-realtime-u-1', 'chat-realtime-u-2']);
    });

    it('l’INSERT si instrada col thread aperto letto AL MOMENTO dell’evento', () => {
        const { rerender, cb } = monta({ userId: 'u-1', threads: [A, B], aperto: null });
        rerender({ userId: 'u-1', threads: [A, B], aperto: 'th-a' });

        act(() => ultimo().handlers.INSERT({ new: messaggio('th-a') }));
        act(() => ultimo().handlers.INSERT({ new: messaggio('th-b') }));

        expect(cb.onNewMessage).toHaveBeenCalledTimes(1);
        expect(cb.onThreadUnread).toHaveBeenCalledWith('th-b', expect.objectContaining({ thread_id: 'th-b' }));
    });

    it('l’INSERT di un thread che la lista non conosce ancora non si perde: onThreadSconosciuto', () => {
        const { cb } = monta({ userId: 'u-1', threads: [A], aperto: 'th-a' });
        act(() => ultimo().handlers.INSERT({ new: messaggio('th-nuovo') }));
        expect(cb.onThreadSconosciuto).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'th-nuovo' }));
        expect(cb.onNewMessage).not.toHaveBeenCalled();
        expect(cb.onThreadUnread).not.toHaveBeenCalled();
    });

    it('l’UPDATE arriva solo per il thread aperto', () => {
        const { cb } = monta({ userId: 'u-1', threads: [A, B], aperto: 'th-a' });
        act(() => ultimo().handlers.UPDATE({ new: messaggio('th-a', { read_at: 'x' }) }));
        act(() => ultimo().handlers.UPDATE({ new: messaggio('th-b', { read_at: 'x' }) }));
        expect(cb.onMessageUpdate).toHaveBeenCalledTimes(1);
    });
});

describe('useChatRealtime — D4: il canale che cade dice perché, una volta, e al rientro lo annuncia', () => {
    it('il primo SUBSCRIBED è silenzioso: niente log, niente rientro', () => {
        const { cb } = monta({ userId: 'u-1', threads: [A], aperto: null });
        act(() => ultimo().stato?.('SUBSCRIBED'));
        expect(logClient).not.toHaveBeenCalled();
        expect(cb.onRiconnesso).not.toHaveBeenCalled();
    });

    it('CHANNEL_ERROR ripetuti: UN log per interruzione, col gettone nel MESSAGGIO e senza il testo dell’errore', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-14T10:00:00.000Z'));
        const { cb } = monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('SUBSCRIBED'));

        const err = new Error('socket closed: 1006 (riservato-zeta)', { cause: { code: 1006, reason: 'riservato-zeta' } });
        act(() => stato('CHANNEL_ERROR', err));
        vi.setSystemTime(new Date('2026-09-14T10:00:05.000Z'));
        act(() => stato('CHANNEL_ERROR', err));

        expect(logClient, 'un log per ogni errore: la serie misura i tentativi, non le interruzioni').toHaveBeenCalledTimes(1);
        const evento = logClient.mock.calls[0][0] as { messaggio: string; campi?: Record<string, unknown> };
        // Il gettone sta nel MESSAGGIO: i campi non entrano nell'impronta di app_log né nel
        // throttle del client, quindi un motivo scritto lì si vedrebbe solo la prima volta al giorno.
        expect(evento).toMatchObject({ livello: 'warn', evento: 'react', messaggio: 'chat-realtime-errore: socket-chiuso-1006', route: '/parent/chat' });
        expect(JSON.stringify(evento)).not.toContain('riservato-zeta');
        for (const valore of Object.values(evento.campi ?? {})) expect(typeof valore).toBe('number');

        vi.setSystemTime(new Date('2026-09-14T10:00:30.000Z'));
        act(() => stato('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledTimes(1);
        expect(cb.onRiconnesso).toHaveBeenCalledWith({
            riconnessoAt: Date.parse('2026-09-14T10:00:30.000Z'),
            ms: 30_000,
            errori: 2,
        });

        // Un SUBSCRIBED senza interruzione in mezzo non è un rientro.
        act(() => stato('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledTimes(1);

        // Una nuova interruzione si logga di nuovo.
        act(() => stato('CHANNEL_ERROR', new Error('channel error: connection lost')));
        expect(logClient).toHaveBeenCalledTimes(2);
        expect((logClient.mock.calls[1][0] as { messaggio: string }).messaggio).toBe('chat-realtime-errore: connessione-persa');
    });

    it('TIMED_OUT apre un’interruzione con il suo gettone', () => {
        const { cb } = monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('TIMED_OUT'));
        act(() => stato('TIMED_OUT'));
        expect(logClient).toHaveBeenCalledTimes(1);
        expect((logClient.mock.calls[0][0] as { messaggio: string }).messaggio).toBe('chat-realtime-timeout');
        act(() => stato('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledWith(expect.objectContaining({ errori: 2 }));
    });

    it('il CLOSED del proprio smontaggio non logga e non ricrea niente', () => {
        vi.useFakeTimers();
        const { unmount } = monta({ userId: 'u-1', threads: [A], aperto: null });
        act(() => ultimo().stato?.('SUBSCRIBED'));
        unmount(); // removeChannel emette CLOSED in modo sincrono
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(logClient).not.toHaveBeenCalled();
        expect(sb.creati).toHaveLength(1);
    });

    it('un CLOSED inatteso ricrea il canale dopo 10 s, al massimo 3 volte, poi si arrende con un log', () => {
        vi.useFakeTimers();
        monta({ userId: 'u-1', threads: [A], aperto: null });

        for (let tentativo = 1; tentativo <= 3; tentativo++) {
            act(() => ultimo().stato?.('CLOSED'));
            act(() => {
                vi.advanceTimersByTime(9_999);
            });
            expect(sb.creati, `ricreato prima dei 10 s (tentativo ${tentativo})`).toHaveLength(tentativo);
            act(() => {
                vi.advanceTimersByTime(1);
            });
            expect(sb.creati, `non ricreato dopo 10 s (tentativo ${tentativo})`).toHaveLength(tentativo + 1);
        }

        act(() => ultimo().stato?.('CLOSED'));
        act(() => {
            vi.advanceTimersByTime(120_000);
        });
        expect(sb.creati, 'oltre il terzo tentativo il canale si ricrea ancora').toHaveLength(4);

        const messaggi = logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toContain('chat-realtime-chiuso-inatteso');
        expect(messaggi.filter((m) => m === 'chat-realtime-abbandonato')).toHaveLength(1);
    });

    it('il SUBSCRIBED del canale ricreato è un rientro: i messaggi del buco vanno recuperati', () => {
        vi.useFakeTimers();
        const { cb } = monta({ userId: 'u-1', threads: [A], aperto: null });
        act(() => ultimo().stato?.('SUBSCRIBED'));
        act(() => ultimo().stato?.('CLOSED'));
        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        expect(sb.creati).toHaveLength(2);
        act(() => ultimo().stato?.('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledTimes(1);
        expect(cb.onRiconnesso).toHaveBeenCalledWith(expect.objectContaining({ ms: 10_000, errori: 1 }));
    });
});
