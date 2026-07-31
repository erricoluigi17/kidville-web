import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { getFigliDiGenitore, getGenitoriDiAlunni } from '@/lib/anagrafiche/legami';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// Gap auth chiuso in M9: il legacy `?userId=` in query resta ACCETTATO dallo
// schema per compatibilità coi client ma viene IGNORATO — l'identità è quella
// del gate (sessione; pattern M4 "parent_id legacy strippato").
const getQuerySchema = z.object({
    userId: zUuid.optional(),
});

// GET /api/chat/contacts
// Restituisce i contatti disponibili per iniziare una nuova chat
// - Se l'utente è maestra: restituisce i genitori dei suoi studenti
// - Se l'utente è genitore: restituisce le maestre della sezione dei suoi figli
export const GET = withRoute('chat/contacts:GET', async (request: Request) => {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const userId = auth.user.id;

    try {
        const supabase = await createAdminClient();

        // Determina il ruolo dell'utente
        const { data: user } = await supabase
            .from('utenti')
            .select('id, nome, cognome, ruolo, first_name, last_name, role')
            .eq('id', userId)
            .maybeSingle();

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
            // Sede del LEGAME (quella dell'alunno), non dell'operatore: con più
            // plessi «2 ANNI» non identifica una classe, e una lista di persone
            // senza sede è indistinguibile da quella di un altro plesso. La UI
            // la usa per l'etichetta «nome — sede» quando le sedi sono più d'una.
            scuola_id: string | null;
        }> = [];

        if (role === 'maestra' || role === 'educator') {
            // Isolamento per sede: la sezione è risolta dai legami del docente,
            // ma il nome-classe non è una chiave (con tre sedi «2 ANNI» esiste
            // sia ad Aversa sia a Cesa). Senza questo filtro la maestra si
            // ritrovava fra i contatti i GENITORI dei bambini dell'altra sede,
            // con la chat già apribile. Fail-closed: nessun plesso → nessun
            // contatto (in produzione ogni utente di staff ha una sede).
            //
            // Il calcolo sta QUI, e non venti righe più sotto, perché serve già
            // al fallback storico: la derivazione della sezione dai tag deve
            // restare dentro la sede, altrimenti si IDENTIFICA la maestra con la
            // classe di un altro plesso e la si porta poi sull'omonima.
            const plessi = await scuoleDiUtente(supabase, auth.user);

            // Maestra: sezione dalla fonte canonica (utenti_sezioni → sections).
            const { data: legamiSez } = await supabase
                .from('utenti_sezioni')
                .select('sections(name)')
                .eq('utente_id', userId)
                .limit(1);
            let teacherSection = ((legamiSez?.[0]?.sections as { name?: string } | null)?.name) ?? null;

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
                    // `.in('scuola_id', plessi)`: ultima copia non corretta del
                    // frammento che vive anche in `educator-sections` e `tasks`.
                    // Il `.limit(1)` non ordina: bastava un vecchio tag su un
                    // bambino di un altro plesso perché la SUA classe vincesse.
                    const { data: taggedStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', myTaggedIds)
                        .in('scuola_id', plessi)
                        .limit(1);
                    teacherSection = taggedStudents?.[0]?.classe_sezione ?? null;
                }
            }

            // Senza sezione risolta la lista resta vuota: niente default arbitrari.
            if (teacherSection) {
                // 3 query batched: alunni della sezione → legami → genitori (niente N+1).
                const { data: allStudents } = await supabase
                    .from('alunni')
                    .select('id, nome, cognome, classe_sezione, scuola_id')
                    .eq('classe_sezione', teacherSection)
                    .in('scuola_id', plessi);
                const students = allStudents ?? [];
                const studentIds = students.map(s => s.id);

                // Verso inverso dell'unione (alunno → account genitore): con la
                // sola `legame_genitori_alunni` la maestra non vedeva i genitori
                // dei bambini importati dal form pubblico. Query in blocco, come
                // prima: `getGenitoriDiAlunni` non introduce N+1.
                const genitoriPerAlunno = studentIds.length > 0
                    ? await getGenitoriDiAlunni(supabase, studentIds)
                    : new Map<string, string[]>();

                const parentIds = [...new Set([...genitoriPerAlunno.values()].flat())];
                const { data: parents } = parentIds.length > 0
                    ? await supabase
                        .from('utenti')
                        .select('id, nome, cognome, first_name, last_name')
                        .in('id', parentIds)
                    : { data: [] };

                const parentById = new Map((parents ?? []).map(p => [p.id, p]));
                const seen = new Set<string>();
                for (const student of students) {
                    for (const genitoreId of genitoriPerAlunno.get(student.id) ?? []) {
                        const parent = parentById.get(genitoreId);
                        if (!parent) continue;
                        const key = `${parent.id}:${student.id}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        contacts.push({
                            user_id: parent.id,
                            user_name: `${parent.first_name || parent.nome} ${parent.last_name || parent.cognome}`,
                            user_role: 'genitore',
                            student_id: student.id,
                            student_name: `${student.nome} ${student.cognome}`,
                            sezione: student.classe_sezione ?? '',
                            scuola_id: (student.scuola_id as string | null) ?? null,
                        });
                    }
                }
            }
        } else if (role === 'genitore') {
            // Genitore: figli → docenti delle loro sezioni, tutto batched (niente N+1).
            // I figli vengono dall'unione runtime+anagrafica: con la sola tabella
            // runtime il genitore importato dal form pubblico non aveva contatti.
            const alunnoIds = await getFigliDiGenitore(supabase, userId);

            const { data: studentsData } = alunnoIds.length > 0
                ? await supabase
                    .from('alunni')
                    .select('id, nome, cognome, classe_sezione, section_id, scuola_id')
                    .in('id', alunnoIds)
                : { data: [] };
            const students = studentsData ?? [];

            // Insegnanti per sezione (fonte canonica utenti_sezioni), in blocco.
            const sectionIds = [...new Set(students.map(s => s.section_id).filter(Boolean))] as string[];
            const { data: legamiSez } = sectionIds.length > 0
                ? await supabase
                    .from('utenti_sezioni')
                    .select('section_id, utente_id')
                    .in('section_id', sectionIds)
                : { data: [] };

            type Teacher = { id: string; nome: string | null; cognome: string | null; first_name: string | null; last_name: string | null };
            const teacherIds = [...new Set((legamiSez ?? []).map(r => r.utente_id))];
            const { data: teachersData } = teacherIds.length > 0
                ? await supabase
                    .from('utenti')
                    .select('id, nome, cognome, first_name, last_name')
                    .in('id', teacherIds)
                : { data: [] };
            const teacherById = new Map<string, Teacher>(((teachersData ?? []) as Teacher[]).map(t => [t.id, t]));

            const teachersBySection = new Map<string, Teacher[]>();
            for (const r of legamiSez ?? []) {
                const t = teacherById.get(r.utente_id);
                if (!t) continue;
                const arr = teachersBySection.get(r.section_id) ?? [];
                arr.push(t);
                teachersBySection.set(r.section_id, arr);
            }

            // Fallback storico (una sola query, solo se serve): tutte le maestre
            // per i figli con sezione non mappata.
            let allTeachers: Teacher[] | null = null;
            const needsFallback = students.some(
                s => !s.section_id || (teachersBySection.get(s.section_id) ?? []).length === 0
            );
            if (needsFallback) {
                const { data } = await supabase
                    .from('utenti')
                    .select('id, nome, cognome, first_name, last_name')
                    .or('ruolo.eq.maestra,role.eq.educator');
                allTeachers = (data ?? []) as Teacher[];
            }

            const seen = new Set<string>();
            for (const student of students) {
                const own = student.section_id ? (teachersBySection.get(student.section_id) ?? []) : [];
                const teachers = own.length > 0 ? own : (allTeachers ?? []);
                for (const teacher of teachers) {
                    const key = `${teacher.id}:${student.id}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    contacts.push({
                        user_id: teacher.id,
                        user_name: `${teacher.first_name || teacher.nome} ${teacher.last_name || teacher.cognome}`,
                        user_role: 'maestra',
                        student_id: student.id,
                        student_name: `${student.nome} ${student.cognome}`,
                        sezione: student.classe_sezione ?? '',
                        scuola_id: (student.scuola_id as string | null) ?? null,
                    });
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
                if (role === 'maestra' || role === 'educator') {
                    return t.teacher_id === userId && t.parent_id === c.user_id && t.student_id === c.student_id;
                } else {
                    return t.parent_id === userId && t.teacher_id === c.user_id && t.student_id === c.student_id;
                }
            });
            return !hasThread;
        });

        return NextResponse.json({ contacts: available, existing_count: (existingThreads ?? []).length });
    } catch (error) {
        logErrore({ operazione: 'chat/contacts:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
