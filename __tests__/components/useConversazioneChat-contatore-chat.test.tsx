import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * LA PAGINA CHAT MUOVE IL CONTATORE DELLA BARRA IN BASSO (2026-09-29).
 *
 * `useConversazioneChat` ha già la sua aritmetica dei non letti (`nonLetti`), che serve alla
 * pagina: −n quando si segnano letti dei messaggi, +1 quando ne arriva uno altrui in un thread non
 * aperto. Il numero sulla barra in basso vive FUORI dalla pagina chat (lo mostra la bottom-nav, su
 * ogni schermata), quindi le stesse variazioni vanno riportate nello store — negli stessi punti,
 * con la stessa aritmetica. L'APERTURA di una conversazione non muove più nessuno dei due totali
 * (vedi il test sulla doppia sottrazione, più in basso).
 *
 * Qui si prova che ci arrivino, e che ci arrivino SOLO quando devono: una PATCH fallita non muove
 * niente, e non annuncia una lettura che il server non ha registrato.
 *
 * E si prova la seconda metà: quando il server dice di aver spento delle notifiche
 * (`notifiche_lette > 0`) parte l'evento che fa ricaricare la campanella.
 */

type Json = Record<string, unknown>;
type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };

const IO = 'aaaaaaaa-0000-4000-8000-00000000000a';

const TA = {
    id: 'th-a',
    teacher_id: 'doc-1',
    parent_id: IO,
    student_id: 'alu-1',
    other_user: { first_name: 'A', last_name: 'A', role: 'teacher' },
    student: { nome: 'N', cognome: 'C', classe_sezione: 'S' },
    last_message: null,
    last_message_at: '2026-09-29T07:00:00.000Z',
    unread_count: 0,
    sospensione: null,
};
const TB = { ...TA, id: 'th-b', unread_count: 3 };

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    realtime: null as null | Record<string, unknown>,
    unread: null as null | Record<string, unknown>,
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
vi.mock('@/components/features/chat/useUnreadNotifications', () => ({
    useUnreadNotifications: (o: Record<string, unknown>) => {
        h.unread = o;
    },
}));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

/** Lo stato della rete finta, per test. */
const rete = {
    threads: [TA, TB] as Json[],
    /** Lo stato HTTP della PATCH di lettura. */
    statoPatch: 200,
    /** Quante notifiche di campanella il server dice di aver spento. */
    notificheLette: 0,
    /** La PATCH risponde con un corpo che non è JSON. */
    corpoRotto: false,
    patch: [] as Json[],
};

function fetchFinto(input: string, init?: { method?: string; body?: unknown }): Promise<Risposta> {
    const url = String(input);
    const percorso = url.split('?')[0];
    const metodo = init?.method ?? 'GET';
    if (percorso === '/api/chat/threads' && metodo === 'GET') {
        return Promise.resolve({ ok: true, status: 200, json: async () => rete.threads });
    }
    if (percorso === '/api/chat/messages' && metodo === 'GET') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [], total: 0 }) });
    }
    if (percorso === '/api/chat/messages/read') {
        rete.patch.push(init?.body ? (JSON.parse(String(init.body)) as Json) : {});
        const ok = rete.statoPatch < 400;
        return Promise.resolve({
            ok,
            status: rete.statoPatch,
            json: async () => {
                if (rete.corpoRotto) throw new SyntaxError('Unexpected token <');
                return { success: ok, updated: 1, notifiche_lette: rete.notificheLette };
            },
        });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
}

type Store = typeof import('@/components/features/chat/contatore-non-letti');

/** Store e hook dallo STESSO registro dei moduli: il contatore è stato di modulo. */
async function apparato() {
    vi.resetModules();
    const store = (await import('@/components/features/chat/contatore-non-letti')) as Store;
    const { useConversazioneChat } = await import('@/components/features/chat/useConversazioneChat');
    const vista = renderHook(() => useConversazioneChat({ userId: IO, ready: true, rotta: '/parent/chat' }));
    await waitFor(() => expect(vista.result.current.statoThreads).toBe('pronto'));
    return { store, vista };
}

function realtime() {
    if (!h.realtime) throw new Error('useChatRealtime non montato');
    return h.realtime as {
        onThreadUnread: (id: string, m: Json) => void;
        onNewMessage: (m: Json) => void;
    };
}

function unread() {
    if (!h.unread) throw new Error('useUnreadNotifications non montato');
    return h.unread as { onUnreadChange?: (n: number) => void };
}

function messaggioAltrui(threadId: string, id: string): Json {
    return {
        id,
        thread_id: threadId,
        sender_id: 'doc-1',
        content: 'Ciao',
        attachment_url: null,
        attachment_type: null,
        read_at: null,
        delivered_at: null,
        created_at: '2026-09-29T08:00:00.000Z',
    };
}

async function scorri() {
    await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    });
}

beforeEach(() => {
    rete.threads = [TA, TB];
    rete.statoPatch = 200;
    rete.notificheLette = 0;
    rete.corpoRotto = false;
    rete.patch = [];
    h.realtime = null;
    h.unread = null;
    h.logClient.mockClear();
    vi.stubGlobal('fetch', vi.fn(fetchFinto));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('useConversazioneChat → contatore: le letture scendono', () => {
    it('una PATCH riuscita toglie dal contatore i messaggi segnati letti', async () => {
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(5, store.sequenzaChatNonLetti()));

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1', 'm-2']);
        });

        expect(store.chatNonLetti()).toBe(3);
    });

    it('una PATCH FALLITA non muove il contatore e non annuncia nessuna lettura', async () => {
        rete.statoPatch = 500;
        rete.notificheLette = 4;
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(5, store.sequenzaChatNonLetti()));
        const letture = vi.fn();
        const smetti = store.ascoltaChatLetta(letture);

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1']);
        });
        smetti();

        expect(store.chatNonLetti()).toBe(5);
        expect(letture).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ SI SOTTRAGGONO SOLO GLI ID NUOVI, non tutti quelli passati.
     *
     * `segnaLetti` riceve gli id dall'IntersectionObserver, che manda la finestra di bolle VISIBILI:
     * gli stessi id tornano a ogni scorrimento, e `lettiInviatiRef` tiene fuori quelli già mandati —
     * è la difesa che evita la PATCH doppia. Con `-ids.length` invece di `-nuovi.length` il totale
     * sottrarrebbe di nuovo ciò che ha già sottratto: scorrendo su e giù una conversazione il badge
     * andrebbe a zero senza che nessun altro messaggio sia stato letto.
     */
    it('sottrae solo i messaggi NUOVI: gli id già mandati non scalano una seconda volta', async () => {
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(5, store.sequenzaChatNonLetti()));

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1', 'm-2']);
        });
        expect(store.chatNonLetti()).toBe(3);

        // L'observer ripassa: `m-2` l'ha già mandato, `m-3` no.
        await act(async () => {
            await vista.result.current.segnaLetti(['m-2', 'm-3']);
        });

        expect(
            store.chatNonLetti(),
            'Il totale ha scalato anche `m-2`, che era già stato segnato letto: scorrendo su e giù ' +
                'una conversazione il badge andrebbe a zero senza nuove letture.',
        ).toBe(2);
    });

    it('`contaNelBadge: false` non tocca il contatore (il messaggio non c\'era mai entrato)', async () => {
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(5, store.sequenzaChatNonLetti()));

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1'], { contaNelBadge: false });
        });

        expect(store.chatNonLetti()).toBe(5);
    });

    /**
     * ⚠️ IL DIFETTO DELLA DOPPIA SOTTRAZIONE, e il motivo per cui l'apertura non tocca più il totale.
     *
     * Fino al 2026-09-29 `apri` sottraeva `unread_count` dal totale, e subito dopo la PATCH
     * dell'IntersectionObserver sottraeva GLI STESSI messaggi una seconda volta. Con due
     * conversazioni da 2 e 3 messaggi, aprire quella da 2 portava il totale a 1 invece di 3: un
     * numero più basso del vero, cioè «non hai niente da leggere» detto a chi ha ancora tre messaggi
     * di una famiglia. Il totale scende adesso solo quando la lettura è REGISTRATA.
     */
    it('aprire una conversazione NON tocca il totale: lo sottrae la PATCH, e UNA volta sola', async () => {
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(5, store.sequenzaChatNonLetti()));

        // TB ha 3 messaggi non letti.
        act(() => vista.result.current.apri(TB as never));
        await scorri();

        expect(
            store.chatNonLetti(),
            "L'apertura ha già sottratto: quando la PATCH arriverà, quei tre messaggi verranno " +
                'tolti una seconda volta e il totale dirà meno del vero.',
        ).toBe(5);
        // Il badge del SINGOLO thread nella lista si azzera comunque: è l'unico effetto che
        // l'apertura può garantire da sé, e non entra nell'aritmetica del totale.
        expect(vista.result.current.threads.find((t) => t.id === 'th-b')?.unread_count).toBe(0);

        // Poi l'IntersectionObserver segna letti i tre messaggi: UNA sola sottrazione.
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1', 'm-2', 'm-3']);
        });

        expect(store.chatNonLetti()).toBe(2);
    });

    it('…e lo stesso vale per il totale LOCALE dell’hook, quello dell’intestazione della pagina chat', async () => {
        const { vista } = await apparato();
        act(() => unread().onUnreadChange?.(5));
        expect(vista.result.current.nonLetti).toBe(5);

        act(() => vista.result.current.apri(TB as never));
        await scorri();
        expect(vista.result.current.nonLetti, "l'apertura ha sottratto dal totale locale").toBe(5);

        await act(async () => {
            await vista.result.current.segnaLetti(['m-1', 'm-2', 'm-3']);
        });
        expect(vista.result.current.nonLetti).toBe(2);
    });
});

describe('useConversazioneChat → contatore: i messaggi in arrivo salgono', () => {
    it('un messaggio ALTRUI in un thread non aperto vale +1', async () => {
        const { store } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(1, store.sequenzaChatNonLetti()));

        act(() => realtime().onThreadUnread('th-a', messaggioAltrui('th-a', 'm-9')));
        await scorri();

        expect(store.chatNonLetti()).toBe(2);
    });

    /**
     * ⚠️ IL MESSAGGIO CHE ARRIVA NELLA CONVERSAZIONE APERTA NON ALZA IL TOTALE.
     *
     * Quel messaggio lo si sta guardando: se la bolla è in vista, `handleRealtimeNewMessage` la segna
     * letta subito con `contaNelBadge: false` — «nel contatore globale non è mai entrato». Un `+1`
     * qui lo farebbe entrare e nessuno lo toglierebbe più: il badge salirebbe di uno per ogni
     * messaggio ricevuto a conversazione aperta, e resterebbe su per sempre. È il contatore gonfio
     * che questo lavoro esiste per togliere di mezzo, ricostruito da un'altra strada.
     *
     * Il `+1` vive SOLO in `onThreadUnread`, cioè per i thread NON aperti.
     */
    it('un messaggio altrui nella conversazione APERTA non alza il totale', async () => {
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(1, store.sequenzaChatNonLetti()));

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        act(() => realtime().onNewMessage(messaggioAltrui('th-a', 'm-9')));
        await scorri();

        expect(
            store.chatNonLetti(),
            'Il messaggio arrivato a conversazione aperta è entrato nel totale: lì viene segnato letto ' +
                'con `contaNelBadge: false`, quindi nessuno lo toglierà più e il badge sale per sempre.',
        ).toBe(1);
    });

    it('il PROPRIO messaggio, scritto da un altro dispositivo, non alza niente', async () => {
        const { store } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(1, store.sequenzaChatNonLetti()));

        act(() => realtime().onThreadUnread('th-a', { ...messaggioAltrui('th-a', 'm-9'), sender_id: IO }));
        await scorri();

        expect(store.chatNonLetti()).toBe(1);
    });
});

describe('useConversazioneChat → la campanella: `notifiche_lette`', () => {
    it('con `notifiche_lette > 0` parte l\'evento che fa ricaricare la campanella', async () => {
        rete.notificheLette = 2;
        const { store, vista } = await apparato();
        const letture = vi.fn();
        const smetti = store.ascoltaChatLetta(letture);

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1']);
        });
        smetti();

        expect(letture).toHaveBeenCalledTimes(1);
    });

    it('con `notifiche_lette: 0` NON parte nessun evento (niente da ricaricare)', async () => {
        rete.notificheLette = 0;
        const { store, vista } = await apparato();
        const letture = vi.fn();
        const smetti = store.ascoltaChatLetta(letture);

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1']);
        });
        smetti();

        expect(letture).not.toHaveBeenCalled();
    });

    it('un corpo illeggibile non è un guasto della lettura: niente eccezioni, e lo si logga', async () => {
        rete.corpoRotto = true;
        const { store, vista } = await apparato();
        act(() => store.impostaChatNonLettiDalServer(5, store.sequenzaChatNonLetti()));
        const letture = vi.fn();
        const smetti = store.ascoltaChatLetta(letture);

        act(() => vista.result.current.apri(TA as never));
        await scorri();
        await act(async () => {
            await vista.result.current.segnaLetti(['m-1']);
        });
        smetti();

        // La lettura è andata: il contatore scende comunque, nessun evento (non si sa nulla).
        expect(store.chatNonLetti()).toBe(4);
        expect(letture).not.toHaveBeenCalled();
        expect(
            h.logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio),
            'Un catch che non logga è un bug (AGENTS.md regola 6).',
        ).toContainEqual(expect.stringContaining('chat-segna-letti-corpo-illeggibile'));
    });
});

/**
 * ⚠️ IL TOTALE DI `useUnreadNotifications` NON DEVE ENTRARE NELLO STORE, e questo è il lock.
 *
 * Il numero sarebbe lo stesso di `chat_non_letti` — stesso `or`, stessi «messaggi altrui con
 * `read_at` nullo» — ma la route da cui viene (`chat/threads:GET`) trasforma l'errore del conteggio
 * di UN thread in uno zero (`unread_count: unreadCount ?? 0`): un guasto parziale è indistinguibile
 * da «quella conversazione è tutta letta», e finirebbe nello store come un totale sbagliato PER
 * DIFETTO, cioè come la bugia «hai letto tutto».
 *
 * La fonte di verità dal server resta UNA: `GET /api/notifiche`, che su qualunque errore risponde
 * `null`. Il totale dell'hook serve solo alla pagina chat, dove convive con la lista da cui è nato.
 */
describe('useConversazioneChat → il totale della pagina chat resta nella pagina chat', () => {
    it('`onUnreadChange` non scrive nel contatore della barra in basso', async () => {
        const { store } = await apparato();

        act(() => unread().onUnreadChange?.(7));

        expect(
            store.chatNonLetti(),
            'Il totale di `chat/threads:GET` è finito nello store: quella route conta 0 anche quando ' +
                'il conteggio di un thread FALLISCE, quindi un guasto parziale scriverebbe un numero ' +
                'più basso del vero sulla barra di ogni schermata.',
        ).toBeNull();
    });

    it('e lo aggiorna comunque dentro la pagina (nessuna funzione persa)', async () => {
        const { vista } = await apparato();

        act(() => unread().onUnreadChange?.(7));

        expect(vista.result.current.nonLetti).toBe(7);
    });
});
