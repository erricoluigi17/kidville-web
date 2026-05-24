import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

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
// In the DB we always use a known-valid proxy ID for author_id and null for assigned_to.
// target_class is kept as a real column for class-based SQL pre-filtering.

const PROXY_AUTHOR_ID = '22222222-2222-2222-2222-222222222222'; // Anna Verdi — only valid FK

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

function encodeContenuto(payload: Partial<TaskJsonPayload>): string {
    return JSON.stringify({
        real_author_id: payload.real_author_id ?? PROXY_AUTHOR_ID,
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
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('userId');
        const statusParam = searchParams.get('status');
        const filter = searchParams.get('filter') || 'all';
        const studentId = searchParams.get('studentId');

        if (!userId && !studentId) {
            return NextResponse.json({ error: 'userId o studentId è richiesto' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        // Determine role
        let role = 'educator';
        const { data: uEntry } = await supabase.from('utenti').select('ruolo, role').eq('id', userId).maybeSingle();
        if (uEntry) {
            const rawRole = uEntry.role || uEntry.ruolo;
            if (rawRole === 'admin') role = 'admin';
            else if (rawRole === 'coordinator' || rawRole === 'coordinatore') role = 'coordinator';
        }

        const isManager = role === 'admin' || role === 'coordinator';

        // Educator section names for class-based filter
        let sectionNames: string[] = [];
        if (!isManager) {
            const { data: educatorSections } = await supabase
                .from('educator_sections')
                .select('section_id')
                .eq('educator_id', userId);
            const sectionIds = educatorSections?.map((es: { section_id: string }) => es.section_id) || [];
            if (sectionIds.length > 0) {
                const { data: sections } = await supabase
                    .from('sections')
                    .select('name')
                    .in('id', sectionIds);
                sectionNames = sections?.map((s: { name: string }) => s.name) || [];
            }
        }

        // Fetch rows (all tasks — filtering happens in JS since author/assignee are in JSON)
        const { data: rows, error: rowsErr } = await supabase
            .from('task_interni')
            .select('id, author_id, assigned_to, target_class, titolo, contenuto, completato, created_at')
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
        console.error('Errore API GET /api/tasks:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// ─── POST /api/tasks ──────────────────────────────────────────────────────────
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            titolo, contenuto: rawDescrizione, priority, category, deadline,
            assigned_to, target_class, target_role, target_scope,
            student_id, author_id, compiti
        } = body;

        if (!titolo || !author_id) {
            return NextResponse.json(
                { error: 'titolo e author_id sono richiesti' },
                { status: 400 }
            );
        }

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
            compiti: compiti ?? [],
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
                author_id: PROXY_AUTHOR_ID, // FK-safe proxy
                assigned_to: null,          // FK-safe null; real assignees in JSON
                target_class: target_class ?? null,
                titolo,
                contenuto,
                completato: false,
            })
            .select()
            .single();

        if (error) {
            console.error('Errore creazione task:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(decodeRow(data as Record<string, unknown>), { status: 201 });
    } catch (error) {
        console.error('Errore API POST /api/tasks:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
