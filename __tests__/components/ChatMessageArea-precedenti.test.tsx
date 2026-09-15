import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea';

/**
 * «CARICA MESSAGGI PRECEDENTI» E LO SCORRIMENTO CHE NON SALTA (parte B, 2026-09-14).
 *
 * Dal 2026-09-14 la GET dei messaggi porta gli ULTIMI 50, e lo storico si chiede a mano con un
 * pulsante in cima. Questo file prova ciò che il componente deve fare perché il pulsante serva a
 * qualcosa:
 *
 *  · il pulsante sta DENTRO il contenitore che scorre, prima del primo messaggio, e dice quando
 *    sta caricando e quando non ci è riuscito (i testi sono quelli veri del catalogo italiano,
 *    tramite il mock globale di next-intl: una chiave mancante si vedrebbe);
 *  · aggiungere messaggi IN TESTA non sposta ciò che si sta leggendo. Prima un effetto guardava
 *    solo `messages.length`: la pagina vecchia faceva crescere la lista e lui scorreva in fondo,
 *    cioè l'utente che aveva appena chiesto i messaggi di prima veniva rispedito all'ultimo.
 *    WebKit (la WebView dell'app iOS) non ha lo scroll anchoring: la correzione è nostra;
 *  · un messaggio che arriva IN CODA porta in fondo solo se è mio o se chi legge era già in fondo:
 *    chi sta leggendo lo storico non viene strappato via da ogni messaggio in arrivo.
 *
 * jsdom non impagina: la geometria (posizioni, altezze, scorrimento) è finta e dichiarata caso per
 * caso, ed è l'unica cosa finta. La prova sulla geometria VERA, su Chromium e su WebKit, è
 * `e2e/chat-precedenti.spec.ts` in CI.
 */

const IO = 'gen-1';
const ALTRO = 'doc-1';

const idMsg = (n: number) => `m-${String(n).padStart(3, '0')}`;

function msg(n: number, extra: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: idMsg(n),
        thread_id: 'th-1',
        sender_id: ALTRO,
        content: `Messaggio ${n}`,
        attachment_url: null,
        attachment_type: null,
        read_at: '2026-09-14T08:00:00.000Z',
        created_at: new Date(Date.UTC(2026, 8, 1, 8, 0, 0) + n * 60_000).toISOString(),
        ...extra,
    };
}

const daA = (da: number, a: number, extra: Partial<ChatMessage> = {}) =>
    Array.from({ length: a - da + 1 }, (_, i) => msg(da + i, extra));

/* ── La geometria finta ─────────────────────────────────────────────────────── */

/** Il `top` a schermo di ciascun messaggio (per `data-msg-id`); il contenitore sta a 0. */
const posizioni = new Map<string, number>();
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
    posizioni.clear();
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const id = this.getAttribute('data-msg-id');
        const top = id ? (posizioni.get(id) ?? 0) : 0;
        return { top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** Scorrimento e altezze del contenitore, come li vedrebbe un browser. `scrollTop` resta scrivibile. */
function geometria(contenitore: HTMLElement, g: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    let scrollTop = g.scrollTop;
    Object.defineProperty(contenitore, 'scrollHeight', { configurable: true, get: () => g.scrollHeight });
    Object.defineProperty(contenitore, 'clientHeight', { configurable: true, get: () => g.clientHeight });
    Object.defineProperty(contenitore, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
            scrollTop = v;
        },
    });
    // Chi scorre a mano genera eventi di scroll: è da lì che il componente sa dove sta chi legge.
    fireEvent.scroll(contenitore);
}

function area(props: Partial<Parameters<typeof ChatMessageArea>[0]> & { messages: ChatMessage[] }) {
    return <ChatMessageArea currentUserId={IO} otherUserName="Dora" firstUnreadId={null} {...props} />;
}

/* ── Il pulsante ────────────────────────────────────────────────────────────── */

describe('ChatMessageArea — «Carica messaggi precedenti»', () => {
    it('sta DENTRO il contenitore che scorre, prima del primo messaggio, e il tocco chiede i precedenti', () => {
        const onCaricaPrecedenti = vi.fn();
        render(area({ messages: daA(11, 20), haPrecedenti: true, onCaricaPrecedenti }));

        const contenitore = screen.getByTestId('chat-messaggi');
        const pulsante = within(contenitore).getByRole('button', { name: 'Carica messaggi precedenti' });
        const primo = within(contenitore).getByText('Messaggio 11');
        expect(pulsante.compareDocumentPosition(primo) & Node.DOCUMENT_POSITION_FOLLOWING, 'il pulsante non sta sopra i messaggi').toBeTruthy();

        fireEvent.click(pulsante);
        expect(onCaricaPrecedenti).toHaveBeenCalledTimes(1);
    });

    it('mentre carica è disabilitato e aria-busy, e dice che sta caricando', () => {
        render(area({ messages: daA(11, 20), haPrecedenti: true, caricandoPrecedenti: true, onCaricaPrecedenti: vi.fn() }));

        const pulsante = within(screen.getByTestId('chat-messaggi')).getByRole('button', { name: /Caricamento messaggi/ });
        expect(pulsante).toBeDisabled();
        expect(pulsante).toHaveAttribute('aria-busy', 'true');
    });

    it('se non ci è riuscito lo dice (role=alert) e il pulsante resta per riprovare', () => {
        render(area({ messages: daA(11, 20), haPrecedenti: true, errorePrecedenti: true, onCaricaPrecedenti: vi.fn() }));

        const contenitore = screen.getByTestId('chat-messaggi');
        expect(within(contenitore).getByRole('alert')).toHaveTextContent('Non è stato possibile caricare i messaggi precedenti. Riprova.');
        expect(within(contenitore).getByRole('button', { name: 'Carica messaggi precedenti' })).toBeEnabled();
    });

    it('senza precedenti non c’è', () => {
        render(area({ messages: daA(1, 10), haPrecedenti: false, onCaricaPrecedenti: vi.fn() }));
        expect(screen.queryByRole('button', { name: 'Carica messaggi precedenti' })).toBeNull();
    });

    it('ogni messaggio porta data-msg-id, distinto da data-message-id (che resta ai soli non letti)', () => {
        const { container } = render(
            area({ messages: [msg(1), msg(2, { sender_id: IO, read_at: null }), msg(3, { read_at: null })] }),
        );
        expect(Array.from(container.querySelectorAll('[data-msg-id]')).map((el) => el.getAttribute('data-msg-id'))).toEqual([
            idMsg(1),
            idMsg(2),
            idMsg(3),
        ]);
        // Solo il #3 è un non letto DELL'INTERLOCUTORE: l'IntersectionObserver guarda quello e basta.
        expect(Array.from(container.querySelectorAll('[data-message-id]')).map((el) => el.getAttribute('data-message-id'))).toEqual([idMsg(3)]);
    });
});

/* ── Lo scorrimento ─────────────────────────────────────────────────────────── */

describe('ChatMessageArea — aggiungere in testa non sposta ciò che si legge', () => {
    it('i precedenti arrivano sopra: il messaggio che era in cima resta dov’era, e niente salto in fondo', () => {
        posizioni.set(idMsg(11), 40);
        const { rerender } = render(area({ messages: daA(11, 60), haPrecedenti: true, onCaricaPrecedenti: vi.fn() }));
        const contenitore = screen.getByTestId('chat-messaggi');
        geometria(contenitore, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        scrollIntoView.mockClear();

        // I dieci messaggi più vecchi spingono l'#11 cinquecento pixel più giù.
        posizioni.set(idMsg(11), 540);
        rerender(area({ messages: daA(1, 60), haPrecedenti: false, onCaricaPrecedenti: vi.fn() }));

        expect(scrollIntoView, 'aggiungere in testa ha fatto scorrere la conversazione in fondo').not.toHaveBeenCalled();
        expect(contenitore.scrollTop, 'il messaggio che si stava leggendo è scivolato via').toBe(500);
    });
});

describe('ChatMessageArea — un messaggio in coda porta in fondo solo chi era già lì, o chi l’ha scritto', () => {
    it('chi è in fondo ci resta quando arriva un messaggio', () => {
        const { rerender } = render(area({ messages: daA(11, 60) }));
        geometria(screen.getByTestId('chat-messaggi'), { scrollHeight: 3000, clientHeight: 500, scrollTop: 2500 });
        scrollIntoView.mockClear();

        rerender(area({ messages: daA(11, 61) }));

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('chi legge più su non viene strappato via da un messaggio altrui; il proprio messaggio porta in fondo', () => {
        const { rerender } = render(area({ messages: daA(11, 60) }));
        geometria(screen.getByTestId('chat-messaggi'), { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        scrollIntoView.mockClear();

        rerender(area({ messages: daA(11, 61) }));
        expect(scrollIntoView, 'un messaggio in arrivo ha portato in fondo chi stava leggendo più su').not.toHaveBeenCalled();

        rerender(area({ messages: [...daA(11, 61), msg(62, { sender_id: IO })] }));
        expect(scrollIntoView, 'il proprio messaggio appena inviato non si vede').toHaveBeenCalledTimes(1);
    });

    it('la lista che compare quando finisce il caricamento si apre in fondo, anche se un messaggio era arrivato prima', () => {
        // Il realtime consegna un messaggio mentre la prima GET è in volo: la lista ha già un elemento
        // mentre c'è lo spinner. Prima lo scorrimento iniziale scattava allora (senza niente a schermo)
        // e non scattava più: la conversazione restava aperta in cima.
        const { rerender } = render(area({ messages: [msg(60)], loading: true }));
        scrollIntoView.mockClear();

        rerender(area({ messages: daA(11, 60), loading: false }));

        expect(scrollIntoView).toHaveBeenCalled();
    });
});
