import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zPaginazione } from '@/lib/validation/common';

// markRead='' è ammesso per retro-compatibilità: equivale ad assente (nessun mark-read).
const getQuerySchema = z.object({
    threadId: zUuid,
    markRead: zUuid.or(z.literal('')).optional(),
    ...zPaginazione.shape,
});

const postBodySchema = z.object({
    thread_id: zUuid,
    sender_id: zUuid,
    content: z.string().min(1, 'content è obbligatorio'),
    attachment_url: z.string().nullish(),
    attachment_type: z.string().nullish(),
});

// GET /api/chat/messages?threadId=xxx&limit=50&offset=0&markRead=userId
// Lista messaggi per un thread con paginazione
export async function GET(request: Request) {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { threadId, limit, offset } = q.data;
        const markReadFor = q.data.markRead; // userId che sta leggendo ('' → falsy → ignorato)

        const supabase = await createAdminClient();

        // ── Controllo autorizzazione one-to-one ──────────────────────────
        // Verifica che l'utente richiedente sia effettivamente un partecipante
        // del thread (teacher_id o parent_id). Impedisce leak cross-account.
        if (markReadFor) {
            const { data: thread } = await supabase
                .from('chat_threads')
                .select('teacher_id, parent_id')
                .eq('id', threadId)
                .maybeSingle();

            if (!thread) {
                return NextResponse.json({ error: 'Thread non trovato' }, { status: 404 });
            }

            if (thread.teacher_id !== markReadFor && thread.parent_id !== markReadFor) {
                return NextResponse.json(
                    { error: 'Non sei autorizzato a leggere questo thread' },
                    { status: 403 }
                );
            }
        }

        // Segna come letti i messaggi dell'interlocutore
        if (markReadFor) {
            await supabase
                .from('chat_messages')
                .update({ read_at: new Date().toISOString() })
                .eq('thread_id', threadId)
                .neq('sender_id', markReadFor)
                .is('read_at', null);
        }

        // Recupera messaggi
        const { data, error, count } = await supabase
            .from('chat_messages')
            .select('*', { count: 'exact' })
            .eq('thread_id', threadId)
            .order('created_at', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('Errore GET chat_messages:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ messages: data ?? [], total: count ?? 0 });
    } catch (error) {
        console.error('Errore API GET messages:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/chat/messages
// Body: { thread_id, sender_id, content, attachment_url?, attachment_type? }
export async function POST(request: Request) {
    try {
        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { thread_id, sender_id, content, attachment_url, attachment_type } = b.data;

        const supabase = await createAdminClient();

        // Inserisci messaggio
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
            console.error('Errore POST chat_messages:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Aggiorna last_message_at sul thread
        await supabase
            .from('chat_threads')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', thread_id);

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Errore API POST messages:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
