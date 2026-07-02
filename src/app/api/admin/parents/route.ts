import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

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
            const { student_id, emails, phones, role, birth_nation, birth_place, birth_province, address, zip_code, ...rest } = body;
            // Il discriminante `action` non deve finire nel record genitore.
            const parentData: Record<string, unknown> = { ...rest };
            delete parentData.action;

            let parentId: string | null = null;
            let created = false;

            // 1. Genitore esistente per CF?
            if (parentData.fiscal_code) {
                const { data: existingParent } = await supabase
                    .from('parents')
                    .select('id')
                    .eq('fiscal_code', parentData.fiscal_code)
                    .maybeSingle();

                if (existingParent) {
                    parentId = existingParent.id;
                }
            }

            // 2. Se non esiste, crea il nuovo genitore.
            if (!parentId) {
                const newParentRecord: Record<string, unknown> = {
                    ...parentData,
                    emails: emails || [],
                    phone_numbers: phones || [],
                    citizenship: role,
                    birth_city: birth_place,
                    birth_province: birth_province,
                    birth_nation: birth_nation,
                    residence_address: address,
                    residence_city: body.residence_city,
                    zip_code: zip_code
                };

                const { data: newParent, error: parentError } = await supabase
                    .from('parents')
                    .insert(newParentRecord)
                    .select('id')
                    .single();

                if (parentError) {
                    console.error('[create_parent] Errore insert genitore:', parentError.message);
                    return NextResponse.json({ error: parentError.message }, { status: 500 });
                }
                parentId = newParent.id;
                created = true;

                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'genitori',
                    entitaId: parentId,
                    azione: 'insert',
                    valoreDopo: newParentRecord,
                });
            }

            // 3. Collega il genitore allo studente.
            if (student_id && parentId) {
                const { error: linkError } = await supabase
                    .from('student_parents')
                    .upsert(
                        {
                            student_id,
                            parent_id: parentId,
                            relation_type: role || 'delegate',
                            is_primary: role === 'mother' || role === 'father'
                        },
                        { onConflict: 'student_id,parent_id', ignoreDuplicates: true }
                    );

                if (linkError) {
                    console.error('[create_parent] Errore link student_parents:', linkError.message);
                    return NextResponse.json({ error: linkError.message }, { status: 500 });
                }

                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'legame',
                    entitaId: `${student_id}:${parentId}`,
                    azione: 'insert',
                    valoreDopo: { student_id, parent_id: parentId, relation_type: role || 'delegate' },
                });
            }

            return NextResponse.json({ success: true, parent_id: parentId, created });
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

        const { data, error } = await supabase
            .from('parents')
            .update(dataToUpdate)
            .eq('id', id)
            .select();

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
