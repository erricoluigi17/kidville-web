import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id (userId, studentId, author_id, assignees) restano stringhe libere:
// nel payload JSON di task_interni circolano anche id non-UUID (dati legacy),
// quindi zUuid sarebbe più severo del comportamento attuale.
const getQuerySchema = z.object({
    userId: z.string().optional(),
    status: z.string().optional(), // lista separata da virgole, split in handler
    filter: z.string().default('all'),
    studentId: z.string().optional(),
});

const postBodySchema = z.object({
    titolo: z.string().min(1),
    contenuto: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    deadline: z.string().nullable().optional(),
    assigned_to: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    target_class: z.string().nullable().optional(),
    target_role: z.string().nullable().optional(),
    target_scope: z.string().nullable().optional(),
    student_id: z.string().nullable().optional(),
    author_id: z.string().min(1),
    compiti: z.array(z.unknown()).nullable().optional(),
});

// ─── Schema note ─────────────────────────────────────────────────────────────
// task_interni actual columns: id, author_id(*FK adults), assigned_to(*FK adults),
//   target_class, titolo, contenuto, completato, created_at
//
// FK constraint means only adults.id values are valid for author_id / assigned_to.
// Since we can't add columns and the adults table is only partially populated,
// we store ALL extended data in the contenuto JSON field:
//   { real_author_id, assignees[], descrizione, status, priority, category,
//     deadline, compiti[], target_scope, target_role, student_id,
//     resolved_by, resolution_notes, resolved_at }
//
// In the DB author_id is the AUTHENTICATED actor (FK-safe: requireDocente
// garantisce una riga in `utenti`) and assigned_to stays null; real assignees
// live in JSON. target_class is kept as a real column for SQL pre-filtering.

// ─── Types ────────────────────────────────────────────────────────────────────
interface Attachment {
    name: string;
    url: string;
    size: number;
    type: string;
}

interface Commento {
    id: string;
    author_id: string;
    author_name: string;
    testo: string;
    created_at: string;
    attachments?: Attachment[] | null;
}

interface SubTask {
    id: string;
    titolo: string;
    assigned_to: string;
    status: 'todo' | 'completed' | 'approved';
    resolution_notes?: string | null;
    resolved_at?: string | null;
    resolved_by?: string | null;
    revision_feedback?: string | null;
    attachments?: Attachment[] | null;
    commenti?: Commento[] | null;
}

interface TaskJsonPayload {
    real_author_id: string;
    assignees: string[];
    descrizione: string;
    status: string;
    priority: string;
    category: string;
    deadline: string | null;
    compiti: SubTask[];
    target_scope: string;
    target_role: string | null;
    student_id: string | null;
    resolved_by: string | null;
    resolution_notes: string | null;
    resolved_at: string | null;
    revision_feedback?: string | null;
    attachments?: Attachment[] | null;
    commenti?: Commento[] | null;
}

// ─── Encode / Decode ──────────────────────────────────────────────────────────
function decodeContenuto(contenuto: string | null): Partial<TaskJsonPayload> {
    if (!contenuto) return {};
    try {
        if (contenuto.trimStart().startsWith('{')) {
            return JSON.parse(contenuto) as Partial<TaskJsonPayload>;
        }
        return { descrizione: contenuto };
    } catch {
        return { descrizione: contenuto };
    }
}

function encodeContenuto(payload: Partial<TaskJsonPayload> & { real_author_id: string }): string {
    return JSON.stringify({
        real_author_id: payload.real_author_id,
        assignees: payload.assignees ?? [],
        descrizione: payload.descrizione ?? '',
        status: payload.status ?? 'todo',
        priority: payload.priority ?? 'medium',
        category: payload.category ?? 'generale',
        deadline: payload.deadline ?? null,
        compiti: payload.compiti ?? [],
        target_scope: payload.target_scope ?? 'single',
        target_role: payload.target_role ?? null,
        student_id: payload.student_id ?? null,
        resolved_by: payload.resolved_by ?? null,
        resolution_notes: payload.resolution_notes ?? null,
        resolved_at: payload.resolved_at ?? null,
        revision_feedback: payload.revision_feedback ?? null,
        attachments: payload.attachments ?? [],
        commenti: payload.commenti ?? [],
    });
}

function decodeRow(row: Record<string, unknown>) {
    const payload = decodeContenuto(row.contenuto as string | null);
    return {
        id: row.id,
        titolo: row.titolo,
        author_id: payload.real_author_id ?? row.author_id,
        assigned_to: payload.assignees?.[0] ?? null,
        target_class: row.target_class,
        completato: row.completato,
        created_at: row.created_at,
        // Extended
        descrizione: payload.descrizione ?? '',
        status: payload.status ?? (row.completato ? 'approved' : 'todo'),
        priority: payload.priority ?? 'medium',
        category: payload.category ?? 'generale',
        deadline: payload.deadline ?? null,
        compiti: payload.compiti ?? [],
        target_scope: payload.target_scope ?? 'single',
        target_role: payload.target_role ?? null,
        student_id: payload.student_id ?? null,
        resolved_by: payload.resolved_by ?? null,
        resolution_notes: payload.resolution_notes ?? null,
        resolved_at: payload.resolved_at ?? null,
        revision_feedback: payload.revision_feedback ?? null,
        assignees: payload.assignees ?? [],
        attachments: payload.attachments ?? [],
        commenti: payload.commenti ?? [],
    };
}

// ─── Person lookup ────────────────────────────────────────────────────────────
type PersonInfo = { first_name: string; last_name: string; role: string };

async function lookupPerson(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    id: string | null
): Promise<PersonInfo | null> {
    if (!id) return null;

    // Try utenti first (most likely source)
    const { data: u } = await supabase
        .from('utenti')
        .select('nome, cognome, ruolo, first_name, last_name, role')
        .eq('id', id)
        .maybeSingle();
    if (u) {
        const rawRole = u.role || u.ruolo || '';
        let roleStr = 'educator';
        if (rawRole === 'admin') roleStr = 'admin';
        if (rawRole === 'coordinator' || rawRole === 'coordinatore') roleStr = 'coordinator';
        return {
            first_name: u.first_name || u.nome || '',
            last_name: u.last_name || u.cognome || '',
            role: roleStr
        };
    }

    // Try parents
    const { data: p } = await supabase
        .from('parents')
        .select('first_name, last_name, citizenship')
        .eq('id', id)
        .maybeSingle();
    if (p) return { first_name: p.first_name, last_name: p.last_name, role: p.citizenship };

    return null;
}

async function enrichTask(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    decoded: ReturnType<typeof decodeRow>
) {
    const [author, resolver] = await Promise.all([
        lookupPerson(supabase, decoded.author_id as string | null),
        lookupPerson(supabase, decoded.resolved_by as string | null),
    ]);

    // Resolve primary assignee info (first in assignees array)
    const primaryAssigneeId = (decoded.assignees as string[])?.[0] ?? null;
    const assignee = await lookupPerson(supabase, primaryAssigneeId);

    // Student
    let student = null;
    if (decoded.student_id) {
        const { data: stud } = await supabase
            .from('alunni')
            .select('nome, cognome, classe_sezione, note_mediche')
            .eq('id', decoded.student_id)
            .maybeSingle();
        if (stud) {
            student = {
                nome: stud.nome,
                cognome: stud.cognome,
                classe_sezione: stud.classe_sezione,
                allergie: stud.note_mediche ? String(stud.note_mediche).split(',').map((s: string) => s.trim()) : []
            };
        }
    }

    // Enrich compiti
    const compiti = decoded.compiti as SubTask[];
    const enrichedCompiti = await Promise.all(
        (compiti || []).map(async (c) => {
            const ass = await lookupPerson(supabase, c.assigned_to || null);
            return {
                ...c,
                assignee_name: ass ? `${ass.first_name} ${ass.last_name}` : 'Non assegnato'
            };
        })
    );

    return {
        ...decoded,
        compiti: enrichedCompiti,
        author: author ? { first_name: author.first_name, last_name: author.last_name, role: author.role } : null,
        assignee: assignee ? { first_name: assignee.first_name, last_name: assignee.last_name, role: assignee.role } : null,
        student,
        resolver: resolver ? { first_name: resolver.first_name, last_name: resolver.last_name, role: resolver.role } : null,
    };
}

// ─── GET /api/tasks ───────────────────────────────────────────────────────────
export const GET = withRoute('tasks:GET', async (request: Request) => {
    try {
        // tasks = compiti INTERNI staff: gate ruolo + isolamento per plesso. Nessun flusso genitore.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { userId, status: statusParam, filter, studentId } = q.data;

        if (!userId && !studentId) {
            return NextResponse.json({ error: 'userId o studentId è richiesto' }, { status: 400 });
        }

        const supabase = await createAdminClient();
        const plessi = await scuoleDiUtente(supabase, auth.user);
        if (plessi.length === 0) return NextResponse.json([]);

        // Determine role
        let role = 'educator';
        const { data: uEntry } = await supabase.from('utenti').select('ruolo, role').eq('id', userId ?? null).maybeSingle();
        if (uEntry) {
            const rawRole = uEntry.role || uEntry.ruolo;
            if (rawRole === 'admin') role = 'admin';
            else if (rawRole === 'coordinator' || rawRole === 'coordinatore') role = 'coordinator';
        }

        const isManager = role === 'admin' || role === 'coordinator';

        // Sezioni del docente per il filtro `target_class`: fonte canonica
        // utenti_sezioni → sections.name; fallback legacy sui media taggati.
        // Nessuna mappa email→sezione (verificato in prod: email inesistenti,
        // tutti i docenti hanno legami in utenti_sezioni). Senza riscontri → []
        // (il docente vede comunque i task global/role/authored/assigned).
        let sectionNames: string[] = [];
        if (!isManager && userId) {
            sectionNames = await nomiSezioniDiUtente(supabase, userId);
        }
        if (!isManager && sectionNames.length === 0) {
            // Get sections from educator's media uploads (tagged students' classes)
            const { data: myMedia } = await supabase
                .from('galleria_media_v2')
                .select('tag_students')
                .eq('uploaded_by', userId ?? null)
                .not('tag_students', 'is', null);

            const myTaggedIds = (myMedia ?? [])
                .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                .filter(Boolean);

            if (myTaggedIds.length > 0) {
                const { data: students } = await supabase
                    .from('alunni')
                    .select('classe_sezione')
                    .in('id', myTaggedIds);
                sectionNames = [...new Set(
                    (students ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
                )];
            }
        }

        // Fetch rows (all tasks — filtering happens in JS since author/assignee are in JSON)
        const { data: rows, error: rowsErr } = await supabase
            .from('task_interni')
            .select('id, author_id, assigned_to, target_class, titolo, contenuto, completato, created_at, scuola_id')
            .in('scuola_id', plessi)
            .order('created_at', { ascending: false });

        if (rowsErr) {
            console.error('Errore GET task:', rowsErr);
            return NextResponse.json({ error: rowsErr.message }, { status: 500 });
        }

        // Special filter for studentId (used in StudentDetailPanel)
        if (studentId) {
            const visible = (rows ?? [])
                .map(row => decodeRow(row as Record<string, unknown>))
                .filter(task => task.student_id === studentId);
            const enriched = await Promise.all(visible.map(t => enrichTask(supabase, t)));
            return NextResponse.json(enriched);
        }

        const activeUserId = userId!;

        // Decode and filter in JS
        const statusFilter = statusParam ? statusParam.split(',') : null;

        const visible = (rows ?? [])
            .map(row => decodeRow(row as Record<string, unknown>))
            .filter(task => {
                // 1. Status filter
                if (statusFilter && !statusFilter.includes(task.status as string)) return false;

                const realAuthorId = task.author_id as string;
                const assignees = task.assignees as string[];
                const compiti = task.compiti as SubTask[];

                // 2. Specific filter parameter
                if (filter === 'created') {
                    return realAuthorId === activeUserId;
                }

                if (filter === 'assigned') {
                    if (assignees?.includes(activeUserId)) return true;
                    if (compiti?.some(c => c.assigned_to === activeUserId)) return true;
                    return false;
                }

                if (filter === 'to_review') {
                    // Managers (coordinator / admin) see completed tasks.
                    // If a teacher created it, they see it too under to_review.
                    if (isManager) return task.status === 'completed';
                    return task.status === 'completed' && realAuthorId === activeUserId;
                }

                if (filter === 'all') {
                    if (isManager) return true;
                    if (realAuthorId === activeUserId) return true;
                    if (assignees?.includes(activeUserId)) return true;
                    if (task.target_class && sectionNames.includes(task.target_class as string)) return true;
                    if (task.target_scope === 'global') return true;
                    if (task.target_scope === 'role' && task.target_role === 'educator') return true;
                    if (compiti?.some(c => c.assigned_to === activeUserId)) return true;
                    return false;
                }

                // Default fallthrough:
                if (isManager) return true;
                if (realAuthorId === activeUserId) return true;
                if (assignees?.includes(activeUserId)) return true;
                if (task.target_class && sectionNames.includes(task.target_class as string)) return true;
                if (task.target_scope === 'global') return true;
                if (task.target_scope === 'role' && task.target_role === 'educator') return true;
                if (compiti?.some(c => c.assigned_to === activeUserId)) return true;
                return false;
            });

        const enriched = await Promise.all(visible.map(t => enrichTask(supabase, t)));

        return NextResponse.json(enriched);
    } catch (error) {
        logErrore({ operazione: 'tasks:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// ─── POST /api/tasks ──────────────────────────────────────────────────────────
export const POST = withRoute('tasks:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const {
            titolo, contenuto: rawDescrizione, priority, category, deadline,
            assigned_to, target_class, target_role, target_scope,
            student_id, author_id, compiti
        } = b.data;

        const supabase = await createAdminClient();

        // Build assignees array
        let assignees: string[] = [];
        if (compiti && Array.isArray(compiti) && compiti.length > 0) {
            // Subtask mode — no top-level assignees
            assignees = [];
        } else if (assigned_to && Array.isArray(assigned_to)) {
            assignees = assigned_to;
        } else if (assigned_to && typeof assigned_to === 'string') {
            assignees = [assigned_to];
        }

        const contenuto = encodeContenuto({
            real_author_id: author_id,
            assignees,
            descrizione: rawDescrizione || '',
            status: 'todo',
            priority: priority ?? 'medium',
            category: category ?? 'generale',
            deadline: deadline ?? null,
            compiti: (compiti ?? []) as SubTask[],
            target_scope: target_scope ?? 'single',
            target_role: target_role ?? null,
            student_id: student_id ?? null,
            resolved_by: null,
            resolution_notes: null,
            resolved_at: null,
        });

        const { data, error } = await supabase
            .from('task_interni')
            .insert({
                author_id: auth.user.id, // attore autenticato (FK utenti)
                assigned_to: null,          // FK-safe null; real assignees in JSON
                target_class: target_class ?? null,
                titolo,
                contenuto,
                completato: false,
                scuola_id: auth.user.scuola_id ?? null, // tenant: plesso dell'attore
            })
            .select()
            .single();

        if (error) {
            console.error('Errore creazione task:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'task', entitaId: (data as { id?: string })?.id ?? null,
            azione: 'insert', scuolaId: auth.user.scuola_id ?? null, valoreDopo: { id: (data as { id?: string })?.id, titolo },
        });

        // Notifica agli assegnatari (best-effort), escluso l'autore stesso.
        try {
            const destinatari = assignees.filter((uid) => uid && uid !== auth.user.id);
            if (destinatari.length > 0) {
                await notificaEvento(supabase, {
                    tipo: 'task_assegnato',
                    scuolaId: auth.user.scuola_id ?? null,
                    utenteIds: destinatari,
                    titolo: 'Nuovo incarico assegnato',
                    corpo: titolo,
                    link: '/teacher/tasks',
                    entitaTipo: 'task',
                    entitaId: (data as { id?: string })?.id ?? null,
                    bufferMin: 0,
                });
            }
        } catch (e) {
            console.error('Notifica task assegnato fallita (non bloccante):', e);
        }

        return NextResponse.json(decodeRow(data as Record<string, unknown>), { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'tasks:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
