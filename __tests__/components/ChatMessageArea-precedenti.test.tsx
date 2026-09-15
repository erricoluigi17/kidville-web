import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea';

/**
 * «CARICA MESSAGGI PRECEDENTI» (parte B, 2026-09-14).
 *
 * Dal 2026-09-14 la GET dei messaggi porta gli ULTIMI 50, e lo storico si chiede a mano con un
 * pulsante in cima. Il pulsante sta DENTRO il contenitore che scorre, prima del primo messaggio, e
 * dice quando sta caricando e quando non ci è riuscito. I testi sono quelli veri del catalogo
 * italiano, tramite il mock globale di next-intl: una chiave mancante si vedrebbe.
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

beforeEach(() => {
    // jsdom non implementa scrollIntoView: gli effetti di scorrimento lo chiamano al montaggio.
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

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
});
