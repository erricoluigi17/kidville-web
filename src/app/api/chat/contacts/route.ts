import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET /api/chat/contacts?userId=xxx
// Restituisce i contatti disponibili per iniziare una nuova chat
// - Se l'utente è maestra: restituisce i genitori dei suoi studenti
// - Se l'utente è genitore: restituisce le maestre della sezione dei suoi figli
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId è obbligatorio' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        // Determina il ruolo dell'utente
        const { data: user } = await supabase
            .from('utenti')
            .select('id, nome, cognome, ruolo, first_name, last_name, role')
            .eq('id', userId)
            .single();

        if (!user) {
            return NextResponse.json({ error: 'Utente non trovato' }, { status: 404 });
        }

        const role = user.role || user.ruolo;
        const contacts: Array<{
            user_id: string;
            user_name: string;
            user_role: string;
            student_id: string;
            student_name: string;
            sezione: string;
        }> = [];

        if (role === 'maestra' || role === 'educator') {
            // Maestra: determina la propria sezione.
            let teacherSection: string | null = null;

            // Fonte canonica: legame docente↔sezione (utenti_sezioni → sections).
            const { data: legamiSez } = await supabase
                .from('utenti_sezioni')
                .select('sections(name)')
                .eq('utente_id', userId)
                .limit(1);
            teacherSection = ((legamiSez?.[0]?.sections as { name?: string } | null)?.name) ?? null;

            // Fallback storico: deriva la sezione dai media caricati con studenti taggati
            if (!teacherSection) {
                const { data: myMedia } = await supabase
                    .from('galleria_media_v2')
                    .select('tag_students')
                    .eq('uploaded_by', userId)
                    .not('tag_students', 'is', null)
                    .limit(10);

                const myTaggedIds = (myMedia ?? [])
                    .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                    .filter(Boolean);

                if (myTaggedIds.length > 0) {
                    const { data: taggedStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', myTaggedIds)
                        .limit(1);
                    teacherSection = taggedStudents?.[0]?.classe_sezione ?? null;
                }
            }

            // Fallback: mappa email→sezione per docenti noti
            if (!teacherSection) {
                const emailToSection: Record<string, string> = {
                    'maestra.anna@kidville.it': 'Girasoli',
                    'maestra.chiara@kidville.it': 'Tulipani',
                };
                const userEmail = user.id === '22222222-2222-2222-2222-222222222222'
                    ? 'maestra.anna@kidville.it'
                    : user.id === '22222222-2222-2222-2222-333333333333'
                        ? 'maestra.chiara@kidville.it'
                        : null;
                if (userEmail) teacherSection = emailToSection[userEmail] ?? null;
            }

            const sectionFilter = teacherSection ?? 'Girasoli';

            // Trova tutti gli studenti della sezione della maestra
            const { data: allStudents } = await supabase
                .from('alunni')
                .select('id, nome, cognome, classe_sezione')
                .eq('classe_sezione', sectionFilter);

            if (allStudents) {
                for (const student of allStudents) {
                    // Cerca genitori del bambino in legame_genitori_alunni
                    const { data: legami } = await supabase
                        .from('legame_genitori_alunni')
                        .select('genitore_id')
                        .eq('alunno_id', student.id);

                    if (legami) {
                        for (const legame of legami) {
                            const { data: parent } = await supabase
                                .from('utenti')
                                .select('id, nome, cognome, first_name, last_name')
                                .eq('id', legame.genitore_id)
                                .single();

                            if (parent) {
                                const exists = contacts.some(c => c.user_id === parent.id && c.student_id === student.id);
                                if (!exists) {
                                    contacts.push({
                                        user_id: parent.id,
                                        user_name: `${parent.first_name || parent.nome} ${parent.last_name || parent.cognome}`,
                                        user_role: 'genitore',
                                        student_id: student.id,
                                        student_name: `${student.nome} ${student.cognome}`,
                                        sezione: student.classe_sezione ?? '',
                                    });
                                }
                            }
                        }
                    }
                }
            }
        } else if (role === 'genitore') {
            // Genitore: trova i figli, poi le maestre delle sezioni dei figli
            const { data: legami } = await supabase
                .from('legame_genitori_alunni')
                .select('alunno_id')
                .eq('genitore_id', userId);

            if (legami) {
                for (const legame of legami) {
                    const { data: student } = await supabase
                        .from('alunni')
                        .select('id, nome, cognome, classe_sezione, section_id')
                        .eq('id', legame.alunno_id)
                        .single();

                    if (student) {
                        // Insegnanti della sezione del figlio (fonte canonica utenti_sezioni).
                        let teachers: { id: string; nome: string | null; cognome: string | null; first_name: string | null; last_name: string | null }[] = [];
                        if (student.section_id) {
                            const { data: legamiSez } = await supabase
                                .from('utenti_sezioni')
                                .select('utente_id')
                                .eq('section_id', student.section_id);
                            const ids = (legamiSez ?? []).map(r => r.utente_id);
                            if (ids.length > 0) {
                                const { data } = await supabase
                                    .from('utenti')
                                    .select('id, nome, cognome, first_name, last_name')
                                    .in('id', ids);
                                teachers = data ?? [];
                            }
                        }
                        // Fallback storico: tutte le maestre se la sezione non è mappata.
                        if (teachers.length === 0) {
                            const { data } = await supabase
                                .from('utenti')
                                .select('id, nome, cognome, first_name, last_name')
                                .or('ruolo.eq.maestra,role.eq.educator');
                            teachers = data ?? [];
                        }

                        if (teachers) {
                            for (const teacher of teachers) {
                                const exists = contacts.some(c => c.user_id === teacher.id && c.student_id === student.id);
                                if (!exists) {
                                    contacts.push({
                                        user_id: teacher.id,
                                        user_name: `${teacher.first_name || teacher.nome} ${teacher.last_name || teacher.cognome}`,
                                        user_role: 'maestra',
                                        student_id: student.id,
                                        student_name: `${student.nome} ${student.cognome}`,
                                        sezione: student.classe_sezione ?? '',
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // Filtra contatti che hanno già un thread attivo
        const { data: existingThreads } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id, student_id')
            .or(`teacher_id.eq.${userId},parent_id.eq.${userId}`);

        const available = contacts.filter(c => {
            const hasThread = (existingThreads ?? []).some(t => {
                if (role === 'maestra') {
                    return t.teacher_id === userId && t.parent_id === c.user_id && t.student_id === c.student_id;
                } else {
                    return t.parent_id === userId && t.teacher_id === c.user_id && t.student_id === c.student_id;
                }
            });
            return !hasThread;
        });

        return NextResponse.json({ contacts: available, existing_count: (existingThreads ?? []).length });
    } catch (error) {
        console.error('Errore API GET contacts:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
