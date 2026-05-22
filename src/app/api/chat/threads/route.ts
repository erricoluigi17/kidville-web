import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET /api/chat/threads?userId=xxx
// Lista thread per un utente (insegnante o genitore)
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId è obbligatorio' }, { status: 400 });
        }

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
                    .single();

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
                    .single();

                const { data: student } = await supabase
                    .from('alunni')
                    .select('nome, cognome, classe_sezione')
                    .eq('id', thread.student_id)
                    .single();

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
    try {
        const body = await request.json();
        const { teacher_id, parent_id, student_id } = body;

        if (!teacher_id || !parent_id || !student_id) {
            return NextResponse.json(
                { error: 'teacher_id, parent_id e student_id sono obbligatori' },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        // Cerca se esiste già un thread per questa combinazione
        const { data: existing } = await supabase
            .from('chat_threads')
            .select('id')
            .eq('teacher_id', teacher_id)
            .eq('parent_id', parent_id)
            .eq('student_id', student_id)
            .single();

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
