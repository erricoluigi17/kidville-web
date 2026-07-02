import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';

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
        real_author_id: payload.real_author_id ?? '',
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

interface RouteParams {
    params: Promise<{ id: string }>;
}

// PUT /api/tasks/[id]
export async function PUT(
    request: Request,
    { params }: RouteParams
) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const { id } = await params;
        const body = await request.json();
        const {
            status,
            resolution_notes,
            resolved_by,
            titolo,
            contenuto: rawDescrizione,
            priority,
            category,
            deadline,
            assigned_to,
            target_class,
            target_scope,
            student_id,
            compiti,
            revision_feedback,
            attachments,
            commenti
        } = body;

        const supabase = await createAdminClient();

        // 1. Fetch current row
        const { data: currentRow, error: getErr } = await supabase
            .from('task_interni')
            .select('id, author_id, assigned_to, target_class, titolo, contenuto, completato, created_at, scuola_id')
            .eq('id', id)
            .maybeSingle();

        if (getErr || !currentRow) {
            return NextResponse.json({ error: 'Task non trovato' }, { status: 404 });
        }

        // Tenant: la task deve essere in un plesso dell'attore.
        const plessi = await scuoleDiUtente(supabase, auth.user);
        if (!currentRow.scuola_id || !plessi.includes(currentRow.scuola_id as string)) {
            return NextResponse.json({ error: 'Accesso negato: task fuori dal tuo plesso' }, { status: 403 });
        }

        // 2. Decode existing JSON payload
        const existing = decodeContenuto(currentRow.contenuto as string | null);

        // 3. Merge updates
        const updated: Partial<TaskJsonPayload> = { ...existing };

        if (rawDescrizione !== undefined) updated.descrizione = rawDescrizione;
        if (priority !== undefined) updated.priority = priority;
        if (category !== undefined) updated.category = category;
        if (deadline !== undefined) updated.deadline = deadline;
        if (target_scope !== undefined) updated.target_scope = target_scope;
        if (student_id !== undefined) updated.student_id = student_id;
        if (compiti !== undefined) updated.compiti = compiti;
        if (revision_feedback !== undefined) updated.revision_feedback = revision_feedback;
        if (attachments !== undefined) updated.attachments = attachments;
        if (commenti !== undefined) updated.commenti = commenti;

        // Handle assignees update
        if (assigned_to !== undefined) {
            if (Array.isArray(assigned_to)) {
                updated.assignees = assigned_to;
            } else if (assigned_to) {
                updated.assignees = [assigned_to];
            } else {
                updated.assignees = [];
            }
        }

        // Status transition
        if (status !== undefined) {
            updated.status = status;
            if (status === 'completed') {
                updated.resolved_by = resolved_by ?? null;
                updated.resolution_notes = resolution_notes ?? '';
                updated.resolved_at = new Date().toISOString();
            } else if (status === 'approved') {
                if (resolved_by !== undefined) updated.resolved_by = resolved_by;
                if (resolution_notes !== undefined) updated.resolution_notes = resolution_notes;
                if (!updated.resolved_at) updated.resolved_at = new Date().toISOString();
            } else {
                updated.resolved_by = null;
                updated.resolution_notes = null;
                updated.resolved_at = null;
            }
        }

        // 4. Build DB updates
        const dbUpdates: Record<string, unknown> = {
            contenuto: encodeContenuto(updated),
            completato: (updated.status ?? existing.status ?? 'todo') === 'approved',
        };

        if (titolo !== undefined) dbUpdates.titolo = titolo;
        if (target_class !== undefined) dbUpdates.target_class = target_class;
        // NOTE: assigned_to stays null in DB (FK constraint); real assignees are in JSON

        // 5. Execute
        const { data, error } = await supabase
            .from('task_interni')
            .update(dbUpdates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('Errore aggiornamento task:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const row = data as Record<string, unknown>;
        const payload = decodeContenuto(row.contenuto as string | null);

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'task', entitaId: id, azione: 'update',
            scuolaId: (currentRow.scuola_id as string) ?? null, valoreDopo: { id, status: payload.status, titolo: row.titolo },
        });

        return NextResponse.json({
            id: row.id,
            titolo: row.titolo,
            author_id: payload.real_author_id ?? row.author_id,
            assigned_to: payload.assignees?.[0] ?? null,
            assignees: payload.assignees ?? [],
            target_class: row.target_class,
            completato: row.completato,
            created_at: row.created_at,
            ...payload,
        });
    } catch (error) {
        console.error('Errore API PUT /api/tasks/[id]:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// DELETE /api/tasks/[id]
export async function DELETE(
    request: Request,
    { params }: RouteParams
) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const { id } = await params;
        const supabase = await createAdminClient();

        // Tenant: la task deve essere in un plesso dell'attore.
        const { data: row } = await supabase.from('task_interni').select('scuola_id').eq('id', id).maybeSingle();
        const plessi = await scuoleDiUtente(supabase, auth.user);
        if (!row || !row.scuola_id || !plessi.includes(row.scuola_id as string)) {
            return NextResponse.json({ error: 'Accesso negato: task fuori dal tuo plesso' }, { status: 403 });
        }

        const { error } = await supabase
            .from('task_interni')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Errore eliminazione task:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'task', entitaId: id, azione: 'delete',
            scuolaId: (row.scuola_id as string) ?? null,
        });

        return NextResponse.json({ success: true, message: 'Task eliminato con successo' });
    } catch (error) {
        console.error('Errore API DELETE /api/tasks/[id]:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
