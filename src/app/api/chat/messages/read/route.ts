import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const patchBodySchema = z.object({
    messageIds: z.array(zUuid).min(1, 'messageIds è obbligatorio e non può essere vuoto'),
    userId: zUuid,
});

/**
 * PATCH /api/chat/messages/read
 * Body: { messageIds: string[], userId: string }
 *
 * Marca come letti i messaggi specificati (solo quelli non inviati dall'utente corrente).
 * Usato dall'IntersectionObserver in ChatMessageArea per aggiornare
 * read_at man mano che i messaggi entrano nel viewport.
 */
export const PATCH = withRoute('chat/messages/read:PATCH', async (request: Request) => {
    try {
        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { messageIds, userId } = b.data;

        const supabase = await createAdminClient();

        // Aggiorna solo i messaggi non inviati dall'utente corrente e ancora non letti
        const { error } = await supabase
            .from('chat_messages')
            .update({ read_at: new Date().toISOString() })
            .in('id', messageIds)
            .neq('sender_id', userId)
            .is('read_at', null);

        if (error) {
            logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, updated: messageIds.length });
    } catch (error) {
        logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
