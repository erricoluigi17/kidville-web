/**
 * LA NOTIFICA DEL BROWSER DELLA CHAT NON MOSTRA NÉ TESTO NÉ NOME (spec 2026-09-24, «sei interventi», W1).
 *
 * Fino a oggi il titolo era «Nuovo messaggio da <mittente>» e il corpo i primi 60 caratteri del
 * messaggio: su uno schermo condiviso (la scrivania della segreteria, il PC di casa) il contenuto di
 * una chat fra famiglia e scuola compariva a chiunque passasse. Decisione del titolare: il testo è
 * SEMPRE «Nuovo messaggio in chat», senza testo e senza nome — anche con più messaggi nuovi.
 *
 * E i due `catch` del hook, che erano muti, ora registrano il guasto (AGENTS.md, regola 6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
// Il ritmo del polling ha i suoi test: qui basta il primo controllo, che parte dall'effetto del hook.
vi.mock('@/lib/hooks/use-polling-visibile', () => ({ usePollingVisibile: () => {} }));

import { useUnreadNotifications } from '@/components/features/chat/useUnreadNotifications';

const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000051';
const A = 'dddddddd-0000-4000-8000-0000000000a1';
const B = 'dddddddd-0000-4000-8000-0000000000b2';

/** Segnaposti riconoscibili: se compaiono in una notifica, il dato è trapelato. */
const NOME = 'NomeSegnaposto';
const COGNOME = 'CognomeSegnaposto';
const TESTO = 'testo segnaposto del messaggio riservato';

class NotificaFinta {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    static create: NotificaFinta[] = [];
    static lancia: Error | null = null;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
        public titolo: string,
        public opzioni?: NotificationOptions,
    ) {
        if (NotificaFinta.lancia) throw NotificaFinta.lancia;
        NotificaFinta.create.push(this);
    }
}

const thread = (id: string, nonLetti: number) => ({
    id,
    unread_count: nonLetti,
    other_user: { first_name: NOME, last_name: COGNOME },
    last_message: { content: TESTO },
});

function rispondeConLista(lista: unknown[]) {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => lista }) as unknown as Response);
    vi.stubGlobal('fetch', f);
    return f;
}

function monta() {
    return renderHook(() => useUnreadNotifications({ userId: UTENTE, enabled: true, pollInterval: 30_000 }));
}

beforeEach(() => {
    NotificaFinta.create = [];
    NotificaFinta.lancia = null;
    document.title = 'prima del giro';
    vi.stubGlobal('Notification', NotificaFinta);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    h.logClient.mockClear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Tutto ciò che la notifica porta a schermo, serializzato: titolo e opzioni. */
function aSchermo(n: NotificaFinta): string {
    return JSON.stringify({ titolo: n.titolo, opzioni: n.opzioni ?? null });
}

describe('notifica del browser di un messaggio di chat: niente testo, niente nome', () => {
    it('un messaggio nuovo: titolo «Nuovo messaggio in chat», nessun corpo, né nome né testo del messaggio', async () => {
        rispondeConLista([thread(A, 1)]);
        const r = monta();
        await waitFor(() => expect(NotificaFinta.create).toHaveLength(1));

        const n = NotificaFinta.create[0];
        expect(n.titolo).toBe('Nuovo messaggio in chat');
        expect(n.opzioni?.body).toBeUndefined();
        const schermo = aSchermo(n);
        expect(schermo).not.toContain(NOME);
        expect(schermo).not.toContain(COGNOME);
        expect(schermo).not.toContain('segnaposto');
        // Il raggruppamento delle notifiche resta quello di prima.
        expect(n.opzioni?.tag).toBe('kidville-chat');
        r.unmount();
    });

    it('più messaggi nuovi in più conversazioni: lo stesso titolo, senza conteggio né nome', async () => {
        rispondeConLista([thread(A, 2), thread(B, 3)]);
        const r = monta();
        await waitFor(() => expect(NotificaFinta.create).toHaveLength(1));

        const n = NotificaFinta.create[0];
        expect(n.titolo).toBe('Nuovo messaggio in chat');
        expect(n.opzioni?.body).toBeUndefined();
        expect(aSchermo(n)).not.toMatch(/\d+ nuovi messaggi/);
        expect(aSchermo(n)).not.toContain(NOME);
        r.unmount();
    });

    it('nessun messaggio non letto: nessuna notifica (il conteggio non è salito)', async () => {
        const f = rispondeConLista([thread(A, 0)]);
        const r = monta();
        await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
        // Si aspetta la PRESENZA di un effetto del giro completato: il titolo della pagina.
        await waitFor(() => expect(document.title).toBe('Kidville'));

        expect(NotificaFinta.create).toHaveLength(0);
        r.unmount();
    });
});

describe('i catch del hook registrano il guasto', () => {
    it('il conteggio fallisce (rete giù): warn «fetch» col solo nome dell\'errore, e nessuna notifica', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`Failed to fetch ${NOME}`); }));
        const r = monta();
        await waitFor(() => expect(h.logClient).toHaveBeenCalledTimes(1));

        expect(h.logClient).toHaveBeenCalledWith({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'chat-non-letti-conteggio-fallito: TypeError',
        });
        // Il `message` dell'errore non entra nel log.
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(NOME);
        expect(NotificaFinta.create).toHaveLength(0);
        r.unmount();
    });

    it('la risposta non è una lista: il giro salta e il guasto si registra', async () => {
        rispondeConLista({ errore: 'forma inattesa' } as unknown as unknown[]);
        const r = monta();
        await waitFor(() => expect(h.logClient).toHaveBeenCalledTimes(1));

        expect(h.logClient.mock.calls[0][0]).toMatchObject({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'chat-non-letti-conteggio-fallito: TypeError',
        });
        r.unmount();
    });

    it('il costruttore della notifica lancia (Chrome Android): warn «push» col solo nome dell\'errore', async () => {
        NotificaFinta.lancia = new TypeError(`Illegal constructor ${TESTO}`);
        rispondeConLista([thread(A, 1)]);
        const r = monta();
        await waitFor(() => expect(h.logClient).toHaveBeenCalledTimes(1));

        expect(h.logClient).toHaveBeenCalledWith({
            livello: 'warn',
            evento: 'push',
            messaggio: 'chat-notifica-browser-non-mostrata: TypeError',
        });
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('segnaposto');
        expect(NotificaFinta.create).toHaveLength(0);
        r.unmount();
    });
});
