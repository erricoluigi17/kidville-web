import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';
import { createClient as createAdminClient } from '@supabase/supabase-js';

const supabaseAdmin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const studentId = searchParams.get('student_id');

        const supabase = await createClient();

        let query = supabase.from('parents').select('*');

        if (studentId) {
            // Need to join via student_parents
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
    try {
        const body = await request.json();
        const supabase = await createClient();

        if (body.action === 'invite') {
            const { email } = body;
            if (!email) {
                return NextResponse.json({ error: 'Email mancante' }, { status: 400 });
            }

            // In un ambiente reale, per usare inviteUserByEmail serve supabaseServiceRoleKey 
            // e instanziare il client con quella chiave. Poiché server-client usa cookie utente,
            // si raccomanda l'uso di una service_role key server-side.
            // Qui lo simuliamo/utilizziamo se permesso:
            const { data, error } = await supabase.auth.admin.inviteUserByEmail(email);

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ success: true, message: 'Invito inviato a ' + email, data });
        }

        if (body.action === 'create_parent') {
            const { student_id, action, emails, phones, role, birth_nation, birth_place, birth_province, address, zip_code, ...parentData } = body;

            console.log('[create_parent] Payload ricevuto:', { student_id, fiscal_code: parentData.fiscal_code, role });
            
            let parentId: string | null = null;

            // 1. Controlla se esiste già un genitore con questo CF (usa service role per bypassare RLS)
            if (parentData.fiscal_code) {
                const { data: existingParent, error: lookupError } = await supabaseAdmin
                    .from('parents')
                    .select('id')
                    .eq('fiscal_code', parentData.fiscal_code)
                    .maybeSingle();
                
                console.log('[create_parent] Lookup CF:', existingParent?.id || 'non trovato', lookupError?.message || '');
                
                if (existingParent) {
                    parentId = existingParent.id;
                }
            }

            // 2. Se non esiste, crea il nuovo genitore
            if (!parentId) {
                const newParentRecord = {
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

                const { data: newParent, error: parentError } = await supabaseAdmin
                    .from('parents')
                    .insert(newParentRecord)
                    .select('id')
                    .single();

                if (parentError) {
                    console.error('[create_parent] Errore insert genitore:', parentError.message);
                    return NextResponse.json({ error: parentError.message }, { status: 500 });
                }
                parentId = newParent.id;
                console.log('[create_parent] Nuovo genitore creato:', parentId);
            }

            // 3. Collega il genitore allo studente (se student_id è stato fornito)
            if (student_id && parentId) {
                const { error: linkError } = await supabaseAdmin
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
                console.log('[create_parent] Link upsert OK: student', student_id, '-> parent', parentId);
            } else {
                console.warn('[create_parent] student_id assente, link non creato. student_id:', student_id);
            }

            return NextResponse.json({ success: true, parent_id: parentId });
        }

        return NextResponse.json({ error: 'Azione non supportata' }, { status: 400 });
    } catch (err) {
        console.error('Errore POST /api/admin/parents:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();

        const { id, ...dataToUpdate } = body;
        if (!id) {
            return NextResponse.json({ error: 'ID genitore mancante' }, { status: 400 });
        }

        const { data, error } = await supabase
            .from('parents')
            .update(dataToUpdate)
            .eq('id', id)
            .select();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ success: true, data });
    } catch (err) {
        console.error('Errore PATCH /api/admin/parents:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
