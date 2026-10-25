import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * UN OROLOGIO SOLO PER LA LISTA DELLA CHAT (robustezza 2, sessione 12 — S7).
 *
 * Fino al 2026-10-20 la stessa `GET /api/chat/threads` partiva da due orologi: quello di
 * `useConversazioneChat` e quello di `useUnreadNotifications`, ogni 30 s ciascuno. E ogni GET faceva
 * anche un UPDATE di `delivered_at`. Qui si prova che:
 *  · la lista ha UN orologio: 30 s a pagina visibile, 5 minuti a pagina nascosta (non fermo: la
 *    notifica del browser parte da lì), e al ritorno ricarica subito;
 *  · il totale della pagina è la somma dei non letti della lista;
 *  · la consegna parte solo con non letti nuovi, una alla volta;
 *  · i guasti del conteggio restano detti.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@/components/features/chat/useChatRealtime', () => ({ useChatRealtime: () => {} }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

import { useConversazioneChat } from '@/components/features/chat/useConversazioneChat';

const IO = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const LISTA = '/api/chat/threads';
const CONSEGNA = '/api/chat/threads/consegnati';

function riga(id: string, nonLetti: number, ultimo = '2026-10-20T08:00:00.000Z') {
    return {
        id,
        teacher_id: 'doc-1',
        parent_id: IO,
        student_id: 'alu-1',
        other_user: { first_name: 'A', last_name: 'B', role: 'teacher' },
        student: { nome: 'N', cognome: 'C', classe_sezione: 'S' },
        last_message: null,
        last_message_at: ultimo,
        unread_count: nonLetti,
        sospensione: null,
    };
}

type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };

const rete = {
    threads: [] as unknown[],
    stato: 200,
    giu: false,
    trattieniConsegne: false,
    consegneTrattenute: [] as Array<() => void>,
    chiamate: [] as Array<{ verbo: string; percorso: string }>,
};

function fetchFinto(input: string, init?: { method?: string }): Promise<Risposta> {
    const percorso = String(input).split('?')[0];
    const verbo = init?.method ?? 'GET';
    rete.chiamate.push({ verbo, percorso });
    if (percorso === LISTA && verbo === 'GET') {
        if (rete.giu) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: rete.stato < 400, status: rete.stato, json: async () => rete.threads });
    }
    if (percorso === CONSEGNA && verbo === 'POST') {
        const risposta: Risposta = { ok: true, status: 200, json: async () => ({ consegna: 'ok' }) };
        if (!rete.trattieniConsegne) return Promise.resolve(risposta);
        return new Promise((fatto) => rete.consegneTrattenute.push(() => fatto(risposta)));
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
}

const conta = (verbo: string, percorso: string) =>
    rete.chiamate.filter((c) => c.verbo === verbo && c.percorso === percorso).length;

async function avanza(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });
}

function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (nascosta ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}

async function monta() {
    const vista = renderHook(() => useConversazioneChat({ userId: IO, ready: true, rotta: '/parent/chat' }));
    await avanza(0);
    return vista;
}

beforeEach(() => {
    vi.useFakeTimers();
    rete.threads = [riga('th-a', 0), riga('th-b', 0)];
    rete.stato = 200;
    rete.giu = false;
    rete.trattieniConsegne = false;
    rete.consegneTrattenute = [];
    rete.chiamate = [];
    h.logClient.mockClear();
    vi.stubGlobal('fetch', vi.fn(fetchFinto));
});

afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('S7 — la lista ha UN orologio', () => {
    it('una GET al montaggio, poi una ogni 30 s: non due', async () => {
        const { unmount } = await monta();
        expect(conta('GET', LISTA)).toBe(1);
        await avanza(30_000);
        expect(conta('GET', LISTA), 'due orologi sulla stessa lista').toBe(2);
        await avanza(30_000);
        expect(conta('GET', LISTA)).toBe(3);
        unmount();
    });

    it('a pagina nascosta rallenta a 5 minuti, e al ritorno ricarica subito', async () => {
        const { unmount } = await monta();
        act(() => visibilita(true));
        await avanza(299_999);
        expect(conta('GET', LISTA), 'il ritmo veloce anche da nascosta').toBe(1);
        await avanza(1);
        expect(conta('GET', LISTA), 'da nascosta si è fermato: la notifica del browser non partirebbe più').toBe(2);
        act(() => visibilita(false));
        await avanza(0);
        expect(conta('GET', LISTA)).toBe(3);
        unmount();
    });

    it('il totale della pagina è la somma dei non letti della lista, e il titolo lo dice', async () => {
        rete.threads = [riga('th-a', 2), riga('th-b', 3)];
        const { result, unmount } = await monta();
        expect(result.current.nonLetti).toBe(5);
        expect(document.title).toBe('(5) Kidville');
        unmount();
    });

    /**
     * Il permesso delle notifiche lo chiede ancora la pagina chat: senza, la notifica del browser che
     * `annunciaNonLetti` manda da nascosta non uscirebbe mai. Qui `useUnreadNotifications` è quello
     * vero (gli altri test del hook lo sostituiscono con un finto), e lo si guarda chiedere UNA volta.
     */
    it('la pagina chat chiede il permesso delle notifiche, una volta sola anche coi giri dell’orologio', async () => {
        const richiesta = vi.fn(async () => 'granted' as NotificationPermission);
        vi.stubGlobal('Notification', { permission: 'default', requestPermission: richiesta });
        const { unmount } = await monta();
        await avanza(60_000);
        expect(richiesta, 'la pagina chat non chiede più il permesso: la notifica del browser non uscirebbe').toHaveBeenCalledTimes(1);
        unmount();
    });

    /**
     * La notifica del browser parte dall'orologio da NASCOSTA, sulla lista appena applicata: UNA quando
     * il totale sale, nessuna quando la lista è la stessa. E senza il testo del messaggio (W1).
     */
    it('da nascosta e senza fuoco: la lista che sale manda UNA notifica senza testo, la stessa lista nessuna', async () => {
        const create: Array<{ titolo: string; opzioni?: NotificationOptions }> = [];
        class NotificaFinta {
            static permission: NotificationPermission = 'granted';
            static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
            onclick: (() => void) | null = null;
            close = vi.fn();
            constructor(titolo: string, opzioni?: NotificationOptions) {
                create.push({ titolo, opzioni });
            }
        }
        vi.stubGlobal('Notification', NotificaFinta);
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        const { unmount } = await monta();
        expect(create).toHaveLength(0);

        act(() => visibilita(true));
        rete.threads = [{ ...riga('th-a', 1, '2026-10-20T08:01:00.000Z'), last_message: { content: 'testo segnaposto riservato' } }, riga('th-b', 0)];
        await avanza(300_000);
        expect(create, 'la lista salita da nascosta non ha mandato la notifica del browser').toHaveLength(1);
        expect(create[0].titolo).toBe('Nuovo messaggio in chat');
        expect(JSON.stringify(create[0]), 'la notifica porta il testo del messaggio').not.toContain('segnaposto');

        await avanza(300_000);
        expect(create, 'la stessa lista ha rimandato la notifica').toHaveLength(1);
        unmount();
    });
});

describe('S7 — la consegna esplicita parte solo con non letti nuovi', () => {
    it('una alla prima lista con non letti; nessuna se non cambia; una se cambia; nessuna se è tutto letto', async () => {
        rete.threads = [riga('th-a', 2), riga('th-b', 0)];
        const { unmount } = await monta();
        expect(conta('POST', CONSEGNA)).toBe(1);

        await avanza(30_000);
        expect(conta('POST', CONSEGNA), 'la stessa lista ha chiesto un’altra consegna').toBe(1);

        rete.threads = [riga('th-a', 3, '2026-10-20T08:05:00.000Z'), riga('th-b', 0)];
        await avanza(30_000);
        expect(conta('POST', CONSEGNA)).toBe(2);

        rete.threads = [riga('th-a', 0, '2026-10-20T08:05:00.000Z'), riga('th-b', 0)];
        await avanza(30_000);
        expect(conta('POST', CONSEGNA)).toBe(2);
        unmount();
    });

    it('senza non letti nessuna consegna, mai', async () => {
        const { unmount } = await monta();
        await avanza(90_000);
        expect(conta('POST', CONSEGNA)).toBe(0);
        unmount();
    });

    it('con una consegna in volo, due liste cambiate fanno UNA consegna in più, non due', async () => {
        rete.trattieniConsegne = true;
        rete.threads = [riga('th-a', 1)];
        const { unmount } = await monta();
        expect(conta('POST', CONSEGNA)).toBe(1);

        rete.threads = [riga('th-a', 2, '2026-10-20T08:01:00.000Z')];
        await avanza(30_000);
        rete.threads = [riga('th-a', 3, '2026-10-20T08:02:00.000Z')];
        await avanza(30_000);
        expect(conta('POST', CONSEGNA), 'una seconda POST partita mentre la prima era in volo').toBe(1);

        rete.trattieniConsegne = false;
        await act(async () => {
            rete.consegneTrattenute.shift()?.();
        });
        await avanza(0);
        expect(conta('POST', CONSEGNA)).toBe(2);
        unmount();
    });
});

describe('S7 — i guasti del conteggio restano detti', () => {
    it('rete giù con la lista già in mano: warn «chat-non-letti-conteggio-fallito» con la classe e la pagina', async () => {
        const { unmount } = await monta();
        rete.giu = true;
        await avanza(30_000);
        expect(h.logClient.mock.calls.map((c) => c[0])).toContainEqual({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'chat-non-letti-conteggio-fallito: TypeError',
            route: '/parent/chat',
        });
        unmount();
    });

    it('un 500 con la lista in mano non scrive quel warn (lo registra già il fetch strumentato), e la lista resta', async () => {
        const { result, unmount } = await monta();
        rete.stato = 500;
        await avanza(30_000);
        const messaggi = h.logClient.mock.calls.map((c) => String((c[0] as { messaggio: string }).messaggio));
        expect(messaggi.some((m) => m.startsWith('chat-non-letti-conteggio-fallito'))).toBe(false);
        expect(result.current.statoThreads).toBe('pronto');
        expect(result.current.threads).toHaveLength(2);
        unmount();
    });
});
