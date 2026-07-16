import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { alunniSenzaConsenso } from '@/lib/gallery/privacy';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

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
    // Retro-compatibilità: i client storici lo mandano ancora in query, ma
    // l'identità viene SOLO dal gate (`requireDocente`). Il valore è tollerato
    // ma IGNORATO come identità (anti-spoof): un `?userId=` arbitrario non può
    // più impersonare un admin per cancellare foto di minori.
    userId: z.string().optional(),
});

const patchBodySchema = z.object({
    id: zUuid,
    // Retro-compatibilità: i client storici lo mandano ancora, ma l'identità
    // viene SOLO dal gate (il valore del body è ignorato, anti-spoof).
    userId: zUuid.optional(),
    tag_students: z.array(z.string()).nullish(),
    is_broadcast: z.boolean().nullish(),
    target_classes: z.array(z.string()).nullish(),
    caption: z.string().nullish(),
});

// GET /api/gallery?studentId=xxx&classe=xxx&date=YYYY-MM-DD&limit=30&offset=0
// Lista media con filtri (studentId per genitore, classe per insegnante).
// Filtri e paginazione applicati in SQL (.or + .range): niente scarico dell'intera
// tabella con filtro/slice in memoria. Contratto risposta invariato: { media, total }.
export const GET = withRoute('gallery:GET', async (request: Request) => {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { studentId, classe, date } = q.data;
        const limit = Math.min(Math.max(parseInt(q.data.limit ?? '30') || 30, 1), 100);
        const offset = Math.max(parseInt(q.data.offset ?? '0') || 0, 0);

        // Gate identità: mai più lettura anonima. Con studentId il gate verifica
        // anche il legame genitore↔alunno (401 anonimo / 403 figlio altrui;
        // staff/docente passa); senza studentId (lista/classe) la lettura è
        // riservata a staff/docente.
        const auth = studentId
            ? await requireParentOfStudent(request, studentId)
            : await requireDocente(request);
        if (auth.response) return auth.response;

        // Genitore: il parentId storico in query deve coincidere con l'identità
        // reale del gate (anti-IDOR sul parametro; il legame è già verificato).
        if (auth.user.role === 'genitore' && q.data.parentId && q.data.parentId !== auth.user.id) {
            return NextResponse.json(
                { error: 'Non sei autorizzato a visualizzare i media di questo studente' },
                { status: 403 }
            );
        }

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

        // Scope per sede (tenant) — fix D3: la galleria è isolata per plesso.
        //  - docente (classe): le sedi ATTIVE dell'utente (SedeSelector → cookie,
        //    ri-validate server-side contro le sedi accessibili; mai cross-tenant).
        //  - genitore (studentId): la sede del FIGLIO, così vede solo i broadcast e
        //    i media della sua sede (classi omonime di sedi diverse non collidono).
        let plessi: string[] = [];
        if (classe) {
            plessi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user);
        } else if (studentId) {
            const { data: alunno, error: alErr } = await supabase
                .from('alunni')
                .select('scuola_id')
                .eq('id', studentId)
                .maybeSingle();
            if (alErr) {
                logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, alErr);
                return NextResponse.json({ error: alErr.message }, { status: 500 });
            }
            const sedeFiglio = (alunno?.scuola_id as string | null | undefined) ?? null;
            if (sedeFiglio) plessi = [sedeFiglio];
        }

        // Insegnante: alunni della classe RISTRETTI ai plessi accessibili. Senza
        // questo scope `.eq('classe_sezione', classe)` prendeva anche gli omonimi
        // di un'altra sede → tag cross-tenant nella `.or()` dei media (bug D3).
        let studentIds: string[] = [];
        if (classe) {
            let alunniQ = supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classe);
            if (plessi.length > 0) alunniQ = alunniQ.in('scuola_id', plessi);
            const { data: students, error: stErr } = await alunniQ;
            if (stErr) {
                logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, stErr);
                return NextResponse.json({ error: stErr.message }, { status: 500 });
            }
            studentIds = (students?.map(s => s.id) ?? []).filter(id => UUID_RE.test(id));
        }

        // Builder dei media: `conScuola=false` toglie il SOLO filtro sede per il
        // degrado sul DB E2E CI non migrato (colonna scuola_id assente → 42703).
        const buildMedia = (conScuola: boolean) => {
            let query = supabase
                .from('galleria_media_v2')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false });

            if (date) {
                query = query
                    .gte('created_at', `${date}T00:00:00.000Z`)
                    .lte('created_at', `${date}T23:59:59.999Z`);
            }

            // Isolamento per sede (in AND con i filtri broadcast/tag sotto).
            if (conScuola && plessi.length > 0) {
                query = query.in('scuola_id', plessi);
            }

            // Genitore: media broadcast (semantica storica) o con il figlio taggato.
            if (studentId) {
                query = query.or(`is_broadcast.eq.true,tag_students.cs.{${studentId}}`);
            }

            // Insegnante: broadcast destinati alla classe o media con alunni della classe taggati.
            if (classe) {
                const classeSafe = classe.replace(/[(){}",\\]/g, '');
                const broadcastCond = `and(is_broadcast.eq.true,target_classes.cs.{"${classeSafe}"})`;
                query = query.or(
                    studentIds.length > 0
                        ? `${broadcastCond},tag_students.ov.{${studentIds.join(',')}}`
                        : broadcastCond
                );
            }

            return query.range(offset, offset + limit - 1);
        };

        let mediaRes = await buildMedia(true);
        // DB E2E CI non migrato: scuola_id assente → 42703 (o PGRST204). Riprova
        // senza il filtro sede, così la lettura resta possibile (degrado pulito).
        if (mediaRes.error && ['PGRST204', '42703'].includes((mediaRes.error as { code?: string }).code ?? '')) {
            logEvento('galleria', 'info', {
                operazione: 'gallery:GET',
                esito: 'degrado-scuola-id-assente',
            });
            mediaRes = await buildMedia(false);
        }
        const { data: pageMedia, count, error } = mediaRes;

        if (error) {
            logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, error);
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
        logErrore({ operazione: 'gallery:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// POST /api/gallery
// Body: { uploaded_by, file_url, file_type?, caption?, tag_students?, is_broadcast?, target_classes? }
export const POST = withRoute('gallery:POST', async (request: Request) => {
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

        // Broadcast = comunicazione istituzionale: riservata alla Direzione
        // (admin/coordinatore). La UI lo nasconde già agli educatori; qui lo
        // impone anche il server.
        if (is_broadcast === true && !['admin', 'coordinator'].includes(auth.user.role)) {
            return NextResponse.json(
                { error: 'Solo la Direzione (admin o coordinatore) può pubblicare in broadcast.' },
                { status: 403 }
            );
        }

        const supabase = await createAdminClient();

        // Privacy Lock (DL-041): inibisce il tagging di alunni senza consenso privacy
        // (liberatoria foto), tranne nelle foto broadcast (istituzionali).
        const senza = await alunniSenzaConsenso(supabase, tag_students, is_broadcast ?? false);
        if (senza.length > 0) {
            // Privacy Lock scattato: nel log SOLO conteggi (mai nomi/id dei bambini,
            // che restano nel corpo della risposta per la UI dell'insegnante).
            logEvento('galleria', 'info', {
                operazione: 'gallery:POST',
                esito: 'liberatoria-mancante',
                taggati: new Set(tag_students ?? []).size,
                senzaConsenso: senza.length,
            });
            return NextResponse.json(
                {
                    error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).',
                    nomi: senza.map((s) => s.nome),
                    ids: senza.map((s) => s.id),
                },
                { status: 422 }
            );
        }

        // Sede (tenant) del media = sede di scrittura dell'uploader (rispetta il
        // SedeSelector per gli admin multi-plesso). Se il resolver è ambiguo o
        // nega (admin senza sede attiva) NON blocchiamo la pubblicazione: fallback
        // alla sede primaria dell'utente. Fix D3: senza scuola_id la galleria non
        // era isolabile per sede.
        const sw = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user);
        const scuolaId = sw.scuolaId ?? auth.user.scuola_id ?? null;

        const baseRecord: Record<string, unknown> = {
            uploaded_by,
            file_url,
            file_type: file_type ?? 'foto',
            caption: caption ?? null,
            tag_students: tag_students ?? [],
            is_broadcast: is_broadcast ?? false,
            target_classes: target_classes ?? null,
        };

        let insRes = await supabase
            .from('galleria_media_v2')
            .insert({ ...baseRecord, scuola_id: scuolaId })
            .select()
            .single();
        // DB E2E CI non migrato: colonna scuola_id assente → PGRST204 (o 42703).
        // Riprova senza scuola_id così la pubblicazione resta possibile (degrado).
        if (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '')) {
            logEvento('galleria', 'info', {
                operazione: 'gallery:POST',
                esito: 'degrado-scuola-id-assente',
            });
            insRes = await supabase
                .from('galleria_media_v2')
                .insert(baseRecord)
                .select()
                .single();
        }
        const { data, error } = insRes;

        if (error) {
            logErrore({ operazione: 'gallery:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Evento critico → si logga anche il SUCCESSO (solo conteggi/flag, nessun
        // dato personale): senza, "nessun log" non distinguerebbe "pubblicata" da
        // "non è mai partito niente".
        logEvento('galleria', 'info', {
            operazione: 'gallery:POST',
            esito: 'pubblicata',
            nTag: (tag_students ?? []).length,
            broadcast: is_broadcast ?? false,
        });

        // Notifica ai genitori interessati (best-effort): alunni taggati →
        // classi target → broadcast a tutta la scuola. Buffer 30' + debounce
        // per uploader: gli upload a raffica collassano in una notifica sola.
        try {
            // Riusa la sede risolta sopra (rispetta il SedeSelector), invece di
            // ricadere sempre sulla sede primaria dell'utente.
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
            // `error` benché il media sia pubblicato (201): la notifica non è mai stata accodata,
            // quindi i genitori non sapranno delle foto nuove. Il contenuto è salvo, il suo
            // annuncio è perso — e nessuno se ne accorgerebbe senza questa riga.
            logEvento('notifica', 'error', {
                operazione: 'gallery:POST',
                esito: 'notifica-genitori-non-accodata',
            }, e);
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'gallery:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// DELETE /api/gallery?id=xxx&userId=yyy
// Cancella un media con controllo granularizzato dei ruoli
export const DELETE = withRoute('gallery:DELETE', async (request: Request) => {
    try {
        // Gate identità: l'utente arriva SOLO dal gate, MAI dal parametro `?userId=`.
        // Prima, senza sessione, si ricadeva sul param → spoofing admin (cancellazione
        // di foto di minori). `requireDocente` esclude genitore/cuoca (401 anonimo,
        // 403 ruolo non ammesso): nessun ruolo genitore ha titolo a cancellare, e la
        // successiva logica per ruolo/plesso (isAdmin/isCoordinator/isEducator) resta
        // invariata — cambia solo la FONTE dell'identità.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const userId = auth.user.id;

        const q = parseQuery(request, deleteQuerySchema);
        if ('response' in q) return q.response;
        const id = q.data.id;

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
            logErrore({ operazione: 'gallery:DELETE', stato: 500, evento: 'db' }, deleteErr);
            return NextResponse.json({ error: deleteErr.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        logErrore({ operazione: 'gallery:DELETE', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// PATCH /api/gallery
// Body: { id, tag_students, is_broadcast, target_classes, caption }
// (il campo `userId` nel body è tollerato per retro-compatibilità ma ignorato)
export const PATCH = withRoute('gallery:PATCH', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, tag_students, is_broadcast, target_classes, caption } = b.data;

        // Identità dal gate (sessione o header), MAI dal body: un userId
        // arbitrario nel body non può più impersonare un altro utente.
        const userId = auth.user.id;

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

        // Broadcast è operazione di Direzione (admin/coordinatore): un
        // non-direzione non può né impostare/mantenere broadcast=true né
        // cambiare il flag su un media esistente.
        const isDirezione = ['admin', 'coordinator'].includes(auth.user.role);
        const broadcastEffettivo = (is_broadcast !== undefined ? is_broadcast : media.is_broadcast) === true;
        const cambiaBroadcast = is_broadcast !== undefined && (is_broadcast === true) !== (media.is_broadcast === true);
        if (!isDirezione && (broadcastEffettivo || cambiaBroadcast)) {
            return NextResponse.json(
                { error: 'Solo la Direzione (admin o coordinatore) può gestire i media in broadcast.' },
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
                // Come nel POST: nel log solo conteggi, mai nomi/id dei bambini.
                logEvento('galleria', 'info', {
                    operazione: 'gallery:PATCH',
                    esito: 'liberatoria-mancante',
                    taggati: Array.isArray(effTags) ? new Set(effTags).size : 0,
                    senzaConsenso: senza.length,
                });
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
            logErrore({ operazione: 'gallery:PATCH', stato: 500, evento: 'db' }, updateErr);
            return NextResponse.json({ error: updateErr.message }, { status: 500 });
        }

        return NextResponse.json(updatedMedia);
    } catch (error) {
        logErrore({ operazione: 'gallery:PATCH', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

