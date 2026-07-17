import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers';
import { controparteThread } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zPaginazione } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { marcaConsegnati } from '@/lib/chat/delivered';
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione';

// markRead='' è ammesso per retro-compatibilità: equivale ad assente (nessun mark-read).
const getQuerySchema = z.object({
    threadId: zUuid,
    markRead: zUuid.or(z.literal('')).optional(),
    ...zPaginazione.shape,
});

const postBodySchema = z.object({
    thread_id: zUuid,
    // Retro-compatibilità: i client storici lo mandano ancora, ma il mittente è
    // SOLO l'utente del gate (anti-impersonazione). Tollerato, mai usato.
    sender_id: zUuid.optional(),
    content: z.string().min(1, 'content è obbligatorio'),
    attachment_url: z.string().nullish(),
    attachment_type: z.string().nullish(),
});

// GET /api/chat/messages?threadId=xxx&limit=50&offset=0&markRead=userId
// Lista messaggi per un thread con paginazione
export const GET = withRoute('chat/messages:GET', async (request: Request) => {
    try {
        // Gate identità IN TESTA: mai lettura anonima o da non-partecipante. Prima
        // la verifica del partecipante era annidata in `if (markRead)`: senza
        // `markRead` chiunque otteneva 200 con TUTTI i messaggi del thread (IDOR su
        // PII di minori). Ora l'identità viene SOLO dal gate.
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const uid = auth.user.id;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { threadId, limit, offset } = q.data;
        // `markRead` resta solo un TRIGGER opt-in del mark-read (usato dalla pagina
        // admin/messaggi): il suo VALORE è ignorato, l'identità è `uid` dal gate.
        const vuoleMarkRead = Boolean(q.data.markRead);

        const supabase = await createAdminClient();

        // ── Autorizzazione: SEMPRE, non più solo col mark-read ──────────────
        // Carica il thread e verifica che il richiedente ne sia partecipante
        // (teacher_id o parent_id). 404 se non esiste, 403 se non partecipante.
        const { data: thread, error: threadErr } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id')
            .eq('id', threadId)
            .maybeSingle();

        if (threadErr) {
            logErrore({ operazione: 'chat/messages:GET', stato: 500, evento: 'db' }, threadErr);
            return NextResponse.json({ error: threadErr.message }, { status: 500 });
        }
        if (!thread) {
            return NextResponse.json({ error: 'Thread non trovato' }, { status: 404 });
        }
        if (thread.teacher_id !== uid && thread.parent_id !== uid) {
            // IDOR sventato: utente autenticato ma NON partecipante del thread.
            // Nel log solo uuid (threadId), nessun PII; withRoute registra il 403.
            logEvento('chat', 'info', {
                operazione: 'chat/messages:GET',
                esito: 'non-partecipante',
                threadId,
            });
            return NextResponse.json(
                { error: 'Non sei autorizzato a leggere questo thread' },
                { status: 403 }
            );
        }

        if (vuoleMarkRead) {
            // PRIMA del mark-read: consegna (delivered_at) di tutto il thread, in una query
            // SEPARATA. Mai unita al mark-read: sul DB E2E la colonna delivered_at non esiste
            // e un update congiunto porterebbe giù anche il mark-read qui sotto.
            // Identità = `uid` dal gate (mai il valore di markRead in query).
            await marcaConsegnati(supabase, { userId: uid, threadIds: [threadId] });

            // Segna come letti i messaggi dell'interlocutore. PostgREST NON lancia:
            // si controlla il valore di ritorno. Best-effort: il mark-read è accessorio
            // alla lettura → si logga (mai swallow) ma NON si fa fallire la GET.
            const { error: readErr } = await supabase
                .from('chat_messages')
                .update({ read_at: new Date().toISOString() })
                .eq('thread_id', threadId)
                .neq('sender_id', uid)
                .is('read_at', null);
            if (readErr) {
                logEvento('chat', 'error', {
                    operazione: 'chat/messages:GET',
                    esito: 'mark-read-fallito',
                }, readErr);
            }
        }

        // Recupera messaggi
        const { data, error, count } = await supabase
            .from('chat_messages')
            .select('*', { count: 'exact' })
            .eq('thread_id', threadId)
            .order('created_at', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            logErrore({ operazione: 'chat/messages:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ messages: data ?? [], total: count ?? 0 });
    } catch (error) {
        logErrore({ operazione: 'chat/messages:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// POST /api/chat/messages
// Body: { thread_id, sender_id, content, attachment_url?, attachment_type? }
export const POST = withRoute('chat/messages:POST', async (request: Request) => {
    try {
        // Gate identità IN TESTA: il mittente è SEMPRE l'utente del gate, MAI il
        // `sender_id` del body (che prima permetteva l'impersonazione).
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const sender_id = auth.user.id;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        // `sender_id` del body è tollerato dallo schema ma IGNORATO (anti-spoof).
        const { thread_id, content, attachment_url, attachment_type } = b.data;

        const supabase = await createAdminClient();

        // Sospensione moroso (DL-021 · M4): il genitore con un figlio sospeso non
        // può inviare messaggi (azione di servizio). Solo la SCRITTURA: la lettura
        // (GET) resta libera. Identità dal gate, mai dal body. Su un docente il
        // guard è trasparente (nessun legame genitore↔alunno).
        const sospesoErr = await assertGenitoreNonSospeso(supabase, sender_id);
        if (sospesoErr) return sospesoErr;

        // Autorizzazione: il mittente deve essere partecipante del thread indicato
        // (teacher_id o parent_id). Senza, un utente autenticato poteva iniettare
        // messaggi in conversazioni altrui.
        const { data: thread, error: threadErr } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id')
            .eq('id', thread_id)
            .maybeSingle();

        if (threadErr) {
            logErrore({ operazione: 'chat/messages:POST', stato: 500, evento: 'db' }, threadErr);
            return NextResponse.json({ error: threadErr.message }, { status: 500 });
        }
        if (!thread) {
            return NextResponse.json({ error: 'Thread non trovato' }, { status: 404 });
        }
        if (thread.teacher_id !== sender_id && thread.parent_id !== sender_id) {
            logEvento('chat', 'info', {
                operazione: 'chat/messages:POST',
                esito: 'non-partecipante',
                threadId: thread_id,
            });
            return NextResponse.json(
                { error: 'Non sei autorizzato a scrivere in questo thread' },
                { status: 403 }
            );
        }

        // Inserisci messaggio (sender_id = utente del gate, mai dal body)
        const { data, error } = await supabase
            .from('chat_messages')
            .insert({
                thread_id,
                sender_id,
                content,
                attachment_url: attachment_url ?? null,
                attachment_type: attachment_type ?? null,
            })
            .select()
            .single();

        if (error) {
            logErrore({ operazione: 'chat/messages:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Aggiorna last_message_at sul thread
        await supabase
            .from('chat_threads')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', thread_id);

        // Notifica alla controparte del thread (best-effort). Privacy: il corpo
        // NON contiene il testo del messaggio, solo il nome del mittente. Il
        // debounce per thread collassa le raffiche in un'unica notifica.
        try {
            const controparte = await controparteThread(supabase, thread_id, sender_id);
            if (controparte) {
                const [nome, mittente] = await Promise.all([
                    nomeUtente(supabase, sender_id),
                    supabase.from('utenti').select('scuola_id').eq('id', sender_id).maybeSingle(),
                ]);
                await notificaEvento(supabase, {
                    tipo: controparte.versoGenitore ? 'chat_genitore' : 'chat_docente',
                    scuolaId: (mittente.data?.scuola_id as string | undefined) ?? null,
                    utenteIds: [controparte.utenteId],
                    titolo: 'Nuovo messaggio in chat',
                    corpo: nome ? `Hai un nuovo messaggio da ${nome}` : 'Hai un nuovo messaggio',
                    link: controparte.versoGenitore ? '/parent/chat' : '/teacher/chat',
                    entitaTipo: 'chat_thread',
                    entitaId: thread_id,
                    bufferMin: 0,
                    debounce: true,
                });
            }
        } catch (e) {
            // `error` benché il messaggio sia salvato (201): la controparte non riceve la spinta,
            // quindi il messaggio resta lì finché non apre la chat per caso. In una chat
            // scuola↔famiglia il recapito È la funzione: una notifica mai accodata è un messaggio
            // di fatto non consegnato.
            logEvento('notifica', 'error', {
                operazione: 'chat/messages:POST',
                esito: 'notifica-controparte-non-accodata',
            }, e);
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'chat/messages:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
