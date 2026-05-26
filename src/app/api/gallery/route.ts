import { NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';

// GET /api/gallery?studentId=xxx&classe=xxx&date=YYYY-MM-DD&limit=30&offset=0
// Lista media con filtri (studentId per genitore, classe per insegnante)
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const studentId = searchParams.get('studentId');
        const classe = searchParams.get('classe');
        const date = searchParams.get('date');
        const limit = parseInt(searchParams.get('limit') ?? '30');
        const offset = parseInt(searchParams.get('offset') ?? '0');

        const supabase = await createAdminClient();

        let query = supabase
            .from('galleria_media_v2')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (date) {
            query = query
                .gte('created_at', `${date}T00:00:00.000Z`)
                .lte('created_at', `${date}T23:59:59.999Z`);
        }

        const { data: allMedia, error } = await query;

        if (error) {
            console.error('Errore GET gallery:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        let filtered = allMedia ?? [];

        // Filtro per genitore: mostra solo media dove il figlio è taggato o broadcast
        if (studentId) {
            filtered = filtered.filter(m =>
                m.is_broadcast ||
                (m.tag_students && m.tag_students.includes(studentId))
            );
        }

        // Validazione genitore-studente: verifica che il chiamante sia effettivamente il genitore
        if (studentId) {
            const parentId = searchParams.get('parentId');
            if (parentId) {
                const { data: link } = await supabase
                    .from('legame_genitori_alunni')
                    .select('genitore_id')
                    .eq('genitore_id', parentId)
                    .eq('alunno_id', studentId)
                    .maybeSingle();

                if (!link) {
                    return NextResponse.json(
                        { error: 'Non sei autorizzato a visualizzare i media di questo studente' },
                        { status: 403 }
                    );
                }
            }
        }

        // Filtro per classe/sezione: mostra media della classe (broadcast o taggati con studenti della classe)
        if (classe) {
            const { data: students } = await supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classe);
            const studentIds = students?.map(s => s.id) ?? [];

            filtered = filtered.filter(m =>
                (m.is_broadcast && m.target_classes && m.target_classes.includes(classe)) ||
                (m.tag_students && m.tag_students.some((sId: string) => studentIds.includes(sId)))
            );
        }

        // Paginazione in memoria post-filtro
        const paginated = filtered.slice(offset, offset + limit);

        // Arricchisci con info uploader (usa utenti)
        const enriched = await Promise.all(
            paginated.map(async (media) => {
                const { data: uploader } = await supabase
                    .from('utenti')
                    .select('nome, cognome, first_name, last_name')
                    .eq('id', media.uploaded_by)
                    .single();

                return {
                    ...media,
                    uploader_name: uploader
                        ? `${uploader.first_name || uploader.nome} ${uploader.last_name || uploader.cognome}`
                        : 'Sconosciuto',
                };
            })
        );

        return NextResponse.json({ media: enriched, total: filtered.length });
    } catch (error) {
        console.error('Errore API GET gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/gallery
// Body: { uploaded_by, file_url, file_type?, caption?, tag_students?, is_broadcast?, target_classes? }
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            uploaded_by,
            file_url,
            file_type,
            caption,
            tag_students,
            is_broadcast,
            target_classes,
        } = body;

        if (!uploaded_by || !file_url) {
            return NextResponse.json(
                { error: 'uploaded_by e file_url sono obbligatori' },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        const { data, error } = await supabase
            .from('galleria_media_v2')
            .insert({
                uploaded_by,
                file_url,
                file_type: file_type ?? 'foto',
                caption: caption ?? null,
                tag_students: tag_students ?? [],
                is_broadcast: is_broadcast ?? false,
                target_classes: target_classes ?? null,
            })
            .select()
            .single();

        if (error) {
            console.error('Errore POST gallery:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Errore API POST gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// DELETE /api/gallery?id=xxx&userId=yyy
// Cancella un media con controllo granularizzato dei ruoli
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        const paramUserId = searchParams.get('userId');

        if (!id) {
            return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 });
        }

        // Recupera l'utente dalla sessione se disponibile
        let userId = paramUserId;
        try {
            const sessionClient = await createClient();
            const { data: { user } } = await sessionClient.auth.getUser();
            if (user) {
                userId = user.id;
            }
        } catch {
            userId = paramUserId;
        }

        if (!userId) {
            return NextResponse.json({ error: 'Utente non autenticato' }, { status: 401 });
        }

        const supabase = await createAdminClient();

        // 1. Recupera il record del media
        const { data: media, error: mediaErr } = await supabase
            .from('galleria_media_v2')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (mediaErr || !media) {
            return NextResponse.json({ error: 'Media non trovato' }, { status: 404 });
        }

        // 2. Recupera il ruolo dell'utente da utenti
        const { data: utentiRecord } = await supabase
            .from('utenti')
            .select('ruolo, scuola_id')
            .eq('id', userId)
            .maybeSingle();

        const role = utentiRecord?.ruolo;
        const userScuolaId = utentiRecord?.scuola_id;

        const isAdmin = ['admin', 'segreteria', 'direzione', 'segretaria'].includes(role ?? '');
        const isCoordinator = ['coordinator', 'coordinatore'].includes(role ?? '');
        const isEducator = ['educator', 'maestra'].includes(role ?? '');

        let authorized = false;

        if (isAdmin) {
            // Admin/Segreteria/Direzione possono eliminare qualsiasi media
            authorized = true;
        } else if (isCoordinator) {
            // I coordinatori possono eliminare i media nel proprio plesso/scuola
            const { data: uploaderRecord } = await supabase
                .from('utenti')
                .select('scuola_id')
                .eq('id', media.uploaded_by)
                .maybeSingle();

            if (uploaderRecord?.scuola_id === userScuolaId) {
                authorized = true;
            }
        } else if (isEducator) {
            // L'insegnante può eliminare se l'ha caricato lui stesso
            if (media.uploaded_by === userId) {
                authorized = true;
            } else {
                // Oppure se il media riguarda le sue classi
                // Ricaviamo le sezioni del docente dagli alunni che ha taggato nei suoi media precedenti
                const { data: myMedia } = await supabase
                    .from('galleria_media_v2')
                    .select('tag_students')
                    .eq('uploaded_by', userId)
                    .not('tag_students', 'is', null);

                const myTaggedStudentIds = (myMedia ?? [])
                    .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                    .filter(Boolean);

                let myClassNames: string[] = [];

                if (myTaggedStudentIds.length > 0) {
                    const { data: myStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', myTaggedStudentIds);

                    myClassNames = [...new Set(
                        (myStudents ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
                    )];
                }

                // Verifica se la classe del media interseca con quelle del docente
                const hasClassIntersection = media.target_classes?.some((c: string) => myClassNames.includes(c));

                let hasStudentIntersection = false;
                if (media.tag_students && media.tag_students.length > 0) {
                    const { data: taggedStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', media.tag_students);

                    hasStudentIntersection = taggedStudents?.some(
                        (s: { classe_sezione: string }) => myClassNames.includes(s.classe_sezione)
                    ) ?? false;
                }

                if (hasClassIntersection || hasStudentIntersection) {
                    authorized = true;
                }
            }
        }

        if (!authorized) {
            return NextResponse.json(
                { error: 'Non sei autorizzato a eliminare questo media' },
                { status: 403 }
            );
        }

        // Esegui la cancellazione
        const { error: deleteErr } = await supabase
            .from('galleria_media_v2')
            .delete()
            .eq('id', id);

        if (deleteErr) {
            console.error('Errore DELETE gallery:', deleteErr);
            return NextResponse.json({ error: deleteErr.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Errore API DELETE gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// PATCH /api/gallery
// Body: { id, userId, tag_students, is_broadcast, target_classes, caption }
export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { id, userId, tag_students, is_broadcast, target_classes, caption } = body;

        if (!id) {
            return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 });
        }

        if (!userId) {
            return NextResponse.json({ error: 'userId è obbligatorio' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        // 1. Recupera il record del media
        const { data: media, error: mediaErr } = await supabase
            .from('galleria_media_v2')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (mediaErr || !media) {
            return NextResponse.json({ error: 'Media non trovato' }, { status: 404 });
        }

        // 2. Recupera il ruolo dell'utente da utenti
        const { data: utentiRecord } = await supabase
            .from('utenti')
            .select('ruolo, scuola_id')
            .eq('id', userId)
            .maybeSingle();

        const role = utentiRecord?.ruolo;
        const userScuolaId = utentiRecord?.scuola_id;

        const isAdmin = ['admin', 'segreteria', 'direzione', 'segretaria'].includes(role ?? '');
        const isCoordinator = ['coordinator', 'coordinatore'].includes(role ?? '');
        const isEducator = ['educator', 'maestra'].includes(role ?? '');

        let authorized = false;

        if (isAdmin) {
            authorized = true;
        } else if (isCoordinator) {
            const { data: uploaderRecord } = await supabase
                .from('utenti')
                .select('scuola_id')
                .eq('id', media.uploaded_by)
                .maybeSingle();

            if (uploaderRecord?.scuola_id === userScuolaId) {
                authorized = true;
            }
        } else if (isEducator) {
            if (media.uploaded_by === userId) {
                authorized = true;
            } else {
                // Oppure se il media riguarda le sue classi
                const { data: myMedia } = await supabase
                    .from('galleria_media_v2')
                    .select('tag_students')
                    .eq('uploaded_by', userId)
                    .not('tag_students', 'is', null);

                const myTaggedStudentIds = (myMedia ?? [])
                    .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                    .filter(Boolean);

                let myClassNames: string[] = [];

                if (myTaggedStudentIds.length > 0) {
                    const { data: myStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', myTaggedStudentIds);

                    myClassNames = [...new Set(
                        (myStudents ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
                    )];
                }

                const hasClassIntersection = media.target_classes?.some((c: string) => myClassNames.includes(c));

                let hasStudentIntersection = false;
                if (media.tag_students && media.tag_students.length > 0) {
                    const { data: taggedStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', media.tag_students);

                    hasStudentIntersection = taggedStudents?.some(
                        (s: { classe_sezione: string }) => myClassNames.includes(s.classe_sezione)
                    ) ?? false;
                }

                if (hasClassIntersection || hasStudentIntersection) {
                    authorized = true;
                }
            }
        }

        if (!authorized) {
            return NextResponse.json(
                { error: 'Non sei autorizzato a modificare questo media' },
                { status: 403 }
            );
        }

        // 3. Esegui l'aggiornamento
        const updateData: Record<string, any> = {};
        if (tag_students !== undefined) updateData.tag_students = tag_students;
        if (is_broadcast !== undefined) updateData.is_broadcast = is_broadcast;
        if (target_classes !== undefined) updateData.target_classes = target_classes;
        if (caption !== undefined) updateData.caption = caption;

        const { data: updatedMedia, error: updateErr } = await supabase
            .from('galleria_media_v2')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (updateErr) {
            console.error('Errore PATCH gallery:', updateErr);
            return NextResponse.json({ error: updateErr.message }, { status: 500 });
        }

        return NextResponse.json(updatedMedia);
    } catch (error) {
        console.error('Errore API PATCH gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

