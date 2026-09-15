import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea';

/**
 * IL GRUPPO DEL GIORNO È UNA DATA, NON UN'ETICHETTA (2026-09-14).
 *
 * I messaggi si raggruppano per giorno sotto un separatore («Oggi», «Ieri», «5 novembre»). Il
 * gruppo era definito dall'ETICHETTA, che ne era anche la chiave React: finché la conversazione
 * mostrava i primi 50 messaggi di un anno scolastico non si notava, ma con «Carica messaggi
 * precedenti» lo storico può coprire due anni, e il 5 novembre dell'anno scorso e quello di
 * quest'anno hanno la stessa etichetta. Due difetti dalla stessa radice:
 *  · due gruppi con la stessa chiave, per React, sono lo stesso figlio: a un aggiornamento uno dei
 *    due può sparire o comparire due volte;
 *  · due giorni CONSECUTIVI con la stessa etichetta finivano sotto un solo separatore, come se
 *    fossero lo stesso giorno.
 * Il gruppo, e la sua chiave, sono la data di calendario nel fuso della scuola.
 */

beforeEach(() => {
    // jsdom non implementa scrollIntoView: gli effetti di scorrimento lo chiamano al montaggio.
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function msg(n: number, extra: Partial<ChatMessage>): ChatMessage {
    return {
        id: `m-${n}`,
        thread_id: 'th-1',
        sender_id: 'doc-1',
        content: `Messaggio ${n}`,
        attachment_url: null,
        attachment_type: null,
        read_at: '2026-09-14T08:00:00.000Z',
        created_at: '2026-09-01T08:00:00.000Z',
        ...extra,
    };
}

function area(messages: ChatMessage[]) {
    return <ChatMessageArea currentUserId="gen-1" otherUserName="Dora" firstUnreadId={null} messages={messages} />;
}

/** «Oggi» è il 1° marzo 2027: tutte le date di prova sono più vecchie, e l'etichetta è giorno e mese. */
function orologioAl1Marzo2027() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-01T12:00:00Z'));
}

describe('ChatMessageArea — il gruppo del giorno è una DATA, non un’etichetta', () => {
    it('il 5 novembre di due anni diversi sono due gruppi con due chiavi diverse', () => {
        orologioAl1Marzo2027();
        const errori = vi.spyOn(console, 'error').mockImplementation(() => {});

        render(
            area([
                msg(1, { created_at: '2025-11-05T12:00:00.000Z', content: 'Un anno fa' }),
                msg(2, { created_at: '2026-03-01T12:00:00.000Z', content: 'In mezzo' }),
                msg(3, { created_at: '2026-11-05T12:00:00.000Z', content: 'Quest’anno' }),
            ]),
        );

        const chiaviDuplicate = errori.mock.calls.filter((c) => String(c[0]).includes('same key'));
        expect(chiaviDuplicate, 'due gruppi con la stessa chiave React: uno dei due può sparire o duplicarsi').toEqual([]);
        expect(screen.getAllByText('5 novembre')).toHaveLength(2);
        expect(screen.getByText('Un anno fa')).toBeInTheDocument();
        expect(screen.getByText('Quest’anno')).toBeInTheDocument();
    });

    it('due 5 novembre CONSECUTIVI di anni diversi non finiscono sotto un solo separatore', () => {
        orologioAl1Marzo2027();

        render(
            area([
                msg(1, { created_at: '2025-11-05T12:00:00.000Z', content: 'Un anno fa' }),
                msg(2, { created_at: '2026-11-05T12:00:00.000Z', content: 'Quest’anno' }),
            ]),
        );

        expect(screen.getAllByText('5 novembre'), 'un anno di distanza presentato come lo stesso giorno').toHaveLength(2);
    });

    it('il giorno cambia alla mezzanotte di Roma, non a quella di Greenwich', () => {
        orologioAl1Marzo2027();

        // 23:30 UTC del 4 novembre = 00:30 del 5 a Roma: per la scuola è già il 5, come il messaggio dopo.
        render(
            area([
                msg(1, { created_at: '2026-11-04T23:30:00.000Z', content: 'Appena dopo mezzanotte' }),
                msg(2, { created_at: '2026-11-05T12:00:00.000Z', content: 'A mezzogiorno' }),
            ]),
        );

        expect(screen.getAllByText('5 novembre'), 'lo stesso giorno di Roma diviso in due gruppi').toHaveLength(1);
        expect(screen.queryByText('4 novembre')).toBeNull();
    });
});
