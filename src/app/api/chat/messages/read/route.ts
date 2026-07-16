import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { marcaConsegnati } from '@/lib/chat/delivered';

const patchBodySchema = z.object({
    messageIds: z.array(zUuid).min(1, 'messageIds è obbligatorio e non può essere vuoto'),
    // Retro-compatibilità: i client storici lo mandano ancora, ma l'identità viene
    // SOLO dal gate (anti-spoof). Tollerato, mai usato come identità.
    userId: zUuid.optional(),
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
        // Gate identità IN TESTA: l'utente arriva SOLO dal gate, MAI dal body (prima
        // un anonimo poteva alterare read_at/delivered_at di messaggi altrui).
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const userId = auth.user.id;

        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        // `userId` del body è tollerato dallo schema ma IGNORATO (anti-spoof).
        const { messageIds } = b.data;

        const supabase = await createAdminClient();

        // Anti-IDOR: si marcano SOLO i messaggi appartenenti a thread di cui l'utente
        // è partecipante. Senza, un utente autenticato potrebbe alterare read_at di
        // conversazioni altrui passandone gli id. (Colonne base id/thread_id/teacher_id/
        // parent_id: esistono anche sul DB E2E, nessun degrado da gestire qui.)
        const { data: msgs, error: msgErr } = await supabase
            .from('chat_messages')
            .select('id, thread_id')
            .in('id', messageIds);
        if (msgErr) {
            logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500, evento: 'db' }, msgErr);
            return NextResponse.json({ error: msgErr.message }, { status: 500 });
        }

        const threadIds = [...new Set((msgs ?? []).map((m) => m.thread_id).filter(Boolean))];
        let allowedIds: string[] = [];
        if (threadIds.length > 0) {
            const { data: threads, error: thErr } = await supabase
                .from('chat_threads')
                .select('id, teacher_id, parent_id')
                .in('id', threadIds);
            if (thErr) {
                logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500, evento: 'db' }, thErr);
                return NextResponse.json({ error: thErr.message }, { status: 500 });
            }
            const threadDiMe = new Set(
                (threads ?? [])
                    .filter((t) => t.teacher_id === userId || t.parent_id === userId)
                    .map((t) => t.id),
            );
            allowedIds = (msgs ?? [])
                .filter((m) => threadDiMe.has(m.thread_id))
                .map((m) => m.id);
        }

        // Nessun messaggio di cui l'utente sia partecipante: niente da fare. Non è un
        // errore (id altrui/inesistenti vengono semplicemente ignorati) → 200, updated 0.
        if (allowedIds.length === 0) {
            return NextResponse.json({ success: true, updated: 0 });
        }

        // Aggiorna solo i messaggi non inviati dall'utente corrente e ancora non letti
        const { error } = await supabase
            .from('chat_messages')
            .update({ read_at: new Date().toISOString() })
            .in('id', allowedIds)
            .neq('sender_id', userId)
            .is('read_at', null);

        if (error) {
            logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Dopo il read: consegna gli stessi id che fossero ancora `delivered_at IS NULL`
        // (il path realtime marca letto subito, saltando la consegna). Query separata,
        // best-effort: degrada da sola se la colonna non esiste sul DB E2E.
        await marcaConsegnati(supabase, { userId, messageIds: allowedIds });

        return NextResponse.json({ success: true, updated: allowedIds.length });
    } catch (error) {
        logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
