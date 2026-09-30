import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { marcaConsegnati } from '@/lib/chat/delivered';
import { segnaLetteNotificheChat } from '@/lib/chat/notifiche-chat';

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
        // I thread di cui l'utente è partecipante, cioè quelli la cui campanella si spegne.
        // Sono anche, per costruzione, i thread dei messaggi ammessi: `threadIds` nasce dagli
        // stessi `msgs` da cui esce `allowedIds`, quindi un thread finisce qui dentro se e
        // solo se almeno un messaggio passato nel body gli appartiene. Non serve un secondo
        // insieme — servirebbe se un domani i thread arrivassero da un'altra parte.
        let threadDiMe = new Set<string>();
        if (threadIds.length > 0) {
            const { data: threads, error: thErr } = await supabase
                .from('chat_threads')
                .select('id, teacher_id, parent_id')
                .in('id', threadIds);
            if (thErr) {
                logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500, evento: 'db' }, thErr);
                return NextResponse.json({ error: thErr.message }, { status: 500 });
            }
            threadDiMe = new Set(
                (threads ?? [])
                    .filter((t) => t.teacher_id === userId || t.parent_id === userId)
                    .map((t) => String(t.id)),
            );
            allowedIds = (msgs ?? [])
                .filter((m) => threadDiMe.has(m.thread_id))
                .map((m) => m.id);
        }

        // Nessun messaggio di cui l'utente sia partecipante: niente da fare. Non è un
        // errore (id altrui/inesistenti vengono semplicemente ignorati) → 200, updated 0.
        // `notifiche_lette` c'è anche qui: la forma della risposta è UNA, così il client non
        // deve distinguere due contratti per lo stesso 200.
        if (allowedIds.length === 0) {
            return NextResponse.json({ success: true, updated: 0, notifiche_lette: 0 });
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

        // E SI SPEGNE LA CAMPANELLA. Fin qui il mark-read toccava solo `chat_messages`: la
        // riga in `notifiche` restava accesa per sempre, perché niente la scriveva fuori
        // dalla campanella stessa. La regola — un messaggio letto spegne le notifiche di
        // TUTTO quel thread, per chi legge — e i suoi perché stanno in
        // `@/lib/chat/notifiche-chat`, insieme al limite noto.
        //
        // DOPO il mark-read e mai prima: se l'UPDATE di `read_at` fallisce si è già usciti
        // 500 qui sopra, e la campanella non si tocca. Un fallimento di QUESTO passo invece
        // non cambia la risposta (resta 200): il warn lo scrive la funzione, che non lancia.
        const notificheLette = await segnaLetteNotificheChat(supabase, {
            utenteId: userId,
            threadIds: [...threadDiMe],
            operazione: 'chat/messages/read:PATCH',
        });

        return NextResponse.json({
            success: true,
            updated: allowedIds.length,
            notifiche_lette: notificheLette,
        });
    } catch (error) {
        logErrore({ operazione: 'chat/messages/read:PATCH', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
