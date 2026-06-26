import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';

// ============================================================
// Anagrafica sezioni/classi — gated Segreteria+Direzione (DL-036) + audit (DL-037).
// ============================================================

// ============================================================
// GET /api/admin/sections — Lista sezioni
// ============================================================
export async function GET(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const { searchParams } = new URL(request.url);
        const scuolaId = searchParams.get('scuola_id');
        const supabase = await createAdminClient();

        let query = supabase
            .from('sections')
            .select('*')
            .order('name', { ascending: true });

        if (scuolaId) query = query.eq('scuola_id', scuolaId);

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data || []);
    } catch (err: any) {
        console.error('Errore GET /api/admin/sections:', err);
        return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
    }
}

// ============================================================
// POST /api/admin/sections — Crea nuova sezione
// ============================================================
export async function POST(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const body = await request.json();
        const supabase = await createAdminClient();

        const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111';

        const { name, school_type, scuola_id } = body;
        if (!name) {
            return NextResponse.json({ error: 'Il nome della sezione è obbligatorio' }, { status: 400 });
        }

        const record = {
            name,
            school_type: school_type || 'infanzia',
            scuola_id: scuola_id || SCUOLA_ID_DEFAULT,
        };

        const { data, error } = await supabase
            .from('sections')
            .insert(record)
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'sezioni',
            entitaId: data?.id ?? null,
            azione: 'insert',
            scuolaId: record.scuola_id,
            valoreDopo: data,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (err: any) {
        console.error('Errore POST /api/admin/sections:', err);
        return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
    }
}

// ============================================================
// PATCH /api/admin/sections — Aggiorna sezione
// ============================================================
export async function PATCH(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const body = await request.json();
        const supabase = await createAdminClient();

        const { id, ...updates } = body;
        if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 });

        // Stato precedente per l'audit.
        const { data: prima } = await supabase.from('sections').select('*').eq('id', id).maybeSingle();

        const { data, error } = await supabase
            .from('sections')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'sezioni',
            entitaId: id,
            azione: 'update',
            scuolaId: (data?.scuola_id as string) ?? null,
            valorePrima: prima ?? null,
            valoreDopo: updates,
        });

        return NextResponse.json(data);
    } catch (err: any) {
        console.error('Errore PATCH /api/admin/sections:', err);
        return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
    }
}
