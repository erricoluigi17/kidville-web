import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

// Gap auth chiuso in M9: `?userId=` legacy accettato dallo schema ma IGNORATO,
// l'identità è quella del gate (pattern M4 "parent_id legacy strippato").
const getQuerySchema = z.object({
    userId: zUuid.optional(),
});

const postBodySchema = z.object({
    teacher_id: zUuid,
    parent_id: zUuid,
    student_id: zUuid,
});

// GET /api/chat/threads
// Lista thread per l'utente autenticato (insegnante o genitore)
export async function GET(request: Request) {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const userId = auth.user.id;

    try {
        const supabase = await createAdminClient();

        // Cerca thread dove l'utente è teacher o parent
        const { data: threads, error } = await supabase
            .from('chat_threads')
            .select('*')
            .or(`teacher_id.eq.${userId},parent_id.eq.${userId}`)
            .order('last_message_at', { ascending: false });

        if (error) {
            console.error('Errore GET chat_threads:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Arricchisci con nomi degli interlocutori e conteggio non letti
        const enrichedThreads = await Promise.all(
            (threads ?? []).map(async (thread) => {
                // Prendi l'ultimo messaggio
                const { data: lastMsg } = await supabase
                    .from('chat_messages')
                    .select('content, sender_id, created_at')
                    .eq('thread_id', thread.id)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                // Conta messaggi non letti (inviati dall'altro)
                const { count: unreadCount } = await supabase
                    .from('chat_messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('thread_id', thread.id)
                    .neq('sender_id', userId)
                    .is('read_at', null);

                // Prendi i nomi dalla tabella utenti
                const otherUserId = thread.teacher_id === userId ? thread.parent_id : thread.teacher_id;
                const { data: otherUser } = await supabase
                    .from('utenti')
                    .select('nome, cognome, ruolo, first_name, last_name, role')
                    .eq('id', otherUserId)
                    .maybeSingle();

                const { data: student } = await supabase
                    .from('alunni')
                    .select('nome, cognome, classe_sezione')
                    .eq('id', thread.student_id)
                    .maybeSingle();

                return {
                    ...thread,
                    other_user: otherUser
                        ? {
                            first_name: otherUser.first_name || otherUser.nome || '?',
                            last_name: otherUser.last_name || otherUser.cognome || '?',
                            role: otherUser.role || otherUser.ruolo || 'unknown',
                        }
                        : { first_name: '?', last_name: '?', role: 'unknown' },
                    student: student ?? { nome: '?', cognome: '?', classe_sezione: '?' },
                    last_message: lastMsg ?? null,
                    unread_count: unreadCount ?? 0,
                };
            })
        );

        return NextResponse.json(enrichedThreads);
    } catch (error) {
        console.error('Errore API GET threads:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/chat/threads
// Body: { teacher_id, parent_id, student_id }
export async function POST(request: Request) {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const { teacher_id, parent_id, student_id } = b.data;

    // Gap auth chiuso in M9: il chiamante deve essere uno dei due partecipanti
    // del thread che sta creando (niente thread per conto di terzi).
    if (auth.user.id !== teacher_id && auth.user.id !== parent_id) {
        return NextResponse.json(
            { error: 'Accesso negato: non sei un partecipante del thread' },
            { status: 403 }
        );
    }

    try {
        const supabase = await createAdminClient();

        // Cerca se esiste già un thread per questa combinazione
        const { data: existing } = await supabase
            .from('chat_threads')
            .select('id')
            .eq('teacher_id', teacher_id)
            .eq('parent_id', parent_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existing) {
            return NextResponse.json(existing);
        }

        // Crea nuovo thread
        const { data, error } = await supabase
            .from('chat_threads')
            .insert({ teacher_id, parent_id, student_id })
            .select()
            .single();

        if (error) {
            console.error('Errore POST chat_threads:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Errore API POST threads:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
