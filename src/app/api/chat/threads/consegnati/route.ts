import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { rispostaGuastoDb } from '@/lib/db/guasto';
import { marcaConsegnati } from '@/lib/chat/delivered';

/**
 * LA CONSEGNA ESPLICITA DEI MESSAGGI DELLA CHAT (robustezza 2, sessione 12 — S7).
 *
 * Fino al 2026-10-20 la faceva `GET /api/chat/threads`: ogni apertura della lista, e ogni giro dei due
 * orologi della pagina chat, finiva con un UPDATE di `delivered_at` su TUTTI i thread dell'utente.
 * Una lettura che scriveva, ogni 30 s, anche quando non c'era niente da consegnare.
 *
 * Adesso la pagina la chiede solo quando la lista mostra non letti nuovi (`serveConsegna`, in
 * `@/lib/chat/consegna-conversazioni`). Il lavoro è quello di prima, con le stesse garanzie:
 *  · l'identità è quella del GATE, mai un dato del client: il corpo deve essere `{}`;
 *  · i thread sono quelli di cui si è teacher o parent, letti qui con lo stesso `or` della lista;
 *  · nessun limite temporale (`creatiFinoA` assente), come faceva la lista.
 *
 * I LOG. `withRoute` registra la richiesta. Un guasto della lettura dei thread è un 500 con
 * `logErrore` (`rispostaGuastoDb`). Un guasto dell'UPDATE lo registra `marcaConsegnati`, e la
 * risposta dice `fermati`. Nessuna riga persistita per il successo: la consegna non è fra gli eventi
 * critici, e la sua prova è la doppia spunta che il mittente vede.
 */
const bodySchema = z.object({}).strict();

export const POST = withRoute('chat/threads/consegnati:POST', async (request: Request) => {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const corpo = await parseBody(request, bodySchema);
    if ('response' in corpo) return corpo.response;

    const userId = auth.user.id;
    const supabase = await createAdminClient();

    const { data: righe, error } = await supabase
        .from('chat_threads')
        .select('id')
        .or(`teacher_id.eq.${userId},parent_id.eq.${userId}`);
    if (error) return rispostaGuastoDb('chat/threads/consegnati:POST', 'db:chat_threads', error);

    const threadIds = (righe ?? []).map((r) => r.id as string);
    if (threadIds.length === 0) return NextResponse.json({ consegna: 'ok' });

    const esito = await marcaConsegnati(supabase, { userId, threadIds });
    return NextResponse.json({ consegna: esito.esito });
});
