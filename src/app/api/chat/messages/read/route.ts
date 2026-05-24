import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

/**
 * PATCH /api/chat/messages/read
 * Body: { messageIds: string[], userId: string }
 *
 * Marca come letti i messaggi specificati (solo quelli non inviati dall'utente corrente).
 * Usato dall'IntersectionObserver in ChatMessageArea per aggiornare
 * read_at man mano che i messaggi entrano nel viewport.
 */
export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { messageIds, userId } = body as { messageIds: string[]; userId: string };

        if (!Array.isArray(messageIds) || messageIds.length === 0 || !userId) {
            return NextResponse.json(
                { error: 'messageIds (array) e userId sono obbligatori' },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        // Aggiorna solo i messaggi non inviati dall'utente corrente e ancora non letti
        const { error } = await supabase
            .from('chat_messages')
            .update({ read_at: new Date().toISOString() })
            .in('id', messageIds)
            .neq('sender_id', userId)
            .is('read_at', null);

        if (error) {
            console.error('Errore PATCH chat_messages/read:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, updated: messageIds.length });
    } catch (error) {
        console.error('Errore API PATCH messages/read:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
