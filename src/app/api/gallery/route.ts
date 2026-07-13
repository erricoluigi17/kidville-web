import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { alunniSenzaConsenso } from '@/lib/gallery/privacy';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getQuerySchema = z.object({
    studentId: zUuid.optional(),
    // Fallback storico senza vincolo di formato: se il legame non esiste → 403.
    parentId: z.string().optional(),
    classe: z.string().optional(),
    // Storicamente senza vincolo di formato (concatenata in un timestamp ISO).
    date: z.string().optional(),
    // Clamp storico preservato nell'handler (default 30, max 100, garbage → 30):
    // NON zPaginazione, che cambierebbe default e limiti.
    limit: z.string().optional(),
    offset: z.string().optional(),
});

const postBodySchema = z.object({
    // `uploaded_by` dal client è volutamente ignorato (si usa l'utente del gate).
    file_url: z.string().min(1, 'file_url è obbligatorio'),
    file_type: z.string().nullish(),
    caption: z.string().nullish(),
    // Lasco: oggi nessun vincolo uuid sugli id taggati.
    tag_students: z.array(z.string()).nullish(),
    is_broadcast: z.boolean().nullish(),
    target_classes: z.array(z.string()).nullish(),
});

const deleteQuerySchema = z.object({
    id: zUuid,
    // Fallback quando non c'è sessione: la sessione, se presente, lo sovrascrive,
    // quindi resta lasco (un valore non-uuid oggi non blocca la richiesta).
    userId: z.string().optional(),
});

const patchBodySchema = z.object({
    id: zUuid,
    userId: zUuid,
    tag_students: z.array(z.string()).nullish(),
    is_broadcast: z.boolean().nullish(),
    target_classes: z.array(z.string()).nullish(),
    caption: z.string().nullish(),
});

// GET /api/gallery?studentId=xxx&classe=xxx&date=YYYY-MM-DD&limit=30&offset=0
// Lista media con filtri (studentId per genitore, classe per insegnante).
// Filtri e paginazione applicati in SQL (.or + .range): niente scarico dell'intera
// tabella con filtro/slice in memoria. Contratto risposta invariato: { media, total }.
export async function GET(request: Request) {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { studentId, classe, date } = q.data;
        const limit = Math.min(Math.max(parseInt(q.data.limit ?? '30') || 30, 1), 100);
        const offset = Math.max(parseInt(q.data.offset ?? '0') || 0, 0);

        const supabase = await createAdminClient();

        // Validazione genitore-studente PRIMA di leggere i media
        if (studentId) {
            const parentId = q.data.parentId;
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

        let query = supabase
            .from('galleria_media_v2')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });

        if (date) {
            query = query
                .gte('created_at', `${date}T00:00:00.000Z`)
                .lte('created_at', `${date}T23:59:59.999Z`);
        }

        // Genitore: media broadcast (qualunque, semantica storica) o con il figlio taggato
        if (studentId) {
            query = query.or(`is_broadcast.eq.true,tag_students.cs.{${studentId}}`);
        }

        // Insegnante: broadcast destinati alla classe o media con alunni della classe taggati
        if (classe) {
            const { data: students } = await supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classe);
            const studentIds = (students?.map(s => s.id) ?? []).filter(id => UUID_RE.test(id));
            const classeSafe = classe.replace(/[(){}",\\]/g, '');
            const broadcastCond = `and(is_broadcast.eq.true,target_classes.cs.{"${classeSafe}"})`;
            query = query.or(
                studentIds.length > 0
                    ? `${broadcastCond},tag_students.ov.{${studentIds.join(',')}}`
                    : broadcastCond
            );
        }

        const { data: pageMedia, count, error } = await query.range(offset, offset + limit - 1);

        if (error) {
            console.error('Errore GET gallery:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Arricchisci con info uploader in blocco (niente N+1 sulla pagina)
        const page = pageMedia ?? [];
        const uploaderIds = [...new Set(page.map(m => m.uploaded_by).filter(Boolean))];
        const { data: uploaders } = uploaderIds.length > 0
            ? await supabase
                .from('utenti')
                .select('id, nome, cognome, first_name, last_name')
                .in('id', uploaderIds)
            : { data: [] };
        const uploaderById = new Map((uploaders ?? []).map(u => [u.id, u]));

        const enriched = page.map((media) => {
            const uploader = uploaderById.get(media.uploaded_by);
            return {
                ...media,
                uploader_name: uploader
                    ? `${uploader.first_name || uploader.nome} ${uploader.last_name || uploader.cognome}`
                    : 'Sconosciuto',
            };
        });

        return NextResponse.json({ media: enriched, total: count ?? 0 });
    } catch (error) {
        console.error('Errore API GET gallery:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/gallery
// Body: { uploaded_by, file_url, file_type?, caption?, tag_students?, is_broadcast?, target_classes? }
export async function POST(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const {
            file_url,
            file_type,
            caption,
            tag_students,
            is_broadcast,
            target_classes,
        } = b.data;

        // L'uploader è l'utente del gate (no spoofing del campo uploaded_by).
        const uploaded_by = auth.user.id;

        const supabase = await createAdminClient();

        // Privacy Lock (DL-041): inibisce il tagging di alunni senza consenso privacy
        // (liberatoria foto), tranne nelle foto broadcast (istituzionali).
        const senza = await alunniSenzaConsenso(supabase, tag_students, is_broadcast ?? false);
        if (senza.length > 0) {
            return NextResponse.json(
                {
                    error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).',
                    nomi: senza.map((s) => s.nome),
                    ids: senza.map((s) => s.id),
                },
                { status: 422 }
            );
        }

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

        // Notifica ai genitori interessati (best-effort): alunni taggati →
        // classi target → broadcast a tutta la scuola. Buffer 30' + debounce
        // per uploader: gli upload a raffica collassano in una notifica sola.
        try {
            const scuolaId = auth.user.scuola_id ?? null;
            const tagged = (tag_students ?? []) as string[];
            const classi = Array.isArray(target_classes) ? (target_classes as string[]).filter(Boolean) : [];
            const destinatari = tagged.length > 0
                ? await genitoriDiAlunni(supabase, tagged)
                : classi.length > 0
                    ? await genitoriDiClassi(supabase, scuolaId, classi)
                    : await genitoriDiScuola(supabase, scuolaId);
            await notificaEvento(supabase, {
                tipo: 'galleria',
                scuolaId,
                utenteIds: destinatari,
                titolo: 'Nuove foto in galleria',
                corpo: caption ? `«${caption}»` : 'Sono state pubblicate nuove foto.',
                link: '/parent/gallery',
                entitaTipo: 'galleria',
                entitaId: uploaded_by,
                bufferMin: 30,
                debounce: true,
            });
        } catch (e) {
            console.error('Notifica galleria fallita (non bloccante):', e);
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
        const q = parseQuery(request, deleteQuerySchema);
        if ('response' in q) return q.response;
        const id = q.data.id;
        const paramUserId = q.data.userId;

        // Recupera l'utente dalla sessione se disponibile
        let userId: string | undefined = paramUserId;
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
        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, userId, tag_students, is_broadcast, target_classes, caption } = b.data;

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
        // Privacy Lock (DL-041): valida i tag EFFETTIVI quando si modificano tag/broadcast.
        if (tag_students !== undefined || is_broadcast !== undefined) {
            const effBroadcast = is_broadcast !== undefined ? is_broadcast : media.is_broadcast;
            const effTags = tag_students !== undefined ? tag_students : media.tag_students;
            const senza = await alunniSenzaConsenso(supabase, effTags, effBroadcast ?? false);
            if (senza.length > 0) {
                return NextResponse.json(
                    {
                        error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).',
                        nomi: senza.map((s) => s.nome),
                        ids: senza.map((s) => s.id),
                    },
                    { status: 422 }
                );
            }
        }

        const updateData: Record<string, unknown> = {};
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

