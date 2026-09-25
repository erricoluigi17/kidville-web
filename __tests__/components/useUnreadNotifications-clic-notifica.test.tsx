/**
 * IL CLIC SULLA NOTIFICA DEL BROWSER APRE LA CONVERSAZIONE (parte C della correzione chat, 2026-09-15).
 *
 * `useUnreadNotifications` vive dentro la pagina chat (`useConversazioneChat`) e, quando la pagina NON è
 * a fuoco — la chat aperta in una scheda dietro le altre — manda una notifica del browser per i messaggi
 * nuovi. Al clic faceva solo `window.focus()`: la finestra tornava davanti, ma la conversazione del
 * messaggio no, anche se la notifica la conosceva (è quella da cui prende il nome del mittente).
 *
 * Decisione del titolare (2026-09-14): il tocco su una notifica di chat apre la conversazione giusta, su
 * tutti i percorsi. Questo è il percorso web «a pagina aperta ma non a fuoco»: il clic chiede alla pagina
 * chat montata di aprire la conversazione, con lo stesso evento del tocco sulla push
 * (`richiediAperturaThread`). Qui la pagina è un ascoltatore vero di `ascoltaAperturaThread`.
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
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread';

const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000041';
const A = 'dddddddd-0000-4000-8000-0000000000a1';
const B = 'dddddddd-0000-4000-8000-0000000000b2';
const C = 'dddddddd-0000-4000-8000-0000000000c3';

/** La `Notification` del browser, che jsdom non ha: si registra ogni notifica creata. */
class NotificaFinta {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    static create: NotificaFinta[] = [];
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
        public titolo: string,
        public opzioni?: NotificationOptions,
    ) {
        NotificaFinta.create.push(this);
    }
}

/** Una riga della lista come la restituisce `/api/chat/threads` (ordinata dal messaggio più recente). */
const thread = (id: string, nonLetti: number) => ({
    id,
    unread_count: nonLetti,
    other_user: { first_name: 'Nome', last_name: 'Finto' },
    last_message: { content: 'testo finto' },
});

function rispondeConLista(lista: unknown[]) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => lista }) as unknown as Response),
    );
}

/** Le pagine chat «montate» nel test: si smontano tutte dopo, il contatore dell'apertura è di modulo. */
const pagineMontate: Array<() => void> = [];
function paginaChatMontata() {
    const gestore = vi.fn();
    pagineMontate.push(ascoltaAperturaThread(gestore));
    return gestore;
}

/** Monta il hook e aspetta la notifica del primo controllo. */
async function notificaArrivata() {
    const r = renderHook(() => useUnreadNotifications({ userId: UTENTE, enabled: true, pollInterval: 30_000 }));
    await waitFor(() => expect(NotificaFinta.create).toHaveLength(1));
    return { notifica: NotificaFinta.create[0], smonta: r.unmount };
}

let focus: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    NotificaFinta.create = [];
    vi.stubGlobal('Notification', NotificaFinta);
    // La notifica parte solo a pagina NON a fuoco.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    h.logClient.mockClear();
});

afterEach(() => {
    while (pagineMontate.length) pagineMontate.pop()!();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('clic sulla notifica del browser di un messaggio di chat', () => {
    it('porta la finestra davanti e apre la conversazione del messaggio nella pagina chat', async () => {
        rispondeConLista([thread(A, 1)]);
        const pagina = paginaChatMontata();
        const { notifica, smonta } = await notificaArrivata();

        notifica.onclick!();

        expect(pagina).toHaveBeenCalledTimes(1);
        expect(pagina).toHaveBeenCalledWith(A);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(notifica.close).toHaveBeenCalled();
        smonta();
    });

    it('con più conversazioni non lette apre quella di cui la notifica parla: la più recente con messaggi non letti', async () => {
        // A è la più recente, ma i suoi messaggi sono letti: la notifica parla di B.
        rispondeConLista([thread(A, 0), thread(B, 2), thread(C, 1)]);
        const pagina = paginaChatMontata();
        const { notifica, smonta } = await notificaArrivata();

        notifica.onclick!();

        expect(pagina.mock.calls).toEqual([[B]]);
        smonta();
    });

    it('senza una pagina chat in ascolto il clic porta solo la finestra davanti, senza errori né log (presidio)', async () => {
        rispondeConLista([thread(A, 1)]);
        const { notifica, smonta } = await notificaArrivata();

        expect(() => notifica.onclick!()).not.toThrow();

        expect(focus).toHaveBeenCalledTimes(1);
        expect(notifica.close).toHaveBeenCalled();
        expect(h.logClient).not.toHaveBeenCalled();
        smonta();
    });
});
