import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * IL CANALE REALTIME DELLA CHAT — quando nasce, quando muore, e cosa dice quando cade.
 *
 * ─── S4-B: BROADCAST PRIVATO DAL DATABASE, NON PIÙ `postgres_changes` (2026-10-12) ──
 *
 * Fino al 2026-10-12 il canale ascoltava `postgres_changes` INSERT/UPDATE su `chat_messages`
 * SENZA filtro: ogni client teneva aperta una sottoscrizione che fa decodificare il WAL al
 * database e filtrare per RLS ogni riga, per ogni ascoltatore. È la voce più costosa misurata in
 * produzione: 49.361 s di tempo di database dal 6/8, 7,4 M di chiamate.
 *
 * Adesso il segnale lo manda un trigger (`realtime.send`) su un canale PRIVATO per destinatario,
 * `chat:<uid di auth>`, e il database non decodifica più niente per la chat. Da qui nascono tre
 * vincoli che questo file tiene fermi:
 *
 *  · il topic è l'uid di AUTH della sessione del browser, non `userId` (l'id applicativo, che per
 *    un genitore è un'altra cosa): un topic sbagliato è un canale che la policy su
 *    `realtime.messages` rifiuta, cioè una chat muta;
 *  · `realtime.setAuth()` si attende PRIMA di `subscribe()`: il token nel socket è ciò che la
 *    policy legge, e `connect()` lo imposta per conto suo senza attenderlo (una corsa vera);
 *  · il payload NON ha il testo del messaggio (`realtime.messages` conserva le righe per giorni,
 *    fuori dall'oblio e dalla scatola nera, e una chat fra famiglia e maestra contiene dati
 *    sanitari di minori). Il contenuto lo rilegge chi ascolta, dall'API.
 *
 * ─── D5: IL CANALE NON DIPENDE DALLA LISTA DEI THREAD ───────────────────────
 *
 * L'effect che apriva il canale dipendeva da `threads.map(t => t.id).join(',')`, cioè dall'ORDINE
 * della lista: ogni messaggio che riordinava i thread (il più recente sale in cima) faceva
 * `removeChannel` + `channel` — un leave e un join — e nella finestra fra i due i segnali si
 * perdevano. La lista serve solo al filtro lato client, via ref. Con zero thread il canale non
 * nasceva affatto: la prima conversazione aperta dall'altra parte arrivava solo al polling.
 *
 * ─── D4: IL CANALE CHE CADE NON TACE PIÙ ─────────────────────────────────────
 *
 * Il callback di `subscribe` guardava solo CHANNEL_ERROR, ignorava l'errore che lo accompagna e
 * scriveva un log per OGNI tentativo (2.034 da iOS in 8 giorni, motivo mai registrato). Dopo una
 * caduta nessuno recuperava i segnali persi, e un CLOSED non chiesto lasciava il canale morto.
 * Qui: un log per interruzione col motivo come gettone nel messaggio, `onRiconnesso` al rientro,
 * il CLOSED del proprio smontaggio ignorato, quello inatteso ricreato al massimo tre volte.
 */

/** Il messaggio che il server Realtime consegna a un binding `broadcast`. */
type MessaggioBroadcast = { type: 'broadcast'; event: string; payload: Record<string, unknown> };
type Handler = (messaggio: MessaggioBroadcast) => void;
type CallbackStato = (status: string, err?: unknown) => void;

const sb = vi.hoisted(() => ({
    creati: [] as Array<{
        topic: string;
        opzioni: unknown;
        api: unknown;
        handlers: Record<string, Handler>;
        tipiAscoltati: string[];
        stato: CallbackStato | null;
    }>,
    rimossi: 0,
    /** Che cosa è stato chiamato, e in quale ordine: `setAuth` deve venire prima di `subscribe`. */
    ordine: [] as string[],
    /** La sessione del browser. `null` = nessuna identità di auth risolvibile. */
    sessione: { user: { id: 'auth-1' } } as { user: { id: string } } | null,
    /** `setAuth()` può fallire (token scaduto, rete): il canale non deve nascere muto e zitto. */
    setAuthFallisce: false,
    /**
     * Il `removeChannel` vero emette CLOSED: subito se il socket non è connesso (leave di phoenix
     * senza ack), dopo l'ack se lo è. Qui subito, che è il caso in cui il flag dello smontaggio
     * deve già essere alzato.
     */
    closedAllaRimozione: true,
}));

vi.mock('@/lib/supabase/browser-client', () => ({
    getSupabase: () => ({
        auth: {
            getSession: () => {
                sb.ordine.push('getSession');
                return Promise.resolve({ data: { session: sb.sessione }, error: null });
            },
        },
        realtime: {
            setAuth: () => {
                sb.ordine.push('setAuth');
                return sb.setAuthFallisce ? Promise.reject(new TypeError('token')) : Promise.resolve();
            },
        },
        channel: (topic: string, opzioni?: unknown) => {
            sb.ordine.push('channel');
            const voce = {
                topic,
                opzioni,
                api: null as unknown,
                handlers: {} as Record<string, Handler>,
                tipiAscoltati: [] as string[],
                stato: null as CallbackStato | null,
            };
            const api = {
                on: (tipo: string, filtro: { event: string }, fn: Handler) => {
                    voce.tipiAscoltati.push(tipo);
                    voce.handlers[filtro.event] = fn;
                    return api;
                },
                subscribe: (cb: CallbackStato) => {
                    sb.ordine.push('subscribe');
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

/** Il payload MINIMO del trigger: sei chiavi, e mai il testo. */
function segnale(threadId: string, extra: Record<string, unknown> = {}) {
    return {
        id: `m-${threadId}`,
        thread_id: threadId,
        sender_id: 'doc-1',
        created_at: '2026-09-14T08:00:00.000Z',
        read_at: null,
        delivered_at: null,
        ...extra,
    };
}

function trasmetti(voce: { handlers: Record<string, Handler> }, event: 'INSERT' | 'UPDATE', payload: Record<string, unknown>) {
    const h = voce.handlers[event];
    if (!h) throw new Error(`nessun ascoltatore per l'evento ${event}`);
    h({ type: 'broadcast', event, payload });
}

type Props = { userId: string; threads: Array<{ id: string }>; aperto: string | null };

/**
 * Monta il hook e ATTENDE la risoluzione dell'identità: il canale privato nasce dopo due
 * promesse (`getSession`, `setAuth`), quindi senza questo `await` non esiste ancora niente.
 */
async function monta(iniziali: Props, extra: Record<string, unknown> = {}) {
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
    await act(async () => {});
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
    sb.ordine.length = 0;
    sb.sessione = { user: { id: 'auth-1' } };
    sb.setAuthFallisce = false;
    sb.closedAllaRimozione = true;
    logClient.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useChatRealtime — S4-B: canale PRIVATO per destinatario, niente postgres_changes', () => {
    it('il topic è `chat:<uid di auth>` — NON l’id applicativo — e il canale è privato', async () => {
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        expect(sb.creati).toHaveLength(1);
        expect(ultimo().topic).toBe('chat:auth-1');
        expect(ultimo().topic, 'il topic usa l’id applicativo: la policy rifiuterebbe il join').not.toContain('u-1');
        expect(ultimo().opzioni).toMatchObject({ config: { private: true } });
    });

    it('NESSUN binding `postgres_changes`: solo broadcast, su INSERT e UPDATE', async () => {
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        expect(
            ultimo().tipiAscoltati,
            'un binding postgres_changes rimette il database a decodificare il WAL per ogni client',
        ).toEqual(['broadcast', 'broadcast']);
        expect(Object.keys(ultimo().handlers).sort()).toEqual(['INSERT', 'UPDATE']);
    });

    it('`setAuth()` è atteso PRIMA di `subscribe()`: senza token la policy chiude il canale', async () => {
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        const iAuth = sb.ordine.indexOf('setAuth');
        const iSub = sb.ordine.indexOf('subscribe');
        expect(iAuth, '`setAuth()` non è stato chiamato').toBeGreaterThanOrEqual(0);
        expect(iSub, '`subscribe()` non è stato chiamato').toBeGreaterThanOrEqual(0);
        expect(iAuth, 'subscribe prima di setAuth: il join parte senza token (corsa vera, vedi connect())').toBeLessThan(iSub);
    });

    it('senza sessione di auth il canale NON nasce, e non in silenzio', async () => {
        sb.sessione = null;
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        expect(sb.creati, 'un canale aperto su `chat:undefined` non riceve niente').toHaveLength(0);
        const messaggi = logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toContain('chat-realtime-senza-identita');
    });

    it('se `setAuth()` fallisce il canale non nasce e il guasto si legge (solo la CLASSE dell’errore)', async () => {
        sb.setAuthFallisce = true;
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        expect(sb.creati).toHaveLength(0);
        const evento = logClient.mock.calls.map((c) => c[0] as { livello: string; messaggio: string }).at(-1);
        expect(evento?.messaggio).toBe('chat-realtime-identita-fallita: TypeError');
        expect(evento?.livello).toBe('warn');
    });

    it('nessun log porta il topic: dentro c’è l’uuid dell’utente', async () => {
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        act(() => ultimo().stato?.('CHANNEL_ERROR', new Error('socket closed: 1006')));
        act(() => ultimo().stato?.('CLOSED'));
        const tutto = JSON.stringify(logClient.mock.calls);
        expect(tutto).not.toContain('auth-1');
        expect(tutto).not.toContain('chat:');
    });
});

describe('useChatRealtime — D5: il canale non si rifà a ogni riordino', () => {
    it('riordinare i thread o aggiungerne uno non rimuove né ricrea il canale', async () => {
        const { rerender } = await monta({ userId: 'u-1', threads: [A, B], aperto: null });
        expect(sb.creati).toHaveLength(1);

        rerender({ userId: 'u-1', threads: [B, A], aperto: null });
        rerender({ userId: 'u-1', threads: [C, B, A], aperto: null });

        expect(sb.rimossi, 'un riordino ha fatto leave: i segnali di quella finestra sono persi').toBe(0);
        expect(sb.creati).toHaveLength(1);
    });

    it('sottoscrive anche con ZERO thread (la RLS filtra lato server)', async () => {
        await monta({ userId: 'u-1', threads: [], aperto: null });
        expect(sb.creati).toHaveLength(1);
        expect(ultimo().stato, 'il canale non è stato sottoscritto').not.toBeNull();
    });

    it('cambiare utente ricrea il canale sul topic del NUOVO uid di auth', async () => {
        const { rerender } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        sb.sessione = { user: { id: 'auth-2' } };
        rerender({ userId: 'u-2', threads: [A], aperto: null });
        await act(async () => {});
        expect(sb.rimossi).toBe(1);
        expect(sb.creati.map((c) => c.topic)).toEqual(['chat:auth-1', 'chat:auth-2']);
    });

    it('il segnale di INSERT si instrada col thread aperto letto AL MOMENTO dell’evento', async () => {
        const { rerender, cb } = await monta({ userId: 'u-1', threads: [A, B], aperto: null });
        rerender({ userId: 'u-1', threads: [A, B], aperto: 'th-a' });

        act(() => trasmetti(ultimo(), 'INSERT', segnale('th-a')));
        act(() => trasmetti(ultimo(), 'INSERT', segnale('th-b')));

        expect(cb.onNewMessage).toHaveBeenCalledTimes(1);
        expect(cb.onNewMessage).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'th-a', id: 'm-th-a' }));
        expect(cb.onThreadUnread).toHaveBeenCalledWith('th-b', expect.objectContaining({ thread_id: 'th-b' }));
    });

    it('un segnale senza `thread_id` si scarta: non è un messaggio instradabile', async () => {
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: 'th-a' });
        act(() => trasmetti(ultimo(), 'INSERT', { id: 'm-x', sender_id: 'doc-1', created_at: 'x' }));
        expect(cb.onNewMessage).not.toHaveBeenCalled();
        expect(cb.onThreadUnread).not.toHaveBeenCalled();
        expect(cb.onThreadSconosciuto).not.toHaveBeenCalled();
    });

    it('il segnale di un thread che la lista non conosce ancora non si perde: onThreadSconosciuto', async () => {
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: 'th-a' });
        act(() => trasmetti(ultimo(), 'INSERT', segnale('th-nuovo')));
        expect(cb.onThreadSconosciuto).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'th-nuovo' }));
        expect(cb.onNewMessage).not.toHaveBeenCalled();
        expect(cb.onThreadUnread).not.toHaveBeenCalled();
    });

    it('l’UPDATE arriva solo per il thread aperto', async () => {
        const { cb } = await monta({ userId: 'u-1', threads: [A, B], aperto: 'th-a' });
        act(() => trasmetti(ultimo(), 'UPDATE', segnale('th-a', { read_at: 'x' })));
        act(() => trasmetti(ultimo(), 'UPDATE', segnale('th-b', { read_at: 'x' })));
        expect(cb.onMessageUpdate).toHaveBeenCalledTimes(1);
        expect(cb.onMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-th-a', read_at: 'x' }));
    });
});

describe('useChatRealtime — D4: il canale che cade dice perché, una volta, e al rientro lo annuncia', () => {
    it('il primo SUBSCRIBED è silenzioso: niente log, niente rientro', async () => {
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        act(() => ultimo().stato?.('SUBSCRIBED'));
        expect(logClient).not.toHaveBeenCalled();
        expect(cb.onRiconnesso).not.toHaveBeenCalled();
    });

    it('CHANNEL_ERROR ripetuti: UN log per interruzione, col gettone nel MESSAGGIO e senza il testo dell’errore', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-14T10:00:00.000Z'));
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: null });
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

    it('TIMED_OUT apre un’interruzione con il suo gettone', async () => {
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        const stato = ultimo().stato!;
        act(() => stato('TIMED_OUT'));
        act(() => stato('TIMED_OUT'));
        expect(logClient).toHaveBeenCalledTimes(1);
        expect((logClient.mock.calls[0][0] as { messaggio: string }).messaggio).toBe('chat-realtime-timeout');
        act(() => stato('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledWith(expect.objectContaining({ errori: 2 }));
    });

    it('il CLOSED del proprio smontaggio non logga e non ricrea niente', async () => {
        const { unmount } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        vi.useFakeTimers();
        act(() => ultimo().stato?.('SUBSCRIBED'));
        unmount(); // removeChannel emette CLOSED in modo sincrono
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(logClient).not.toHaveBeenCalled();
        expect(sb.creati).toHaveLength(1);
    });

    it('un CLOSED inatteso ricrea il canale dopo 10 s, al massimo 3 volte, poi si arrende con un log', async () => {
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        vi.useFakeTimers();

        for (let tentativo = 1; tentativo <= 3; tentativo++) {
            act(() => ultimo().stato?.('CLOSED'));
            act(() => {
                vi.advanceTimersByTime(9_999);
            });
            expect(sb.creati, `ricreato prima dei 10 s (tentativo ${tentativo})`).toHaveLength(tentativo);
            await act(async () => {
                vi.advanceTimersByTime(1);
            });
            expect(sb.creati, `non ricreato dopo 10 s (tentativo ${tentativo})`).toHaveLength(tentativo + 1);
        }

        act(() => ultimo().stato?.('CLOSED'));
        await act(async () => {
            vi.advanceTimersByTime(120_000);
        });
        expect(sb.creati, 'oltre il terzo tentativo il canale si ricrea ancora').toHaveLength(4);

        const messaggi = logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toContain('chat-realtime-chiuso-inatteso');
        expect(messaggi.filter((m) => m === 'chat-realtime-abbandonato')).toHaveLength(1);
    });

    it('il SUBSCRIBED del canale ricreato è un rientro: i messaggi del buco vanno recuperati', async () => {
        const { cb } = await monta({ userId: 'u-1', threads: [A], aperto: null });
        vi.useFakeTimers();
        act(() => ultimo().stato?.('SUBSCRIBED'));
        act(() => ultimo().stato?.('CLOSED'));
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(sb.creati).toHaveLength(2);
        act(() => ultimo().stato?.('SUBSCRIBED'));
        expect(cb.onRiconnesso).toHaveBeenCalledTimes(1);
        expect(cb.onRiconnesso).toHaveBeenCalledWith(expect.objectContaining({ ms: 10_000, errori: 1 }));
    });

    it('la ricreazione NON rifà `getSession`: l’identità è già in mano, e il token lo rinfresca setAuth', async () => {
        await monta({ userId: 'u-1', threads: [A], aperto: null });
        const sessioniPrima = sb.ordine.filter((o) => o === 'getSession').length;
        vi.useFakeTimers();
        act(() => ultimo().stato?.('CLOSED'));
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(sb.creati).toHaveLength(2);
        expect(sb.ordine.filter((o) => o === 'getSession')).toHaveLength(sessioniPrima);
    });
});
