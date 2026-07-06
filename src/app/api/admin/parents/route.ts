import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { linkOrCreateParent } from '@/lib/anagrafiche/parents';

// ============================================================
// Anagrafica genitori — gated Segreteria+Direzione (DL-036) + audit
// immutabile su ogni mutazione (DL-037).
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
    // '' oggi equivale a "nessun filtro" (truthy check nel codice): preservato.
    student_id: z.union([zUuid, z.literal('')]).optional(),
});

// POST — due azioni sul discriminante `action`.
const inviteBodySchema = z.object({
    action: z.literal('invite'),
    // Sostituisce il 400 manuale 'Email mancante'; nessun vincolo di formato (come oggi).
    email: z.string().min(1, 'Email mancante'),
});

// `create_parent` spalma il resto del body nell'insert (...parentData):
// .loose() preserva le chiavi extra (fiscal_code, first_name, ecc.).
// I campi mappati a mano restano liberi: oggi accettano qualunque valore.
const createParentBodySchema = z
    .object({
        action: z.literal('create_parent'),
        // ''/null oggi saltano il collegamento allo studente: preservati.
        student_id: z.union([zUuid, z.literal('')]).nullish(),
        emails: z.unknown().optional(),
        phones: z.unknown().optional(),
        role: z.unknown().optional(),
        birth_nation: z.unknown().optional(),
        birth_place: z.unknown().optional(),
        birth_province: z.unknown().optional(),
        address: z.unknown().optional(),
        zip_code: z.unknown().optional(),
        residence_city: z.unknown().optional(),
    })
    .loose();

const postBodySchema = z.discriminatedUnion('action', [
    inviteBodySchema,
    createParentBodySchema,
]);

// Il body (meno id) viene spalmato in update(dataToUpdate): .loose() preserva le chiavi extra.
const patchBodySchema = z
    .object({
        id: zUuid, // obbligatorio (sostituisce il 400 manuale 'ID genitore mancante')
    })
    .loose();

export async function GET(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    try {
        const studentId = q.data.student_id;

        const supabase = await createAdminClient();

        let query = supabase.from('parents').select('*');

        if (studentId) {
            query = supabase
                .from('parents')
                .select(`
                    *,
                    student_parents!inner (
                        student_id
                    )
                `)
                .eq('student_parents.student_id', studentId);
        }

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data);
    } catch (err) {
        console.error('Errore GET /api/admin/parents:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const parsed = await parseBody(request, postBodySchema);
    if ('response' in parsed) return parsed.response;
    const body = parsed.data;
    try {
        const supabase = await createAdminClient();

        if (body.action === 'invite') {
            const { email } = body;

            const { data, error } = await supabase.auth.admin.inviteUserByEmail(email);

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ success: true, message: 'Invito inviato a ' + email, data });
        }

        if (body.action === 'create_parent') {
            try {
                const { parentId, created } = await linkOrCreateParent(supabase, auth.user, {
                    studentId: (body.student_id as string) || null,
                    payload: body as Record<string, unknown>,
                });
                return NextResponse.json({ success: true, parent_id: parentId, created });
            } catch (e) {
                console.error('[create_parent]', (e as Error).message);
                return NextResponse.json({ error: (e as Error).message }, { status: 500 });
            }
        }

        return NextResponse.json({ error: 'Azione non supportata' }, { status: 400 });
    } catch (err) {
        console.error('Errore POST /api/admin/parents:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const parsed = await parseBody(request, patchBodySchema);
    if ('response' in parsed) return parsed.response;
    try {
        const supabase = await createAdminClient();

        const { id, ...dataToUpdate } = parsed.data;

        // Stato precedente per l'audit.
        const { data: prima } = await supabase.from('parents').select('*').eq('id', id).maybeSingle();

        const updates: Record<string, unknown> = { ...dataToUpdate };
        let { data, error } = await supabase.from('parents').update(updates).eq('id', id).select();
        // Resilienza pre-migration: rimuove le colonne non ancora esistenti (42703) e riprova.
        let attempts = 0;
        while (error && (error as { code?: string }).code === '42703' && attempts < 6) {
            const col = /column "?([a-z_]+)"? of relation/i.exec(error.message)?.[1];
            if (!col || !(col in updates)) break;
            delete updates[col];
            ({ data, error } = await supabase.from('parents').update(updates).eq('id', id).select());
            attempts++;
        }

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'genitori',
            entitaId: id,
            azione: 'update',
            valorePrima: prima ?? null,
            valoreDopo: dataToUpdate,
        });

        return NextResponse.json({ success: true, data });
    } catch (err) {
        console.error('Errore PATCH /api/admin/parents:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
