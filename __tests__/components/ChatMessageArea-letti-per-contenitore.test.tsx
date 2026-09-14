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
