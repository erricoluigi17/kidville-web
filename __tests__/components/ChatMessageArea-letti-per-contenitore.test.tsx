import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea';

/**
 * IL CONTENITORE DEI MESSAGGI HA UN NOME, E OGNI ISTANZA GUARDA SOLO DENTRO SÉ STESSA.
 *
 * Le pagine della chat montano `ChatMessageArea` DUE volte quando una conversazione è aperta:
 * l'istanza desktop (`hidden md:flex`) e quella mobile a schermo intero. Nel DOM ci sono
 * entrambe. Questo file prova le proprietà che dipendono dal contenitore: che si possa trovare
 * (i test di pagina contano i doppioni DENTRO un contenitore, non nel documento), e — nei casi
 * aggiunti con la correzione dell'observer — che ciascuna istanza osservi solo le proprie bolle.
 */

beforeAll(() => {
    // jsdom non implementa scrollIntoView: gli effetti di scorrimento lo chiamano al montaggio.
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

const base: Omit<ChatMessage, 'id'> = {
    thread_id: 'th-1',
    sender_id: 'doc-1',
    content: 'Buongiorno',
    attachment_url: null,
    attachment_type: null,
    read_at: '2026-09-14T08:00:00.000Z',
    created_at: '2026-09-14T07:59:00.000Z',
};

describe('ChatMessageArea — il contenitore che scorre', () => {
    it('è marcato data-testid="chat-messaggi"', () => {
        render(
            <ChatMessageArea
                messages={[{ ...base, id: 'm-1' }]}
                currentUserId="gen-1"
                otherUserName="Dora"
                firstUnreadId={null}
            />,
        );
        const contenitore = screen.getByTestId('chat-messaggi');
        expect(contenitore).toHaveTextContent('Buongiorno');
    });
});

/* ── L'IntersectionObserver finto: registra, per ciascuna istanza, cosa osserva ── */

type Voce = { isIntersecting: boolean; target: Element };

const osservatori: FintoIO[] = [];

class FintoIO {
    osservati: Element[] = [];
    scollegato = false;
    constructor(public cb: (voci: Voce[]) => void) {
        osservatori.push(this);
    }
    observe(el: Element) {
        this.osservati.push(el);
    }
    unobserve(el: Element) {
        this.osservati = this.osservati.filter((x) => x !== el);
    }
    disconnect() {
        this.scollegato = true;
        this.osservati = [];
    }
    takeRecords() {
        return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
}

function attivi() {
    return osservatori.filter((o) => !o.scollegato);
}

const nonLetto = (id: string, testo: string, thread = 'th-1'): ChatMessage => ({
    ...base,
    id,
    thread_id: thread,
    content: testo,
    read_at: null,
});

describe('ChatMessageArea — l’observer dei letti guarda solo DENTRO il proprio contenitore', () => {
    beforeAll(() => {
        vi.stubGlobal('IntersectionObserver', FintoIO as unknown as typeof IntersectionObserver);
    });

    afterEach(() => {
        osservatori.length = 0;
    });

    it('due istanze montate insieme (desktop e mobile): ciascun observer osserva solo le proprie bolle', () => {
        render(
            <>
                <ChatMessageArea messages={[nonLetto('m-a', 'Bolla di A')]} currentUserId="gen-1" otherUserName="Dora" firstUnreadId={null} onMarkRead={vi.fn()} />
                <ChatMessageArea messages={[nonLetto('m-b', 'Bolla di B')]} currentUserId="gen-1" otherUserName="Dora" firstUnreadId={null} onMarkRead={vi.fn()} />
            </>,
        );

        const conBolle = attivi().filter((o) => o.osservati.length > 0);
        expect(conBolle).toHaveLength(2);
        for (const o of conBolle) {
            // Prima ognuno osservava anche le bolle dell'altra istanza: un lotto di letti partiva due volte.
            expect(o.osservati, 'un observer osserva bolle di un altro contenitore').toHaveLength(1);
            const contenitori = new Set(o.osservati.map((el) => el.closest('[data-testid="chat-messaggi"]')));
            expect(contenitori.size).toBe(1);
        }
    });

    it('i messaggi arrivati mentre era in caricamento vengono osservati quando il caricamento finisce', () => {
        const messaggi = [nonLetto('m-a', 'Bolla di A')];
        const { rerender } = render(
            <ChatMessageArea messages={messaggi} currentUserId="gen-1" otherUserName="Dora" firstUnreadId={null} onMarkRead={vi.fn()} loading />,
        );
        expect(attivi().flatMap((o) => o.osservati)).toHaveLength(0);

        // Stessi messaggi, stesso array: cambia solo `loading`.
        rerender(<ChatMessageArea messages={messaggi} currentUserId="gen-1" otherUserName="Dora" firstUnreadId={null} onMarkRead={vi.fn()} loading={false} />);

        expect(attivi().flatMap((o) => o.osservati), 'la bolla non letta non è mai stata osservata: non verrà segnata letta').toHaveLength(1);
    });

    it('una bolla che entra nel viewport arriva a onMarkRead col suo id, dopo il debounce', async () => {
        vi.useFakeTimers();
        const onMarkRead = vi.fn();
        render(<ChatMessageArea messages={[nonLetto('m-a', 'Bolla di A')]} currentUserId="gen-1" otherUserName="Dora" firstUnreadId={null} onMarkRead={onMarkRead} />);
        const o = attivi().find((x) => x.osservati.length > 0);
        expect(o).toBeDefined();
        o?.cb([{ isIntersecting: true, target: o.osservati[0] }]);
        vi.advanceTimersByTime(600);
        expect(onMarkRead).toHaveBeenCalledWith(['m-a']);
        vi.useRealTimers();
    });
});
