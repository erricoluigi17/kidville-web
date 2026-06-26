import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';

// ============================================================
// Anagrafica genitori — gated Segreteria+Direzione (DL-036) + audit
// immutabile su ogni mutazione (DL-037).
// ============================================================

export async function GET(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const { searchParams } = new URL(request.url);
        const studentId = searchParams.get('student_id');

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
    try {
        const body = await request.json();
        const supabase = await createAdminClient();

        if (body.action === 'invite') {
            const { email } = body;
            if (!email) {
                return NextResponse.json({ error: 'Email mancante' }, { status: 400 });
            }

            const { data, error } = await supabase.auth.admin.inviteUserByEmail(email);

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ success: true, message: 'Invito inviato a ' + email, data });
        }

        if (body.action === 'create_parent') {
            const { student_id, action, emails, phones, role, birth_nation, birth_place, birth_province, address, zip_code, ...parentData } = body;

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
    try {
        const body = await request.json();
        const supabase = await createAdminClient();

        const { id, ...dataToUpdate } = body;
        if (!id) {
            return NextResponse.json({ error: 'ID genitore mancante' }, { status: 400 });
        }

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
